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
 *   6. `listLaunching` / `adoptLaunched` / `stopSession` — the store's read,
 *      adopt, and stop operations; see its own doc comment below for charter.
 *      The store keeps a spawned child's handle for as long as it lives, so a
 *      session can be stopped from the dashboard at any point, not just during
 *      its pre-adoption window. Every signal goes through one guarded helper
 *      (`signalGroup`) that only ever targets a process this server spawned.
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
import type { LaunchingSession, PermissionMode, ProjectRef, StopState } from '../../shared/types.js';

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
  /** Launch with `--remote-control`: the session registers with the account and is drivable from the phone app (docs/subsystems/spawn.md). */
  remoteControl?: boolean;
  /**
   * Resume `sessionId` instead of starting it fresh: argv carries
   * `--resume <sessionId>` and NO `--session-id` — the CLI refuses that pair
   * without `--fork-session`, and a fork is exactly what resume must not do
   * (verified on 2.1.233: plain `--resume` keeps the id and appends to the
   * same transcript, which is what makes the dashboard row wake up).
   */
  resume?: boolean;
}

/**
 * The charset a `resume` session id must match before it is looked up — the
 * same shape `api.ts`'s `ID_RE` holds every `:id` path segment to. Duplicated
 * rather than imported: this module stays free of the handler layer.
 */
const RESUME_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Result of validating an untrusted POST body against {@link SpawnInput}. */
export type ParseResult =
  | { ok: true; input: Omit<SpawnInput, 'sessionId'>; resumeId?: string }
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
  // Strictly `=== true`: anything else (absent, "yes", 1) fails soft to false,
  // the same drop-don't-reject rule the fields above follow.
  const remoteControl = b.remoteControl === true;

  // `resume` is the one optional field that REJECTS when present-but-malformed
  // instead of dropping: silently ignoring it would launch a fresh session
  // somewhere the user never asked for, which is worse than any 400. A valid
  // one also forces the identity fields off — `-n` renames and
  // `--remote-control` registration on a resumed session are unverified CLI
  // combos, so they are never sent.
  if (b.resume !== undefined) {
    if (typeof b.resume !== 'string' || b.resume === '' || !RESUME_ID_RE.test(b.resume)) {
      return { ok: false, error: 'bad resume id' };
    }
    return {
      ok: true,
      input: { prompt, permissionMode, name: undefined, model, effort, remoteControl: false },
      resumeId: b.resume
    };
  }

  return { ok: true, input: { prompt, permissionMode, name, model, effort, remoteControl } };
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
  // Resume swaps how the id is passed and nothing else: `--resume <id>` in
  // place of `--session-id <id>` (the CLI refuses the pair without
  // `--fork-session`). Every append below stays mode-agnostic.
  const args = input.resume
    ? ['-p', '--resume', input.sessionId, '--permission-mode', input.permissionMode]
    : ['-p', '--session-id', input.sessionId, '--permission-mode', input.permissionMode];
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.name) args.push('-n', input.name);
  // `--remote-control [name]` takes its own optional name; without it the
  // account registration auto-names itself `<hostname>-N`. Reuse the form's
  // (already charset-validated) name so the phone app shows the same label.
  if (input.remoteControl) {
    args.push('--remote-control');
    if (input.name) args.push(input.name);
  }
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
 * Delivers a signal. Receives the pid *already negated* into a process-group
 * target, exactly as `process.kill` would — so a test asserting `-pid` is
 * asserting the negation itself, not re-deriving it. See {@link setGroupKiller}.
 */
export type GroupKiller = (pid: number, signal: string) => void;

let groupKiller: GroupKiller | null = null;

/**
 * Test seam: swap what actually delivers a group signal. `null` restores
 * `process.kill`.
 *
 * Required, not a convenience, and the mirror of {@link setSpawner}: the
 * suite's fake children carry made-up pids, and without this seam every stop
 * test would hand one of them to the real `process.kill` — signalling whatever
 * unrelated process on the developer's machine happens to own that number.
 */
export function setGroupKiller(fn: GroupKiller | null): void {
  groupKiller = fn;
}

/**
 * Signal the whole process group behind `child` — the CLI, and every MCP
 * server, bash tool and grandchild it started. `launch` spawns `detached`, so
 * the child leads its own group and its pid *is* the pgid; the negation is what
 * POSIX reads as "the group", and it is why stopping a session actually stops
 * the work rather than orphaning six processes (measured: SIGTERM on the
 * negated pgid reaped a real `claude -p` plus five grandchildren in ~1.1s).
 *
 * Refuses unless all four hold, and every clause is load-bearing:
 *
 *  - **`typeof pid === 'number'` and `pid > 1`.** This is the dangerous one.
 *    POSIX `kill(0, sig)` signals *every process in the caller's own group*, so
 *    a pid of 0 — which is what an absent/zeroed pid coerces to — would take
 *    down this dashboard and the terminal that started it. `1` is init.
 *  - **`exitCode === null` and `signalCode === null`.** The child is still
 *    live. Signalling a reaped pgid is at best a no-op and at worst reaches a
 *    recycled group, and this is also what stops the escalation timer from
 *    firing SIGKILL at a session that already exited cleanly.
 *
 * The security rule the whole feature rests on lives here: only ever signal a
 * process this server spawned and still holds a handle to. No pid from a
 * request body, no `ps` scan.
 *
 * Returns whether a signal was actually delivered. A lost race throws ESRCH
 * (the group died between the liveness check and the call) — swallowed, since
 * no caller's verdict changes: the process the user asked to stop is gone.
 */
function signalGroup(child: ChildProcess | null, signal: string): boolean {
  const pid = signalablePid(child);
  if (pid === null) return false;
  const kill = groupKiller ?? ((p: number, s: string): void => { process.kill(p, s as NodeJS.Signals); });
  // Negated here, once, so exactly one line in the codebase turns a pid into a
  // process-group target — and so a test asserting `-pid` is asserting that
  // this line ran, rather than re-deriving the negation itself.
  try { kill(-pid, signal); } catch { /* ESRCH: already gone, which is the goal */ }
  return true;
}

/**
 * The pid whose group may be signalled for `child`, or null when it must not
 * be. The guard above, split out and returning the pid so the caller needs no
 * cast — and reused by {@link stopStates} and {@link stopSession}, because this
 * is also the honest definition of "stoppable": a session whose handle fails
 * these checks is exactly as unstoppable as one this server never held, so it
 * must be omitted from the map and answer `'not-found'` rather than have a stop
 * claimed for it that can never be delivered.
 */
function signalablePid(child: ChildProcess | null): number | null {
  if (!child) return null;
  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 1) return null;
  return childAlive(child) ? pid : null;
}

/**
 * RAM-only store of launches still being watched. Charter: explain the first
 * ~3 seconds of a launch, report ones that never became a real session — and,
 * since the Stop control, **hold the live `ChildProcess` handle for as long as
 * the child lives**, so a session this server started can be signalled later.
 *
 * That handle is the whole of the widening, and it is deliberately the *only*
 * widening. This is still NOT a session registry: the transcript stays the
 * single source of truth for what a session is and what it did, the same
 * division `pending.ts`/`plans.ts`/`messages.ts` keep small. What the store now
 * answers is narrower — "do I personally hold a killable handle for this id?" —
 * and it can only ever answer yes for a child this process spawned itself.
 *
 * Persisting pids instead (so a restart could still stop them) was refused:
 * pids are reused. A pid recorded before a restart may belong to something else
 * entirely by the time anyone presses Stop, and a stale record is indistinguishable
 * from a live one, so the failure mode is signalling an innocent process. A handle
 * cannot be stale — it dies with the process that holds it. The cost is stated
 * where the user can see it: after a dashboard restart the handle is gone, so
 * `stopStates()` omits the id and no Stop control renders on that row.
 *
 * A restart still drops every entry, live children included — `detached` +
 * `unref()` is deliberate, and restarting the dashboard while sessions work is
 * an ordinary thing to do, so there is no shutdown reaper.
 *
 * One timer, and only while a stop is in flight: {@link stopSession} arms the
 * SIGKILL escalation. It is `unref()`ed, so it can never hold the process open,
 * and {@link resetLaunches} clears any that are armed. Expiry is still lazy —
 * the client polls every 3s, so it is evaluated inside {@link listLaunching}.
 */
interface Entry {
  sessionId: string;
  projectName: string;
  projectPath: string;
  prompt: string;
  startedAtMs: number;
  /**
   * `'running'` is internal-only — an adopted (or TTL-promoted) child that is
   * still alive. {@link listLaunching} never emits one and {@link toPublic} is
   * never called for one, so the public `LaunchingSession.state` union stays
   * the two-state contract Tasks 3/4 already consume.
   */
  state: 'launching' | 'running' | 'failed';
  exitCode?: number;
  error?: string;
  /** When `state` became `'failed'`; undefined while still `'launching'`. Kept separate from `startedAtMs` so `FAIL_TTL_MS` measures time-since-failure, not time-since-launch. */
  failedAtMs?: number;
  /**
   * This launch resumes an existing session rather than starting one — its id
   * already names a transcript on disk, so `adoptLaunched` must skip it (the
   * first poll would otherwise delete it instantly, swallowing any failure).
   * It leaves the store via the same TTLs, `stopSession`, or a failure.
   */
  resume: boolean;
  /** The live child, for {@link stopSession}. Null only in the (rare) synchronous-throw path. */
  child: ChildProcess | null;
  /**
   * When a graceful stop was asked for; undefined until then. Set on a
   * `'running'` entry only, and it is what makes {@link stopSession} idempotent
   * (a double-tap must not re-signal) and what {@link escalateStop} measures
   * `STOP_GRACE_MS` from.
   */
  stopRequestedAtMs?: number;
  /** The armed SIGKILL escalation, so {@link resetLaunches} can clear it. */
  escalateTimer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();

/** Stderr tail kept on a failed launch, in characters. Bounds memory regardless of how much a crashing process writes. */
export const STDERR_TAIL_CAP = 2048;

/**
 * How long a `launching` entry survives with no adoption before `listLaunching`
 * stops treating it as a launch. Its child is not necessarily orphaned at that
 * point — if it is still alive the entry is *promoted* to `'running'` rather
 * than dropped (see {@link listLaunching}).
 */
export const LAUNCH_TTL_MS = 60_000;

/**
 * How long a graceful stop waits before {@link escalateStop} escalates to
 * SIGKILL.
 *
 * A constant, not a config setting: `LAUNCH_TTL_MS`, `FAIL_TTL_MS` and
 * `MAX_LAUNCHING` are all exported constants for the same reason — an env var
 * would drag `.env.example`, `README.md`, `docs/workflows/configuration.md` and
 * `config.ts` along for a number nobody tunes.
 *
 * 5 seconds, not the ~30 the idea first guessed. This grace is not "let real
 * work finish" — the user pressed Stop — it is only "let the CLI flush and exit
 * on SIGTERM before we SIGKILL it".
 */
export const STOP_GRACE_MS = 5_000;

/** How long a `failed` entry survives after failing, so a phone that never looks does not accumulate them. */
export const FAIL_TTL_MS = 5 * 60_000;

/** Characters of the prompt kept in the store for display. The child on stdin still gets the full, untruncated prompt. */
export const PROMPT_PREVIEW_CAP = 120;

/**
 * How many entries still in the `'launching'` state may sit in this store
 * before `serveSpawn` answers 429 (`api.ts`). The accident rail, not a security
 * boundary: a caller with launch rights can simply prompt one session into
 * spawning more, so this exists to stop a *mistake* — a retry loop, a flaky
 * phone connection, a double-tap that beats React's re-render — from becoming N
 * real `claude` processes burning the account's quota. `transcribe.ts`
 * single-flights its own child for the same reason.
 *
 * What it counts is deliberately narrow, on both axes:
 *
 *  - **`'launching'` only.** A `failed` entry lingers for `FAIL_TTL_MS`
 *    (5 minutes) purely so the UI can explain itself, and it holds no process
 *    at all — letting it hold a slot would lock a user out of launching for
 *    five minutes after four transient failures, with a 429 that explains
 *    nothing. The rail bounds concurrent *processes*, so it counts them.
 *  - **The pre-adoption window only** (~3s, until `adoptLaunched` sees the id
 *    on disk). It therefore bounds **rapid-fire POSTs**, not the number of live
 *    sessions — ten launches a minute apart all succeed, because each has left
 *    the store before the next arrives. Capping live sessions would need the
 *    session registry this store is explicitly not (see the charter above).
 */
export const MAX_LAUNCHING = 4;

/**
 * `state` is passed in rather than read off `e` so the compiler enforces what
 * the charter asserts: `'running'` is internal-only and never crosses into the
 * public `LaunchingSession` union. `listLaunching`, the sole caller, has already
 * skipped those entries, and narrowing at the call site is what proves it —
 * where reading `e.state` here would need a cast that asserts the invariant away.
 */
function toPublic(e: Entry, state: LaunchingSession['state']): LaunchingSession {
  const out: LaunchingSession = {
    sessionId: e.sessionId,
    projectName: e.projectName,
    projectPath: e.projectPath,
    prompt: e.prompt,
    startedAtMs: e.startedAtMs,
    state
  };
  if (e.exitCode !== undefined) out.exitCode = e.exitCode;
  if (e.error !== undefined) out.error = e.error;
  if (e.resume) out.resume = true;
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this child still running? Both codes are null until it ends, then exactly
 * one of them is set (`exitCode` for a normal exit, `signalCode` for a kill) —
 * so checking either alone misreads the other kind of death as still-alive.
 */
function childAlive(child: ChildProcess | null): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/**
 * Drop a `'running'` entry (and disarm any escalation it had armed), reporting
 * whether it did. False for an unknown id or an entry in any other state, which
 * is what lets the exit handlers use it as a guard: `launching` and `failed`
 * entries fall through to the behaviour they have always had.
 */
function dropIfRunning(sessionId: string, child: ChildProcess): boolean {
  const entry = entries.get(sessionId);
  if (!entry || entry.state !== 'running') return false;
  if (!ownedBy(entry, child)) return false;
  // The child is already gone; an armed SIGKILL has nothing left to reach, and
  // leaving it armed keeps a dead entry's timer alive for the rest of the grace.
  if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
  entries.delete(sessionId);
  return true;
}

/**
 * Does `entry` still belong to `child`?
 *
 * Every handler `launch` registers closes over a **session id**, not over the
 * entry, and re-looks it up when it fires. An id is not unique over time: a
 * resume reuses the transcript's id deliberately, so a second `launch` for the
 * same id can replace the entry while the first child is still alive. Without
 * this check the first child's eventual `'exit'` reaches whatever entry now
 * holds that id and deletes or fails it — a live session losing its handle
 * because an unrelated, older process finally died.
 *
 * That is precisely the promise the store's charter makes ("hold the live
 * handle for as long as the child lives"), so the check belongs on every path a
 * stale handler can reach: this, and {@link fail}.
 */
function ownedBy(entry: Entry, child: ChildProcess): boolean {
  return entry.child === child;
}

/**
 * Mark an entry failed. A no-op if it is already gone — adopted, or already
 * expired out of the map — so a late `exit`/`error` can never resurrect an
 * entry `adoptLaunched` already removed.
 */
function fail(sessionId: string, exitCode: number | undefined, error: string, child?: ChildProcess): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  // Same id-reuse guard as `dropIfRunning`: a stale handler must not mark a
  // *newer* entry failed, which would draw a red "launch failed" row for a
  // launch that is running perfectly well. `child` is omitted only on the
  // synchronous-throw path, where no child object exists to compare against and
  // the entry can only be the one just created.
  if (child && !ownedBy(entry, child)) return;
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
export function launch(
  config: Config, ref: ProjectRef, input: Omit<SpawnInput, 'sessionId'>, resumeId?: string
): string {
  // A resume reuses the transcript's own id — minting one would tell the CLI
  // to fork, and the handler needs the same id back to keep the row stable.
  const sessionId = resumeId ?? randomUUID();
  const entry: Entry = {
    sessionId,
    projectName: ref.name,
    projectPath: ref.path,
    prompt: input.prompt.slice(0, PROMPT_PREVIEW_CAP),
    startedAtMs: Date.now(),
    state: 'launching',
    resume: resumeId !== undefined,
    child: null
  };
  // A resume reuses an existing id, so this `set` can replace a live entry —
  // the store is keyed by id and cannot hold two children for one. `serveSpawn`
  // is what stops that happening (it 409s on `hasLiveChild`); this only makes
  // sure the replaced entry cannot leave an armed SIGKILL behind with nothing
  // left able to clear it, since `dropIfRunning`/`resetLaunches` reach entries
  // by id and would never see it again.
  const replaced = entries.get(sessionId);
  if (replaced?.escalateTimer) clearTimeout(replaced.escalateTimer);
  entries.set(sessionId, entry);

  const args = buildSpawnArgs({ ...input, sessionId, resume: resumeId !== undefined });
  const doSpawn = spawner ?? nodeSpawn;

  // The child inherits this server's environment — minus CLAUDE_CODE_ENTRYPOINT.
  // A server started from inside another Claude Code context (a desktop-app
  // terminal, a Claude-driven shell) carries that marker, and a child that
  // inherits it stamps it into the transcript instead of `sdk-cli` — losing the
  // `dashboard` pill and the right to be resumed (`sessionSurface`, scan.ts).
  // Measured both ways on CLI 2.1.233: with the variable the transcript says
  // `claude-desktop`; without it a `-p` run says `sdk-cli`. `delete`, not an
  // `undefined` assignment: this Node build happens to omit undefined-valued
  // keys (measured), but that is filtering behaviour to not lean on — an
  // absent key needs no guarantee at all.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;

  let child: ChildProcess;
  try {
    child = doSpawn(config.claudeBin, args, { cwd: ref.path, env, detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
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
    fail(sessionId, undefined, errMessage(err), child);
  });
  child.stdin?.write(input.prompt);
  child.stdin?.end();

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CAP);
  });
  child.stderr?.on('error', err => {
    fail(sessionId, undefined, errMessage(err), child);
  });
  child.on('exit', (code, signal) => {
    // A `running` entry that exits is simply over — delete it, whatever the
    // code, and before any `fail` logic can see it. It was a real session with
    // a real row for however long it lived; resurrecting it as a red "launch
    // failed" phantom because it ended nonzero (or because the user stopped it,
    // which exits by signal) would be a lie about a launch that plainly worked.
    if (dropIfRunning(sessionId, child)) return;
    // A clean (code 0) exit is left alone: a fast run can finish before the
    // next scan ever sees it, and the transcript — not the exit — is what
    // matters then. Adoption or the launching-state TTL settle it from here.
    if (code === 0) return;
    fail(sessionId, code ?? undefined, stderrTail || (signal ? `terminated by signal ${signal}` : `exited with code ${code}`), child);
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
    // Same delete-first rule as 'exit'. Reached on its own when the child died
    // in a way that produced no 'exit' at all (a spawn that never started), and
    // harmless when 'exit' already dropped the entry — `dropIfRunning` is a
    // no-op for an id that has left the map.
    if (dropIfRunning(sessionId, child)) return;
    if (!stderrTail || code === null || code <= 0) return;
    fail(sessionId, code, stderrTail, child);
  });
  child.on('error', err => {
    fail(sessionId, undefined, errMessage(err), child);
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
    // A `running` entry is a real session with a row of its own from the scan.
    // It is neither reported here (that would draw a second, phantom "launching"
    // row for it) nor TTL'd (its handle is the point — it leaves when the child
    // exits, not when a clock runs out).
    if (entry.state === 'running') continue;
    if (entry.state === 'launching' && now - entry.startedAtMs > LAUNCH_TTL_MS) {
      // Past the TTL this is no longer a *launch*, but that says nothing about
      // the child. If it is still alive, promote rather than drop: losing the
      // handle would silently make a live session unstoppable. This is also the
      // only route to `running` a resume entry has — `adoptLaunched` skips those
      // on purpose — so a resumed session becomes stoppable here, and not before
      // (the documented LAUNCH_TTL_MS blind spot).
      if (childAlive(entry.child)) entry.state = 'running';
      else entries.delete(id);
      continue;
    }
    if (entry.state === 'failed' && now - (entry.failedAtMs ?? entry.startedAtMs) > FAIL_TTL_MS) {
      entries.delete(id);
      continue;
    }
    out.push(toPublic(entry, entry.state));
  }
  return out;
}

/**
 * The sessions handler calls this with the ids it just scanned off disk, before
 * serializing its response — a launch that became a real session stops being
 * reported as one. It no longer *removes* the entry: the entry transitions to
 * `'running'` and keeps its child handle, which is what makes the session
 * stoppable for the rest of its life. `listLaunching` skips `running` entries,
 * so the visible effect is unchanged.
 *
 * Returns how many entries this call transitioned. An id already `running`
 * counts 0 — adoption happens once, and the dashboard re-scans the same id
 * every 3s thereafter.
 */
export function adoptLaunched(ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    // A resume entry's id names a transcript that already exists, so seeing it
    // in a scan proves nothing — adopting it here would swallow a failure
    // before the user's next poll could ever render it. Resume entries reach
    // `running` from the other end, via the TTL promotion in `listLaunching`,
    // and otherwise leave through `stopSession` or a failure.
    const entry = entries.get(id);
    if (!entry || entry.resume || entry.state !== 'launching') continue;
    entry.state = 'running';
    n++;
  }
  return n;
}

/**
 * What a stop request did. `'stopping'` is the honest answer for the graceful
 * path: SIGTERM is a request, and whether the child honours it is not knowable
 * synchronously — the escalation to SIGKILL is what makes it eventually true.
 */
export type StopResult = 'not-found' | 'stopped' | 'stopping';

/**
 * Stop a session this server spawned. The one entry point for both halves of a
 * spawned child's life — a launch still inside its pre-adoption window, and a
 * session that has been running for an hour.
 *
 *  - unknown id, a `failed` entry, or an entry with no child handle →
 *    `'not-found'`. Nothing is signalled. This is also the post-restart case:
 *    the handle died with the old process, so there is nothing to stop.
 *  - a `launching` entry → the pre-adoption behaviour, unchanged: SIGTERM the
 *    *handle* (not the group) and remove the entry immediately, so a launch the
 *    user stopped vanishes from the list rather than lingering as a `failed`
 *    row for `FAIL_TTL_MS` labelled as an error they never hit. `'stopped'`.
 *  - a `running` entry with a stop already in flight → `'stopping'`, and **no
 *    second signal**. A double-tap on a phone must not re-signal, and must not
 *    push the escalation deadline back.
 *  - a `running` entry otherwise → record the request, SIGTERM the group, arm
 *    the SIGKILL escalation, `'stopping'`.
 *
 * `now` is a parameter for the same reason `listLaunching`'s is: the suite's
 * runner is synchronous, so a test drives the grace window by passing times
 * rather than by waiting.
 */
export function stopSession(id: string, now: number = Date.now()): StopResult {
  const entry = entries.get(id);
  if (!entry || !entry.child || entry.state === 'failed') return 'not-found';

  if (entry.state === 'launching') {
    entry.child.kill('SIGTERM');
    entries.delete(id);
    return 'stopped';
  }

  if (entry.stopRequestedAtMs !== undefined) return 'stopping';
  // Checked before anything is recorded: marking an entry `stopping` when the
  // signal could never land would leave the row saying `stopping…` forever,
  // with no escalation able to finish it.
  if (signalablePid(entry.child) === null) return 'not-found';

  entry.stopRequestedAtMs = now;
  signalGroup(entry.child, 'SIGTERM');
  // unref'd so a pending escalation can never hold the process open — the same
  // rule every timer in this codebase follows. Cleared by `dropIfRunning` when
  // the child exits first, which is the ordinary case.
  entry.escalateTimer = setTimeout(() => { escalateStop(id); }, STOP_GRACE_MS);
  entry.escalateTimer.unref?.();
  return 'stopping';
}

/**
 * SIGKILL a running session's group outright, skipping the grace window — what
 * the UI's `force stop` sends when the user will not wait.
 *
 * `running` entries only. A `launching` entry answers `'not-found'`: that path
 * is already an immediate kill, so there is nothing to escalate past.
 *
 * Deletion is deliberately left to the `'exit'` handler rather than done here.
 * SIGKILL cannot be caught, so an exit always follows, and letting the one
 * handler own removal keeps a single path out of the store.
 */
export function forceStopSession(id: string): StopResult {
  const entry = entries.get(id);
  if (!entry || entry.state !== 'running') return 'not-found';
  if (!signalGroup(entry.child, 'SIGKILL')) return 'not-found';
  return 'stopped';
}

/**
 * Escalate a graceful stop to SIGKILL once the grace has elapsed. Reports
 * whether it actually signalled.
 *
 * Exported, and taking `now`, so the synchronous test runner can drive it
 * directly — the armed timer's callback is nothing but a call to this.
 *
 * False (and silent) unless every one of these holds: the entry still exists,
 * it is `running`, a stop was actually requested, `STOP_GRACE_MS` has elapsed
 * since, and the child is still alive. That last clause is what keeps a
 * SIGKILL from being fired at a session that already exited on the SIGTERM —
 * by then the pgid may belong to something else entirely.
 */
export function escalateStop(id: string, now: number = Date.now()): boolean {
  const entry = entries.get(id);
  if (!entry || entry.state !== 'running') return false;
  if (entry.stopRequestedAtMs === undefined) return false;
  if (now - entry.stopRequestedAtMs < STOP_GRACE_MS) return false;
  return signalGroup(entry.child, 'SIGKILL');
}

/**
 * Which spawned sessions can be stopped right now, and whether a stop is
 * already under way. Injected into the scan by the sessions handler, the same
 * way `messageSessionIds()` is — a Map rather than a Set because the one field
 * carries two states.
 *
 * Only `running` entries with a live child appear. An id that is absent means
 * "not stoppable", which is the honest answer for a terminal-started session,
 * for a resume still inside its `LAUNCH_TTL_MS` window, and for anything
 * spawned before the last dashboard restart.
 */
export function stopStates(): ReadonlyMap<string, StopState> {
  const out = new Map<string, StopState>();
  for (const [id, entry] of entries) {
    if (entry.state !== 'running' || signalablePid(entry.child) === null) continue;
    out.set(id, entry.stopRequestedAtMs === undefined ? 'ready' : 'stopping');
  }
  return out;
}

/**
 * Does this server still hold a live child for `id`?
 *
 * The same predicate as "is it stoppable" ({@link stopStates}), exposed for the
 * one caller that needs it as a *refusal*: `serveSpawn`'s resume guard. That
 * guard's job is "don't put a second writer on a session that is still running",
 * and until this existed it could only see sessions holding a question, plan or
 * reply socket, plus ones still inside their pre-adoption window
 * (`listLaunching`). It could not see the case this store now knows about — an
 * adopted session, mid-tool-call or lingering after its turn, holding nothing
 * but a live process.
 *
 * Not the whole of that problem: this can only answer for children *this*
 * process spawned, so a terminal session, or one spawned before the last
 * restart, still answers false. What the CLI itself does with two writers on one
 * transcript is `bug-19`.
 */
export function hasLiveChild(id: string): boolean {
  const entry = entries.get(id);
  return !!entry && entry.state === 'running' && signalablePid(entry.child) !== null;
}

/** Test seam: drop every entry, disarming any escalation timers they had armed. */
export function resetLaunches(): void {
  for (const entry of entries.values()) {
    if (entry.escalateTimer) clearTimeout(entry.escalateTimer);
  }
  entries.clear();
}
