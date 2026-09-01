import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as scan from '../server/lib/scan.js';
import { DEFAULTS, parseEnv, toPosInt, loadConfig } from '../server/lib/config.js';
import { refreshCwd } from '../server/lib/token-refresh.js';

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
/** A conversational record stamped with the CLI entrypoint, as real ones are. */
function entryRec(entrypoint: string) {
  return { ...assistantDone(), type: 'assistant', entrypoint };
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
    assert.strictEqual(c.maxSessions, 5);
  })) p++; else f++;

  // bug-4: `.env.example` tells you to copy it verbatim, so every line left
  // active in it must already BE the default — otherwise the copy silently
  // changes behaviour. This guards the whole class, not just MAX_SESSIONS.
  if (test('.env.example active lines match DEFAULTS', () => {
    const text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const active = parseEnv(text);
    const keys = Object.keys(active);
    assert.ok(keys.length > 0, '.env.example has no active settings to check');
    keys.forEach(k => {
      assert.ok(k in DEFAULTS, `.env.example sets ${k}, which has no entry in DEFAULTS`);
      assert.strictEqual(
        active[k], String((DEFAULTS as Record<string, unknown>)[k]),
        `.env.example ${k}=${active[k]} disagrees with DEFAULTS.${k}`
      );
    });
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

  // An unset DASHBOARD_PUBLIC_URL must stay empty, not become a localhost guess.
  // It used to default to `http://localhost:<port>`, which made `clickUrl`'s
  // "no URL → no Click header" guard and `sendTest`'s "you never set this"
  // warning both unreachable: a push carried a link only the server's own
  // machine could open, and the test button called that configured.
  if (test('loadConfig: publicUrl is empty unless DASHBOARD_PUBLIC_URL is set', () => {
    const was = process.env.DASHBOARD_PUBLIC_URL;
    delete process.env.DASHBOARD_PUBLIC_URL;
    try {
      assert.strictEqual(loadConfig({ envPath: '/no/such/.env' }).publicUrl, '');
    } finally {
      if (was === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
      else process.env.DASHBOARD_PUBLIC_URL = was;
    }
  })) p++; else f++;

  if (test('loadConfig: DASHBOARD_PUBLIC_URL is trimmed and loses trailing slashes', () => {
    const was = process.env.DASHBOARD_PUBLIC_URL;
    process.env.DASHBOARD_PUBLIC_URL = '  https://dash.example:4173//  ';
    try {
      assert.strictEqual(
        loadConfig({ envPath: '/no/such/.env' }).publicUrl,
        'https://dash.example:4173'
      );
    } finally {
      if (was === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
      else process.env.DASHBOARD_PUBLIC_URL = was;
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

  if (test('pendingIds: a held remote wait flags the row and turns it blue', () => {
    // The hook registers the wait during PreToolUse, so the transcript still ends
    // on a finished turn — only the store knows a question is open.
    const now = 1_700_000_000_000;
    const staleTs = new Date(now - 60 * 60 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-pq', id: 'pq', mtimeMs: now - 60 * 60 * 1000, records: [metaRec('/a/pq', 'main'), at(assistantDone(), staleTs)] }
    ]);
    const flagged = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null, pendingIds: new Set(['pq']) });
    assert.strictEqual(flagged.sessions[0].status, 'question');   // would be idle on the transcript alone
    assert.strictEqual(flagged.sessions[0].remoteQuestion, true);
    assert.strictEqual(flagged.totals.active, 0);                 // question never counts as working
    // Omitted / null → nothing flagged, statuses exactly as before.
    const bare = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null });
    assert.strictEqual(bare.sessions[0].status, 'idle');
    assert.strictEqual(bare.sessions[0].remoteQuestion, false);
    const nulled = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null, pendingIds: null });
    assert.strictEqual(nulled.sessions[0].remoteQuestion, false);
  })) p++; else f++;

  if (test('pendingIds: a held wait outranks the dead-process gate', () => {
    // lsof is per-cwd and can read "dead" for a session that is very much alive;
    // a socket held open by its hook is the stronger signal.
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-pd', id: 'pd', mtimeMs: now - 60 * 1000, records: [metaRec('/a/pd', 'main'), assistantDone()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: new Set(), pendingIds: new Set(['pd']) });
    assert.strictEqual(out.sessions[0].status, 'question');
    assert.strictEqual(out.sessions[0].remoteQuestion, true);
  })) p++; else f++;

  if (test('pendingIds: only the matching session id is flagged (no prefix match)', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-p1', id: 'sess-one', mtimeMs: now - 60 * 60 * 1000, records: [metaRec('/a/p1', 'main'), assistantDone()] },
      { dirName: '-a-p2', id: 'sess-two', mtimeMs: now - 90 * 60 * 1000, records: [metaRec('/a/p2', 'main'), assistantDone()] }
    ]);
    // 'sess-' is a prefix of both ids and must match neither: the store is keyed
    // by the full session id the hook reported.
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null, pendingIds: new Set(['sess-two', 'sess-']) });
    const byId = new Map(out.sessions.map(s => [s.id, s]));
    assert.strictEqual(byId.get('sess-one')!.remoteQuestion, false);
    assert.strictEqual(byId.get('sess-one')!.status, 'idle');
    assert.strictEqual(byId.get('sess-two')!.remoteQuestion, true);
    assert.strictEqual(byId.get('sess-two')!.status, 'question');
  })) p++; else f++;

  if (test('permissionWaits: a notified session goes blue and carries the flag', () => {
    // The permission dialog is TUI-only: the transcript still ends on the
    // tool_use that triggered it, which alone reads as plain "working".
    const now = 1_700_000_000_000;
    const toolTs = new Date(now - 30 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-pw', id: 'pw', mtimeMs: now - 30 * 1000, records: [metaRec('/a/pw', 'main'), at(assistantPending(), toolTs)] }
    ]);
    const opts = { root, now, liveCwds: null as Set<string> | null };
    // notified AFTER the tool_use landed = the dialog is still up
    const flagged = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 },
      { ...opts, permissionWaits: new Map([['pw', now - 20 * 1000]]) });
    assert.strictEqual(flagged.sessions[0].status, 'question');
    assert.strictEqual(flagged.sessions[0].permissionWait, true);
    assert.strictEqual(flagged.totals.active, 0);       // blue never counts as working
    // Omitted / null → untouched: green, flag false.
    const bare = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, opts);
    assert.strictEqual(bare.sessions[0].status, 'working');
    assert.strictEqual(bare.sessions[0].permissionWait, false);
    const nulled = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { ...opts, permissionWaits: null });
    assert.strictEqual(nulled.sessions[0].permissionWait, false);
    assert.strictEqual(nulled.sessions[0].status, 'working');
  })) p++; else f++;

  if (test('permissionWaits: a message newer than the notify clears it (you answered)', () => {
    // Answering the dialog — allow or deny — appends a record, so the newest
    // message timestamp overtaking notifiedAt IS the "dialog closed" signal.
    const now = 1_700_000_000_000;
    const answeredTs = new Date(now - 10 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-pa', id: 'pa', mtimeMs: now - 10 * 1000, records: [metaRec('/a/pa', 'main'), at(assistantPending(), answeredTs)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 },
      { root, now, liveCwds: null, permissionWaits: new Map([['pa', now - 30 * 1000]]) });
    assert.strictEqual(out.sessions[0].permissionWait, false);
    assert.strictEqual(out.sessions[0].status, 'working');   // back to the plain 2×2
  })) p++; else f++;

  if (test('permissionWaits: the dead-process gate and a held wait both outrank it', () => {
    const now = 1_700_000_000_000;
    const toolTs = new Date(now - 30 * 1000).toISOString();
    const specs = [{ dirName: '-a-pd2', id: 'pd2', mtimeMs: now - 30 * 1000, records: [metaRec('/a/pd2', 'main'), at(assistantPending(), toolTs)] }];
    const waits = new Map([['pd2', now - 20 * 1000]]);
    // A notify is fire-and-forget — no evidence the session is still alive, so
    // lsof wins and the pill is suppressed with it.
    const dead = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 },
      { root: makeRoot(specs), now, liveCwds: new Set(), permissionWaits: waits });
    assert.strictEqual(dead.sessions[0].status, 'idle');
    assert.strictEqual(dead.sessions[0].permissionWait, false);
    // A held remote wait is the stronger claim on the row: it stays `answer`, not `allow?`.
    const held = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 },
      { root: makeRoot(specs), now, liveCwds: null, permissionWaits: waits, pendingIds: new Set(['pd2']) });
    assert.strictEqual(held.sessions[0].status, 'question');
    assert.strictEqual(held.sessions[0].remoteQuestion, true);
    assert.strictEqual(held.sessions[0].permissionWait, false);
  })) p++; else f++;

  if (test('permissionWaits: only the exact id matches, and a stale session is unaffected', () => {
    const now = 1_700_000_000_000;
    const toolTs = new Date(now - 30 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-px', id: 'perm-one', mtimeMs: now - 30 * 1000, records: [metaRec('/a/px', 'main'), at(assistantPending(), toolTs)] },
      { dirName: '-a-py', id: 'perm-two', mtimeMs: now - 90 * 60 * 1000, records: [metaRec('/a/py', 'main'), at(assistantDone(), new Date(now - 90 * 60 * 1000).toISOString())] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 },
      { root, now, liveCwds: null, permissionWaits: new Map([['perm-one', now - 20 * 1000], ['perm-', now]]) });
    const byId = new Map(out.sessions.map(s => [s.id, s]));
    assert.strictEqual(byId.get('perm-one')!.permissionWait, true);
    assert.strictEqual(byId.get('perm-two')!.permissionWait, false);  // prefix must not match
    assert.strictEqual(byId.get('perm-two')!.status, 'idle');
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

  if (test('token-renewal transcript (cwd = refreshCwd) is excluded', () => {
    // Automatic renewal spawns `claude -p` in a dedicated cwd; that turn writes
    // a real transcript which must not show up as a session row.
    const now = 1_700_000_000_000;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-home-'));
    const freshTs = new Date(now - 30 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-refresh', id: 'phantom', mtimeMs: now - 10 * 1000, records: [metaRec(refreshCwd(home), 'main'), at(assistantDone(), freshTs)] },
      { dirName: '-a-real2', id: 'real2', mtimeMs: now - 60 * 1000, records: [metaRec('/a/real2', 'main'), at(assistantPending(), freshTs)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, homeDir: home, liveCwds: null });
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].project, 'real2');
  })) p++; else f++;

  if (test('slash-command-only session (e.g. /login) is excluded', () => {
    // Running `/login` in a fresh terminal writes a transcript of nothing but
    // local-command records: user-role messages, so `hasMessages` passes, but no
    // assistant turn and no tokens. Fresh mtime + role 'user' read as
    // recent + !turnComplete = a yellow "your turn" phantom row.
    const now = 1_700_000_000_000;
    const iso = new Date(now - 5 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-a-login', id: 'login', mtimeMs: now - 5 * 1000, records: [
        metaRec('/a/login', 'main'),
        { type: 'user', timestamp: iso, message: { role: 'user', content: '<command-name>/login</command-name>' } },
        { type: 'user', timestamp: iso, message: { role: 'user', content: '<local-command-stdout>Login successful</local-command-stdout>' } }
      ] },
      { dirName: '-a-real', id: 'real', mtimeMs: now - 60 * 1000, records: [metaRec('/a/real', 'main'), at(assistantPending(), new Date(now - 60 * 1000).toISOString())] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null });
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].project, 'real');
    assert.strictEqual(out.totals.shown, 1);
  })) p++; else f++;

  if (test('dropped sessions do not eat a maxSessions slot', () => {
    // The candidate pool is sliced before parsing, so a filtered-out transcript
    // used to cost a display slot: 2 phantoms + maxSessions 3 showed 1 row.
    // Pool over-fetches; the cap still holds at exactly maxSessions.
    const now = 1_700_000_000_000;
    const iso = (agoSec: number) => new Date(now - agoSec * 1000).toISOString();
    const login = (n: number) => ({
      dirName: '-a-l' + n, id: 'l' + n, mtimeMs: now - n * 1000, records: [
        metaRec('/a/l' + n, 'main'),
        { type: 'user', timestamp: iso(n), message: { role: 'user', content: '<command-name>/login</command-name>' } }
      ]
    });
    const real = (n: number) => ({
      dirName: '-a-r' + n, id: 'r' + n, mtimeMs: now - n * 1000,
      records: [metaRec('/a/r' + n, 'main'), at(assistantPending(), iso(n))]
    });
    // Newest first: two phantoms, then three real sessions.
    const root = makeRoot([login(1), login(2), real(3), real(4), real(5)]);
    const out = scan.scanSessions({ maxSessions: 3, activeWindowMin: 5, lookbackHours: 24 }, { root, now, liveCwds: null });
    assert.deepStrictEqual(out.sessions.map(s => s.id), ['r3', 'r4', 'r5']);
    assert.strictEqual(out.totals.shown, 3);
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

  if (test('sessionSurface: only sdk-cli is dashboard; anything unknown stays local', () => {
    assert.strictEqual(scan.sessionSurface('sdk-cli'), 'dashboard');
    assert.strictEqual(scan.sessionSurface('cli'), 'local');
    assert.strictEqual(scan.sessionSurface('claude-desktop'), 'local');
    // The failure direction is the point: an unknown or missing value must not
    // claim "no other surface lists this" about a session sitting in the desktop
    // app's sidebar. Under-claiming loses a pill; over-claiming makes the row lie.
    assert.strictEqual(scan.sessionSurface('some-future-entrypoint'), 'local');
    assert.strictEqual(scan.sessionSurface(null), 'local');
    assert.strictEqual(scan.sessionSurface(undefined), 'local');
    assert.strictEqual(scan.sessionSurface(''), 'local');
  })) p++; else f++;

  if (test('surface: a headless spawn is marked dashboard, terminal/desktop rows local', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-spawned', id: 'spawned', mtimeMs: now - 60 * 1000, records: [metaRec('/a/spawned', 'main'), entryRec('sdk-cli')] },
      { dirName: '-a-term', id: 'term', mtimeMs: now - 90 * 1000, records: [metaRec('/a/term', 'main'), entryRec('cli')] },
      { dirName: '-a-app', id: 'app', mtimeMs: now - 120 * 1000, records: [metaRec('/a/app', 'main'), entryRec('claude-desktop')] },
      // Pre-field transcript: no entrypoint anywhere.
      { dirName: '-a-old', id: 'old', mtimeMs: now - 150 * 1000, records: [metaRec('/a/old', 'main'), assistantDone()] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    const byId = new Map(out.sessions.map(s => [s.id, s.surface]));
    assert.strictEqual(byId.get('spawned'), 'dashboard');
    assert.strictEqual(byId.get('term'), 'local');
    assert.strictEqual(byId.get('app'), 'local');
    assert.strictEqual(byId.get('old'), 'local');
  })) p++; else f++;

  if (test('surface: a spawn later continued elsewhere stops claiming dashboard', () => {
    // Observed on this machine: one transcript runs sdk-cli → claude-desktop.
    // The newest entrypoint decides, because that session is in the app's
    // sidebar now — "dashboard-only" would be a false claim about it.
    const now = 1_700_000_000_000;
    const root = makeRoot([
      {
        dirName: '-a-moved', id: 'moved', mtimeMs: now - 60 * 1000,
        records: [metaRec('/a/moved', 'main'), entryRec('sdk-cli'), entryRec('claude-desktop')]
      }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].surface, 'local');
  })) p++; else f++;


  /* --------------------------------------------------------- lastMessageMs */

  if (test('lastMessageMs reports the newest conversational timestamp in ms', () => {
    const root = makeRoot([{
      dirName: '-a', id: 'sx',
      records: [
        metaRec('/a', 'main'),
        at(assistantQuestion(), '2026-08-18T11:20:56.333Z'),
        at(assistantDone(), '2026-08-18T11:21:59.809Z')
      ]
    }]);
    assert.strictEqual(scan.lastMessageMs(root, 'sx'), Date.parse('2026-08-18T11:21:59.809Z'));
  })) p++; else f++;

  if (test('lastMessageMs is null for a session id the root does not hold', () => {
    const root = makeRoot([{ dirName: '-a', id: 'sx', records: [metaRec('/a', 'main'), assistantDone()] }]);
    assert.strictEqual(scan.lastMessageMs(root, 'nope'), null);
  })) p++; else f++;

  if (test('lastMessageMs ignores trailing records that carry no conversational role', () => {
    const root = makeRoot([{
      dirName: '-a', id: 'sx',
      records: [
        at(assistantQuestion(), '2026-08-18T11:20:56.333Z'),
        { type: 'system', subtype: 'hook', timestamp: '2026-08-18T11:30:00.000Z' }
      ]
    }]);
    assert.strictEqual(scan.lastMessageMs(root, 'sx'), Date.parse('2026-08-18T11:20:56.333Z'));
  })) p++; else f++;

  if (test('lastMessageMs is null when no conversational record is stamped', () => {
    const root = makeRoot([{ dirName: '-a', id: 'sx', records: [assistantQuestion()] }]);
    assert.strictEqual(scan.lastMessageMs(root, 'sx'), null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
