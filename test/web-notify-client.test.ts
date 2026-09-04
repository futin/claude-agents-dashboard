import assert from 'node:assert';

import {
  fireTestNotification, requestWebNotifyPermission, webNotifyPermission, webNotifySupported
} from '../client/src/hooks/useWebNotify.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Records what a stubbed `new Notification(...)` was called with. */
interface Call { title: string; options: NotificationOptions; }

/**
 * Node has neither `window` nor `Notification` — both engine globals
 * `useWebNotify.ts` reads directly, so every case must stub them rather than
 * rely on jsdom. `window` is set with no `AudioContext` on it so the audio
 * half of `fireTestNotification` always resolves 'unsupported' without a real
 * AudioContext implementation; only the Notification half varies per case.
 */
async function withGlobals<T>(
  permission: NotificationPermission | undefined,
  calls: Call[],
  fn: () => T | Promise<T>,
  opts: { throwOnConstruct?: boolean } = {}
): Promise<T> {
  const g = global as unknown as { window?: unknown; Notification?: unknown };
  const prevWindow = g.window;
  const prevNotification = g.Notification;
  g.window = {};
  if (permission === undefined) {
    delete g.Notification;
  } else {
    function StubNotification(title: string, options: NotificationOptions) {
      if (opts.throwOnConstruct) throw new Error('no service worker');
      calls.push({ title, options });
    }
    StubNotification.permission = permission;
    StubNotification.requestPermission = async () => 'granted' as NotificationPermission;
    g.Notification = StubNotification;
  }
  try {
    // Awaited here, not just returned: the caller must not restore the
    // globals above until every `await` inside `fn` has actually resumed and
    // finished reading them — a bare `return fn()` lets `finally` run the
    // moment `fn` first suspends, wiping Notification/window mid-flight.
    return await fn();
  } finally {
    g.window = prevWindow;
    g.Notification = prevNotification;
  }
}

export async function run(): Promise<number> {
  console.log('\n=== useWebNotify.ts (client) ===\n');
  let p = 0, f = 0;

  if (await test('unsupported when there is no Notification API at all', () => withGlobals(undefined, [], () => {
    assert.strictEqual(webNotifySupported(), false);
    assert.strictEqual(webNotifyPermission(), 'unsupported');
  }))) p++; else f++;

  if (await test('requestWebNotifyPermission reports denied when the API is missing', () =>
    withGlobals(undefined, [], async () => {
      assert.strictEqual(await requestWebNotifyPermission(), 'denied');
    }))) p++; else f++;

  if (await test('requestWebNotifyPermission short-circuits once a real answer is on record', () =>
    withGlobals('denied', [], async () => {
      assert.strictEqual(await requestWebNotifyPermission(), 'denied');
    }))) p++; else f++;

  if (await test('requestWebNotifyPermission asks the engine when still undecided', () =>
    withGlobals('default', [], async () => {
      assert.strictEqual(await requestWebNotifyPermission(), 'granted');
    }))) p++; else f++;

  if (await test('fireTestNotification explains a missing API, audio included', () =>
    withGlobals(undefined, [], async () => {
      const outcome = await fireTestNotification();
      assert.match(outcome, /no Notification API in this browser/);
      assert.match(outcome, /no audio support/);
    }))) p++; else f++;

  if (await test('fireTestNotification explains a blocked permission', () =>
    withGlobals('denied', [], async () => {
      const outcome = await fireTestNotification();
      assert.match(outcome, /blocked for this site/);
    }))) p++; else f++;

  if (await test('fireTestNotification explains an undecided permission', () =>
    withGlobals('default', [], async () => {
      const outcome = await fireTestNotification();
      assert.match(outcome, /never granted/);
    }))) p++; else f++;

  if (await test('fireTestNotification constructs a real banner when granted', () => {
    const calls: Call[] = [];
    return withGlobals('granted', calls, async () => {
      const outcome = await fireTestNotification();
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].title, 'Claude Sessions');
      assert.strictEqual(calls[0].options.tag, 'web-notify-test');
      assert.strictEqual(calls[0].options.silent, true);
      assert.match(outcome, /notification sent/);
    });
  })) p++; else f++;

  if (await test('a constructor that throws is reported, not crashed on', () => {
    const calls: Call[] = [];
    return withGlobals('granted', calls, async () => {
      const outcome = await fireTestNotification();
      assert.match(outcome, /notification threw: no service worker/);
    }, { throwOnConstruct: true });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
