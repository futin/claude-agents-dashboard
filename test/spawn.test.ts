import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FAIL_TTL_MS, LAUNCH_TTL_MS, NAME_CAP, PROMPT_CAP, PROMPT_PREVIEW_CAP, STDERR_TAIL_CAP,
  adoptLaunched, buildSpawnArgs, clampPermission, launch, listLaunching, parseSpawnRequest,
  probeSpawn, resetLaunches, resetSpawnProbe, setSpawner, stopLaunch
} from '../server/lib/spawn.js';
import type { Config } from '../server/lib/config.js';
import type { SpawnInput, Spawner } from '../server/lib/spawn.js';
import type { PermissionMode, ProjectRef } from '../shared/types.js';
import type { ChildProcess } from 'node:child_process';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Fixed test uuid — the exact value doesn't matter, only that it's echoed verbatim. */
const UUID = '11111111-1111-4111-8111-111111111111';

/** Shape check for a real `crypto.randomUUID()` (v4) result. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only the fields `probeSpawn`/`launch` read off `Config`. */
function cfg(over: Partial<Config> = {}): Config {
  return { claudeBin: '', spawnMaxPermission: 'auto', ...over } as Config;
}

/** A throwaway executable that appends one line to `counterFile` on every run, then exits 0. */
function countingBin(dir: string, name: string, counterFile: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/bash\necho x >> "${counterFile}"\nexit 0\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** How many times `countingBin` has run, i.e. lines appended to `counterFile`. 0 if it never has. */
function countLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.length > 0).length;
}

/**
 * A recording stand-in for a child's stdin. Extends `EventEmitter` (a real
 * stream is one too) so a test can simulate its own `'error'` — e.g. an
 * EPIPE — independently of the child's own `'error'` event.
 */
class FakeStdin extends EventEmitter {
  writes: string[] = [];
  ended = false;
  write(chunk: string): boolean { this.writes.push(chunk); return true; }
  end(): void { this.ended = true; }
}

/**
 * A fake `ChildProcess`: a recording stdin, a plain emitter standing in for
 * stderr/exit/error, and a kill spy — exactly the surface `launch` touches.
 * Cast through `unknown` where a real `ChildProcess` is expected; no test
 * needs the rest of that interface.
 */
class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  stderr = new EventEmitter();
  killSignals: string[] = [];
  unrefCalled = false;
  kill(signal?: string): boolean { this.killSignals.push(signal ?? 'SIGTERM'); return true; }
  unref(): this { this.unrefCalled = true; return this; }
}

interface SpawnCall { command: string; args: string[]; options: Record<string, unknown>; }

/** A `Spawner` that records every call and hands back a fresh `FakeChild`. */
function fakeSpawner(calls: SpawnCall[], children: FakeChild[]): Spawner {
  return (command, args, options) => {
    calls.push({ command, args: args.slice(), options: { ...options } });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
}

/** A recently-active project fixture — the shape `launch` reads off `ProjectRef`. */
const REF: ProjectRef = { dirName: 'enc-demo', name: 'demo-project', path: '/tmp/demo-project', lastActiveMs: Date.now() };

/** A minimal valid `launch` input, overridable per test. */
function baseInput(over: Partial<Omit<SpawnInput, 'sessionId'>> = {}): Omit<SpawnInput, 'sessionId'> {
  return { prompt: 'do the thing', permissionMode: 'auto', ...over };
}

export function run(): number {
  console.log('\n=== spawn.ts ===\n');
  let p = 0, f = 0;

  /* -------------------------------------------------------------- constants */

  if (test('caps match the spec verbatim', () => {
    assert.strictEqual(PROMPT_CAP, 4000);
    assert.strictEqual(NAME_CAP, 60);
  })) p++; else f++;

  /* ------------------------------------------------------------ clampPermission */

  const LADDER: Array<{ requested: unknown; ceiling: unknown; expected: PermissionMode; why: string }> = [
    { requested: 'bypassPermissions', ceiling: 'auto', expected: 'auto',
      why: 'the browser cannot escalate past the host' },
    { requested: 'plan', ceiling: 'auto', expected: 'plan',
      why: 'asking for less than the ceiling is always allowed' },
    { requested: 'auto', ceiling: 'plan', expected: 'plan',
      why: 'a lowered ceiling lowers everything' },
    { requested: 'auto', ceiling: 'auto', expected: 'auto', why: 'equal is a no-op' },
    { requested: 'bypassPermissions', ceiling: 'bypassPermissions', expected: 'bypassPermissions',
      why: 'an opted-in host can reach the top' },
    { requested: 'nonsense', ceiling: 'auto', expected: 'auto',
      why: 'unknown request falls to the default, never to the top' },
    { requested: 'auto', ceiling: 'nonsense', expected: 'auto',
      why: 'unknown ceiling falls to the default, never to the top' },
    { requested: undefined, ceiling: 'plan', expected: 'plan',
      why: 'absent request defaults to auto, then clamps' }
  ];
  for (const { requested, ceiling, expected, why } of LADDER) {
    if (test(`clampPermission(${JSON.stringify(requested)}, ${JSON.stringify(ceiling)}) -> ${expected} (${why})`, () => {
      assert.strictEqual(clampPermission(requested, ceiling), expected);
    })) p++; else f++;
  }

  /* ------------------------------------------------------------ parseSpawnRequest */

  if (test('prompt is trimmed; permissionMode defaults to auto', () => {
    const r = parseSpawnRequest({ prompt: '  do it  ' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) {
      assert.strictEqual(r.input.prompt, 'do it');
      assert.strictEqual(r.input.permissionMode, 'auto');
    }
  })) p++; else f++;

  if (test('an empty or blank prompt is refused, naming the prompt', () => {
    for (const body of [{ prompt: '' }, { prompt: '   ' }]) {
      const r = parseSpawnRequest(body, 'auto');
      assert.strictEqual(r.ok, false);
      if (!r.ok) assert.match(r.error, /prompt/i);
    }
  })) p++; else f++;

  if (test('a 4000-char prompt is accepted — the cap is inclusive', () => {
    const r = parseSpawnRequest({ prompt: 'a'.repeat(4000) }, 'auto');
    assert.strictEqual(r.ok, true);
  })) p++; else f++;

  if (test('a 4001-char prompt is refused', () => {
    const r = parseSpawnRequest({ prompt: 'a'.repeat(4001) }, 'auto');
    assert.strictEqual(r.ok, false);
  })) p++; else f++;

  if (test('a non-object body (null, string, number) is refused', () => {
    for (const body of [null, 'a string', 42]) {
      assert.strictEqual(parseSpawnRequest(body, 'auto').ok, false);
    }
  })) p++; else f++;

  if (test('an unrecognized model is dropped, not fatal', () => {
    const r = parseSpawnRequest({ prompt: 'x', model: 'gpt-4' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.model, undefined);
  })) p++; else f++;

  if (test('a recognized model is kept', () => {
    const r = parseSpawnRequest({ prompt: 'x', model: 'opus' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.model, 'opus');
  })) p++; else f++;

  if (test('an unrecognized effort is dropped, not fatal', () => {
    const r = parseSpawnRequest({ prompt: 'x', effort: 'ludicrous' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.effort, undefined);
  })) p++; else f++;

  if (test('a name in the allowed charset is kept', () => {
    const r = parseSpawnRequest({ prompt: 'x', name: 'nightly build-2' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.name, 'nightly build-2');
  })) p++; else f++;

  if (test('a name outside the allowed charset is dropped', () => {
    const r = parseSpawnRequest({ prompt: 'x', name: 'x"; rm -rf /; echo "' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.name, undefined);
  })) p++; else f++;

  if (test('a name over NAME_CAP is dropped; exactly NAME_CAP is kept', () => {
    const over = parseSpawnRequest({ prompt: 'x', name: 'a'.repeat(61) }, 'auto');
    assert.ok(over.ok);
    if (over.ok) assert.strictEqual(over.input.name, undefined);

    const exact = parseSpawnRequest({ prompt: 'x', name: 'a'.repeat(60) }, 'auto');
    assert.ok(exact.ok);
    if (exact.ok) assert.strictEqual(exact.input.name, 'a'.repeat(60));
  })) p++; else f++;

  if (test('the ceiling clamps a requested permissionMode', () => {
    const r = parseSpawnRequest({ prompt: 'x', permissionMode: 'bypassPermissions' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.permissionMode, 'auto');
  })) p++; else f++;

  if (test('an unrecognized permissionMode clamps to the default', () => {
    const r = parseSpawnRequest({ prompt: 'x', permissionMode: 'manual' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.permissionMode, 'auto');
  })) p++; else f++;

  /* ------------------------------------------------------------ buildSpawnArgs */

  if (test('minimal input builds exactly the five fixed elements', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto']);
    assert.strictEqual(args.length, 5);
  })) p++; else f++;

  if (test('no argv element carries the prompt text (stdin regression guard)', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto' });
    assert.ok(args.every(a => !a.includes('hi')));
  })) p++; else f++;

  if (test('a model appends --model as its own pair', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', model: 'opus' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '--model', 'opus']);
  })) p++; else f++;

  if (test('an effort appends --effort as its own pair', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', effort: 'high' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '--effort', 'high']);
  })) p++; else f++;

  if (test('a name appends -n as one array element, not split on its space', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', name: 'nightly build' });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '-n', 'nightly build']);
    assert.strictEqual(args[args.length - 1], 'nightly build');
    assert.strictEqual(args.length, 7);
  })) p++; else f++;

  // NOTE ON THE COUNT: the brief's Step 1 table claims length 13 for "all
  // three optional knobs at once." SpawnInput has exactly three optional
  // fields — name, model, effort — each contributing one 2-element flag pair
  // on top of the always-present 5-element base (`-p`, the `--session-id`
  // pair, the `--permission-mode` pair). That arithmetic is 5 + 2*3 = 11, not
  // 13; reaching 13 would need a fourth optional flag pair that doesn't exist
  // anywhere in SpawnInput or in this module. This looks like the brief
  // double-counting `--permission-mode`'s pair (once as part of the 5-element
  // base, again as one of "four knobs"). Asserting the internally-consistent
  // value (11) here — see the task report for the full disagreement.
  if (test('all three optional knobs together: fixed order, 11 elements total', () => {
    const args = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto',
      model: 'opus', effort: 'high', name: 'nightly build'
    });
    assert.deepStrictEqual(args, [
      '-p', '--session-id', UUID, '--permission-mode', 'auto',
      '--model', 'opus', '--effort', 'high', '-n', 'nightly build'
    ]);
    assert.strictEqual(args.length, 11);

    // flag order is stable across repeated calls with the same input
    const again = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto',
      model: 'opus', effort: 'high', name: 'nightly build'
    });
    assert.deepStrictEqual(again, args);
  })) p++; else f++;

  if (test('empty-string knobs are absent, not empty flag values', () => {
    const args = buildSpawnArgs({
      sessionId: UUID, prompt: 'hi', permissionMode: 'auto', model: '', effort: '', name: ''
    });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto']);
    assert.strictEqual(args.length, 5);
  })) p++; else f++;

  /* ---------------------------------------------------------------- probeSpawn */

  resetSpawnProbe();

  if (test('probeSpawn: /bin/echo stands in for a working CLI', () => {
    resetSpawnProbe();
    assert.strictEqual(probeSpawn(cfg({ claudeBin: '/bin/echo' })), true);
  })) p++; else f++;

  if (test('probeSpawn: a nonexistent binary is false', () => {
    resetSpawnProbe();
    assert.strictEqual(probeSpawn(cfg({ claudeBin: '/nonexistent/claude' })), false);
  })) p++; else f++;

  if (test('probeSpawn: empty claudeBin never runs a process; the cache holds across configs; reset re-invokes', () => {
    resetSpawnProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-spawn-probe-'));
    try {
      const counter = path.join(dir, 'count');
      const bin = countingBin(dir, 'claude-stub', counter);

      // An unconfigured server must not shell out at all.
      assert.strictEqual(probeSpawn(cfg({ claudeBin: '' })), false);
      assert.strictEqual(countLines(counter), 0);

      // First real probe of a working binary: true, exactly one invocation.
      resetSpawnProbe();
      assert.strictEqual(probeSpawn(cfg({ claudeBin: bin })), true);
      assert.strictEqual(countLines(counter), 1);

      // A different config on a later call: the cached true wins, no re-invoke.
      assert.strictEqual(probeSpawn(cfg({ claudeBin: '/nonexistent/other-claude' })), true);
      assert.strictEqual(countLines(counter), 1);

      // resetSpawnProbe drops the cache: the next call re-invokes.
      resetSpawnProbe();
      assert.strictEqual(probeSpawn(cfg({ claudeBin: bin })), true);
      assert.strictEqual(countLines(counter), 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      resetSpawnProbe();
    }
  })) p++; else f++;

  /* ------------------------------------------------------------ launch store */

  resetLaunches();

  if (test('launch mints a v4-uuid session id and registers a launching entry', () => {
    resetLaunches();
    setSpawner(fakeSpawner([], []));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.match(id, UUID_V4_RE);
      const list = listLaunching();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].sessionId, id);
      assert.strictEqual(list[0].state, 'launching');
      assert.strictEqual(list[0].projectName, REF.name);
      assert.strictEqual(list[0].projectPath, REF.path);
      assert.ok(Number.isFinite(list[0].startedAtMs) && list[0].startedAtMs > 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a 300-character prompt is stored truncated to PROMPT_PREVIEW_CAP characters', () => {
    resetLaunches();
    setSpawner(fakeSpawner([], []));
    try {
      const longPrompt = 'x'.repeat(300);
      const id = launch(cfg(), REF, baseInput({ prompt: longPrompt }));
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.prompt.length, PROMPT_PREVIEW_CAP);
      assert.strictEqual(entry.prompt, longPrompt.slice(0, PROMPT_PREVIEW_CAP));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('adoptLaunched removes the entry and reports 1; an unknown id reports 0 and leaves it', () => {
    resetLaunches();
    setSpawner(fakeSpawner([], []));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(adoptLaunched(['some-other-id']), 0);
      assert.strictEqual(listLaunching().length, 1);
      assert.strictEqual(adoptLaunched([id]), 1);
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a nonzero exit with stderr marks the entry failed, with the exit code and message', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].stderr.emit('data', Buffer.from('boom'));
      children[0].emit('exit', 2, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.strictEqual(entry.exitCode, 2);
      assert.ok(entry.error!.includes('boom'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('an exit that arrives after adoption does not resurrect the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(adoptLaunched([id]), 1);
      children[0].stderr.emit('data', Buffer.from('boom'));
      children[0].emit('exit', 2, null);
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  /* --------------------------------------------------- failure paths: streams, error, close */

  if (test('a child "error" event (e.g. a typo in CLAUDE_BIN) marks the entry failed with no exit code', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].emit('error', new Error('spawn claude-nope ENOENT'));
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.strictEqual(entry.exitCode, undefined);
      assert.ok(entry.error!.includes('ENOENT'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  // Regression guard for an unhandled-stream-error crash (a real EPIPE took a
  // Node 22 process down with no listener here): a stream is its own
  // EventEmitter, so the child's own 'error' handler above does not cover it.
  // Without a listener, `.emit('error', ...)` throws; with one, it's just
  // handled — this proves the listener is attached and wired to the store.
  if (test('an error on the child stdin (e.g. EPIPE) marks the entry failed', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].stdin.emit('error', new Error('write EPIPE'));
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.ok(entry.error!.includes('EPIPE'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('an error on the child stderr stream marks the entry failed', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].stderr.emit('error', new Error('read EPIPE'));
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.ok(entry.error!.includes('EPIPE'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('stderr that keeps arriving after exit is captured by a later close event', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      const child = children[0];
      // Node documents 'exit' as able to fire before stdio has finished
      // draining — transcribe.ts's own child runner reads on 'close' for
      // exactly this reason. Simulate more stderr landing in that gap.
      child.stderr.emit('data', Buffer.from('partial'));
      child.emit('exit', 1, null);
      child.stderr.emit('data', Buffer.from('-rest'));
      child.emit('close', 1, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.strictEqual(entry.exitCode, 1);
      assert.strictEqual(entry.error, 'partial-rest');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a spawn-failure close (negative code, no prior exit) does not clobber the error-event message', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg({ claudeBin: '/nonexistent/claude' }), REF, baseInput());
      const child = children[0];
      // A spawn that never started fires no 'exit' at all: only 'error',
      // then 'close' with a synthetic negative libuv code (e.g. -2 ENOENT).
      child.emit('error', new Error('spawn /nonexistent/claude ENOENT'));
      child.emit('close', -2, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.strictEqual(entry.exitCode, undefined);
      assert.ok(entry.error!.includes('ENOENT'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a close with code 0 does not re-fail an already-clean exit', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      const child = children[0];
      // Stray, non-fatal stderr output alongside a code-0 exit must not flip
      // the entry to failed at 'close' either — same rule 'exit' applies.
      child.stderr.emit('data', Buffer.from('a stray warning, not a failure'));
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'launching');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('5000 characters of stderr is capped to STDERR_TAIL_CAP, keeping the tail', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      const marker = '[[END]]';
      const long = 'a'.repeat(5000 - marker.length) + marker;
      children[0].stderr.emit('data', Buffer.from(long));
      children[0].emit('exit', 1, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.error!.length, STDERR_TAIL_CAP);
      assert.ok(entry.error!.endsWith(marker));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a clean exit (code 0) before adoption leaves the entry launching', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].emit('exit', 0, null);
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'launching');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a launching entry older than LAUNCH_TTL_MS is not returned by listLaunching(now)', () => {
    resetLaunches();
    setSpawner(fakeSpawner([], []));
    try {
      const id = launch(cfg(), REF, baseInput());
      const startedAtMs = listLaunching().find(e => e.sessionId === id)!.startedAtMs;
      assert.strictEqual(listLaunching(startedAtMs + LAUNCH_TTL_MS - 1000).length, 1);
      assert.strictEqual(listLaunching(startedAtMs + LAUNCH_TTL_MS + 1000).length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a failed entry older than FAIL_TTL_MS is dropped by listLaunching(now)', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      children[0].emit('exit', 1, null);
      const failedAtMs = listLaunching().find(e => e.sessionId === id)!.startedAtMs;
      assert.strictEqual(listLaunching(failedAtMs + FAIL_TTL_MS - 1000).length, 1);
      assert.strictEqual(listLaunching(failedAtMs + FAIL_TTL_MS + 1000).length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('stopLaunch: an unknown id returns false', () => {
    resetLaunches();
    assert.strictEqual(stopLaunch('unknown-id'), false);
  })) p++; else f++;

  if (test('stopLaunch: a live entry returns true, SIGTERMs the fake child, and removes the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(stopLaunch(id), true);
      assert.deepStrictEqual(children[0].killSignals, ['SIGTERM']);
      // A launch the user asked to stop vanishes immediately — it must not
      // linger as a `failed` row for FAIL_TTL_MS once the real exit arrives.
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('an exit that arrives after stopLaunch does not resurrect the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(stopLaunch(id), true);
      // The real SIGTERM'd process eventually reports in: code null, signal
      // SIGTERM. fail()'s presence guard must no-op, same as post-adoption.
      children[0].emit('exit', null, 'SIGTERM');
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  /* -------------------------------------------------------------- the spawn call */

  if (test('the spawner is called with config.claudeBin as the command', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    try {
      launch(cfg({ claudeBin: '/opt/bin/claude' }), REF, baseInput());
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].command, '/opt/bin/claude');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the argv contains the same uuid launch returned', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.ok(calls[0].args.includes(id));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the options are exactly cwd/detached/stdio, stdin piped and stdout ignored', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    try {
      launch(cfg(), REF, baseInput());
      const { options } = calls[0];
      assert.deepStrictEqual(Object.keys(options).sort(), ['cwd', 'detached', 'stdio']);
      assert.strictEqual(options.cwd, REF.path);
      assert.strictEqual(options.detached, true);
      const stdio = options.stdio as unknown[];
      assert.strictEqual(stdio[0], 'pipe');
      assert.strictEqual(stdio[1], 'ignore');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the prompt is written to the child stdin and the stream is ended', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const prompt = 'a prompt that must reach stdin, never argv';
      launch(cfg(), REF, baseInput({ prompt }));
      assert.strictEqual(children[0].stdin.writes.join(''), prompt);
      assert.strictEqual(children[0].stdin.ended, true);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('unref is called on the child', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput());
      assert.strictEqual(children[0].unrefCalled, true);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the full prompt reaches stdin even though the stored preview is truncated', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const prompt = 'y'.repeat(300);
      const id = launch(cfg(), REF, baseInput({ prompt }));
      assert.strictEqual(children[0].stdin.writes.join(''), prompt);
      assert.strictEqual(listLaunching().find(e => e.sessionId === id)!.prompt.length, PROMPT_PREVIEW_CAP);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a spawner that throws synchronously still leaves a failed entry (registered before spawning)', () => {
    resetLaunches();
    setSpawner(() => { throw new Error('boom-sync'); });
    try {
      const id = launch(cfg(), REF, baseInput());
      const entry = listLaunching().find(e => e.sessionId === id)!;
      assert.strictEqual(entry.state, 'failed');
      assert.ok(entry.error!.includes('boom-sync'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  resetLaunches();
  resetSpawnProbe();

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
