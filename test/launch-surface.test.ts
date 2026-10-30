/** `client/src/lib/launchSurface.ts`: which surfaces the launch form offers, which one starts picked, and the desktop copy it shows. */

import assert from 'node:assert';

import {
  DESKTOP_FAILED_TEXT, DESKTOP_HANDOVER_NOTE, DESKTOP_LAUNCHED_TEXT, DESKTOP_OPENED_TEXT, canOpenLaunchForm, initialSurface, offeredSurfaces
} from '../client/src/lib/launchSurface.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== launch surface (offered surfaces, preselect, copy) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('offeredSurfaces lists dashboard before desktop', () => {
    assert.deepEqual(offeredSurfaces(true, true), ['dashboard', 'desktop']);
  }));
  check(test('offeredSurfaces drops the surface the host cannot serve', () => {
    assert.deepEqual(offeredSurfaces(true, undefined), ['dashboard']);
    assert.deepEqual(offeredSurfaces(undefined, undefined), []);
  }));
  check(test('offeredSurfaces offers desktop only with the headless launch too: its first turn runs here', () => {
    assert.deepEqual(offeredSurfaces(false, true), []);
    assert.deepEqual(offeredSurfaces(undefined, true), []);
  }));
  check(test('offeredSurfaces needs a strict true: a truthy non-boolean offers nothing', () => {
    assert.deepEqual(offeredSurfaces(1 as unknown as boolean, 'yes' as unknown as boolean), []);
  }));

  check(test('initialSurface takes the preferred one when it is offered', () => {
    assert.equal(initialSurface(['dashboard', 'desktop'], 'desktop'), 'desktop');
    assert.equal(initialSurface(['dashboard', 'desktop'], 'dashboard'), 'dashboard');
  }));
  check(test('initialSurface falls back to the first offered when the preference is not offered or absent', () => {
    assert.equal(initialSurface(['dashboard'], 'desktop'), 'dashboard');
    assert.equal(initialSurface(['desktop'], 'dashboard'), 'desktop');
    assert.equal(initialSurface(['dashboard', 'desktop'], undefined), 'dashboard');
  }));
  check(test('initialSurface is null when nothing is offered', () => {
    assert.equal(initialSurface([], 'dashboard'), null);
  }));

  check(test('canOpenLaunchForm follows the headless launch: the desktop app alone opens nothing', () => {
    assert.equal(canOpenLaunchForm(false, true), false);
    assert.equal(canOpenLaunchForm(true, false), true);
    assert.equal(canOpenLaunchForm(true, true), true);
    assert.equal(canOpenLaunchForm(false, false), false);
    assert.equal(canOpenLaunchForm(undefined, undefined), false);
  }));

  check(test('the desktop copy is the spec string, byte for byte', () => {
    assert.equal(DESKTOP_LAUNCHED_TEXT, 'Running here first — it moves to the desktop app when its first turn ends.');
    assert.equal(DESKTOP_OPENED_TEXT, 'Opened in the desktop app.');
    assert.equal(DESKTOP_FAILED_TEXT, "Couldn't open the desktop app.");
    assert.equal(DESKTOP_HANDOVER_NOTE, 'The first turn runs here, then the session moves to the desktop app.');
  }));

  console.log(`\nlaunch surface: ${ok}/${total} passed`);
  return total - ok;
}
