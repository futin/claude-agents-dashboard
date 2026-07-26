import assert from 'node:assert';

import { parseInline, parseMarkdown, type Block, type Inline } from '../client/src/lib/markdown.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Flatten inline spans back to plain text — handy for asserting structure only. */
function flat(spans: Inline[]): string {
  return spans.map(s => (s.t === 'text' || s.t === 'code' ? s.v : flat(s.kids))).join('');
}

/** Emphasis runs that must stay literal (whitespace-flanked, or lone markers). */
const LITERAL = ['2 * 3 * 4', 'a ` b', 'a * b', '** not bold **'];

export function run(): number {
  console.log('\n=== markdown.ts ===\n');
  let p = 0, f = 0;

  /* ------------------------------------------------------------ inline */

  if (test('bold, italic, inline code', () => {
    assert.deepStrictEqual(parseInline('a **b** c'), [
      { t: 'text', v: 'a ' },
      { t: 'strong', kids: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' c' }
    ]);
    assert.deepStrictEqual(parseInline('*it*'), [{ t: 'em', kids: [{ t: 'text', v: 'it' }] }]);
    assert.deepStrictEqual(parseInline('use `npm i`'), [
      { t: 'text', v: 'use ' },
      { t: 'code', v: 'npm i' }
    ]);
  })) p++; else f++;

  if (test('bold wins over italic; code wins over both', () => {
    assert.deepStrictEqual(parseInline('**yes, easy**'), [{ t: 'strong', kids: [{ t: 'text', v: 'yes, easy' }] }]);
    const spans = parseInline('`**not bold**`');
    assert.deepStrictEqual(spans, [{ t: 'code', v: '**not bold**' }]);
  })) p++; else f++;

  if (test('underscores left alone (snake_case, __init__)', () => {
    for (const src of ['snake_case_name', '__init__', 'a _b_ c']) {
      assert.deepStrictEqual(parseInline(src), [{ t: 'text', v: src }]);
    }
  })) p++; else f++;

  if (test('http/mailto/# become links; everything else is a hoverable path', () => {
    assert.deepStrictEqual(parseInline('[x](https://a.dev/b)')[0], {
      t: 'link', kids: [{ t: 'text', v: 'x' }], href: 'https://a.dev/b'
    });
    // repo-relative: nothing to navigate to, so label + target-on-hover
    assert.deepStrictEqual(parseInline('[api.ts](server/api.ts)'), [
      { t: 'path', kids: [{ t: 'text', v: 'api.ts' }], target: 'server/api.ts' }
    ]);
    // an unsafe scheme must never reach an href
    assert.deepStrictEqual(parseInline('[bad](javascript:evil)'), [
      { t: 'path', kids: [{ t: 'text', v: 'bad' }], target: 'javascript:evil' }
    ]);
    assert.ok(!parseInline('[bad](javascript:alert(1))').some(s => s.t === 'link'));
    assert.deepStrictEqual(parseInline('[](x)'), [{ t: 'text', v: '[](x)' }]);
  })) p++; else f++;

  if (test('whitespace-flanked markers stay literal', () => {
    for (const src of LITERAL) {
      assert.deepStrictEqual(parseInline(src), [{ t: 'text', v: src }], src);
    }
  })) p++; else f++;

  /* ------------------------------------------------------------ blocks */

  if (test('headings by level', () => {
    const bs = parseMarkdown('## Verification\n### Deep');
    assert.deepStrictEqual(bs.map(b => b.t), ['h', 'h']);
    assert.strictEqual((bs[0] as Extract<Block, { t: 'h' }>).level, 2);
    assert.strictEqual(flat((bs[0] as Extract<Block, { t: 'h' }>).spans), 'Verification');
    assert.strictEqual((bs[1] as Extract<Block, { t: 'h' }>).level, 3);
  })) p++; else f++;

  if (test('paragraphs split on blank lines, hard breaks kept', () => {
    const bs = parseMarkdown('one\ntwo\n\nthree');
    assert.deepStrictEqual(bs.map(b => b.t), ['p', 'p']);
    assert.strictEqual(flat((bs[0] as Extract<Block, { t: 'p' }>).spans), 'one\ntwo');
    assert.strictEqual(flat((bs[1] as Extract<Block, { t: 'p' }>).spans), 'three');
  })) p++; else f++;

  if (test('fenced code keeps content verbatim, incl. blank lines and markdown', () => {
    const bs = parseMarkdown('```bash\npnpm test\n\n# **not** a heading\n```\nafter');
    assert.deepStrictEqual(bs[0], { t: 'code', lang: 'bash', text: 'pnpm test\n\n# **not** a heading' });
    assert.strictEqual(bs[1].t, 'p');
  })) p++; else f++;

  if (test('unterminated fence swallows the rest', () => {
    const bs = parseMarkdown('```\nstill going');
    assert.deepStrictEqual(bs, [{ t: 'code', lang: '', text: 'still going' }]);
  })) p++; else f++;

  if (test('GFM table with alignment', () => {
    const bs = parseMarkdown('| Check | Result |\n|---|---:|\n| `pnpm test` | ALL PASS |\n| build | ok |\n\nafter');
    const t = bs[0] as Extract<Block, { t: 'table' }>;
    assert.strictEqual(t.t, 'table');
    assert.deepStrictEqual(t.head.map(flat), ['Check', 'Result']);
    assert.deepStrictEqual(t.align, [null, 'r']);
    assert.strictEqual(t.rows.length, 2);
    assert.deepStrictEqual(t.rows[0].map(flat), ['pnpm test', 'ALL PASS']);
    assert.deepStrictEqual(t.rows[0][0][0], { t: 'code', v: 'pnpm test' });
    assert.strictEqual(bs[1].t, 'p'); // the table ended cleanly
  })) p++; else f++;

  if (test('pipe line without a delimiter row stays a paragraph', () => {
    const bs = parseMarkdown('a | b | c');
    assert.deepStrictEqual(bs.map(b => b.t), ['p']);
  })) p++; else f++;

  if (test('bullet and numbered lists, with nesting depth', () => {
    const ul = parseMarkdown('- one\n- two\n  - nested')[0] as Extract<Block, { t: 'list' }>;
    assert.strictEqual(ul.ordered, false);
    assert.deepStrictEqual(ul.items.map(i => [i.depth, flat(i.spans)]), [[0, 'one'], [0, 'two'], [1, 'nested']]);
    const ol = parseMarkdown('1. first\n2. second')[0] as Extract<Block, { t: 'list' }>;
    assert.strictEqual(ol.ordered, true);
    assert.strictEqual(ol.items.length, 2);
  })) p++; else f++;

  if (test('a bullet list and a numbered list are separate blocks', () => {
    const bs = parseMarkdown('- a\n1. b');
    assert.deepStrictEqual(bs.map(b => b.t), ['list', 'list']);
    assert.strictEqual((bs[0] as Extract<Block, { t: 'list' }>).ordered, false);
    assert.strictEqual((bs[1] as Extract<Block, { t: 'list' }>).ordered, true);
  })) p++; else f++;

  if (test('blockquote and horizontal rule', () => {
    const bs = parseMarkdown('> quoted\n> more\n\n---\ntail');
    assert.deepStrictEqual(bs.map(b => b.t), ['quote', 'hr', 'p']);
    assert.strictEqual(flat((bs[0] as Extract<Block, { t: 'quote' }>).spans), 'quoted\nmore');
  })) p++; else f++;

  if (test('empty and whitespace-only input yield no blocks', () => {
    assert.deepStrictEqual(parseMarkdown(''), []);
    assert.deepStrictEqual(parseMarkdown('\n  \n'), []);
  })) p++; else f++;

  if (test('the verification table from a real message round-trips', () => {
    const src = [
      '## Verification',
      '',
      '| Check | Result |',
      '|---|---|',
      '| `pnpm typecheck` | clean |',
      '| Payloads | tail 10.4 KB vs 805 KB file; idle poll **110 bytes** |',
      '',
      'Docs: new [rules](.claude/rules/chat-tail.md).'
    ].join('\n');
    const bs = parseMarkdown(src);
    assert.deepStrictEqual(bs.map(b => b.t), ['h', 'table', 'p']);
    const t = bs[1] as Extract<Block, { t: 'table' }>;
    assert.strictEqual(t.rows.length, 2);
    assert.ok(t.rows[1][1].some(s => s.t === 'strong'), 'bold inside a cell');
    const para = bs[2] as Extract<Block, { t: 'p' }>;
    assert.ok(para.spans.some(s => s.t === 'path'), 'repo link in the trailing paragraph');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
