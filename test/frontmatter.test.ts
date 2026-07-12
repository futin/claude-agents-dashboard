import assert from 'node:assert';

import { parseFrontmatter } from '../shared/frontmatter.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== frontmatter.ts ===\n');
  let p = 0, f = 0;

  if (test('plain key: value pairs parsed, body separated', () => {
    const r = parseFrontmatter('---\nname: study\nmodel: haiku\n---\n# Body\ntext');
    assert.strictEqual(r.data.name, 'study');
    assert.strictEqual(r.data.model, 'haiku');
    assert.strictEqual(r.body, '# Body\ntext');
  })) p++; else f++;

  if (test('quoted values are unquoted', () => {
    const r = parseFrontmatter('---\nname: "my skill"\ndesc: \'single\'\n---\nbody');
    assert.strictEqual(r.data.name, 'my skill');
    assert.strictEqual(r.data.desc, 'single');
  })) p++; else f++;

  if (test('folded > scalar joins indented lines with spaces', () => {
    const r = parseFrontmatter(
      '---\nname: caveman\ndescription: >\n  Ultra-compressed communication mode.\n  Cuts token usage ~75%.\ntrigger: /caveman\n---\nbody'
    );
    assert.strictEqual(r.data.description, 'Ultra-compressed communication mode. Cuts token usage ~75%.');
    assert.strictEqual(r.data.trigger, '/caveman');
  })) p++; else f++;

  if (test('folded >- behaves like >', () => {
    const r = parseFrontmatter('---\ndescription: >-\n  one\n  two\n---\n');
    assert.strictEqual(r.data.description, 'one two');
  })) p++; else f++;

  if (test('literal | scalar joins indented lines with newlines', () => {
    const r = parseFrontmatter('---\nscript: |\n  line1\n  line2\n---\n');
    assert.strictEqual(r.data.script, 'line1\nline2');
  })) p++; else f++;

  if (test('no frontmatter → empty data, whole text as body', () => {
    const r = parseFrontmatter('# Just markdown\ncontent');
    assert.deepStrictEqual(r.data, {});
    assert.strictEqual(r.body, '# Just markdown\ncontent');
  })) p++; else f++;

  if (test('unclosed fence → fail-open, whole text as body', () => {
    const text = '---\nname: broken\nno closing fence';
    const r = parseFrontmatter(text);
    assert.deepStrictEqual(r.data, {});
    assert.strictEqual(r.body, text);
  })) p++; else f++;

  if (test('CRLF line endings handled', () => {
    const r = parseFrontmatter('---\r\nname: win\r\n---\r\nbody');
    assert.strictEqual(r.data.name, 'win');
  })) p++; else f++;

  if (test('nested keys (indented, non-scalar) are skipped silently', () => {
    const r = parseFrontmatter('---\nname: x\nmetadata:\n  type: user\n  extra: y\nafter: z\n---\n');
    assert.strictEqual(r.data.name, 'x');
    assert.strictEqual(r.data.after, 'z');
    assert.strictEqual(r.data.type, undefined);
  })) p++; else f++;

  if (test('empty file → empty data + empty body', () => {
    const r = parseFrontmatter('');
    assert.deepStrictEqual(r.data, {});
    assert.strictEqual(r.body, '');
  })) p++; else f++;

  if (test('BOM before fence tolerated', () => {
    const r = parseFrontmatter('﻿---\nname: bom\n---\nbody');
    assert.strictEqual(r.data.name, 'bom');
  })) p++; else f++;

  console.log(`\nfrontmatter: ${p} passed, ${f} failed`);
  return f;
}
