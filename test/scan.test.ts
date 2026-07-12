import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as scan from '../server/lib/scan.js';
import { parseEnv, toPosInt, loadConfig } from '../server/lib/config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

interface Spec {
  dirName: string;
  id: string;
  records: unknown[];
  mtimeMs?: number;
}

// Build a fake ~/.claude/projects root with project dirs + transcripts.
function makeRoot(specs: Spec[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-root-'));
  specs.forEach(spec => {
    const dir = path.join(root, spec.dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, spec.id + '.jsonl');
    fs.writeFileSync(file, spec.records.map(r => JSON.stringify(r)).join('\n'));
    if (spec.mtimeMs) {
      const t = spec.mtimeMs / 1000;
      fs.utimesSync(file, t, t);
    }
  });
  return root;
}

function usageRec(tokens: number) {
  return { message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: tokens } } };
}
function toolRec(name: string, input: unknown) {
  return { message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] } };
}
function metaRec(cwd: string, branch: string) {
  return { cwd, gitBranch: branch, version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user' };
}
function assistantDone() {
  return { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000 } } };
}
function assistantPending() {
  return { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }], usage: { input_tokens: 1000 } } };
}
function assistantQuestion() {
  return { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } }], usage: { input_tokens: 1000 } } };
}

/** Stamp a top-level timestamp on a record (real transcripts carry rec.timestamp). */
function at(rec: any, iso: string) {
  return { ...rec, timestamp: iso };
}

export function run(): number {
  console.log('\n=== config.ts ===\n');
  let p = 0, f = 0;

  if (test('parseEnv handles comments, quotes, blanks', () => {
    const e = parseEnv('# c\nPORT=4000\nMAX_SESSIONS="7"\n\nBAD\nACTIVE_WINDOW_MIN=3');
    assert.strictEqual(e.PORT, '4000');
    assert.strictEqual(e.MAX_SESSIONS, '7');
    assert.strictEqual(e.ACTIVE_WINDOW_MIN, '3');
    assert.strictEqual(e.BAD, undefined);
  })) p++; else f++;

  if (test('toPosInt coerces / falls back', () => {
    assert.strictEqual(toPosInt('5', 1), 5);
    assert.strictEqual(toPosInt('0', 9), 9);
    assert.strictEqual(toPosInt('x', 9), 9);
    assert.strictEqual(toPosInt(undefined, 9), 9);
  })) p++; else f++;

  if (test('loadConfig applies defaults when no .env', () => {
    const c = loadConfig({ envPath: '/no/such/.env' });
    assert.strictEqual(c.port, 4173);
    assert.strictEqual(c.maxSessions, 10);
  })) p++; else f++;

  if (test('loadConfig: skipProcScan defaults to Docker detection, SKIP_PROC_SCAN overrides', () => {
    const wasEnv = process.env.SKIP_PROC_SCAN;
    delete process.env.SKIP_PROC_SCAN;
    try {
      // /.dockerenv doesn't exist on this host/CI runner → default false outside a container.
      assert.strictEqual(loadConfig({ envPath: '/no/such/.env' }).skipProcScan, false);
      process.env.SKIP_PROC_SCAN = 'true';
      assert.strictEqual(loadConfig({ envPath: '/no/such/.env' }).skipProcScan, true);
    } finally {
      if (wasEnv === undefined) delete process.env.SKIP_PROC_SCAN;
      else process.env.SKIP_PROC_SCAN = wasEnv;
    }
  })) p++; else f++;

  console.log('\n=== scan.ts ===\n');

  if (test('decodeProjectName fallback basename', () => {
    assert.strictEqual(scan.decodeProjectName('-Users-me-Documents-ECC'), 'ECC');
  })) p++; else f++;

  if (test('scanSessions ranks by recency, caps at maxSessions', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-old', id: 'old', mtimeMs: now - 60 * 60 * 1000, records: [metaRec('/a/old', 'main'), usageRec(1000)] },
      { dirName: '-a-mid', id: 'mid', mtimeMs: now - 10 * 60 * 1000, records: [metaRec('/a/mid', 'dev'), usageRec(2000)] },
      { dirName: '-a-new', id: 'new', mtimeMs: now - 60 * 1000, records: [metaRec('/a/new', 'main'), toolRec('Bash', { description: 'go' }), usageRec(3000)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 2, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions.length, 2);
    assert.strictEqual(out.sessions[0].project, 'new');   // newest first
    assert.strictEqual(out.sessions[1].project, 'mid');
    assert.strictEqual(out.maxSessions, 2);
  })) p++; else f++;

  if (test('working (recent + unfinished) vs idle (stale + finished)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-hot', id: 'hot', mtimeMs: now - 60 * 1000, records: [metaRec('/a/hot', 'main'), assistantPending()] },
      { dirName: '-a-cold', id: 'cold', mtimeMs: now - 30 * 60 * 1000, records: [metaRec('/a/cold', 'main'), assistantDone()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    const hot = out.sessions.find(s => s.project === 'hot')!;
    const cold = out.sessions.find(s => s.project === 'cold')!;
    assert.strictEqual(hot.status, 'working');
    assert.strictEqual(cold.status, 'idle');
    assert.strictEqual(out.totals.active, 1);
  })) p++; else f++;

  if (test('lookbackHours excludes stale transcripts', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-stale', id: 'stale', mtimeMs: now - 48 * 60 * 60 * 1000, records: [metaRec('/a/stale', 'main'), usageRec(1000)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions.length, 0);
  })) p++; else f++;

  if (test('activity captured from newest tool_use', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-act', id: 'act', mtimeMs: now - 60 * 1000, records: [metaRec('/a/act', 'main'), usageRec(1000), toolRec('Task', { subagent_type: 'Explore', description: 'map' })] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].activity!.tool, 'Task');
    assert.strictEqual(out.sessions[0].activity!.detail, 'Explore: map');
  })) p++; else f++;

  if (test('status: unanswered question is blue even when recent (beats green)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-q', id: 'q', mtimeMs: now - 60 * 1000, records: [metaRec('/a/q', 'main'), assistantQuestion()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'question');
    assert.strictEqual(out.totals.active, 0); // 'question' is not counted as working
  })) p++; else f++;

  if (test('status: recent + pending tool = working (green)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-w', id: 'w', mtimeMs: now - 60 * 1000, records: [metaRec('/a/w', 'main'), assistantPending()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'working');
  })) p++; else f++;

  if (test('status: recent + finished turn = incomplete (your turn, not green)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-yt', id: 'yt', mtimeMs: now - 60 * 1000, records: [metaRec('/a/yt', 'main'), assistantDone()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'incomplete');
    assert.strictEqual(out.totals.active, 0);
  })) p++; else f++;

  if (test('status: stale + unfinished turn = incomplete (yellow)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-i', id: 'i', mtimeMs: now - 30 * 60 * 1000, records: [metaRec('/a/i', 'main'), assistantPending()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'incomplete');
  })) p++; else f++;

  if (test('status: stale + end_turn = idle (gray)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-d', id: 'd', mtimeMs: now - 30 * 60 * 1000, records: [metaRec('/a/d', 'main'), assistantDone()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'idle');
  })) p++; else f++;

  if (test('selection bump: fresh mtime + stale message ts is NOT working', () => {
    // Reproduces the reported bug: selecting a session in Claude Code appends
    // timestamp-less mode/last-prompt records that bump file mtime. An unfinished
    // turn whose last real message is old must stay stalled, not flip to green.
    const now = 1_700_000_000_000;
    const staleTs = new Date(now - 30 * 60 * 1000).toISOString(); // last message 30m ago
    const root = makeRoot([
      {
        dirName: '-a-sel', id: 'sel',
        mtimeMs: now - 2 * 1000,           // just "selected" → mtime fresh
        records: [metaRec('/a/sel', 'main'), at(assistantPending(), staleTs), { type: 'mode' }, { type: 'last-prompt' }]
      }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'incomplete'); // stale + unfinished, NOT working
    assert.strictEqual(out.totals.active, 0);
  })) p++; else f++;

  if (test('recency tracks message ts, not mtime: recent message + stale mtime = working', () => {
    const now = 1_700_000_000_000;
    const freshTs = new Date(now - 30 * 1000).toISOString(); // message 30s ago
    const root = makeRoot([
      {
        dirName: '-a-live', id: 'live',
        mtimeMs: now - 30 * 60 * 1000,     // mtime stale, but the message is fresh
        records: [metaRec('/a/live', 'main'), at(assistantPending(), freshTs)]
      }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].status, 'working');
    assert.strictEqual(out.totals.active, 1);
  })) p++; else f++;

  if (test('liveness: dead process (cwd not live) forces idle despite recent + pending', () => {
    // Reported bug: a cleaned/interrupted session's last record has no end_turn,
    // so it reads recent+pending = working forever. With no live process at its
    // cwd it must drop to idle.
    const now = 1_700_000_000_000;
    const freshTs = new Date(now - 30 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-dead', id: 'dead', mtimeMs: now - 30 * 1000, records: [metaRec('/a/dead', 'main'), at(assistantPending(), freshTs)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: new Set(['/a/other']) });
    assert.strictEqual(out.sessions[0].status, 'idle');
    assert.strictEqual(out.totals.active, 0);
  })) p++; else f++;

  if (test('liveness: dead process forces idle even over an unanswered question', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-dq', id: 'dq', mtimeMs: now - 60 * 1000, records: [metaRec('/a/dq', 'main'), assistantQuestion()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: new Set() });
    assert.strictEqual(out.sessions[0].status, 'idle');
  })) p++; else f++;

  if (test('liveness: live cwd keeps working; null set fails open (no gating)', () => {
    const now = 1_700_000_000_000;
    const freshTs = new Date(now - 30 * 1000).toISOString();
    const specs = [{ dirName: '-a-lv', id: 'lv', mtimeMs: now - 30 * 1000, records: [metaRec('/a/lv', 'main'), at(assistantPending(), freshTs)] }];
    const live = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root: makeRoot(specs), now, liveCwds: new Set(['/a/lv']) });
    assert.strictEqual(live.sessions[0].status, 'working');
    // null → probe disabled, existing behavior unchanged
    const nogate = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root: makeRoot(specs), now, liveCwds: null });
    assert.strictEqual(nogate.sessions[0].status, 'working');
  })) p++; else f++;

  if (test('empty session (no conversational message, e.g. post-/clear) is excluded', () => {
    // /clear starts a fresh UUID transcript with only queue-operation/attachment/
    // meta records and no user/assistant message yet. Its mtime is fresh, so it
    // used to read recent + turnComplete(default) = incomplete ("pending") and
    // show up as a phantom row next to the real session. It has nothing to show.
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-cleared', id: 'cleared', mtimeMs: now - 5 * 1000, records: [{ type: 'queue-operation', timestamp: new Date(now - 5 * 1000).toISOString() }, metaRec('/a/cleared', 'main')] },
      { dirName: '-a-real', id: 'real', mtimeMs: now - 60 * 1000, records: [metaRec('/a/real', 'main'), at(assistantPending(), new Date(now - 60 * 1000).toISOString())] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null });
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].project, 'real');
    assert.strictEqual(out.totals.shown, 1);
  })) p++; else f++;

  if (test('kaizen: injected lesson tags the matching session by id-prefix', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-k', id: 'abc123def', mtimeMs: now - 60 * 1000, records: [metaRec('/a/k', 'main'), assistantDone()] },
      { dirName: '-a-n', id: 'zzz999', mtimeMs: now - 90 * 1000, records: [metaRec('/a/n', 'main'), assistantDone()] }
    ]);
    const lessons = [{ date: '2026-07-12', project: 'k', idPrefix: 'abc123', lesson: 'return terse findings.' }];
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true, lessons });
    const k = out.sessions.find(s => s.project === 'k')!;
    const n = out.sessions.find(s => s.project === 'n')!;
    assert.strictEqual(k.kaizenLesson, 'return terse findings.'); // prefix match
    assert.strictEqual(n.kaizenLesson, null);                     // no matching entry
  })) p++; else f++;

  if (test('kaizen: null lessons (analytics off / not injected) leaves every session null', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-off', id: 'abc123def', mtimeMs: now - 60 * 1000, records: [metaRec('/a/off', 'main'), assistantDone()] }
    ]);
    // explicit null inject skips the log read entirely
    const injected = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true, lessons: null });
    assert.strictEqual(injected.sessions[0].kaizenLesson, null);
    // showAnalytics:false takes the same branch (no inject) without touching disk
    const gated = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24, showAnalytics: false }, { root, now, skipProcScan: true });
    assert.strictEqual(gated.sessions[0].kaizenLesson, null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
