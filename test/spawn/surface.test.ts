import assert from 'node:assert';

import { DESKTOP_HANDOVER_FAILED_TEXT } from '../../client/src/lib/launchSurface.js';
import { surfacePill } from '../../client/src/lib/surface.js';
import { sessionSurface } from '../../server/lib/scan.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== surface.ts ===\n');
  let p = 0, f = 0;

  if (test('surfacePill: local is silent, the other two speak', () => {
    assert.strictEqual(surfacePill({ surface: 'local' }), null);
    assert.strictEqual(surfacePill({ surface: 'local', desktopOwned: true }), null);
    assert.strictEqual(surfacePill({ surface: 'dashboard' })!.label, 'dashboard');
    assert.strictEqual(surfacePill({ surface: 'cloud' })!.label, 'cloud');
  })) p++; else f++;

  if (test('surfacePill: every pill carries a title — it is the whole point', () => {
    // The label is four syllables; the tooltip is what actually answers "why is
    // this session not in my desktop app?". A pill without one is a worse
    // version of no pill.
    for (const s of ['dashboard', 'cloud'] as const) {
      const pill = surfacePill({ surface: s })!;
      assert.ok(pill.title.length > 20, `${s} title too thin: ${pill.title}`);
    }
    // The dashboard tooltip must name the way back in, since that is the
    // question the pill provokes.
    assert.ok(surfacePill({ surface: 'dashboard' })!.title.includes('--resume'));
  })) p++; else f++;

  if (test('surfacePill: a desktop-owned dashboard row is silent, a plain one still speaks', () => {
    // Imported into the desktop app, not yet continued there: the transcript still reads `dashboard`, so the row keeps that surface (the drawer's
    // hand-over reads `owned` off it), but the pill's claim — no other list has this session — is false once the app's sidebar lists it.
    assert.strictEqual(surfacePill({ surface: 'dashboard', desktopOwned: true }), null);
    assert.strictEqual(surfacePill({ surface: 'dashboard' })!.label, 'dashboard');
  })) p++; else f++;

  if (test('surfacePill: a failed hand-over relabels the dashboard pill and names the retry; desktopOwned still wins', () => {
    const pill = surfacePill({ surface: 'dashboard', handOverFailed: true })!;
    assert.strictEqual(pill.label, 'hand-over failed');
    assert.ok(pill.title.startsWith(DESKTOP_HANDOVER_FAILED_TEXT));
    assert.ok(pill.title.includes('Open in desktop app'));
    assert.strictEqual(surfacePill({ surface: 'dashboard', handOverFailed: true, desktopOwned: true }), null);
    assert.strictEqual(surfacePill({ surface: 'dashboard' })!.label, 'dashboard');
  })) p++; else f++;

  if (test('surfacePill covers every value the server can produce', () => {
    // The producer and this renderer are the two halves of the enum. A value
    // added to `sessionSurface` without a case here would render nothing at all
    // — the same silence `local` uses to mean "nothing to say".
    assert.strictEqual(surfacePill({ surface: sessionSurface('sdk-cli') })!.label, 'dashboard');
    assert.strictEqual(surfacePill({ surface: sessionSurface('cli') }), null);
    assert.strictEqual(surfacePill({ surface: sessionSurface(null) }), null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
