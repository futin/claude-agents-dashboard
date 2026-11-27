/**
 * `readTranscript`'s tail-scan memo (#587): an unchanged transcript — same size and mtime — is served without reading a byte, while the context window
 * and percent are still computed on every call. Each case starts from an empty memo.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanSessions } from '../../server/lib/scan.js';
import { readTranscript, resetTranscriptMemo, setTranscriptMemoMax, transcriptMemoStats } from '../../server/lib/transcript.js';

function test(name: string, fn: () => void): boolean {
  resetTranscriptMemo();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally { setTranscriptMemoMax(null); resetTranscriptMemo(); }
}

const MTIME_S = 1_790_000_000;

function user(text: string, ts: string): object {
  return { type: 'user', cwd: '/tmp/memo', timestamp: ts, message: { role: 'user', content: text } };
}

function assistant(ts: string, content: unknown[] = [{ type: 'text', text: 'done' }]): object {
  return {
    type: 'assistant', cwd: '/tmp/memo', timestamp: ts,
    message: { role: 'assistant', model: 'claude-opus-4-5', stop_reason: 'end_turn', content, usage: { input_tokens: 1000 } }
  };
}

const lines = (recs: object[]): string => recs.map(r => JSON.stringify(r)).join('\n') + '\n';

/** A tmpdir holding transcripts; `write(name, recs)` plants one with a fixed mtime and returns its path. */
function withDir(fn: (dir: string, write: (name: string, recs: object[]) => string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-memo-'));
  const write = (name: string, recs: object[]): string => {
    const file = path.join(dir, name + '.jsonl');
    fs.writeFileSync(file, lines(recs));
    fs.utimesSync(file, MTIME_S, MTIME_S);
    return file;
  };
  try { fn(dir, write); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function run(): number {
  console.log('\n=== transcript.ts tail-scan memo ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('an unchanged file is scanned once, and each call gets its own result object', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('hi', '2026-11-27T10:00:00Z'), assistant('2026-11-27T10:00:01Z')]);
      const one = readTranscript(file);
      const two = readTranscript(file);
      assert.deepStrictEqual(transcriptMemoStats(), { scans: 1, hits: 1, entries: 1 });
      assert.deepStrictEqual(two, one);
      assert.notStrictEqual(two, one);
    });
  });

  t('an append rescans and shows the new state', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('hi', '2026-11-27T10:00:00Z')]);
      assert.strictEqual(readTranscript(file)!.turnComplete, false);
      fs.appendFileSync(file, lines([assistant('2026-11-27T10:00:05Z')]));
      const after = readTranscript(file)!;
      assert.strictEqual(transcriptMemoStats().scans, 2);
      assert.strictEqual(after.turnComplete, true);
      assert.strictEqual(after.lastMessageTs, '2026-11-27T10:00:05Z');
    });
  });

  t('same size with a new mtime rescans', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('aaaa', '2026-11-27T10:00:00Z')]);
      assert.strictEqual(readTranscript(file)!.lastMessageTs, '2026-11-27T10:00:00Z');
      fs.writeFileSync(file, lines([user('aaaa', '2026-11-27T11:00:00Z')]));
      fs.utimesSync(file, MTIME_S + 60, MTIME_S + 60);
      const after = readTranscript(file)!;
      assert.strictEqual(transcriptMemoStats().scans, 2);
      assert.strictEqual(after.lastMessageTs, '2026-11-27T11:00:00Z');
    });
  });

  t('same size and same mtime is a hit — the key\'s accepted blind spot, pinned so a key change is deliberate', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('aaaa', '2026-11-27T10:00:00Z')]);
      readTranscript(file);
      fs.writeFileSync(file, lines([user('aaaa', '2026-11-27T11:00:00Z')]));
      fs.utimesSync(file, MTIME_S, MTIME_S);
      const after = readTranscript(file)!;
      assert.strictEqual(transcriptMemoStats().scans, 1);
      assert.strictEqual(after.lastMessageTs, '2026-11-27T10:00:00Z');
    });
  });

  t('a deleted file returns null and leaves the memo', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('hi', '2026-11-27T10:00:00Z')]);
      readTranscript(file);
      assert.strictEqual(transcriptMemoStats().entries, 1);
      fs.rmSync(file);
      assert.strictEqual(readTranscript(file), null);
      assert.strictEqual(transcriptMemoStats().entries, 0);
    });
  });

  t('a non-default tail bypasses the memo, neither reading nor writing it', () => {
    withDir((_dir, write) => {
      const file = write('a', [user('hi', '2026-11-27T10:00:00Z')]);
      readTranscript(file);
      assert.strictEqual(transcriptMemoStats().scans, 1);
      readTranscript(file, { tailBytes: 1024 });
      assert.deepStrictEqual(transcriptMemoStats(), { scans: 2, hits: 0, entries: 1 });
      readTranscript(file);
      assert.deepStrictEqual(transcriptMemoStats(), { scans: 2, hits: 1, entries: 1 });
    });
  });

  t('the least recently used entry is the one evicted', () => {
    withDir((_dir, write) => {
      const [a, b, c] = ['a', 'b', 'c'].map(n => write(n, [user(n, '2026-11-27T10:00:00Z')]));
      setTranscriptMemoMax(2);
      readTranscript(a); readTranscript(b); readTranscript(a); readTranscript(c);
      assert.deepStrictEqual(transcriptMemoStats(), { scans: 3, hits: 1, entries: 2 });
      readTranscript(a);
      assert.deepStrictEqual(transcriptMemoStats(), { scans: 3, hits: 2, entries: 2 });
      readTranscript(b);
      assert.strictEqual(transcriptMemoStats().scans, 4);
    });
  });

  t('the context-window env override is read per call, never frozen into the memo', () => {
    const saved = { a: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, o: process.env.CLAUDE_OBS_CONTEXT_WINDOW };
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    delete process.env.CLAUDE_OBS_CONTEXT_WINDOW;
    try {
      withDir((_dir, write) => {
        const file = write('a', [user('hi', '2026-11-27T10:00:00Z'), assistant('2026-11-27T10:00:01Z')]);
        assert.notStrictEqual(readTranscript(file)!.contextWindow, 50000);
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '50000';
        const after = readTranscript(file)!;
        assert.strictEqual(transcriptMemoStats().hits, 1);
        assert.strictEqual(after.contextWindow, 50000);
        assert.strictEqual(after.contextPct, 2);
      });
    } finally {
      if (saved.a === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved.a;
      if (saved.o !== undefined) process.env.CLAUDE_OBS_CONTEXT_WINDOW = saved.o;
    }
  });

  t('memoised nested objects are frozen, so a caller cannot corrupt the next read', () => {
    withDir((_dir, write) => {
      const file = write('a', [assistant('2026-11-27T10:00:00Z', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])]);
      const parsed = readTranscript(file)!;
      assert.strictEqual(parsed.activity!.tool, 'Bash');
      assert.throws(() => { parsed.activity!.tool = 'x'; }, TypeError);
      assert.strictEqual(readTranscript(file)!.activity!.tool, 'Bash');
    });
  });

  t('the poll stops re-reading unchanged transcripts, and rereads exactly the one appended to', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-memo-root-'));
    try {
      const now = Date.now();
      const ts = new Date(now - 60_000).toISOString();
      const files = ['s1', 's2', 's3'].map(id => {
        const dir = path.join(root, '-tmp-memo-' + id);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, id + '.jsonl');
        fs.writeFileSync(file, lines([user('hi', ts), assistant(ts)]));
        return file;
      });
      const cfg = { maxSessions: 10, activeWindowMin: 5, lookbackHours: 24 };
      const opts = { root, liveCwds: null, lessons: null, skipProcScan: true };
      const first = scanSessions(cfg, opts);
      assert.strictEqual(first.sessions.length, 3);
      const afterFirst = transcriptMemoStats().scans;
      scanSessions(cfg, opts);
      assert.strictEqual(transcriptMemoStats().scans - afterFirst, 0, 'second scan reads nothing');
      fs.appendFileSync(files[0], lines([user('again', new Date(now).toISOString())]));
      scanSessions(cfg, opts);
      assert.strictEqual(transcriptMemoStats().scans - afterFirst, 1, 'third scan rereads only the appended file');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
