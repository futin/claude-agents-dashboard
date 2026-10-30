/**
 * `lib/handover.ts`: one poll of a desktop launch's hand-over watch, driven by hand (`stepHandOver`), never by its timer. The launch store holds a fake
 * child (`setSpawner`), the transcript is a tmpdir JSONL under a fixture HOME, and `open` is a recording runner (`overrideDesktop`).
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handOverInFlight, overrideDesktop, reserveDesktopLaunch, resetDesktopRail, DESKTOP_RAIL_MAX } from '../server/lib/desktop.js';
import { HANDOVER_MAX_MS, resetHandOvers, stepHandOver, type HandOverWatch } from '../server/lib/handover.js';
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

interface Fixture { home: string; opened: string[][]; children: FakeChild[]; reject: boolean }

async function test(name: string, fn: (f: Fixture) => Promise<void>): Promise<boolean> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-'));
  const prevHome = process.env.HOME;
  const f: Fixture = { home, opened: [], children: [], reject: false };
  process.env.HOME = home;
  resetLaunches(); resetDesktopRail(); resetHandOvers();
  setSpawner(() => { const c = new FakeChild(); f.children.push(c); return c as unknown as ChildProcess; });
  overrideDesktop({
    run: async (_cmd, args) => { f.opened.push(args.slice()); if (f.reject) throw new Error('LSOpenURLsWithRole() failed'); }
  });
  try { await fn(f); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    setSpawner(null); overrideDesktop({ run: null });
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
  }));

  check(await test('a child gone from the store without a finished turn (stopped, crashed) is given up', async f => {
    const w = { id: '11111111-1111-4111-8111-111111111111', startedAtMs: Date.now(), settledMtimeMs: null };
    write(f, w.id, [user, toolUse]);
    assert.equal(await stepHandOver(w), 'gave-up');
    assert.deepEqual(f.opened, []);
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
    assert.equal(await stepHandOver(w, w.startedAtMs + HANDOVER_MAX_MS + 1), 'gave-up');
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
  }));

  console.log(`\nhandover: ${ok}/${total} passed`);
  return total - ok;
}
