import assert from 'node:assert';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import {
  STOP_GRACE_MS, adoptLaunched, launch, resetLaunches, setSpawner, stopSession, stopStates,
} from '../server/lib/spawn.js';
import type { Config } from '../server/lib/config.js';
import type { ProjectRef } from '../shared/types.js';

/**
 * The graceful-stop escalation against a **real** child, which `spawn.test.ts` cannot give: its runner is synchronous and its children are fakes, so it
 * drives `escalateStop` by hand-picked times and never lets the armed timer fire. That gap is how bug-28 stayed green — the timer's own callback re-read the
 * wall clock and vetoed itself whenever `Date.now()` ran ahead of the loop clock, and a SIGTERM-ignoring CLI then outlived every graceful Stop.
 *
 * The child traps SIGTERM, so only a SIGKILL ends it. The default group killer stays installed: the fake one records a call and cannot prove a kill.
 */

async function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const cfg = { claudeBin: 'bash', spawnMaxPermission: 'auto' } as Config;
const REF: ProjectRef = { dirName: 'enc-demo', name: 'demo-project', path: process.cwd(), lastActiveMs: Date.now() };

/** Time for bash to install its trap before any signal is sent — a SIGTERM that lands first would end the child and prove nothing. */
const TRAP_SETTLE_MS = 300;
/** How long past the grace a stopped child may take to die before the test calls the escalation lost. */
const DEATH_SLACK_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** A real `bash` that ignores SIGTERM, spawned exactly as `launch` asks (detached, so it leads its own group). */
function trappingSpawner(children: ChildProcess[]): void {
  setSpawner((_command, _args, options) => {
    const child = nodeSpawn('bash', ['-c', 'trap "" TERM; while :; do sleep 1; done'], options);
    children.push(child);
    return child;
  });
}

/** Launch one trapping child, adopt it to `running`, and wait for its trap. */
async function runningChild(children: ChildProcess[]): Promise<{ id: string; child: ChildProcess }> {
  const id = launch(cfg, REF, { prompt: 'x', permissionMode: 'auto' });
  assert.strictEqual(adoptLaunched([id]), 1);
  const child = children[children.length - 1];
  await sleep(TRAP_SETTLE_MS);
  assert.strictEqual(child.exitCode, null, 'the child must be alive before the stop');
  return { id, child };
}

/** Resolves true once `child` has exited, false if it is still alive after `ms`. */
function diesWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

/** Kill any survivor by the pid this test recorded — its own group, never a pattern. */
function reap(children: ChildProcess[]): void {
  for (const c of children) {
    if (c.pid && c.exitCode === null && c.signalCode === null) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

export async function run(): Promise<number> {
  let p = 0, f = 0;
  console.log('\n# spawn — graceful stop against a real SIGTERM-ignoring child');

  if (await test('the armed escalation SIGKILLs even when the wall clock read ahead of the timer at stop time', async () => {
    resetLaunches();
    const children: ChildProcess[] = [];
    trappingSpawner(children);
    try {
      const { id, child } = await runningChild(children);
      // 500 ms of skew models a wall-clock step (WSL2 resync) or an early timer: the timer fires on the loop clock, and a callback that re-reads
      // `Date.now()` then sees less than STOP_GRACE_MS elapsed and refuses.
      assert.strictEqual(stopSession(id, Date.now() + 500), 'stopping');
      assert.ok(await diesWithin(child, STOP_GRACE_MS + DEATH_SLACK_MS), 'the escalation was vetoed and the child outlived the grace');
    } finally { reap(children); setSpawner(null); resetLaunches(); }
  })) p++; else f++;

  if (await test('an ordinary graceful stop SIGKILLs a child that ignores SIGTERM once the grace elapses', async () => {
    resetLaunches();
    const children: ChildProcess[] = [];
    trappingSpawner(children);
    try {
      const { id, child } = await runningChild(children);
      assert.strictEqual(stopSession(id), 'stopping');
      assert.ok(await diesWithin(child, STOP_GRACE_MS + DEATH_SLACK_MS), 'the child outlived the grace');
    } finally { reap(children); setSpawner(null); resetLaunches(); }
  })) p++; else f++;

  if (await test('stopStates inside the grace sends no SIGKILL', async () => {
    resetLaunches();
    const children: ChildProcess[] = [];
    trappingSpawner(children);
    try {
      const { id, child } = await runningChild(children);
      assert.strictEqual(stopSession(id), 'stopping');
      assert.strictEqual(stopStates().get(id), 'stopping');
      assert.strictEqual(await diesWithin(child, 500), false, 'a poll inside the grace must not kill');
      assert.strictEqual(stopStates().get(id), 'stopping');
    } finally { reap(children); setSpawner(null); resetLaunches(); }
  })) p++; else f++;

  if (await test('stopStates finishes a stop whose grace has passed, without waiting for the armed timer', async () => {
    resetLaunches();
    const children: ChildProcess[] = [];
    trappingSpawner(children);
    try {
      const { id, child } = await runningChild(children);
      // Requested a full grace ago: the armed timer is still ~5 s out, so a death inside DEATH_SLACK_MS can only be the poll's backstop.
      assert.strictEqual(stopSession(id, Date.now() - STOP_GRACE_MS), 'stopping');
      stopStates();
      assert.ok(await diesWithin(child, DEATH_SLACK_MS), 'the backstop did not escalate a stop past its grace');
      assert.strictEqual(stopStates().has(id), false, 'a reaped session is no longer stoppable');
    } finally { reap(children); setSpawner(null); resetLaunches(); }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
