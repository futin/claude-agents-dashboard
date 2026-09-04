import assert from 'node:assert';

import { armBackClose, type BackCloseHost } from '../client/src/lib/backClose.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Call = { name: string; args: unknown[] };

/** A recording BackCloseHost the test drives by hand — no DOM, no timers. */
function fakeHost(opts: { pushThrows?: boolean } = {}) {
  const log: Call[] = [];
  const deferred = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  let nextHandle = 1;

  const host: BackCloseHost = {
    pushState(state, title) {
      log.push({ name: 'pushState', args: [state, title, arguments[2]] });
      if (opts.pushThrows) throw new Error('SecurityError: pushState throttled');
    },
    back() { log.push({ name: 'back', args: [] }); },
    addEventListener(type, fn) { log.push({ name: 'addEventListener', args: [type] }); listeners.add(fn); },
    removeEventListener(type, fn) { log.push({ name: 'removeEventListener', args: [type] }); listeners.delete(fn); },
    defer(fn) {
      const handle = nextHandle++;
      log.push({ name: 'defer', args: [handle] });
      deferred.set(handle, fn);
      return handle;
    },
    cancel(handle) { log.push({ name: 'cancel', args: [handle] }); deferred.delete(handle); }
  };

  return {
    host,
    log,
    /** Run every callback still scheduled, in the order they were deferred. */
    runDeferred() {
      for (const handle of [...deferred.keys()]) {
        const fn = deferred.get(handle);
        deferred.delete(handle);
        fn?.();
      }
    },
    /** Fire popstate at whatever is currently registered. */
    firePopstate() { for (const fn of [...listeners]) fn(); },
    listenerCount: () => listeners.size,
    count: (name: string) => log.filter(c => c.name === name).length,
    indexOf: (name: string) => log.findIndex(c => c.name === name)
  };
}

export function run(): number {
  console.log('\n=== backClose.ts ===\n');
  let p = 0, f = 0;

  if (test('arms nothing synchronously', () => {
    const h = fakeHost();
    armBackClose(h.host, () => {});
    assert.strictEqual(h.count('pushState'), 0);
    assert.strictEqual(h.listenerCount(), 0);
    assert.strictEqual(h.count('back'), 0);
  })) p++; else f++;

  if (test('the deferred callback pushes one entry and registers one listener', () => {
    const h = fakeHost();
    armBackClose(h.host, () => {});
    h.runDeferred();
    assert.strictEqual(h.count('pushState'), 1);
    assert.strictEqual(h.listenerCount(), 1);
    const push = h.log.find(c => c.name === 'pushState')!;
    assert.strictEqual((push.args[0] as { chatDrawer: boolean }).chatDrawer, true);
    // No url argument — the entry must carry the current URL unchanged.
    assert.strictEqual(push.args[2], undefined);
  })) p++; else f++;

  if (test('push comes before listener registration', () => {
    const h = fakeHost();
    armBackClose(h.host, () => {});
    h.runDeferred();
    assert.ok(h.indexOf('pushState') < h.indexOf('addEventListener'));
  })) p++; else f++;

  if (test('teardown before the callback runs cancels it', () => {
    const h = fakeHost();
    const off = armBackClose(h.host, () => {});
    off();
    h.runDeferred();
    const deferHandle = h.log.find(c => c.name === 'defer')!.args[0];
    assert.deepStrictEqual(h.log.find(c => c.name === 'cancel')!.args, [deferHandle]);
    assert.strictEqual(h.count('pushState'), 0);
    assert.strictEqual(h.count('back'), 0);
    assert.strictEqual(h.listenerCount(), 0);
  })) p++; else f++;

  if (test('a StrictMode double-invoke arms exactly once', () => {
    const h = fakeHost();
    let closed = 0;
    const off = armBackClose(h.host, () => { closed++; });
    off();
    armBackClose(h.host, () => { closed++; });
    h.runDeferred();
    assert.strictEqual(h.count('pushState'), 1);
    assert.strictEqual(h.listenerCount(), 1);
    assert.strictEqual(h.count('back'), 0);
    assert.strictEqual(closed, 0);
  })) p++; else f++;

  if (test('a back press closes the drawer', () => {
    const h = fakeHost();
    let closed = 0;
    armBackClose(h.host, () => { closed++; });
    h.runDeferred();
    h.firePopstate();
    assert.strictEqual(closed, 1);
    assert.strictEqual(h.listenerCount(), 0);
  })) p++; else f++;

  if (test('two back presses close it once', () => {
    const h = fakeHost();
    let closed = 0;
    armBackClose(h.host, () => { closed++; });
    h.runDeferred();
    h.firePopstate();
    h.firePopstate();
    assert.strictEqual(closed, 1);
  })) p++; else f++;

  if (test('a programmatic close consumes the entry', () => {
    const h = fakeHost();
    const off = armBackClose(h.host, () => {});
    h.runDeferred();
    off();
    assert.strictEqual(h.count('back'), 1);
    assert.strictEqual(h.listenerCount(), 0);
  })) p++; else f++;

  if (test('a programmatic close cannot re-enter onClose', () => {
    const h = fakeHost();
    let closed = 0;
    const off = armBackClose(h.host, () => { closed++; });
    h.runDeferred();
    off();
    h.firePopstate(); // the popstate back() would really fire
    assert.strictEqual(closed, 0);
    // The guard itself: unregister must precede back().
    assert.ok(h.indexOf('removeEventListener') < h.indexOf('back'));
  })) p++; else f++;

  if (test('back-then-unmount does not navigate', () => {
    const h = fakeHost();
    const off = armBackClose(h.host, () => {});
    h.runDeferred();
    h.firePopstate();
    off();
    assert.strictEqual(h.count('back'), 0);
  })) p++; else f++;

  if (test('teardown is idempotent', () => {
    const h = fakeHost();
    const off = armBackClose(h.host, () => {});
    h.runDeferred();
    off();
    off();
    assert.strictEqual(h.count('back'), 1);
  })) p++; else f++;

  if (test('a throwing pushState leaves the arm inert', () => {
    const h = fakeHost({ pushThrows: true });
    let closed = 0;
    const off = armBackClose(h.host, () => { closed++; });
    h.runDeferred();
    off();
    assert.strictEqual(h.count('back'), 0);
    assert.strictEqual(h.listenerCount(), 0);
    assert.strictEqual(closed, 0);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
