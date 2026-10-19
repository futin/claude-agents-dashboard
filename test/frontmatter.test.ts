import assert from 'node:assert';

import { parseFrontmatter, writeFrontmatterLine } from '../shared/frontmatter.js';

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

  if (test('writeFrontmatterLine: replaces the value, keeping spacing and the trailing comment', () => {
    const text = '---\nrun: claude\nenabled: true                 # absent = true\nmodel: opus\n---\nbody\n';
    assert.strictEqual(
      writeFrontmatterLine(text, 'enabled', 'false'),
      '---\nrun: claude\nenabled: false                 # absent = true\nmodel: opus\n---\nbody\n',
    );
  })) p++; else f++;

  if (test('writeFrontmatterLine: a quoted value containing " #" is the whole value, the comment after it survives', () => {
    const text = '---\ncron: "0 22 * * *"  # nightly\nrun: shell\n---\n';
    assert.strictEqual(writeFrontmatterLine(text, 'cron', '"5 4 * * *"'), '---\ncron: "5 4 * * *"  # nightly\nrun: shell\n---\n');
    const hashed = '---\nnote: "a #b"  # c\n---\n';
    assert.strictEqual(writeFrontmatterLine(hashed, 'note', 'x'), '---\nnote: x  # c\n---\n');
  })) p++; else f++;

  if (test('writeFrontmatterLine: absent key is inserted after afterKey, else before the closing fence', () => {
    const text = '---\ncron: "0 1 * * *"\nrun: claude\nmodel: opus\n---\nbody';
    assert.strictEqual(writeFrontmatterLine(text, 'enabled', 'false', 'run'), '---\ncron: "0 1 * * *"\nrun: claude\nenabled: false\nmodel: opus\n---\nbody');
    assert.strictEqual(writeFrontmatterLine(text, 'enabled', 'false'), '---\ncron: "0 1 * * *"\nrun: claude\nmodel: opus\nenabled: false\n---\nbody');
    assert.strictEqual(writeFrontmatterLine(text, 'enabled', 'false', 'nope'), '---\ncron: "0 1 * * *"\nrun: claude\nmodel: opus\nenabled: false\n---\nbody');
  })) p++; else f++;

  if (test('writeFrontmatterLine: an empty value (alone, with a comment, CRLF) gets the value without gluing to the comment', () => {
    assert.strictEqual(writeFrontmatterLine('---\nenabled:\n---\n', 'enabled', 'false'), '---\nenabled: false\n---\n');
    assert.strictEqual(writeFrontmatterLine('---\nenabled:   # x\n---\n', 'enabled', 'false'), '---\nenabled:   false # x\n---\n');
    assert.strictEqual(writeFrontmatterLine('---\r\nenabled:\r\n---\r\n', 'enabled', 'false'), '---\r\nenabled: false\r\n---\r\n');
  })) p++; else f++;

  if (test('writeFrontmatterLine: only top-level keys match; a body line or indented line of the same name is left alone', () => {
    const text = '---\nrun: claude\n  enabled: true\n---\nenabled: true\n';
    assert.strictEqual(writeFrontmatterLine(text, 'enabled', 'false'), '---\nrun: claude\n  enabled: true\nenabled: false\n---\nenabled: true\n');
  })) p++; else f++;

  if (test('writeFrontmatterLine: CRLF files keep CRLF on the edited and inserted lines', () => {
    const text = '---\r\nrun: claude\r\nenabled: true\r\n---\r\nbody';
    assert.strictEqual(writeFrontmatterLine(text, 'enabled', 'false'), '---\r\nrun: claude\r\nenabled: false\r\n---\r\nbody');
    const bare = '---\r\nrun: claude\r\n---\r\nbody';
    assert.strictEqual(writeFrontmatterLine(bare, 'enabled', 'false', 'run'), '---\r\nrun: claude\r\nenabled: false\r\n---\r\nbody');
  })) p++; else f++;

  if (test('writeFrontmatterLine: no frontmatter, or an unclosed one, is returned unchanged', () => {
    assert.strictEqual(writeFrontmatterLine('# md\nenabled: true\n', 'enabled', 'false'), '# md\nenabled: true\n');
    assert.strictEqual(writeFrontmatterLine('---\nenabled: true\n', 'enabled', 'false'), '---\nenabled: true\n');
    assert.strictEqual(writeFrontmatterLine('', 'enabled', 'false'), '');
  })) p++; else f++;

  console.log(`\nfrontmatter: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
