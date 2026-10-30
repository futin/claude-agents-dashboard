/**
 * `lib/desktop.ts`: the `claude://` links, the availability probe, the `open` runner and the two launch gates (the rail and the per-session hand-over marks).
 * `open` never runs here — every case that reaches the runner installs a recording one — and each case restores the seams it moved.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DESKTOP_RAIL_MAX, DESKTOP_WINDOW_MS, desktopAvailable, handOverInFlight, openDesktopUrl, overrideDesktop, releaseDesktopLaunch,
  reserveDesktopLaunch, resetDesktopProbe, resetDesktopRail, resumeUrl
} from '../server/lib/desktop.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  resetDesktopRail();
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally { overrideDesktop({ run: null, platform: null, appPath: null }); resetDesktopProbe(); resetDesktopRail(); }
}

export async function run(): Promise<number> {
  console.log('\n=== desktop (claude:// links, probe, open, rail, marks) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-test-'));

  check(await test('resumeUrl carries the session id', () => {
    assert.equal(resumeUrl('48716273-aaaa'), 'claude://resume?session=48716273-aaaa');
  }));

  check(await test('probe: needs darwin and an app path that stats', () => {
    overrideDesktop({ platform: 'linux', appPath: tmp });
    assert.equal(desktopAvailable(), false);
    overrideDesktop({ platform: 'darwin', appPath: path.join(tmp, 'missing.app') });
    assert.equal(desktopAvailable(), false);
    overrideDesktop({ platform: 'darwin', appPath: tmp });
    assert.equal(desktopAvailable(), true);
  }));

  check(await test('probe is memoised until an override or reset drops it', () => {
    const app = path.join(tmp, 'Memo.app');
    overrideDesktop({ platform: 'darwin', appPath: app });
    assert.equal(desktopAvailable(), false);
    fs.mkdirSync(app);
    assert.equal(desktopAvailable(), false, 'cached');
    resetDesktopProbe();
    assert.equal(desktopAvailable(), true);
  }));

  check(await test('openDesktopUrl runs `open <url>` and nothing else', async () => {
    const calls: Array<[string, string[]]> = [];
    overrideDesktop({ run: async (cmd, args) => { calls.push([cmd, args]); } });
    await openDesktopUrl('claude://resume?session=x');
    assert.deepEqual(calls, [['open', ['claude://resume?session=x']]]);
  }));

  check(await test('openDesktopUrl rejects when the runner does', async () => {
    overrideDesktop({ run: async () => { throw new Error('exit 1'); } });
    await assert.rejects(openDesktopUrl('claude://resume?session=x'), /exit 1/);
  }));

  check(await test('constants are the spec values', () => {
    assert.equal(DESKTOP_RAIL_MAX, 4);
    assert.equal(DESKTOP_WINDOW_MS, 5000);
  }));

  check(await test('rail: four fit, the fifth is full, the window expires', () => {
    assert.deepEqual(reserveDesktopLaunch(null, 1000), { status: 'ok', at: 1000 });
    for (let i = 0; i < 3; i++) assert.equal(reserveDesktopLaunch(null, 1000).status, 'ok');
    assert.equal(reserveDesktopLaunch(null, 1000).status, 'rail-full');
    assert.equal(reserveDesktopLaunch(null, 1000 + 5001).status, 'ok');
  }));

  check(await test('marks: a live mark answers in-flight, then expires', () => {
    assert.equal(reserveDesktopLaunch('s1', 0).status, 'ok');
    assert.equal(reserveDesktopLaunch('s1', 10).status, 'in-flight');
    assert.equal(handOverInFlight('s1', 10), true);
    assert.equal(handOverInFlight('s1', 5001), false);
  }));

  check(await test('release frees the mark so a new reserve fits', () => {
    const r = reserveDesktopLaunch('s1', 0);
    assert.equal(r.status, 'ok');
    releaseDesktopLaunch('s1', 0);
    assert.equal(handOverInFlight('s1', 1), false);
    assert.equal(reserveDesktopLaunch('s1', 1).status, 'ok');
  }));

  check(await test('release clears only its own entry', () => {
    // The released entry sits after the one that must survive, so a release that matched on `at` alone would take the wrong one.
    reserveDesktopLaunch('s2', 0);
    reserveDesktopLaunch('s1', 0);
    releaseDesktopLaunch('s1', 0);
    assert.equal(handOverInFlight('s2', 1), true);
    assert.equal(handOverInFlight('s1', 1), false);
    resetDesktopRail();
    reserveDesktopLaunch('s3', 0);
    reserveDesktopLaunch(null, 0);
    releaseDesktopLaunch(null, 0);
    assert.equal(handOverInFlight('s3', 1), true);
    resetDesktopRail();
    for (let i = 0; i < 4; i++) assert.equal(reserveDesktopLaunch(null, 0).status, 'ok');
    releaseDesktopLaunch(null, 0);
    assert.equal(reserveDesktopLaunch(null, 0).status, 'ok');
    assert.equal(reserveDesktopLaunch(null, 0).status, 'rail-full');
  }));

  check(await test('in-flight beats rail-full', () => {
    for (let i = 0; i < 3; i++) reserveDesktopLaunch(null, 0);
    assert.equal(reserveDesktopLaunch('s1', 0).status, 'ok');
    assert.equal(reserveDesktopLaunch('s1', 1).status, 'in-flight');
  }));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ndesktop: ${ok}/${total} passed`);
  return total - ok;
}
