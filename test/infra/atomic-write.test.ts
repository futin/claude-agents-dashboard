/** `server/lib/atomic-write.ts` — a state file is replaced whole or left as it was, and no temp file is ever left beside it. */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { overrideAtomicRename, writeFileAtomic } from '../../server/lib/atomic-write.js';

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

  if (process.platform !== 'win32') {
    if (test('mode 0o600 gives the file that mode under a 0o022 umask, and replacing a 0o644 file narrows it', () => {
      const dir = fs.mkdtempSync(path.join(tmp, 'mode-'));
      const file = path.join(dir, 'cron.env');
      const prev = process.umask(0o022);
      try {
        writeFileAtomic(file, 'A=1\n', { mode: 0o600 });
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        fs.chmodSync(file, 0o644);
        writeFileAtomic(file, 'A=2\n', { mode: 0o600 });
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
        // A mode wider than the umask allows is set too: the chmod, not the create flag, decides.
        writeFileAtomic(file, 'A=3\n', { mode: 0o666 });
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o666);
      } finally {
        process.umask(prev);
      }
      assert.deepStrictEqual(temps(dir), []);
    })) p++; else f++;
  }

  if (test('with a mode, a failed rename still leaves no *.tmp', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'modefail-'));
    overrideAtomicRename(() => { throw new Error('EXDEV'); });
    try {
      assert.throws(() => writeFileAtomic(path.join(dir, 'x'), 'x', { mode: 0o600 }), /EXDEV/);
    } finally {
      overrideAtomicRename(null);
    }
    assert.deepStrictEqual(temps(dir), []);
  })) p++; else f++;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
