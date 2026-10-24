import assert from 'node:assert';

import { copyText } from '../client/src/lib/clipboard.js';

async function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type FakeTextarea = { value: string; style: Record<string, string>; attrs: Record<string, string>; setAttribute(k: string, v: string): void; select(): void };

/**
 * Stubs `navigator` and `document` on globalThis for one case. `clipboard` is the `navigator.clipboard` value (undefined = non-secure context);
 * `exec` is what `document.execCommand` does. Returns the recorded calls and the body's live children.
 */
function stub(clipboard: { writeText(t: string): Promise<void> } | undefined, exec: (cmd: string, body: FakeTextarea[]) => boolean) {
  const calls = { writeText: [] as string[], execCommand: [] as string[] };
  const body: FakeTextarea[] = [];
  const nav = clipboard
    ? { clipboard: { writeText: (t: string) => { calls.writeText.push(t); return clipboard.writeText(t); } } }
    : {};
  const doc = {
    body: {
      appendChild(el: FakeTextarea) { body.push(el); return el; },
      removeChild(el: FakeTextarea) { body.splice(body.indexOf(el), 1); return el; }
    },
    createElement(): FakeTextarea {
      return { value: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, select() {} };
    },
    execCommand(cmd: string) { calls.execCommand.push(cmd); return exec(cmd, body); }
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  return { calls, body };
}

export async function run(): Promise<number> {
  console.log('clipboard');
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const results: boolean[] = [];

  results.push(await test('clipboard API resolving → true, writeText gets the exact text, no execCommand', async () => {
    const { calls } = stub({ writeText: async () => {} }, () => true);
    assert.strictEqual(await copyText('abc-123'), true);
    assert.deepStrictEqual(calls.writeText, ['abc-123']);
    assert.deepStrictEqual(calls.execCommand, []);
  }));

  results.push(await test('clipboard API rejecting → falls back to execCommand(copy) and returns its result', async () => {
    const { calls, body } = stub({ writeText: async () => { throw new Error('NotAllowedError'); } }, () => true);
    assert.strictEqual(await copyText('abc-123'), true);
    assert.deepStrictEqual(calls.execCommand, ['copy']);
    assert.strictEqual(body.length, 0);
  }));

  results.push(await test('navigator.clipboard undefined → fallback copies the text, true when execCommand is true', async () => {
    let copied = '';
    const { calls, body } = stub(undefined, (_cmd, live) => { copied = live[live.length - 1]?.value ?? ''; return true; });
    assert.strictEqual(await copyText('full-session-id'), true);
    assert.strictEqual(copied, 'full-session-id');
    assert.deepStrictEqual(calls.execCommand, ['copy']);
    assert.strictEqual(body.length, 0);
  }));

  results.push(await test('navigator.clipboard undefined, execCommand false → false, textarea removed', async () => {
    const { body } = stub(undefined, () => false);
    assert.strictEqual(await copyText('x'), false);
    assert.strictEqual(body.length, 0);
  }));

  results.push(await test('execCommand throws → false, never throws, textarea removed', async () => {
    const { body } = stub(undefined, () => { throw new Error('boom'); });
    assert.strictEqual(await copyText('x'), false);
    assert.strictEqual(body.length, 0);
  }));

  results.push(await test('clipboard rejects and fallback throws → false', async () => {
    const { body } = stub({ writeText: async () => { throw new Error('denied'); } }, () => { throw new Error('boom'); });
    assert.strictEqual(await copyText('x'), false);
    assert.strictEqual(body.length, 0);
  }));

  if (savedNav) Object.defineProperty(globalThis, 'navigator', savedNav); else delete (globalThis as any).navigator;
  if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc); else delete (globalThis as any).document;
  return results.filter(r => !r).length;
}
