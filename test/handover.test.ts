/**
 * `lib/handover.ts`: a desktop launch's hand-over watch, one poll at a time: by hand (`stepHandOver`), or through the loop with a recording timer
 * (`overrideHandOverTimer`). The launch store holds a fake child (`setSpawner`), the transcript is a tmpdir JSONL under a fixture HOME, and `open` is a
 * recording runner (`overrideDesktop`).
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handOverInFlight, overrideDesktop, reserveDesktopLaunch, resetDesktopRail, DESKTOP_RAIL_MAX } from '../server/lib/desktop.js';
import {
  HANDOVER_MAX_MS, HANDOVER_POLL_MS, handOverFailedIds, markHandOverFailed, overrideHandOverTimer, resetHandOvers, stepHandOver, watchHandOver, watchedHandOvers,
  type HandOverWatch
} from '../server/lib/handover.js';
import { launch, resetLaunches, setSpawner } from '../server/lib/spawn.js';
import type { Config } from '../server/lib/config.js';
import type { ChildProcess } from 'node:child_process';

class FakeChild extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { write: (): boolean => true, end: (): void => undefined });
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(): boolean { return true; }
  unref(): this { return this; }
}

interface ArmedTimer { callback: () => void; ms: number }

interface Fixture { home: string; opened: string[][]; children: FakeChild[]; reject: boolean; armed: ArmedTimer[] }

async function test(name: string, fn: (f: Fixture) => Promise<void>): Promise<boolean> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  const prevHome = process.env.HOME;
  const f: Fixture = { home, opened: [], children: [], reject: false, armed: [] };
  process.env.HOME = home;
  resetLaunches(); resetDesktopRail(); resetHandOvers();
  setSpawner(() => { const c = new FakeChild(); f.children.push(c); return c as unknown as ChildProcess; });
  overrideDesktop({
    run: async (_cmd, args) => { f.opened.push(args.slice()); if (f.reject) throw new Error('LSOpenURLsWithRole() failed'); }
  });
  // `resetHandOvers` hands this to `clearTimeout`, which ignores a plain object.
  overrideHandOverTimer((callback, ms) => {
    f.armed.push({ callback, ms });
    return { unref(): void { /* nothing to hold open */ } } as unknown as ReturnType<typeof setTimeout>;
  });
  try { await fn(f); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    setSpawner(null); overrideDesktop({ run: null }); overrideHandOverTimer(null);
    resetLaunches(); resetDesktopRail(); resetHandOvers();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const CFG = { claudeBin: '/bin/echo', spawnMaxPermission: 'auto' } as Config;

/** A launch in the store, as `launchForDesktop` leaves it, and the watch it would start. */
function launched(f: Fixture): HandOverWatch {
  const id = launch(CFG, { dirName: '-p', name: 'p', path: f.home, lastActiveMs: 0 }, { prompt: 'go', permissionMode: 'auto', oneShot: true });
  return { id, startedAtMs: Date.now(), settledMtimeMs: null };
}

const user = { type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: 'go' } };
const toolUse = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } };
const endTurn = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };

/** Write the session's transcript (replacing it), each write ten seconds after the last, so a settle poll can tell two writes apart. */
let clock = 1_700_000_000;
function write(f: Fixture, id: string, records: object[]): void {
  const dir = path.join(f.home, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map(r => JSON.stringify({ cwd: f.home, timestamp: '2026-10-30T10:00:00.000Z', ...r })).join('\n') + '\n');
  clock += 10;
  fs.utimesSync(file, clock, clock);
}

/** One `setImmediate` turn: `open` runs through the fixture's async runner, so every promise a poll involves has settled by the end of it. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Fire the watch's one armed poll and let it finish. */
async function firePoll(f: Fixture): Promise<void> {
  assert.equal(f.armed.length, 1, 'exactly one timer is armed');
  const [timer] = f.armed.splice(0);
  assert.equal(timer.ms, HANDOVER_POLL_MS);
  timer.callback();
  await settle();
}

export async function run(): Promise<number> {
  console.log('\n=== handover (desktop launch: headless first turn, then claude://resume) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await test('waits while there is no transcript yet, and while the turn is still running', async f => {
    const w = launched(f);
    assert.equal(await stepHandOver(w), 'wait');
    write(f, w.id, [user, toolUse]);
    assert.equal(await stepHandOver(w), 'wait');
    write(f, w.id, [user]);
    assert.equal(await stepHandOver(w), 'wait');
    assert.deepEqual(f.opened, []);
  }));

  check(await test('a finished turn hands over on the second poll that sees it unchanged: one resume link, then the mark is held', async f => {
    const w = launched(f);
    write(f, w.id, [user, toolUse, endTurn]);
    assert.equal(await stepHandOver(w), 'wait', 'the first sighting only settles');
    assert.deepEqual(f.opened, []);
    assert.equal(await stepHandOver(w), 'handed-over');
    assert.deepEqual(f.opened, [[`claude://resume?session=${w.id}`]]);
    assert.equal(handOverInFlight(w.id), true, 'a drawer tap now reads as already resuming');
    assert.equal(handOverFailedIds().has(w.id), false);
  }));

  // #368: an API-error record reads as a finished turn on the board, but a `server_error` can be retried within the same turn 3-15 s later, past the settle poll.
  check(await test('an API-error record is never handed over: the retry it may precede would fork the transcript', async f => {
    const w = launched(f);
    write(f, w.id, [user, toolUse, { type: 'assistant', isApiErrorMessage: true, error: 'server_error',
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } }]);
    assert.equal(await stepHandOver(w), 'wait');
    assert.equal(await stepHandOver(w), 'wait');
    assert.deepEqual(f.opened, []);
  }));

  check(await test('a transcript that moves between the two polls settles again: a blocked Stop starting another turn is not handed over', async f => {
    const w = launched(f);
    write(f, w.id, [user, endTurn]);
    assert.equal(await stepHandOver(w), 'wait');
    write(f, w.id, [user, endTurn, user]);
    assert.equal(await stepHandOver(w), 'wait', 'the turn reopened');
    write(f, w.id, [user, endTurn, user, endTurn]);
    assert.equal(await stepHandOver(w), 'wait', 'a new end_turn settles from scratch');
    assert.equal(await stepHandOver(w), 'handed-over');
    assert.equal(f.opened.length, 1);
  }));

  check(await test('a launch that failed is given up, finished transcript or not', async f => {
    const w = launched(f);
    f.children[0].emit('exit', 1, null);
    write(f, w.id, [user, endTurn]);
    assert.equal(await stepHandOver(w), 'gave-up');
    assert.deepEqual(f.opened, []);
    assert.equal(handOverFailedIds().has(w.id), false, 'the failed launching row already says so');
  }));

  check(await test('a child gone from the store without a finished turn (stopped, crashed) is given up', async f => {
    const w = { id: '11111111-1111-4111-8111-111111111111', startedAtMs: Date.now(), settledMtimeMs: null };
    write(f, w.id, [user, toolUse]);
    assert.equal(await stepHandOver(w), 'gave-up');
    assert.deepEqual(f.opened, []);
    assert.equal(handOverFailedIds().has(w.id), false, 'no turn ended, so the promise never came due');
  }));

  check(await test('a child gone after finishing its turn is still handed over: the transcript, not the process, decides', async f => {
    const w = { id: '22222222-2222-4222-8222-222222222222', startedAtMs: Date.now(), settledMtimeMs: null };
    write(f, w.id, [user, endTurn]);
    assert.equal(await stepHandOver(w), 'wait');
    assert.equal(await stepHandOver(w), 'handed-over');
  }));

  check(await test('past HANDOVER_MAX_MS the watch gives up', async f => {
    const w = launched(f);
    write(f, w.id, [user, toolUse]);
    const prevError = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    try { assert.equal(await stepHandOver(w, w.startedAtMs + HANDOVER_MAX_MS + 1), 'gave-up'); } finally { console.error = prevError; }
    assert.equal(handOverFailedIds().has(w.id), true, 'a first turn outliving the watch is a failure to report');
    assert.equal(logged.length, 1, 'and the path logs, which it did not before');
  }));

  check(await test('a full rail waits for a slot rather than giving up', async f => {
    const w = launched(f);
    write(f, w.id, [user, endTurn]);
    await stepHandOver(w);
    const now = Date.now();
    for (let i = 0; i < DESKTOP_RAIL_MAX; i++) assert.equal(reserveDesktopLaunch(null, now).status, 'ok');
    assert.equal(await stepHandOver(w, now), 'wait');
    assert.deepEqual(f.opened, []);
    resetDesktopRail();
    assert.equal(await stepHandOver(w), 'handed-over');
  }));

  check(await test('a hand-over already in flight from the chat drawer ends the watch without a second link', async f => {
    const w = launched(f);
    write(f, w.id, [user, endTurn]);
    await stepHandOver(w);
    assert.equal(reserveDesktopLaunch(w.id).status, 'ok');
    assert.equal(await stepHandOver(w), 'gave-up');
    assert.deepEqual(f.opened, []);
    assert.equal(handOverFailedIds().has(w.id), false, 'the drawer got there first: nothing failed');
  }));

  check(await test('a failed `open` gives the mark back and ends the watch: the drawer can still hand it over', async f => {
    const w = launched(f);
    write(f, w.id, [user, endTurn]);
    await stepHandOver(w);
    f.reject = true;
    const prevError = console.error;
    console.error = () => undefined;
    try { assert.equal(await stepHandOver(w), 'gave-up'); } finally { console.error = prevError; }
    assert.equal(f.opened.length, 1);
    assert.equal(handOverInFlight(w.id), false);
    assert.equal(handOverFailedIds().has(w.id), true);
  }));

  check(await test('resetHandOvers empties the failed set', async () => {
    markHandOverFailed('33333333-3333-4333-8333-333333333333');
    assert.equal(handOverFailedIds().size, 1);
    resetHandOvers();
    assert.equal(handOverFailedIds().size, 0);
  }));

  check(await test('the watch re-polls a fresh launch through wait, wait, hand-over, then stops', async f => {
    const { id } = launched(f);
    watchHandOver(id);
    watchHandOver(id);
    assert.equal(f.armed.length, 1, 'a second watch of the same id arms nothing');
    assert.deepEqual(watchedHandOvers(), [id]);
    assert.deepEqual(f.opened, []);
    write(f, id, [user, toolUse]);
    await firePoll(f);
    assert.equal(f.armed.length, 1, 'the turn is still running');
    assert.deepEqual(f.opened, []);
    write(f, id, [user, endTurn]);
    await firePoll(f);
    assert.equal(f.armed.length, 1, 'the settle poll');
    assert.deepEqual(f.opened, []);
    await firePoll(f);
    assert.deepEqual(f.opened, [[`claude://resume?session=${id}`]]);
    assert.equal(f.armed.length, 0);
    assert.deepEqual(watchedHandOvers(), []);
  }));

  check(await test('a poll that gives up ends the watch', async f => {
    const { id } = launched(f);
    watchHandOver(id);
    f.children[0].emit('exit', 1, null);
    write(f, id, [user, endTurn]);
    await firePoll(f);
    assert.equal(f.armed.length, 0);
    assert.deepEqual(watchedHandOvers(), []);
    assert.deepEqual(f.opened, []);
  }));

  check(await test('a full rail keeps the watch polling until a slot frees', async f => {
    const { id } = launched(f);
    watchHandOver(id);
    write(f, id, [user, endTurn]);
    await firePoll(f);
    for (let i = 0; i < DESKTOP_RAIL_MAX; i++) assert.equal(reserveDesktopLaunch(null).status, 'ok');
    await firePoll(f);
    assert.equal(f.armed.length, 1, 'the rail is full, so it polls again');
    assert.deepEqual(f.opened, []);
    assert.deepEqual(watchedHandOvers(), [id]);
    resetDesktopRail();
    await firePoll(f);
    assert.deepEqual(f.opened, [[`claude://resume?session=${id}`]]);
    assert.equal(f.armed.length, 0);
  }));

  check(await test('a watch dropped while a poll is in flight does not come back', async f => {
    const { id } = launched(f);
    watchHandOver(id);
    const [timer] = f.armed.splice(0);
    // No transcript, so this poll answers `wait`; the drop lands before its promise settles.
    timer.callback();
    resetHandOvers();
    await settle();
    assert.equal(f.armed.length, 0);
    assert.deepEqual(watchedHandOvers(), []);
  }));

  console.log(`\nhandover: ${ok}/${total} passed`);
  return total - ok;
}
