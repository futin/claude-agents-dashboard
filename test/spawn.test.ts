import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FAIL_TTL_MS, LAUNCH_TTL_MS, NAME_CAP, PERMISSION_MODES, PROMPT_CAP, PROMPT_PREVIEW_CAP,
  STDERR_TAIL_CAP, STOP_GRACE_MS, adoptLaunched, buildSpawnArgs, clampPermission, escalateStop,
  forceStopSession, launch, listLaunching, parseSpawnRequest, probeSpawn, resetLaunches,
  resetSpawnProbe, setGroupKiller, setSpawner, stopSession, stopStates
} from '../server/lib/spawn.js';
import { toPermissionMode } from '../server/lib/config.js';
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
  /**
   * The three fields `signalGroup`'s guard reads. A real child reports a pid
   * and keeps both codes null until it ends, so those are the defaults; a test
   * that emits `'exit'` sets `exitCode` first, the way a real child does.
   * `FAKE_PID` is deliberately > 1 — the pid guard's own tests override it.
   */
  pid: number | undefined = FAKE_PID;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(signal?: string): boolean { this.killSignals.push(signal ?? 'SIGTERM'); return true; }
  unref(): this { this.unrefCalled = true; return this; }
}

/** A plausible pid for a fake child. Never reaches a real `process.kill` — see `killerSpy`. */
const FAKE_PID = 4242;

/** One recorded group signal: the pid as `process.kill` would receive it (negated), and the signal. */
interface KillCall { pid: number; signal: string; }

/**
 * Install a recording group killer and hand back the calls it saw.
 *
 * Every stop test installs one. Without it the fake pids above would reach the
 * real `process.kill`, which on a developer's machine means signalling whatever
 * unrelated process happens to own pid 4242.
 */
function killerSpy(calls: KillCall[], onCall?: () => void): void {
  setGroupKiller((pid, signal) => {
    calls.push({ pid, signal });
    onCall?.();
  });
}

/** Launch one fake session and drive it to `running` via adoption. Returns its id and child. */
function runningSession(children: FakeChild[]): string {
  const id = launch(cfg(), REF, baseInput());
  assert.strictEqual(adoptLaunched([id]), 1);
  assert.strictEqual(children.length, 1);
  return id;
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

/** Run `fn` with `console.warn` captured, and return every line it wrote. */
function captureWarn(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

/**
 * Busy-wait until `Date.now()` has advanced by at least `ms`.
 *
 * `fail()` reads `Date.now()` itself and `failedAtMs` is deliberately absent
 * from the public `LaunchingSession` shape, so the only way to prove expiry is
 * measured from the *failure* rather than from the launch is to make the two
 * clocks genuinely differ — and this suite's runner is synchronous, so there is
 * nowhere to await. A few milliseconds, once.
 */
function spinMs(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberate */ }
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

  /* ------------------------------------------------ toPermissionMode (config.ts)

     One layer above clampPermission: the ceiling knob itself, validated at
     config load. It bounds the whole feature's blast radius, and it was added
     *because* a bare cast let `SPAWN_MAX_PERMISSION=Plan` silently raise an
     intended `plan` ceiling two rungs to `auto`. `isPermissionMode` is private
     to config.ts and hand-writes a second literal copy of the mode set, so the
     first case below is what catches it drifting from `PERMISSION_MODES`. */

  if (test('toPermissionMode keeps every PERMISSION_MODES value verbatim, silently (drift guard)', () => {
    for (const mode of PERMISSION_MODES) {
      const warnings = captureWarn(() => {
        assert.strictEqual(toPermissionMode(mode, 'plan'), mode, `${mode} should survive unchanged`);
      });
      assert.deepStrictEqual(warnings, [], `${mode} is valid — nothing to warn about`);
    }
  })) p++; else f++;

  if (test('toPermissionMode: absent, empty, blank and non-string all mean "unset" — fallback, no warning', () => {
    for (const value of [undefined, null, '', '   ', 42, {}]) {
      const warnings = captureWarn(() => {
        assert.strictEqual(toPermissionMode(value, 'acceptEdits'), 'acceptEdits');
      });
      assert.deepStrictEqual(warnings, [], `${JSON.stringify(value)} is the ordinary unset case`);
    }
  })) p++; else f++;

  if (test('toPermissionMode: "Plan" (the capitalization typo) falls back AND warns, naming value and fallback', () => {
    const warnings = captureWarn(() => {
      // The regression: this used to reach a bare cast, so the ceiling rose
      // from the intended `plan` to `auto` — two rungs, permissive direction,
      // nothing printed anywhere.
      assert.strictEqual(toPermissionMode('Plan', 'auto'), 'auto');
    });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Plan/);
    assert.match(warnings[0], /auto/);
  })) p++; else f++;

  if (test('toPermissionMode: an unrecognized value warns and never reaches the top of the ladder', () => {
    const warnings = captureWarn(() => {
      assert.strictEqual(toPermissionMode('nonsense', 'plan'), 'plan');
    });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /nonsense/);
  })) p++; else f++;

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

  if (test('a name may not start with a hyphen — "-p" must never become the value of -n', () => {
    for (const name of ['-p', '--model', '-', '_x', ' leading space']) {
      const r = parseSpawnRequest({ prompt: 'x', name }, 'auto');
      assert.ok(r.ok);
      if (r.ok) assert.strictEqual(r.input.name, undefined, `${JSON.stringify(name)} should be dropped`);
    }
  })) p++; else f++;

  if (test('a dotted version-style name is kept (it used to be silently dropped)', () => {
    const r = parseSpawnRequest({ prompt: 'x', name: 'v1.2 release' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.name, 'v1.2 release');
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

  if (test('remoteControl: true is kept', () => {
    const r = parseSpawnRequest({ prompt: 'x', remoteControl: true }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.input.remoteControl, true);
  })) p++; else f++;

  if (test('an absent or non-boolean remoteControl normalizes to false (fail-soft)', () => {
    for (const body of [{ prompt: 'x' }, { prompt: 'x', remoteControl: 'yes' }, { prompt: 'x', remoteControl: 1 }]) {
      const r = parseSpawnRequest(body, 'auto');
      assert.ok(r.ok);
      if (r.ok) assert.strictEqual(r.input.remoteControl, false, `${JSON.stringify(body)} should normalize to false`);
    }
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

  if (test('remoteControl with a name passes the name as the flag value, so the account registration is not auto-named', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', name: 'nightly build', remoteControl: true });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '-n', 'nightly build', '--remote-control', 'nightly build']);
  })) p++; else f++;

  if (test('remoteControl without a name appends the bare flag last', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', remoteControl: true });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto', '--remote-control']);
  })) p++; else f++;

  if (test('remoteControl: false emits no flag — argv identical to the minimal build', () => {
    const args = buildSpawnArgs({ sessionId: UUID, prompt: 'hi', permissionMode: 'auto', remoteControl: false });
    assert.deepStrictEqual(args, ['-p', '--session-id', UUID, '--permission-mode', 'auto']);
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
      const startedAtMs = listLaunching().find(e => e.sessionId === id)!.startedAtMs;
      assert.strictEqual(listLaunching(startedAtMs + FAIL_TTL_MS - 1000).length, 1);
      assert.strictEqual(listLaunching(startedAtMs + FAIL_TTL_MS + 1000).length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  // The case above passes identically whether `failedAtMs` exists or not: a
  // fake child fails in the same millisecond it launched, so the two clocks are
  // indistinguishable. This one separates them — the failure lands measurably
  // later than the launch, and the entry must then outlive
  // `startedAtMs + FAIL_TTL_MS`, because the window is time-since-failure.
  if (test('FAIL_TTL_MS runs from the failure, not from the launch (failedAtMs)', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      const startedAtMs = listLaunching().find(e => e.sessionId === id)!.startedAtMs;
      const GAP_MS = 25;
      spinMs(GAP_MS);
      children[0].emit('exit', 1, null);

      // Strictly past the launch-based deadline, but inside the failure-based
      // one: only a separate failedAtMs keeps the entry alive here.
      assert.strictEqual(listLaunching(startedAtMs + FAIL_TTL_MS + 5).length, 1);
      // And it still expires — measured from the failure, so a whole gap later.
      assert.strictEqual(listLaunching(startedAtMs + FAIL_TTL_MS + GAP_MS + 1000).length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('stopSession: an unknown id is not-found', () => {
    resetLaunches();
    assert.strictEqual(stopSession('unknown-id'), 'not-found');
  })) p++; else f++;

  if (test('stopSession: a launching entry is stopped, SIGTERMs the fake child, and is removed', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(stopSession(id), 'stopped');
      assert.deepStrictEqual(children[0].killSignals, ['SIGTERM']);
      // The *handle*, not the group: a launch this young has no grandchildren
      // worth the negated-pgid machinery, and this path predates it.
      assert.strictEqual(calls.length, 0);
      // A launch the user asked to stop vanishes immediately — it must not
      // linger as a `failed` row for FAIL_TTL_MS once the real exit arrives.
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('an exit that arrives after stopSession does not resurrect the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = launch(cfg(), REF, baseInput());
      assert.strictEqual(stopSession(id), 'stopped');
      // The real SIGTERM'd process eventually reports in: code null, signal
      // SIGTERM. fail()'s presence guard must no-op, same as post-adoption.
      children[0].signalCode = 'SIGTERM';
      children[0].emit('exit', null, 'SIGTERM');
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  /* --------------------------------------------- the entry survives adoption */

  if (test('adoption transitions rather than deletes: the entry becomes stoppable', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = runningSession(children);
      // No phantom "launching" row for a session the scan is already showing.
      assert.strictEqual(listLaunching().length, 0);
      assert.strictEqual(stopStates().get(id), 'ready');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('adoption happens once: a second call counts 0 and changes nothing', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      const id = runningSession(children);
      // The dashboard re-scans the same id every 3s thereafter; only the first
      // one is an adoption.
      assert.strictEqual(adoptLaunched([id]), 0);
      assert.strictEqual(stopStates().get(id), 'ready');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a resume entry is still skipped by adoption, so a launch failure can still render', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      // Its id names a transcript that already existed, so the scan seeing it
      // proves nothing about the child.
      assert.strictEqual(adoptLaunched([UUID]), 0);
      const rows = listLaunching();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].state, 'launching');
      // The documented consequence: not stoppable yet.
      assert.strictEqual(stopStates().size, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a resume failure still renders after that skipped adoption', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      assert.strictEqual(adoptLaunched([UUID]), 0);
      children[0].exitCode = 2;
      children[0].emit('exit', 2, null);
      const rows = listLaunching();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].state, 'failed');
      assert.strictEqual(rows[0].resume, true);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the launch TTL promotes a still-live child instead of dropping its handle', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      // The only route to `running` a resume has — and the reason a resumed
      // session becomes stoppable exactly one LAUNCH_TTL_MS in.
      assert.strictEqual(listLaunching(Date.now() + LAUNCH_TTL_MS + 1).length, 0);
      assert.strictEqual(stopStates().get(UUID), 'ready');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('the launch TTL still deletes an entry whose child is gone', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      // Code 0 leaves a `launching` entry alone (a fast run can beat the scan),
      // so the entry is still there — but its child is not.
      children[0].exitCode = 0;
      children[0].emit('exit', 0, null);
      assert.strictEqual(listLaunching(Date.now() + LAUNCH_TTL_MS + 1).length, 0);
      assert.strictEqual(stopStates().size, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a running entry that exits is deleted, not resurrected as a failed phantom', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      runningSession(children);
      // An hour-old session that ends nonzero is over, not a failed *launch*.
      children[0].exitCode = 1;
      children[0].emit('exit', 1, null);
      assert.strictEqual(listLaunching().length, 0);
      assert.strictEqual(stopStates().size, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  /* -------------------------------------------------- stopping a live session */

  if (test('stopSession on a running entry signals the group and keeps the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      assert.strictEqual(stopSession(id), 'stopping');
      assert.deepStrictEqual(calls, [{ pid: -FAKE_PID, signal: 'SIGTERM' }]);
      assert.strictEqual(stopStates().get(id), 'stopping');
      // The entry survives: the escalation still needs its handle.
      assert.strictEqual(stopStates().size, 1);
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('stopSession is idempotent: a double-tap does not re-signal', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      assert.strictEqual(stopSession(id), 'stopping');
      assert.strictEqual(stopSession(id), 'stopping');
      assert.strictEqual(calls.length, 1);
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('stopSession is not-found for an unknown id and for a failed entry, and signals neither', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      assert.strictEqual(stopSession('unknown-id'), 'not-found');
      const id = launch(cfg(), REF, baseInput());
      children[0].exitCode = 7;
      children[0].emit('exit', 7, null);
      assert.strictEqual(listLaunching()[0].state, 'failed');
      assert.strictEqual(stopSession(id), 'not-found');
      assert.strictEqual(calls.length, 0);
      assert.deepStrictEqual(children[0].killSignals, []);
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('escalateStop does nothing one millisecond before the grace elapses', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      const at = 1_000_000;
      assert.strictEqual(stopSession(id, at), 'stopping');
      assert.strictEqual(escalateStop(id, at + STOP_GRACE_MS - 1), false);
      assert.strictEqual(calls.length, 1);   // still only the SIGTERM
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('escalateStop SIGKILLs the group exactly on the grace boundary', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      const at = 1_000_000;
      stopSession(id, at);
      assert.strictEqual(escalateStop(id, at + STOP_GRACE_MS), true);
      assert.deepStrictEqual(calls[1], { pid: -FAKE_PID, signal: 'SIGKILL' });
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('escalateStop does not fire after the exit handler has dropped the entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      const at = 1_000_000;
      stopSession(id, at);
      // The child honoured the SIGTERM, as the real CLI does (measured: the
      // whole group went in ~1.1s). Its `'exit'` deletes the entry, so the
      // armed timer finds nothing left to escalate.
      children[0].exitCode = 0;
      children[0].emit('exit', 0, null);
      assert.strictEqual(escalateStop(id, at + STOP_GRACE_MS), false);
      assert.strictEqual(calls.length, 1);   // the SIGTERM, and nothing after it
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('a reaped-but-not-yet-dispatched child is never signalled — the liveness clause', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      // Node sets `exitCode` when it reaps the child and dispatches `'exit'`
      // afterwards, so there is a window where the entry is still `running`
      // while the process behind it is already gone. That window is the ONLY
      // way to reach the liveness clause — once `'exit'` has run, the entry is
      // deleted and every caller stops at the presence check instead. Deliberately
      // no `emit('exit')` here: this is the pre-dispatch state, not a fake one.
      children[0].exitCode = 0;
      // Nothing may be offered, claimed, or signalled for a dead pgid — by then
      // that group number may belong to an unrelated process.
      assert.strictEqual(stopStates().size, 0, 'a reaped child is not stoppable');
      assert.strictEqual(stopSession(id), 'not-found');
      assert.strictEqual(forceStopSession(id), 'not-found');
      assert.strictEqual(escalateStop(id, Date.now() + STOP_GRACE_MS), false);
      assert.strictEqual(calls.length, 0, 'no signal may reach a reaped pgid');
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  for (const badPid of [0, 1, undefined]) {
    if (test(`the pid guard refuses to signal a child whose pid is ${String(badPid)}`, () => {
      resetLaunches();
      const children: FakeChild[] = [];
      const calls: KillCall[] = [];
      setSpawner(fakeSpawner([], children));
      killerSpy(calls);
      try {
        const id = launch(cfg(), REF, baseInput());
        children[0].pid = badPid;
        assert.strictEqual(adoptLaunched([id]), 1);
        const verdict = stopSession(id);
        // Asserted before the verdict so a regression's failure output names the
        // pid that would have been signalled. For pid 0 that is `-0`, and
        // `kill(0, sig)` signals every process in the CALLER's own group — i.e.
        // this dashboard and the terminal that started it.
        assert.deepStrictEqual(calls, [], 'nothing may be signalled for an unusable pid');
        // `not-found`, because a child with no usable pid is exactly as
        // unstoppable as one this server never held: `stopStates` omits it too.
        assert.strictEqual(verdict, 'not-found');
        assert.strictEqual(stopStates().size, 0);
      } finally { setSpawner(null); setGroupKiller(null); }
    })) p++; else f++;
  }

  if (test('a killer that throws ESRCH does not propagate — the process is gone, which is the goal', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls, () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });
    try {
      const id = runningSession(children);
      assert.strictEqual(stopSession(id), 'stopping');
      assert.strictEqual(calls.length, 1);
    } finally { setSpawner(null); setGroupKiller(null); }
  })) p++; else f++;

  if (test('forceStopSession SIGKILLs a running group, and refuses a launching entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    const calls: KillCall[] = [];
    setSpawner(fakeSpawner([], children));
    killerSpy(calls);
    try {
      const id = runningSession(children);
      assert.strictEqual(forceStopSession(id), 'stopped');
      assert.deepStrictEqual(calls, [{ pid: -FAKE_PID, signal: 'SIGKILL' }]);

      // A launching entry is already an immediate kill; there is nothing to
      // escalate past, so force has no meaning for it.
      const other = launch(cfg(), REF, baseInput());
      assert.strictEqual(forceStopSession(other), 'not-found');
      assert.strictEqual(calls.length, 1);
    } finally { setSpawner(null); setGroupKiller(null); }
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

  if (test('the options are exactly cwd/env/detached/stdio, stdin piped, stdout ignored, stderr piped', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    try {
      launch(cfg(), REF, baseInput());
      const { options } = calls[0];
      assert.deepStrictEqual(Object.keys(options).sort(), ['cwd', 'detached', 'env', 'stdio']);
      assert.strictEqual(options.cwd, REF.path);
      assert.strictEqual(options.detached, true);
      const stdio = options.stdio as unknown[];
      assert.strictEqual(stdio[0], 'pipe');
      assert.strictEqual(stdio[1], 'ignore');
      // stderr must stay piped for as long as the parent lives: the whole
      // failure-reporting story (the stderr tail on a `failed` row) rests on it.
      assert.strictEqual(stdio[2], 'pipe');
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

  /* ----------------------------------------------------------------- resume */

  if (test('buildSpawnArgs: resume swaps --session-id for --resume, everything after unchanged', () => {
    const args = buildSpawnArgs({
      sessionId: UUID, prompt: 'p', permissionMode: 'auto', model: 'haiku', effort: 'low', resume: true
    });
    assert.deepStrictEqual(args, [
      '-p', '--resume', UUID, '--permission-mode', 'auto', '--model', 'haiku', '--effort', 'low'
    ]);
    assert.ok(!args.includes('--session-id'), 'CLI refuses --session-id with --resume sans --fork-session');
  })) p++; else f++;

  if (test('parseSpawnRequest: a valid resume id comes back as resumeId, identity fields forced off', () => {
    const r = parseSpawnRequest(
      { prompt: 'go on', resume: UUID, name: 'My Run', remoteControl: true }, 'auto'
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.strictEqual(r.resumeId, UUID);
      // -n renames and --remote-control registration on a resumed session are
      // unverified CLI combos — dropped, never sent.
      assert.strictEqual(r.input.name, undefined);
      assert.strictEqual(r.input.remoteControl, false);
    }
  })) p++; else f++;

  if (test('parseSpawnRequest: a present-but-malformed resume REJECTS (load-bearing, unlike cosmetic fields)', () => {
    for (const bad of [42, '', '../evil', 'a b', {}]) {
      const r = parseSpawnRequest({ prompt: 'p', resume: bad }, 'auto');
      assert.strictEqual(r.ok, false, `resume=${JSON.stringify(bad)} must reject, not silently launch fresh`);
    }
  })) p++; else f++;

  if (test('parseSpawnRequest: absent resume yields no resumeId (fresh-launch path unchanged)', () => {
    const r = parseSpawnRequest({ prompt: 'p' }, 'auto');
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.resumeId, undefined);
  })) p++; else f++;

  if (test('launch with a resume id: reuses that id, spawns --resume, and flags the entry', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    try {
      const id = launch(cfg(), REF, baseInput({ resume: true }), UUID);
      assert.strictEqual(id, UUID, 'resume must not mint a new id — the transcript already owns this one');
      assert.deepStrictEqual(calls[0].args.slice(0, 3), ['-p', '--resume', UUID]);
      const entry = listLaunching().find(e => e.sessionId === UUID)!;
      assert.strictEqual(entry.resume, true);
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('adoptLaunched skips resume entries — the id pre-exists on disk, so adoption means nothing', () => {
    resetLaunches();
    setSpawner(fakeSpawner([], []));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      assert.strictEqual(adoptLaunched([UUID]), 0);
      assert.strictEqual(listLaunching().length, 1, 'entry must survive the poll that would adopt a fresh launch');
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('a failed resume stays visible as a failed entry (the one signal the user gets)', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      children[0].stderr.emit('data', 'resume exploded');
      children[0].emit('exit', 1, null);
      const entry = listLaunching().find(e => e.sessionId === UUID)!;
      assert.strictEqual(entry.state, 'failed');
      assert.strictEqual(entry.resume, true);
      assert.ok(entry.error!.includes('resume exploded'));
    } finally { setSpawner(null); }
  })) p++; else f++;

  if (test('launch strips CLAUDE_CODE_ENTRYPOINT from the child env (child must stamp sdk-cli)', () => {
    resetLaunches();
    const calls: SpawnCall[] = [];
    setSpawner(fakeSpawner(calls, []));
    const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
    try {
      launch(cfg(), REF, baseInput());
      const env = calls[0].options.env as Record<string, string> | undefined;
      assert.ok(env, 'launch must pass an explicit env to the spawner');
      assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env), 'the inherited entrypoint marker must not reach the child');
      assert.strictEqual(env.PATH, process.env.PATH, 'everything else passes through untouched');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
      setSpawner(null);
    }
  })) p++; else f++;

  if (test('stopSession still SIGTERMs a launching resume entry', () => {
    resetLaunches();
    const children: FakeChild[] = [];
    setSpawner(fakeSpawner([], children));
    try {
      launch(cfg(), REF, baseInput({ resume: true }), UUID);
      assert.strictEqual(stopSession(UUID), 'stopped');
      assert.deepStrictEqual(children[0].killSignals, ['SIGTERM']);
      assert.strictEqual(listLaunching().length, 0);
    } finally { setSpawner(null); }
  })) p++; else f++;

  resetLaunches();
  resetSpawnProbe();
  setGroupKiller(null);

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
