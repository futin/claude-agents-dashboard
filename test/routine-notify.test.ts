/**
 * routine-notify.ts — the seen ledger in front of `sendRoutineEvent`. Settings resolve from cwd and the state root from HOME, so every case runs in a tmpdir
 * pair with the ntfy transport swapped for a recorder; the owner lock is claimed for real under that HOME, never against the developer's own.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RoutineRun } from '../shared/types.js';
import type { Config } from '../server/lib/config.js';
import { resetEnvBaseline } from '../server/lib/config.js';
import { resetNotify, setLabelResolver, setSender } from '../server/lib/notify.js';
import type { NotifyPayload } from '../server/lib/notify.js';
import { resetState } from '../server/lib/remoteState.js';
import { PUSH_HORIZON_MS, SEED_AGE_MS, notifyRoutineRuns, resetRoutineNotify, seedRoutineNotify } from '../server/lib/routine-notify.js';
import { claimOwner, releaseOwner } from '../server/lib/routine-store.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const made: string[] = [];

function conf(over: Partial<Config> = {}): Config {
  return {
    port: 4173, routinesDir: '~/claude-global/routines', routineMachine: 'mac', routinesOwner: true, routinesStateRoot: '',
    ntfyTopic: 'test-topic', ntfyServer: 'https://ntfy.example', publicUrl: 'https://dash.example', ...over
  } as Config;
}

const NOW = Date.now();
const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();
const DAY = 24 * 3600_000;

/** Times default to an hour ago, so a case stays inside the push horizon whatever day it runs; a given `startedAt` ends a minute later. */
function runOf(over: Partial<RoutineRun> = {}): RoutineRun {
  const startedAt = over.startedAt ?? isoAgo(3600_000);
  return {
    id: 'run-1', job: 'nightly', machine: 'mac', trigger: 'schedule', startedAt, endedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(), ms: 60000,
    late: false, state: 'failed', ok: 1, failed: 2, skipped: 0, total: 3, stopped: false, error: null, why: null,
    steps: [{ index: 0, outcome: 'failed', why: 'exit 1' } as RoutineRun['steps'][number]], ...over
  };
}

const ledgerOf = (state: string): { seen: Record<string, number>; floor?: number } => JSON.parse(fs.readFileSync(path.join(state, 'notified.json'), 'utf8'));

/** A tmp cwd (settings) and HOME (state root), the transport recorded, push switched on. `owner: false` leaves the lock unclaimed. */
function world(fn: (ctx: { sent: NotifyPayload[]; state: string }) => void, owner = true): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-notify-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-notify-home-'));
  made.push(cwd, home);
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const sent: NotifyPayload[] = [];
  try {
    process.chdir(cwd);
    process.env.HOME = home;
    resetSettings(); resetState(); resetNotify(); resetEnvBaseline(); resetRoutineNotify(); releaseOwner();
    setSender(p => { sent.push(p); });
    setLabelResolver(() => 'demo');
    setSettings({ notify: { enabled: true, events: { 'routine-failed': true } } });
    if (owner) assert.strictEqual(claimOwner(conf()), 'owner');
    fn({ sent, state: path.join(home, '.claude', 'routines') });
  } finally {
    releaseOwner();
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    resetNotify(); resetSettings(); resetState(); resetRoutineNotify();
  }
}

export function run(): number {
  console.log('\n=== routine-notify.ts ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('a failed run pushes once, with the spec copy and a click to its fold', () => world(({ sent }) => {
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(
      { title: sent[0].title, body: sent[0].body, click: sent[0].click },
      { title: 'nightly · 2 of 3 failed', body: 'exit 1', click: 'https://dash.example/?view=routines&run=run-1' }
    );
  }));

  t('the same run folded again sends nothing', () => world(({ sent }) => {
    notifyRoutineRuns(conf(), [runOf()]);
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf(), runOf({ id: 'run-ok', state: 'ok', failed: 0 })]), 0);
    assert.strictEqual(sent.length, 1);
  }));

  t('a restart (notified.json reloaded) does not resend, and a second run still does', () => world(({ sent, state }) => {
    notifyRoutineRuns(conf(), [runOf()]);
    assert.deepStrictEqual(Object.keys(ledgerOf(state).seen), ['run-1']);
    resetRoutineNotify();
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 0);
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf(), runOf({ id: 'run-2' })]), 1);
    assert.strictEqual(sent.length, 2);
  }));

  t('a run pushed as lost that later ends failed does not push again', () => world(({ sent }) => {
    notifyRoutineRuns(conf(), [runOf({ state: 'lost', endedAt: null, ms: null, failed: 0, steps: [] })]);
    assert.strictEqual(sent[0].title, 'nightly · lost');
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 1);
  }));

  t('a run seen running is not marked, so its later failure still pushes', () => world(({ sent }) => {
    notifyRoutineRuns(conf(), [runOf({ state: 'running', endedAt: null, ms: null })]);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 1);
  }));

  t('a user-stopped run does not push, and is not pushed on a later fold either', () => world(({ sent }) => {
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf({ stopped: true })]), 0);
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf({ stopped: true })]), 0);
    assert.strictEqual(sent.length, 0);
  }));

  // Mirror of the stopped case: only `stopped` exempts, so a plain failure with the same shape goes out.
  t('refused, before-start and ok runs follow pushableEvents: the first two push, ok never does', () => world(({ sent }) => {
    notifyRoutineRuns(conf(), [
      runOf({ id: 'a', state: 'refused', why: 'disabled', steps: [], failed: 0 }),
      runOf({ id: 'b', error: 'ambiguous pin', steps: [], failed: 0, total: 0 }),
      runOf({ id: 'c', state: 'ok', failed: 0 })
    ]);
    assert.deepStrictEqual(sent.map(s => s.title), ['nightly · not run', 'nightly · failed before start']);
  }));

  t('a non-owner sends nothing and writes no notified.json, then sends once it owns', () => world(({ sent, state }) => {
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(fs.existsSync(path.join(state, 'notified.json')), false);
    assert.strictEqual(claimOwner(conf()), 'owner');
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 1);
  }, false));

  t('master off marks the run seen, so ticking the switch later does not replay it', () => world(({ sent }) => {
    setSettings({ notify: { enabled: false } });
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 0);
    setSettings({ notify: { enabled: true } });
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 0);
  }));

  t('with requireAfk, requireRemoteAnswer and requireAutoMode all on the push still goes out', () => world(({ sent }) => {
    setSettings({ notify: { requireAfk: true, requireRemoteAnswer: true, requireAutoMode: true } });
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  t('a corrupt notified.json starts empty instead of throwing', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), '{nope');
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  t('first-ever start: runs older than 24 h are seeded without a push, the newer one is pushed by the fold', () => world(({ sent, state }) => {
    const old = runOf({ id: 'old', startedAt: isoAgo(SEED_AGE_MS + 60_000) });
    const fresh = runOf({ id: 'fresh', startedAt: isoAgo(SEED_AGE_MS - 60_000) });
    assert.strictEqual(seedRoutineNotify(conf(), [old, fresh], NOW), 1);
    assert.strictEqual(sent.length, 0, 'seeding never pushes');
    assert.deepStrictEqual(Object.keys(ledgerOf(state).seen), ['old']);
    assert.strictEqual(notifyRoutineRuns(conf(), [old, fresh]), 1);
    assert.deepStrictEqual(sent.map(s => s.title), ['nightly · 2 of 3 failed']);
  }));

  t('a start with notified.json already present seeds nothing, so an old unseen failure still pushes', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ ids: [] }));
    assert.strictEqual(seedRoutineNotify(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })], NOW), 0);
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  t('seeding with nothing to seed still writes notified.json, so the next start is not a first one', () => world(({ state }) => {
    assert.strictEqual(seedRoutineNotify(conf(), [], NOW), 0);
    assert.deepStrictEqual(ledgerOf(state), { seen: {} });
  }));

  t('a non-owner seeds nothing and writes no notified.json', () => world(({ state }) => {
    assert.strictEqual(seedRoutineNotify(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })], NOW), 0);
    assert.strictEqual(fs.existsSync(path.join(state, 'notified.json')), false);
  }, false));

  // The fold has no window (rotation keeps every log file), so dedupe must not depend on how many ids the ledger can hold.
  t('2100 failed runs older than the horizon plus 3 inside it: 3 pushes, then a restart on the same notified.json pushes 0', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ seen: {} }));
    const old = Array.from({ length: 2100 }, (_, i) => runOf({ id: `old-${i}`, startedAt: isoAgo(PUSH_HORIZON_MS + DAY + i * 60_000) }));
    const fresh = [1, 2, 3].map((i) => runOf({ id: `fresh-${i}`, startedAt: isoAgo(i * DAY) }));
    assert.strictEqual(notifyRoutineRuns(conf(), [...old, ...fresh], undefined, NOW), 3);
    assert.deepStrictEqual(Object.keys(ledgerOf(state).seen).sort(), ['fresh-1', 'fresh-2', 'fresh-3']);
    resetRoutineNotify();
    assert.strictEqual(notifyRoutineRuns(conf(), [...old, ...fresh], undefined, NOW), 0);
    assert.strictEqual(sent.length, 3);
  }));

  t('2100 failed runs all inside the horizon: 2100 pushes, then a restart pushes 0 although the backstop dropped 100 ids', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ seen: {} }));
    const runs = Array.from({ length: 2100 }, (_, i) => runOf({ id: `r-${i}`, startedAt: isoAgo(DAY + i * 60_000) }));
    let n = 0;
    const count = (): boolean => { n++; return true; };
    assert.strictEqual(notifyRoutineRuns(conf(), runs, count, NOW), 2100);
    resetRoutineNotify();
    assert.strictEqual(notifyRoutineRuns(conf(), runs, count, NOW), 0);
    assert.strictEqual(n, 2100);
    assert.strictEqual(Object.keys(ledgerOf(state).seen).length, 2000);
    assert.strictEqual(sent.length, 0);
  }));

  t('a new failure inside the horizon still pushes once, across a restart', () => world(({ sent }) => {
    notifyRoutineRuns(conf(), [runOf({ id: 'a', startedAt: isoAgo(2 * DAY) })], undefined, NOW);
    const next = runOf({ id: 'b', startedAt: isoAgo(PUSH_HORIZON_MS - DAY) });
    assert.strictEqual(notifyRoutineRuns(conf(), [next], undefined, NOW), 1);
    resetRoutineNotify();
    assert.strictEqual(notifyRoutineRuns(conf(), [next], undefined, NOW), 0);
    assert.strictEqual(sent.length, 2);
  }));

  t('a seen id is pruned once its run passes the horizon, and the run never pushes again', () => world(({ sent, state }) => {
    const r = runOf({ id: 'aging', startedAt: isoAgo(DAY) });
    assert.strictEqual(notifyRoutineRuns(conf(), [r], undefined, NOW), 1);
    const later = NOW + PUSH_HORIZON_MS;
    assert.strictEqual(notifyRoutineRuns(conf(), [r, runOf({ id: 'new', startedAt: new Date(later - 3600_000).toISOString() })], undefined, later), 1);
    assert.deepStrictEqual(Object.keys(ledgerOf(state).seen), ['new']);
    resetRoutineNotify();
    assert.strictEqual(notifyRoutineRuns(conf(), [r], undefined, later), 0);
    assert.strictEqual(sent.length, 2);
  }));

  t('the legacy {ids: [...]} file migrates: its ids stay seen, the next write is the stamped shape', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ ids: ['run-1'] }));
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf(), runOf({ id: 'run-2' })], undefined, NOW), 1);
    assert.deepStrictEqual(sent.length, 1);
    const l = ledgerOf(state);
    assert.deepStrictEqual(Object.keys(l.seen).sort(), ['run-1', 'run-2']);
    assert.strictEqual(l.seen['run-1'], NOW, 'a migrated id is stamped with the load time');
    assert.strictEqual('ids' in l, false);
  }));

  t('a bare-array notified.json migrates too, without throwing', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify(['run-1', 7]));
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()], undefined, NOW), 0);
    assert.strictEqual(sent.length, 0);
  }));

  t('first-ever start seeds only inside the horizon: a run older than it is neither seeded nor pushed', () => world(({ sent, state }) => {
    const ancient = runOf({ id: 'ancient', startedAt: isoAgo(PUSH_HORIZON_MS + DAY) });
    const old = runOf({ id: 'old', startedAt: isoAgo(2 * DAY) });
    assert.strictEqual(seedRoutineNotify(conf(), [ancient, old], NOW), 1);
    assert.deepStrictEqual(Object.keys(ledgerOf(state).seen), ['old']);
    assert.strictEqual(notifyRoutineRuns(conf(), [ancient, old], undefined, NOW), 0);
    assert.strictEqual(sent.length, 0);
  }));

  t('the send seam replaces the transport call and is what the count follows', () => world(({ sent }) => {
    const seen: string[] = [];
    assert.strictEqual(notifyRoutineRuns(conf(), [runOf()], (e) => { seen.push(e.run.id); return true; }), 1);
    assert.deepStrictEqual(seen, ['run-1']);
    assert.strictEqual(sent.length, 0);
  }));

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
