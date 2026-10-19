/**
 * schedule-notify.ts — the seen ledger in front of `sendScheduleEvent`. Settings resolve from cwd and the state root from HOME, so every case runs in a tmpdir
 * pair with the ntfy transport swapped for a recorder; the owner lock is claimed for real under that HOME, never against the developer's own.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ScheduleRun } from '../shared/types.js';
import type { Config } from '../server/lib/config.js';
import { resetEnvBaseline } from '../server/lib/config.js';
import { resetNotify, setLabelResolver, setSender } from '../server/lib/notify.js';
import type { NotifyPayload } from '../server/lib/notify.js';
import { resetState } from '../server/lib/remoteState.js';
import { SEED_AGE_MS, notifyScheduleRuns, resetScheduleNotify, seedScheduleNotify } from '../server/lib/schedule-notify.js';
import { claimOwner, releaseOwner } from '../server/lib/schedule-store.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const made: string[] = [];

function conf(over: Partial<Config> = {}): Config {
  return {
    port: 4173, schedulesDir: '~/claude-global/schedules', scheduleMachine: 'mac', schedulesOwner: true, schedulesStateRoot: '',
    ntfyTopic: 'test-topic', ntfyServer: 'https://ntfy.example', publicUrl: 'https://dash.example', ...over
  } as Config;
}

function runOf(over: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run-1', job: 'nightly', machine: 'mac', trigger: 'schedule', startedAt: '2026-10-19T20:00:00.000Z', endedAt: '2026-10-19T20:01:00.000Z', ms: 60000,
    late: false, state: 'failed', ok: 1, failed: 2, skipped: 0, total: 3, stopped: false, error: null, why: null,
    steps: [{ index: 0, outcome: 'failed', why: 'exit 1' } as ScheduleRun['steps'][number]], ...over
  };
}

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
    resetSettings(); resetState(); resetNotify(); resetEnvBaseline(); resetScheduleNotify(); releaseOwner();
    setSender(p => { sent.push(p); });
    setLabelResolver(() => 'demo');
    setSettings({ notify: { enabled: true, events: { 'schedule-failed': true } } });
    if (owner) assert.strictEqual(claimOwner(conf()), 'owner');
    fn({ sent, state: path.join(home, '.claude', 'schedules') });
  } finally {
    releaseOwner();
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    resetNotify(); resetSettings(); resetState(); resetScheduleNotify();
  }
}

export function run(): number {
  console.log('\n=== schedule-notify.ts ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('a failed run pushes once, with the spec copy and a click to its fold', () => world(({ sent }) => {
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(
      { title: sent[0].title, body: sent[0].body, click: sent[0].click },
      { title: 'nightly · 2 of 3 failed', body: 'exit 1', click: 'https://dash.example/?view=schedules&run=run-1' }
    );
  }));

  t('the same run folded again sends nothing', () => world(({ sent }) => {
    notifyScheduleRuns(conf(), [runOf()]);
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf(), runOf({ id: 'run-ok', state: 'ok', failed: 0 })]), 0);
    assert.strictEqual(sent.length, 1);
  }));

  t('a restart (notified.json reloaded) does not resend, and a second run still does', () => world(({ sent, state }) => {
    notifyScheduleRuns(conf(), [runOf()]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(state, 'notified.json'), 'utf8')).ids, ['run-1']);
    resetScheduleNotify();
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 0);
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf(), runOf({ id: 'run-2' })]), 1);
    assert.strictEqual(sent.length, 2);
  }));

  t('a run pushed as lost that later ends failed does not push again', () => world(({ sent }) => {
    notifyScheduleRuns(conf(), [runOf({ state: 'lost', endedAt: null, ms: null, failed: 0, steps: [] })]);
    assert.strictEqual(sent[0].title, 'nightly · lost');
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 1);
  }));

  t('a run seen running is not marked, so its later failure still pushes', () => world(({ sent }) => {
    notifyScheduleRuns(conf(), [runOf({ state: 'running', endedAt: null, ms: null })]);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 1);
  }));

  t('a user-stopped run does not push, and is not pushed on a later fold either', () => world(({ sent }) => {
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf({ stopped: true })]), 0);
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf({ stopped: true })]), 0);
    assert.strictEqual(sent.length, 0);
  }));

  // Mirror of the stopped case: only `stopped` exempts, so a plain failure with the same shape goes out.
  t('refused, before-start and ok runs follow pushableEvents: the first two push, ok never does', () => world(({ sent }) => {
    notifyScheduleRuns(conf(), [
      runOf({ id: 'a', state: 'refused', why: 'disabled', steps: [], failed: 0 }),
      runOf({ id: 'b', error: 'ambiguous pin', steps: [], failed: 0, total: 0 }),
      runOf({ id: 'c', state: 'ok', failed: 0 })
    ]);
    assert.deepStrictEqual(sent.map(s => s.title), ['nightly · not run', 'nightly · failed before start']);
  }));

  t('a non-owner sends nothing and writes no notified.json, then sends once it owns', () => world(({ sent, state }) => {
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(fs.existsSync(path.join(state, 'notified.json')), false);
    assert.strictEqual(claimOwner(conf()), 'owner');
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 1);
  }, false));

  t('master off marks the run seen, so ticking the switch later does not replay it', () => world(({ sent }) => {
    setSettings({ notify: { enabled: false } });
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 0);
    setSettings({ notify: { enabled: true } });
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 0);
    assert.strictEqual(sent.length, 0);
  }));

  t('with requireAfk, requireRemoteAnswer and requireAutoMode all on the push still goes out', () => world(({ sent }) => {
    setSettings({ notify: { requireAfk: true, requireRemoteAnswer: true, requireAutoMode: true } });
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  t('a corrupt notified.json starts empty instead of throwing', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), '{nope');
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  const NOW = Date.parse('2026-10-20T12:00:00.000Z');
  const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();

  t('first-ever start: runs older than 24 h are seeded without a push, the newer one is pushed by the fold', () => world(({ sent, state }) => {
    const old = runOf({ id: 'old', startedAt: isoAgo(SEED_AGE_MS + 60_000) });
    const fresh = runOf({ id: 'fresh', startedAt: isoAgo(SEED_AGE_MS - 60_000) });
    assert.strictEqual(seedScheduleNotify(conf(), [old, fresh], NOW), 1);
    assert.strictEqual(sent.length, 0, 'seeding never pushes');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(state, 'notified.json'), 'utf8')).ids, ['old']);
    assert.strictEqual(notifyScheduleRuns(conf(), [old, fresh]), 1);
    assert.deepStrictEqual(sent.map(s => s.title), ['nightly · 2 of 3 failed']);
  }));

  t('a start with notified.json already present seeds nothing, so an old unseen failure still pushes', () => world(({ sent, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'notified.json'), JSON.stringify({ ids: [] }));
    assert.strictEqual(seedScheduleNotify(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })], NOW), 0);
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })]), 1);
    assert.strictEqual(sent.length, 1);
  }));

  t('seeding with nothing to seed still writes notified.json, so the next start is not a first one', () => world(({ state }) => {
    assert.strictEqual(seedScheduleNotify(conf(), [], NOW), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(state, 'notified.json'), 'utf8')).ids, []);
  }));

  t('a non-owner seeds nothing and writes no notified.json', () => world(({ state }) => {
    assert.strictEqual(seedScheduleNotify(conf(), [runOf({ id: 'old', startedAt: isoAgo(3 * SEED_AGE_MS) })], NOW), 0);
    assert.strictEqual(fs.existsSync(path.join(state, 'notified.json')), false);
  }, false));

  t('the send seam replaces the transport call and is what the count follows', () => world(({ sent }) => {
    const seen: string[] = [];
    assert.strictEqual(notifyScheduleRuns(conf(), [runOf()], (e) => { seen.push(e.run.id); return true; }), 1);
    assert.deepStrictEqual(seen, ['run-1']);
    assert.strictEqual(sent.length, 0);
  }));

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
