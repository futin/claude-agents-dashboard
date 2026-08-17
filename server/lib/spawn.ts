/**
 * spawn.ts — launching a headless `claude -p` session from the dashboard:
 * the pure request/argv core, plus the impure half that actually runs it.
 *
 * Pure core — synchronous, no filesystem or process access:
 *
 *   1. `clampPermission` — the permission mode a launch actually runs under,
 *      never higher than the server-configured ceiling.
 *   2. `parseSpawnRequest` — whether an untrusted POST body is safe to act on,
 *      and the sanitized `SpawnInput` if so.
 *   3. `buildSpawnArgs` — the exact argv `child_process.spawn` receives.
 *
 * Impure half — the cached CLI probe, the RAM-only launch store, and `launch`
 * itself:
 *
 *   4. `probeSpawn` — is a `claude` binary configured and runnable? Cached
 *      for the process lifetime, mirroring `probeTranscribe` in `transcribe.ts`.
 *   5. `launch` — mints a session id, registers the store entry, spawns
 *      detached with the prompt piped to stdin, and returns immediately.
 *   6. `listLaunching` / `adoptLaunched` / `stopLaunch` — the store's read,
 *      adopt, and stop operations; see its own doc comment below for charter.
 *
 * Two rules `buildSpawnArgs` and `launch` never break between them:
 *
 *  - The prompt is never an argv element. `claude -p` parses argv the way
 *    almost every CLI does: a value starting with `-`/`--` is read as a flag,
 *    not as data, regardless of what flag it happens to follow. A prompt is
 *    untrusted free text a user typed — `--dangerously-skip-permissions` is a
 *    perfectly ordinary-looking sentence to start a prompt with — so the only
 *    safe place for it is somewhere the CLI's flag parser never looks: stdin.
 *    `launch` pipes `input.prompt` in over stdin and ends the stream right
 *    after; this module just makes sure nothing here ever puts it in argv.
 *  - `child_process.spawn` is always called in array form, never with
 *    `shell: true`. `shell: true` hands the whole command line to `/bin/sh`,
 *    which re-tokenizes it — the exact step that turns a value into code if
 *    it contains a quote, `;`, `$(...)`, or a stray space. Array-form `spawn`
 *    hands the child each argv element directly, with no shell in between to
 *    reinterpret any of them.
 *
 * Every test spawns a fake process: `launch` takes its spawner from
 * `setSpawner`, which defaults to `node:child_process.spawn` only outside
 * tests. No test ever spawns a real `claude` CLI.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Config } from './config.js';
import type { LaunchingSession, PermissionMode, ProjectRef } from '../../shared/types.js';

/** The permission ladder, lowest to highest. Array index order IS the ordering. */
export const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'bypassPermissions'] as const;

/** Models the launch form may request. */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Effort levels the launch form may request. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Prompt length cap, in characters. Inclusive — exactly this many is fine. */
export const PROMPT_CAP = 4000;

/** Display-name length cap, in characters. Inclusive — exactly this many is fine. */
export const NAME_CAP = 60;

/**
 * Allowed charset for a session's display name: letters, digits, spaces, dots,
 * hyphens, underscores — and the **first** character must be a letter or digit.
 * Nothing here is a shell metacharacter or a path separator; the name ends up
 * as a single argv element (never shell-parsed, see the module doc comment
 * above), but it also flows into UI and, later, onto disk, so it is sanitized
 * on its own merits rather than piggy-backing on argv safety.
 *
 * Two deliberate details:
 *
 *  - **The leading character is constrained separately** so a name can never
 *    itself *look* like a flag: `-p` passed the old charset and became the
 *    value of `-n`. No escalation was possible even then (a name is always
 *    exactly one argv element, pinned by test), but the worst case — a name
 *    the CLI's own option parser chokes on — is not worth keeping for zero
 *    benefit.
 *  - **`.` is allowed** because the spec's charset (`/^[\w .\-]*$/`) has it and
 *    an ordinary name like `v1.2 release` was being silently dropped. A dot is
 *    not a path separator, and a name is never joined into a path.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** `PERMISSION_MODES` index of `value`, or of `'auto'` when `value` isn't one of them. */
function modeIndex(value: unknown): number {
  const idx = (PERMISSION_MODES as readonly string[]).indexOf(value as string);
  return idx === -1 ? PERMISSION_MODES.indexOf('auto') : idx;
}

/**
 * The permission mode a launch actually runs under: never higher on the
 * ladder than `ceiling`, no matter what was requested. An unrecognized
 * `requested` or `ceiling` — including `undefined` — is treated as `'auto'`,
 * never as the top of the ladder, so a malformed value can only ever make the
 * result *less* permissive.
 */
export function clampPermission(requested: unknown, ceiling: unknown): PermissionMode {
  return PERMISSION_MODES[Math.min(modeIndex(requested), modeIndex(ceiling))];
}

/** Untrusted input for a new headless launch, once a `sessionId` has been assigned. */
export interface SpawnInput {
  sessionId: string;
  prompt: string;
  permissionMode: PermissionMode;
  name?: string;
  model?: string;
  effort?: string;
}

/** Result of validating an untrusted POST body against {@link SpawnInput}. */
export type ParseResult =
  | { ok: true; input: Omit<SpawnInput, 'sessionId'> }
  | { ok: false; error: string };

/**
 * Turn an untrusted POST body into a safe {@link SpawnInput}, or a reason it
 * can't launch. Deliberately ignores `body.project`: resolving a project
 * needs config and the filesystem, which a pure function doesn't have — the
 * handler (Task 3) resolves it separately.
 *
 * Only the prompt can fail the request outright. Everything else fails soft —
 * an unrecognized `model`, `effort` or `name`, or a `permissionMode` outside
 * the enum, is dropped or clamped rather than rejected, so a client sending a
 * field this server doesn't recognize (an old build, a future one) can still
 * launch with the rest of the request honored.
 */
export function parseSpawnRequest(body: unknown, ceiling: PermissionMode): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== 'string') {
    return { ok: false, error: 'prompt is required' };
  }
  const prompt = b.prompt.trim();
  if (prompt === '') {
    return { ok: false, error: 'prompt must not be empty' };
  }
  if (prompt.length > PROMPT_CAP) {
    return { ok: false, error: `prompt must be at most ${PROMPT_CAP} characters` };
  }

  const permissionMode = clampPermission(b.permissionMode, ceiling);
  const model = typeof b.model === 'string' && (MODELS as readonly string[]).includes(b.model)
    ? b.model
    : undefined;
  const effort = typeof b.effort === 'string' && (EFFORTS as readonly string[]).includes(b.effort)
    ? b.effort
    : undefined;
  const name = typeof b.name === 'string' && b.name.length <= NAME_CAP && NAME_RE.test(b.name)
    ? b.name
    : undefined;

  return { ok: true, input: { prompt, permissionMode, name, model, effort } };
}

/**
 * The exact argv `child_process.spawn('claude', ...)` receives (Task 2).
 * Fixed element order, built the same way on every call: required flags
 * first, then each optional flag appended in the same declared order when
 * present. No branch ever reorders a flag already emitted — a later diff that
 * adds a new optional flag only ever appends to the end of this function.
 *
 * The prompt is deliberately absent: see the module doc comment.
 */
export function buildSpawnArgs(input: SpawnInput): string[] {
  const args = ['-p', '--session-id', input.sessionId, '--permission-mode', input.permissionMode];
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.name) args.push('-n', input.name);
  return args;
}

/* ------------------------------------------------------------------ probe */

/** Per-probe wall-clock ceiling. `claude --version` returns almost instantly; this is a safety rail, not an expected wait. */
const PROBE_TIMEOUT_MS = 5_000;

/** Probe result for this process. `null` = not probed yet. Mirrors `transcribe.ts`'s `probed`. */
let spawnProbed: boolean | null = null;

/** Drop the cached probe. Tests only — a running server never changes its CLI binary mid-flight. */
export function resetSpawnProbe(): void {
  spawnProbed = null;
}

function computeSpawnProbe(config: Config): boolean {
  if (!config.claudeBin) return false;
  try {
    const result = spawnSync(config.claudeBin, ['--version'], { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

/**
 * Is spawning a new session available? Cached for the process lifetime — one
 * spawn per server run, never one per request, the same reasoning as
 * `probeTranscribe`. False, without ever invoking a process, when
 * `config.claudeBin` is empty — the "unset means off" rule every optional
 * feature in this config follows (`whisperModel`, `ntfyTopic`, …).
 */
export function probeSpawn(config: Config): boolean {
  if (spawnProbed === null) spawnProbed = computeSpawnProbe(config);
  return spawnProbed;
}

/* ------------------------------------------------------------ launch store */

/**
 * Test seam for {@link launch}, mirroring `setIdleReader` in `messages.ts`:
 * same call shape as `node:child_process.spawn`, so a fake child (a recording
 * stdin, an emitter standing in for stderr/exit/error, a kill spy) can stand
 * in without any test spawning a real process.
 */
export type Spawner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

let spawner: Spawner | null = null;

/** Test seam: swap the process spawner. `null` restores `node:child_process.spawn`. */
export function setSpawner(fn: Spawner | null): void {
  spawner = fn;
}

/**
 * RAM-only store of launches still being watched. Charter: explain the first
 * ~3 seconds of a launch, and report ones that never became a real session.
 * This is NOT a session registry — the transcript stays the single source of
 * truth, the same division `pending.ts`/`plans.ts`/`messages.ts` keep small. A
 * launch that succeeds leaves no trace here once `adoptLaunched` sees its id;
 * a restart drops every entry, live children included.
 *
 * No timer: the three other stores each own a reaper because something must
 * fire without a reader, but the client already polls every 3s, so expiry is
 * evaluated lazily inside {@link listLaunching} instead — see its doc comment.
 */
interface Entry {
  sessionId: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  startedAtMs: number;
  state: 'launching' | 'failed';
  exitCode?: number;
  error?: string;
  /** When `state` became `'failed'`; undefined while still `'launching'`. Kept separate from `startedAtMs` so `FAIL_TTL_MS` measures time-since-failure, not time-since-launch. */
  failedAtMs?: number;
  /** The live child, for `stopLaunch`. Null only in the (rare) synchronous-throw path. */
  child: ChildProcess | null;
}

const entries = new Map<string, Entry>();

/** Stderr tail kept on a failed launch, in characters. Bounds memory regardless of how much a crashing process writes. */
export const STDERR_TAIL_CAP = 2048;

/** How long a `launching` entry survives with no adoption before `listLaunching` treats it as orphaned. */
export const LAUNCH_TTL_MS = 60_000;

/** How long a `failed` entry survives after failing, so a phone that never looks does not accumulate them. */
export const FAIL_TTL_MS = 5 * 60_000;

/** Characters of the prompt kept in the store for display. The child on stdin still gets the full, untruncated prompt. */
export const PROMPT_PREVIEW_CAP = 120;

/**
 * How many un-adopted launches may sit in this store before `serveSpawn`
 * answers 429 (`api.ts`). The accident rail, not a security boundary: a caller
 * with launch rights can simply prompt one session into spawning more, so this
 * exists to stop a *mistake* — a retry loop, a flaky phone connection, a
 * double-tap that beats React's re-render — from becoming N real `claude`
 * processes burning the account's quota. `transcribe.ts` single-flights its own
 * child for the same reason.
 *
 * ⚠️ What this counter spans is only the pre-adoption window (~3s, until
 * `adoptLaunched` sees the id on disk) plus `FAIL_TTL_MS` for entries that
 * failed. It therefore bounds **rapid-fire POSTs**, not the number of live
 * sessions — ten launches a minute apart all succeed, because each has left
 * the store before the next arrives. That is deliberate: capping live sessions
 * would need the session registry this store is explicitly not (see the store's
 * charter above). The flip side of counting `failed` entries too: four launches
 * that failed back-to-back keep answering 429 until they age out, which for a
 * rail whose job is damping a retry loop is the wanted behaviour.
 */
export const MAX_LAUNCHING = 4;

function toPublic(e: Entry): LaunchingSession {
  const out: LaunchingSession = {
    sessionId: e.sessionId,
    projectName: e.projectName,
    projectPath: e.projectPath,
    prompt: e.prompt,
    startedAtMs: e.startedAtMs,
    state: e.state
  };
  if (e.exitCode !== undefined) out.exitCode = e.exitCode;
  if (e.error !== undefined) out.error = e.error;
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mark an entry failed. A no-op if it is already gone — adopted, or already
 * expired out of the map — so a late `exit`/`error` can never resurrect an
 * entry `adoptLaunched` already removed.
 */
function fail(sessionId: string, exitCode: number | undefined, error: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.state = 'failed';
  entry.exitCode = exitCode;
  entry.error = error;
  entry.failedAtMs = Date.now();
}

/**
 * Start a new headless `claude -p` session in `ref`'s directory. Mints the
 * session id, registers the store entry *before* spawning (so a spawner that
 * throws synchronously still has somewhere to record the failure), spawns
 * detached with the prompt piped to stdin, and returns the id immediately —
 * the caller never waits on the child.
 *
 * Failure can reach the store from four independent places, and all four
 * route through {@link fail}, which is safe to call more than once (or after
 * the entry is gone): a synchronous throw from the spawner itself; the
 * child's own `'error'` event (e.g. a typo'd `CLAUDE_BIN` — async ENOENT,
 * which the cached probe never catches); an `'error'` on the `stdin`/`stderr`
 * streams themselves (a stream is its own `EventEmitter` — an unhandled
 * `'error'` there, e.g. a write-side EPIPE, throws and takes the whole
 * process down, independently of the child's own `'error'` handler); and a
 * nonzero/non-null `'exit'`. `'close'` only *refines* the exit-time message
 * once stdio has actually finished draining — see its handler below for why
 * it cannot simply replace `'exit'`.
 */
export function launch(config: Config, ref: ProjectRef, input: Omit<SpawnInput, 'sessionId'>): string {
  const sessionId = randomUUID();
  const entry: Entry = {
    sessionId,
    projectName: ref.name,
    projectPath: ref.path,
    prompt: input.prompt.slice(0, PROMPT_PREVIEW_CAP),
    startedAtMs: Date.now(),
    state: 'launching',
    child: null
  };
  entries.set(sessionId, entry);

  const args = buildSpawnArgs({ ...input, sessionId });
  const doSpawn = spawner ?? nodeSpawn;

  let child: ChildProcess;
  try {
    child = doSpawn(config.claudeBin, args, { cwd: ref.path, detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (err) {
    fail(sessionId, undefined, errMessage(err));
    return sessionId;
  }
  entry.child = child;

  // A stream is its own EventEmitter with its own 'error' event; the child's
  // 'error' handler further down does NOT cover it. Without a listener here,
  // an async EPIPE (the child dies, or never reads stdin, before the write
  // finishes) throws unhandled and takes this whole process down — observed
  // on Node 22. Attached before the write/end below on principle, though the
  // error, being async, cannot land synchronously inside them.
  child.stdin?.on('error', err => {
    fail(sessionId, undefined, errMessage(err));
  });
  child.stdin?.write(input.prompt);
  child.stdin?.end();

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CAP);
  });
  child.stderr?.on('error', err => {
    fail(sessionId, undefined, errMessage(err));
  });
  child.on('exit', (code, signal) => {
    // A clean (code 0) exit is left alone: a fast run can finish before the
    // next scan ever sees it, and the transcript — not the exit — is what
    // matters then. Adoption or the launching-state TTL settle it from here.
    if (code === 0) return;
    fail(sessionId, code ?? undefined, stderrTail || (signal ? `terminated by signal ${signal}` : `exited with code ${code}`));
  });
  child.on('close', (code, signal) => {
    // Node documents 'exit' as able to fire before a child's stdio has
    // actually finished draining — `transcribe.ts`'s own child runner reads
    // on 'close' for exactly this reason — so stderrTail can still grow
    // between the 'exit' handler above and this one. This handler only
    // *refines* the message with whatever arrived since; it must not become
    // the sole path, because a spawn that never started at all (bad
    // `claudeBin`) fires no 'exit' and reaches 'close' with a synthetic
    // negative libuv code (e.g. -2 ENOENT, -13 EACCES) — refining on that
    // would clobber the far more useful message the 'error' handler below
    // already set. Guard on all three: a tail actually arrived, `code` is
    // not the signal-kill `null`, and `code` is a genuine positive exit code
    // (0 is deliberately excluded too — the same clean-exit rule as above,
    // since a process can write stray, non-fatal output to stderr and still
    // exit 0).
    if (!stderrTail || code === null || code <= 0) return;
    fail(sessionId, code, stderrTail);
  });
  child.on('error', err => {
    fail(sessionId, undefined, errMessage(err));
  });

  child.unref();
  return sessionId;
}

/**
 * Every launch the store still remembers, minus whatever just expired.
 * Expiry is evaluated lazily here rather than on a timer: `pending.ts`/
 * `plans.ts`/`messages.ts` each need a reaper because nothing else would ever
 * read their entries, but the dashboard already polls every 3s, so the next
 * `listLaunching` call is strictly simpler and cannot hold the process open.
 *
 * `now` is a parameter, not `Date.now()` read internally, so a test can
 * simulate elapsed time without faking the clock.
 */
export function listLaunching(now: number = Date.now()): LaunchingSession[] {
  const out: LaunchingSession[] = [];
  for (const [id, entry] of entries) {
    if (entry.state === 'launching' && now - entry.startedAtMs > LAUNCH_TTL_MS) {
      entries.delete(id);
      continue;
    }
    if (entry.state === 'failed' && now - (entry.failedAtMs ?? entry.startedAtMs) > FAIL_TTL_MS) {
      entries.delete(id);
      continue;
    }
    out.push(toPublic(entry));
  }
  return out;
}

/**
 * The sessions handler calls this with the ids it just scanned off disk,
 * before serializing its response — a launch that became a real session
 * leaves no trace here. Returns how many entries were removed.
 */
export function adoptLaunched(ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    if (entries.delete(id)) n++;
  }
  return n;
}

/**
 * SIGTERM the live child behind a still-`launching` entry, and remove the
 * entry immediately. A launch the user asked to stop should vanish from the
 * list right away, not linger as a `failed` row for `FAIL_TTL_MS` (5 minutes)
 * once the real `exit` eventually arrives labelled as an error the user
 * never actually hit — the two-state union has no way to say "you stopped
 * this" separately from "it crashed," and widening it would drift a
 * shared-contract type Tasks 3/4 already consume. The later `exit`/`close`
 * for this id finds no entry and no-ops through `fail`'s presence guard, the
 * same as any exit arriving after `adoptLaunched`.
 *
 * False for an unknown id or one that has already left the `launching` state
 * (nothing left alive to signal).
 */
export function stopLaunch(id: string): boolean {
  const entry = entries.get(id);
  if (!entry || entry.state !== 'launching' || !entry.child) return false;
  entry.child.kill('SIGTERM');
  entries.delete(id);
  return true;
}

/** Test seam: drop every entry. No timers to clear — this store, deliberately, has none. */
export function resetLaunches(): void {
  entries.clear();
}
