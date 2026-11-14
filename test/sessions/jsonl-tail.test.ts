/**
 * `server/lib/jsonl-tail.ts` — `foldLines`, the chunked read loop every transcript and log follower shares, and `followJsonl` on top of it. Byte offsets,
 * line splitting on bytes before decoding, a line longer than a chunk delivered whole, and the offset a throw leaves behind.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTail, foldLines, followJsonl } from '../../server/lib/jsonl-tail.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Write `content` to a fresh file, fold `[from, size)` with `chunkBytes`, and report what came out. */
function fold(content: string | Buffer, opts: { from?: number; chunkBytes?: number; onLine?: (line: Buffer, i: number) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-jsonl-tail-'));
  const file = path.join(dir, 'f.jsonl');
  fs.writeFileSync(file, content);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const lines: string[] = [];
  const cursor = { offset: opts.from ?? 0 };
  let bytesRead = 0;
  let rest: Buffer | null = null;
  let error: unknown = null;
  try {
    rest = foldLines(fd, cursor, size, line => { opts.onLine?.(line, lines.length); lines.push(line.toString('utf8')); },
      { chunkBytes: opts.chunkBytes, onRead: n => { bytesRead += n; } });
  } catch (e) {
    error = e;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { lines, offset: cursor.offset, bytesRead, size, rest, error };
}

export function run(): number {
  console.log('\n=== jsonl-tail.ts (foldLines, followJsonl) ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('a\\nb\\nc: lines a and b, offset 4, the newline-less c handed back unconsumed', () => {
    const got = fold('a\nb\nc');
    assert.deepStrictEqual(got.lines, ['a', 'b']);
    assert.strictEqual(got.offset, 4);
    assert.strictEqual(got.rest!.toString(), 'c');
  }));

  r(test('a line straddling a chunk boundary is delivered whole, in order', () => {
    const got = fold('first\nsecond-line\nthird\n', { chunkBytes: 8 });
    assert.deepStrictEqual(got.lines, ['first', 'second-line', 'third']);
    assert.strictEqual(got.offset, got.size);
    assert.strictEqual(got.rest!.length, 0);
  }));

  r(test('a line three chunks long is delivered once, whole', () => {
    const long = 'x'.repeat(24);
    const got = fold(`${long}\nend\n`, { chunkBytes: 8 });
    assert.deepStrictEqual(got.lines, [long, 'end']);
  }));

  r(test('a 2-byte é whose bytes straddle a chunk boundary decodes as é, not U+FFFD', () => {
    // `{"s":"` is 6 bytes, so with 7-byte chunks é's two bytes land at 6 and 7 — one in each chunk.
    const got = fold('{"s":"é"}\n', { chunkBytes: 7 });
    assert.strictEqual(Buffer.from('{"s":"').length, 6);
    assert.strictEqual(JSON.parse(got.lines[0]).s, 'é');
    assert.ok(!got.lines[0].includes('�'));
  }));

  r(test('bytes read is size - from; folding again from size reads nothing', () => {
    const content = 'one\ntwo\nthree\n';
    const got = fold(content, { from: 4, chunkBytes: 5 });
    assert.deepStrictEqual(got.lines, ['two', 'three']);
    assert.strictEqual(got.bytesRead, got.size - 4);
    const again = fold(content, { from: Buffer.byteLength(content) });
    assert.strictEqual(again.bytesRead, 0);
    assert.deepStrictEqual(again.lines, []);
  }));

  r(test('onLine throwing on line 2 leaves the offset at the end of line 1, and a retry from it re-delivers line 2', () => {
    const content = 'l1\nl2\nl3\n';
    const got = fold(content, { onLine: (_line, i) => { if (i === 1) throw new Error('boom'); } });
    assert.ok(got.error, 'the throw propagates');
    assert.strictEqual(got.offset, 3);
    const retry = fold(content, { from: got.offset });
    assert.deepStrictEqual(retry.lines, ['l2', 'l3']);
  }));

  r(test('a carry from an earlier call is not read again, and is prefixed to the next line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-jsonl-tail-'));
    try {
      const file = path.join(dir, 'f.jsonl');
      fs.writeFileSync(file, 'ab');
      let fd = fs.openSync(file, 'r');
      const cursor = { offset: 0 };
      const carry = foldLines(fd, cursor, 2, () => assert.fail('no complete line yet'));
      fs.closeSync(fd);
      assert.strictEqual(carry.toString(), 'ab');
      fs.appendFileSync(file, 'c\n');
      fd = fs.openSync(file, 'r');
      const lines: string[] = [];
      let read = 0;
      foldLines(fd, cursor, 4, line => lines.push(line.toString()), { carry, onRead: n => { read += n; } });
      fs.closeSync(fd);
      assert.deepStrictEqual(lines, ['abc']);
      assert.strictEqual(read, 2, 'only the appended bytes are read');
      assert.strictEqual(cursor.offset, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  r(test('followJsonl: a newline-less complete JSON tail is consumed; a partial one waits for its newline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-jsonl-tail-'));
    try {
      const file = path.join(dir, 'f.jsonl');
      const recs: unknown[] = [];
      const tail = createTail();
      fs.writeFileSync(file, '{"n":1}\n{"n":2}');
      followJsonl(file, fs.statSync(file).size, tail, rec => recs.push(rec));
      assert.deepStrictEqual(recs, [{ n: 1 }, { n: 2 }]);
      assert.strictEqual(tail.partial.length, 0);
      assert.strictEqual(tail.offset, fs.statSync(file).size);

      fs.appendFileSync(file, '\n{"a":');
      followJsonl(file, fs.statSync(file).size, tail, rec => recs.push(rec));
      assert.strictEqual(recs.length, 2, 'a strict prefix never parses');
      assert.strictEqual(tail.partial.toString(), '{"a":');

      fs.appendFileSync(file, '1}\n');
      followJsonl(file, fs.statSync(file).size, tail, rec => recs.push(rec));
      assert.deepStrictEqual(recs, [{ n: 1 }, { n: 2 }, { a: 1 }]);
      assert.strictEqual(tail.offset, fs.statSync(file).size);
      assert.strictEqual(tail.partial.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
