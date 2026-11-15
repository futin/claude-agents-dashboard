/** `server/lib/atomic-write.ts` — a state file is replaced whole or left as it was, and no temp file is ever left beside it. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic } from '../../server/lib/atomic-write.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const temps = (dir: string): string[] => fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));

export function run(): number {
  console.log('\n=== atomic write ===\n');
  let p = 0, f = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-atomic-'));

  if (test('writes the content and leaves no *.tmp beside the file', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'new-'));
    const file = path.join(dir, 'state.json');
    writeFileAtomic(file, '{"a":1}\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
    assert.deepStrictEqual(temps(dir), []);
  })) p++; else f++;

  if (test('a rename that fails throws, leaves no *.tmp, and leaves the target as it was', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'dir-'));
    const target = path.join(dir, 'state.json');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside'), 'keep');
    assert.throws(() => writeFileAtomic(target, 'x'));
    assert.deepStrictEqual(temps(dir), []);
    assert.ok(fs.statSync(target).isDirectory());
    assert.strictEqual(fs.readFileSync(path.join(target, 'inside'), 'utf8'), 'keep');
  })) p++; else f++;

  if (test('replaces an existing file whole, Buffer data included', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'replace-'));
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, 'a much longer old content than the new one\n'.repeat(10));
    writeFileAtomic(file, Buffer.from('short\n'));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'short\n');
    assert.deepStrictEqual(temps(dir), []);
  })) p++; else f++;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
