import assert from 'node:assert';

import { splitPlan } from '../client/src/components/PlanPanel.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== splitPlan (PlanPanel.tsx) ===\n');
  let p = 0, f = 0;

  if (test('the first heading becomes the title and leaves the body', () => {
    const { title, body } = splitPlan('## Title\n\nFirst para\n\nmore');
    assert.strictEqual(title, 'Title');
    assert.strictEqual(body, 'First para\n\nmore');
    assert.ok(!body.includes('## Title'), 'the heading must not print twice');
  })) p++; else f++;

  if (test('#, ## and ### are all recognised', () => {
    assert.deepStrictEqual(splitPlan('# One\nbody'), { title: 'One', body: 'body' });
    assert.deepStrictEqual(splitPlan('## Two\nbody'), { title: 'Two', body: 'body' });
    assert.deepStrictEqual(splitPlan('### Three\nbody'), { title: 'Three', body: 'body' });
  })) p++; else f++;

  if (test('leading blank lines are dropped with the heading', () => {
    assert.deepStrictEqual(splitPlan('\n\n## Title\nbody'), { title: 'Title', body: 'body' });
  })) p++; else f++;

  // PINNED BEHAVIOUR: the scan is not "first line only" — a heading further
  // down is still the title, and only its own line is removed, so the prose
  // that preceded it stays at the top of the body and a blank line is left
  // where the heading was. Markdown collapses that blank run, so it is
  // invisible once rendered; asserted here so a change to the rule is loud.
  if (test('a heading after a paragraph still titles the plan, in place', () => {
    const { title, body } = splitPlan('Intro para\n\n## Title\n\nbody');
    assert.strictEqual(title, 'Title');
    assert.strictEqual(body, 'Intro para\n\n\nbody');
  })) p++; else f++;

  if (test('no heading at all → the generic kicker and an untouched body', () => {
    const src = 'just text\nmore text';
    assert.deepStrictEqual(splitPlan(src), { title: 'proposed plan', body: src });
  })) p++; else f++;

  // The case the fence-awareness was built for: a plan that opens with a
  // fenced sample containing "## ".
  if (test('a ## line inside a fence is not the title when a real heading follows', () => {
    const { title, body } = splitPlan('```\n## not a title\n```\n\n## Real\n\nbody');
    assert.strictEqual(title, 'Real');
    assert.ok(body.startsWith('```\n## not a title\n```'), 'the fenced sample survives verbatim');
    assert.ok(!body.includes('## Real'), 'only the real heading is stripped');
  })) p++; else f++;

  if (test('a fenced ## with no real heading falls back, body untouched', () => {
    const src = 'intro\n\n```md\n## fake\n```\n\ntail';
    assert.deepStrictEqual(splitPlan(src), { title: 'proposed plan', body: src });
    const tilde = '~~~\n## fake\n~~~\ntail';
    assert.deepStrictEqual(splitPlan(tilde), { title: 'proposed plan', body: tilde });
  })) p++; else f++;

  // PINNED BEHAVIOUR: an unterminated fence swallows the rest of the plan,
  // so nothing after it can title it. Safe direction to fail in — the body
  // is returned whole.
  if (test('an unterminated fence keeps everything after it fenced', () => {
    const src = '```\n## fake\nstill open';
    assert.deepStrictEqual(splitPlan(src), { title: 'proposed plan', body: src });
  })) p++; else f++;

  // PINNED BEHAVIOUR: PlanPanel prints the title as plain text, so the title
  // carries the heading's WORDS without its syntax — emphasis, inline code and
  // links, the three `markdown.ts` renders inline. Whitespace is trimmed too.
  if (test('inline markup is stripped from the title; whitespace is trimmed', () => {
    assert.strictEqual(splitPlan('## Redesign the **board**\n\nbody').title, 'Redesign the board');
    assert.strictEqual(splitPlan('## Drop *one* column\nbody').title, 'Drop one column');
    assert.strictEqual(splitPlan('## Touch `styles.css` once\nbody').title, 'Touch styles.css once');
    assert.strictEqual(splitPlan('## See [the mock](docs/x.html)\nbody').title, 'See the mock');
    assert.strictEqual(splitPlan('##   Spaced title   \nbody').title, 'Spaced title');
  })) p++; else f++;

  // The strip is narrow on purpose: syntax `markdown.ts` leaves literal in the
  // body stays literal in the title, so the title can never say LESS than the
  // heading did. Underscore emphasis is the case that matters — it would fire
  // inside snake_case, which is why neither renders it.
  if (test('markup the body would leave literal is left literal in the title', () => {
    assert.strictEqual(splitPlan('## Fix _snake_case_ naming\nbody').title, 'Fix _snake_case_ naming');
    assert.strictEqual(splitPlan('## 2 * 3 * 4 columns\nbody').title, '2 * 3 * 4 columns');
    assert.strictEqual(splitPlan('## Rename foo_bar to baz\nbody').title, 'Rename foo_bar to baz');
    // `__bold__` is the case that made this worth deriving from parseInline:
    // markdown.ts omits underscore emphasis on purpose (it fires inside
    // identifiers), so a title that stripped it would say LESS than the body.
    assert.strictEqual(splitPlan('## Rename __init__ handling\nbody').title, 'Rename __init__ handling');
    assert.strictEqual(splitPlan('## Rename __the__ rail\nbody').title, 'Rename __the__ rail');
    assert.strictEqual(splitPlan('## Fix a__b__c\nbody').title, 'Fix a__b__c');
    // a code span keeps its content verbatim, marks and all — only the ticks go
    assert.strictEqual(splitPlan('## Fix `__init__` lookup\nbody').title, 'Fix __init__ lookup');
  })) p++; else f++;

  // A heading that is only markup has no words to show, so it is not a title —
  // the same rule as a bare `#`, and the reason the strip runs before the
  // emptiness check rather than after it.
  if (test('a heading that is nothing but markup is not a title', () => {
    assert.deepStrictEqual(splitPlan('## ****\n\nbody'), { title: 'proposed plan', body: '## ****\n\nbody' });
    assert.strictEqual(splitPlan('## ``\n## Real one\nbody').title, 'Real one');
  })) p++; else f++;

  if (test('an empty plan, and a heading with no body', () => {
    assert.deepStrictEqual(splitPlan(''), { title: 'proposed plan', body: '' });
    assert.deepStrictEqual(splitPlan('## Only'), { title: 'Only', body: '' });
  })) p++; else f++;

  if (test('a bare # with no text is not a title', () => {
    const src = '#\n\nbody';
    assert.deepStrictEqual(splitPlan(src), { title: 'proposed plan', body: src });
  })) p++; else f++;

  // PINNED BEHAVIOUR: splitPlan is deliberately NOT idempotent. It strips the
  // first heading it finds, so re-running it on its own body promotes the
  // plan's first section heading to a title. PlanPanel calls it exactly once
  // per plan (useMemo over pending.plan), so this never happens at runtime —
  // but nothing else may feed a body back in expecting a no-op.
  if (test('re-running on the body promotes the next section heading', () => {
    const src = '## Title\n\nintro\n\n## Step 1\n\ndo it';
    const once = splitPlan(src);
    assert.deepStrictEqual(once, { title: 'Title', body: 'intro\n\n## Step 1\n\ndo it' });
    const twice = splitPlan(once.body);
    assert.strictEqual(twice.title, 'Step 1');
    assert.strictEqual(twice.body, 'intro\n\n\ndo it');
  })) p++; else f++;

  console.log(`\nsplitPlan: ${p} passed, ${f} failed`);
  return f;
}
