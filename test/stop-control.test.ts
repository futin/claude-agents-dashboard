import assert from 'node:assert';

import { stopControl } from '../client/src/lib/stopControl.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== stopControl.ts ===\n');
  let p = 0, f = 0;

  if (test('no stopState renders nothing — the post-restart orphan case', () => {
    // The server holds no handle for the session, so a button could only fail.
    // Absent, not false: see `Session.stopState`.
    assert.deepStrictEqual(stopControl(undefined, false), { render: false });
    // And an armed confirm from a previous poll cannot conjure one back.
    assert.deepStrictEqual(stopControl(undefined, true), { render: false });
  })) p++; else f++;

  if (test('ready, not confirming: the primary label only arms, and sends nothing', () => {
    const view = stopControl('ready', false);
    assert.strictEqual(view.render, true);
    if (!view.render) return;
    assert.strictEqual(view.label, 'stop session');
    assert.strictEqual(view.arms, true);
    assert.strictEqual(view.cancel, false);
    assert.strictEqual(view.badge, null);
  })) p++; else f++;

  if (test('ready, confirming: the confirm pair, sending the NON-force stop', () => {
    const view = stopControl('ready', true);
    assert.strictEqual(view.render, true);
    if (!view.render) return;
    assert.strictEqual(view.label, 'really stop?');
    assert.strictEqual(view.arms, false, 'the second tap must actually send');
    assert.strictEqual(view.cancel, true, 'a destructive confirm needs a way out');
    // The graceful path in both ready states — force is never reachable from here.
    assert.strictEqual(view.force, false);
  })) p++; else f++;

  if (test('stopping: a visible badge plus force, with no confirm step reachable', () => {
    for (const confirming of [false, true]) {
      const view = stopControl('stopping', confirming);
      assert.strictEqual(view.render, true);
      if (!view.render) return;
      // Real text, because a `title` attribute never appears on touch — and the
      // phone is the surface this control exists for.
      assert.strictEqual(view.badge, 'stopping…');
      assert.strictEqual(view.label, 'force stop');
      assert.strictEqual(view.force, true);
      assert.strictEqual(view.arms, false);
      // `confirming` is ignored here on purpose: the graceful stop was already
      // confirmed and sent, so a stale flag must not resurrect an arming step.
      assert.strictEqual(view.cancel, false, `confirming=${confirming} must not reach the confirm pair`);
    }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
