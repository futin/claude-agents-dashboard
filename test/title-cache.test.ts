import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tc from '../server/lib/title-cache.js';
import * as tr from '../server/lib/transcript.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const line = (r: unknown) => JSON.stringify(r) + '\n';
const TITLE = (t: string) => line({ type: 'custom-title', customTitle: t, sessionId: 'x' });
const MSG = (i: number) => line({
  timestamp: '2026-07-01T09:00:00Z', cwd: '/p', gitBranch: 'main', version: '2.1.0',
  message: {
    role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn',
    usage: { input_tokens: i },
    content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.js' } }]
  }
});

/** Records totalling at least `bytes`, so a title before them sinks out of the tail. */
function padding(bytes: number): string {
  let out = '', i = 0;
  while (out.length < bytes) out += MSG(i++);
  return out;
}

/** Exactly `bytes` of newline-terminated filler, for byte-exact fixtures. */
function filler(bytes: number): string {
  const OVERHEAD = '{"pad":""}\n'.length;
  assert.ok(bytes >= OVERHEAD, 'filler too small to form a record');
  return '{"pad":"' + 'x'.repeat(bytes - OVERHEAD) + '"}\n';
}

function writeFixture(body: string, name = 's.jsonl'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tt-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const DEEP = tr.DEFAULT_TAIL_BYTES + 64 * 1024;   // comfortably past the window

export function run(): number {
  console.log('\n=== title-cache.ts ===\n');
  let p = 0, f = 0;

  if (test('titleFromRecord: real title, placeholder, junk', () => {
    assert.strictEqual(tc.titleFromRecord({ type: 'custom-title', customTitle: ' My work ' }), 'My work');
    assert.strictEqual(tc.titleFromRecord({ type: 'custom-title', customTitle: 'New session' }), null);
    assert.strictEqual(tc.titleFromRecord({ type: 'custom-title', customTitle: '   ' }), null);
    assert.strictEqual(tc.titleFromRecord({ type: 'user', customTitle: 'nope' }), null);
    assert.strictEqual(tc.titleFromRecord(null), null);
  })) p++; else f++;

  if (test('title below the tail window is still found', () => {
    tc.resetTitleCache();
    const file = writeFixture(MSG(0) + TITLE('SD Docs Sync') + padding(DEEP));
    assert.ok(fs.statSync(file).size > tr.DEFAULT_TAIL_BYTES, 'fixture must exceed the tail window');
    // Pre-flight: the tail window alone genuinely does not contain it.
    assert.strictEqual(tr.readTail(file, tr.DEFAULT_TAIL_BYTES)!.text.includes(tc.TITLE_MARKER), false);
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'SD Docs Sync');
    assert.strictEqual(tc.titleCacheStats().fullScans, 1);
  })) p++; else f++;

  if (test('a title found deep is remembered — later polls do not re-scan', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('Deep name') + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Deep name');
    assert.strictEqual(tc.titleCacheStats().fullScans, 1);

    fs.appendFileSync(file, MSG(999));            // normal growth, still no title in the tail
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Deep name');
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Deep name');
    assert.strictEqual(tc.titleCacheStats().fullScans, 1, 'must be served from the remembered range');
  })) p++; else f++;

  if (test('a genuinely untitled transcript is remembered as untitled', () => {
    tc.resetTitleCache();
    const file = writeFixture(padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, null);
    assert.strictEqual(tc.titleCacheStats().fullScans, 1);
    fs.appendFileSync(file, MSG(1000));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, null);
    assert.strictEqual(tc.titleCacheStats().fullScans, 1, 'a miss is cached too, or every poll rescans');
  })) p++; else f++;

  if (test('a rename in the tail wins over the remembered deep title', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('Old name') + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Old name');
    fs.appendFileSync(file, TITLE('New name') + MSG(1));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'New name');
  })) p++; else f++;

  if (test('newest title wins when several sit below the window', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('First') + padding(1024) + TITLE('Second') + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Second');
  })) p++; else f++;

  if (test('a deep placeholder does not mask an older real title', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('Real one') + padding(1024) + TITLE('New session') + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Real one');
  })) p++; else f++;

  if (test('the marker appearing inside message text is not mistaken for a title', () => {
    tc.resetTitleCache();
    const decoy = line({
      timestamp: '2026-07-01T09:00:00Z',
      message: { role: 'user', content: 'we should grep for "custom-title" records' }
    });
    const file = writeFixture(TITLE('Genuine') + decoy + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Genuine');

    tc.resetTitleCache();
    const only = writeFixture(decoy + padding(DEEP));
    assert.strictEqual(tr.readTranscript(only)!.sessionName, null);
  })) p++; else f++;

  if (test('a shrunk file is treated as rotated, not as the old session', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('Before rotate') + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Before rotate');
    fs.writeFileSync(file, MSG(0) + MSG(1));      // same path, smaller, no title
    assert.strictEqual(tr.readTranscript(file)!.sessionName, null);
  })) p++; else f++;

  if (test('multibyte text around the title does not desync the byte offsets', () => {
    tc.resetTitleCache();
    const wide = line({
      timestamp: '2026-07-01T09:00:00Z',
      message: { role: 'user', content: '日本語テキスト — em dash, emoji 🎉, ünïcødé'.repeat(40) }
    });
    const file = writeFixture(wide + TITLE('Ünïcødé — 名前 🎉') + wide + padding(DEEP));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Ünïcødé — 名前 🎉');
  })) p++; else f++;

  if (test('a small file needs no scan below the window', () => {
    tc.resetTitleCache();
    const file = writeFixture(TITLE('Small') + MSG(0));
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Small');
    const none = writeFixture(MSG(0) + MSG(1));
    assert.strictEqual(tr.readTranscript(none)!.sessionName, null);
    assert.strictEqual(tc.titleCacheStats().fullScans, 0, 'the tail already was the whole file');
  })) p++; else f++;

  // The two boundary cases below cut the title record with a boundary the
  // reader itself picks, rather than trusting padding to land somewhere
  // interesting. CUT_AT is deliberately *before* the marker, which starts ~9
  // bytes into the record: that is the strictly harder side. Cut after the
  // marker and a marker-sized overlap already suffices; cut before it and the
  // record's first bytes are below the boundary while its whole marker sits
  // above, so only a record-sized overlap recovers it.
  const CUT_AT = 4;
  const boundaryFixture = (label: string, boundaryBelowEof: number) => {
    const title = TITLE(label);
    const L = Buffer.byteLength(title);
    const prefix = 8 * 1024;
    assert.ok(title.indexOf(tc.TITLE_MARKER) > CUT_AT, 'CUT_AT must precede the marker');
    // size - boundaryBelowEof === titleOffset + CUT_AT, titleOffset === prefix
    const suffix = boundaryBelowEof + CUT_AT - L;
    assert.ok(suffix > 0, 'fixture math: suffix must be positive');
    const file = writeFixture(filler(prefix) + title + filler(suffix));
    assert.strictEqual(
      fs.statSync(file).size - boundaryBelowEof - prefix, CUT_AT,
      'boundary must land CUT_AT bytes into the record'
    );
    return file;
  };

  if (test('a title record cut by the tail-window boundary is still read', () => {
    tc.resetTitleCache();
    // The tail window drops its partial first line, so this record is invisible there.
    const file = boundaryFixture('Window straddler', tr.DEFAULT_TAIL_BYTES);
    assert.strictEqual(tr.readTail(file, tr.DEFAULT_TAIL_BYTES)!.text.split('\n').slice(1).join('\n').includes(tc.TITLE_MARKER), false);
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Window straddler');
  })) p++; else f++;

  if (test('a title record cut by a backward-chunk boundary is still read', () => {
    tc.resetTitleCache();
    const file = boundaryFixture('Chunk straddler', tr.DEFAULT_TAIL_BYTES + tc.CHUNK_BYTES);
    assert.strictEqual(tr.readTranscript(file)!.sessionName, 'Chunk straddler');
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
