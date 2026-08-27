/**
 * token-refresh.ts — renew an expired OAuth token by making the *CLI* do it.
 *
 * The dashboard never writes credentials itself. Direct OAuth refresh was
 * rejected on purpose (undocumented endpoint, and refresh-token rotation can
 * log the CLI out if we take a rotation and drop it) — see
 * docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md. So we ask
 * the thing that owns the credential to renew it, and then re-read the store.
 *
 * Two steps, cheapest first:
 *   1. `claude auth status` — costs nothing.
 *   2. `claude -p ok --model haiku` — one cheap turn, only if step 1 didn't
 *      renew.
 * Success is defined by re-probing the credential store, never by an exit
 * code: `claude` exits 0 in plenty of states that leave the token untouched.
 *
 * ⚠️ Never add `--bare` here. It reads neither OAuth nor the keychain
 * (ANTHROPIC_API_KEY only), so a `--bare` turn would exit 0 having renewed
 * nothing — the exact false success this module's probe exists to catch.
 *
 * The turn runs in a dedicated cwd so the transcript it writes lands under a
 * known project dir, which scan.ts filters out (phantom-session mitigation).
 * Zero runtime deps — Node built-ins only.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `claude auth status` is a local read; it should never take this long. */
const STATUS_TIMEOUT_MS = 15_000;
/** A haiku turn is a network round trip — give it the old, roomier budget. */
const TURN_TIMEOUT_MS = 60_000;
/**
 * How often to re-read the credential store while a spawn is still running.
 * Measured on macOS 2026-08-27: `claude -p` finishes its turn — renewing the
 * token — and then does not exit for 90s+ (unchanged by --strict-mcp-config or
 * --no-session-persistence). Waiting on the *process* would keep serving
 * `token-expired` long after the *token* was good, so watch the credential
 * instead and stop as soon as it turns over.
 */
const PROBE_POLL_MS = 2_000;

/** Backoff after a failed attempt: 5 min, doubling, capped at an hour. */
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** cwd for the spawned turn. Exported so scan.ts can filter its transcript. */
export function refreshCwd(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude', 'dashboard-refresh');
}

export interface SpawnResult {
  /** Exit code; null when the process never ran or was killed (ENOENT/timeout). */
  code: number | null;
  error?: string;
  /** ENOENT — no `claude` on PATH. Distinct from "ran and failed": unfixable here. */
  notFound?: boolean;
}

/** Injectable for tests — the real one execFiles `claude`. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
) => Promise<SpawnResult>;

const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolve) => {
    // Strip API-key/proxy vars: with them the spawned turn could bill an API
    // key or route to a gateway and exit 0 WITHOUT touching the OAuth creds
    // this refresh exists to renew (same misroute class as the usage endpoint
    // vs ANTHROPIC_BASE_URL — see CLAUDE.md "Usage limits").
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_API_BASE_URL;
    const child = execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, env }, (err) => {
      if (!err) return resolve({ code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') {
        return resolve({ code: null, error: 'claude CLI not found on PATH', notFound: true });
      }
      if (e.killed) return resolve({ code: null, error: 'claude timed out' });
      resolve({
        code: typeof e.code === 'number' ? e.code : null,
        error: typeof e.code === 'number' ? `claude exited with code ${e.code}` : e.message
      });
    });
    // Close stdin so a prompt-less turn can never sit waiting on the pipe
    // until the timeout.
    child.stdin?.end();
  });

/** Which step renewed the token — reported so the log can say what it cost. */
export type RefreshStep = 'already-ok' | 'auth-status' | 'spawn-turn';

export type RefreshOutcome =
  | { ok: true; step: RefreshStep }
  | { ok: false; httpStatus: 409 | 502; error: string; cliMissing?: boolean };

export interface RefreshOptions {
  spawner?: Spawner;
  cwd?: string;
  /**
   * Re-read the credential store: `true` once the stored token is usable.
   * Required, not defaulted, so this module never imports usage.ts back —
   * the dependency runs one way, and there is no import cycle to reason about.
   */
  probe: () => boolean;
  /** How often to re-probe while a spawn runs. Tests shorten it. */
  probePollMs?: number;
}

/** What {@link shouldAutoRefresh} decides on. */
export interface AutoRefreshGate {
  inFlight: boolean;
  /** When the last attempt started; 0 = never attempted. */
  lastAttempt: number;
  /** Consecutive failures — resets on success. */
  failures: number;
  /** No CLI on this host (Docker). Nothing here can ever work; stop trying. */
  disabled: boolean;
}

/**
 * How long to wait after `failures` consecutive failures. Pure. Doubling
 * matters because the common failure is *structural* (logged out, no CLI on
 * PATH under a launchd PATH, subscription lapsed) rather than transient, and
 * a fixed retry would spawn a process every minute forever against it.
 */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/**
 * May an automatic refresh start? Pure, so the retry policy is testable
 * without spawning anything.
 */
export function shouldAutoRefresh(gate: AutoRefreshGate, now: number): boolean {
  if (gate.disabled || gate.inFlight) return false;
  if (gate.lastAttempt === 0) return true;
  return now - gate.lastAttempt >= backoffMs(gate.failures);
}

/**
 * Deliberately a *ref'd* timer. Unref'ing it looks tidier — a renewal poll
 * should not hold a process open — but it makes the poll unreliable: with no
 * other ref'd handle, Node exits the moment the last ref'd timer fires and the
 * pending poll never runs (it silently killed the test suite mid-run). The
 * server that calls this is held open by its HTTP listener regardless.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Run one spawn, but stop waiting the moment the credential store goes good.
 * Returns `'renewed'` for that, or the spawn's own result if it settles first.
 * The spawn is left to its own timeout — we simply stop caring about it.
 */
async function spawnWatching(
  start: () => Promise<SpawnResult>,
  probe: () => boolean,
  pollMs: number
): Promise<SpawnResult | 'renewed'> {
  // Settled into a value rather than assigned to a captured `let`: the promise
  // itself carries the outcome, so there is no narrowing to fight and no window
  // where `done` is true but the result has not been written yet.
  const running: Promise<{ ok: true; result: SpawnResult } | { ok: false; error: unknown }> =
    start().then(
      (result) => ({ ok: true as const, result }),
      (error) => ({ ok: false as const, error })
    );
  let done = false;
  void running.then(() => { done = true; });
  while (!done) {
    if (probe()) return 'renewed';
    // Races the spawn so a fast, well-behaved CLI costs no extra wait.
    await Promise.race([running, sleep(pollMs)]);
  }
  const outcome = await running;
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

let inFlight = false;

/**
 * Get the stored token renewed. Single-flight: a second call while one runs
 * bounces with 409. Costs nothing when `claude auth status` suffices, and one
 * haiku turn when it doesn't.
 */
export async function runTokenRefresh(opts: RefreshOptions): Promise<RefreshOutcome> {
  if (inFlight) return { ok: false, httpStatus: 409, error: 'refresh already running' };
  inFlight = true;
  const spawner = opts.spawner || defaultSpawner;
  const cwd = opts.cwd || refreshCwd();
  try {
    // Another cycle may have renewed it while we waited to be called.
    if (opts.probe()) return { ok: true, step: 'already-ok' };
    fs.mkdirSync(cwd, { recursive: true });

    let lastError = '';
    let notFound = 0;
    const note = (r: SpawnResult) => {
      if (r.error) lastError = r.error;
      if (r.notFound) notFound++;
    };

    const pollMs = opts.probePollMs ?? PROBE_POLL_MS;

    // 1. Free path. A non-zero exit here is not fatal — step 2 still might work.
    const status = await spawnWatching(
      () => spawner('claude', ['auth', 'status'], { cwd, timeout: STATUS_TIMEOUT_MS }),
      opts.probe,
      pollMs
    );
    if (status === 'renewed') return { ok: true, step: 'auth-status' };
    note(status);
    if (opts.probe()) return { ok: true, step: 'auth-status' };

    // 2. Cheapest real turn.
    const turn = await spawnWatching(
      () => spawner('claude', ['-p', 'ok', '--model', 'haiku'], { cwd, timeout: TURN_TIMEOUT_MS }),
      opts.probe,
      pollMs
    );
    if (turn === 'renewed') return { ok: true, step: 'spawn-turn' };
    note(turn);
    if (opts.probe()) return { ok: true, step: 'spawn-turn' };

    return {
      ok: false,
      httpStatus: 502,
      error: lastError || 'claude ran but the stored token is still expired',
      // Only when BOTH steps hit ENOENT: one missing binary and one working
      // one would mean PATH is fine and something else failed.
      ...(notFound === 2 ? { cliMissing: true } : {})
    };
  } catch (e) {
    return { ok: false, httpStatus: 502, error: (e as Error).message };
  } finally {
    inFlight = false;
  }
}

/**
 * Process-lifetime gate for the automatic path. Module state rather than a
 * caller-held object so every call site shares one backoff — two poll paths
 * both noticing the same expired token must not each spawn a CLI.
 */
let gate: AutoRefreshGate = { inFlight: false, lastAttempt: 0, failures: 0, disabled: false };

/** A copy of the gate — for tests and for anything that wants to report state. */
export function autoRenewGate(): AutoRefreshGate {
  return { ...gate };
}

/** Tests only. The gate is otherwise process-lifetime by design. */
export function resetAutoRenew(): void {
  gate = { inFlight: false, lastAttempt: 0, failures: 0, disabled: false };
}

export interface AutoRenewOptions {
  /** Re-read the credential store: `true` once the stored token is usable. */
  probe: () => boolean;
  /** Injectable clock (tests). */
  now?: number;
  /** Injectable runner (tests). Defaults to {@link runTokenRefresh}. */
  run?: (o: RefreshOptions) => Promise<RefreshOutcome>;
  spawner?: Spawner;
  cwd?: string;
  /** Called once the token is usable again — e.g. to invalidate a usage cache. */
  onRenewed?: () => void;
}

/**
 * The automatic path: renew if the gate allows it, and record what happened.
 * Never throws and never rejects — it is called from a fetch cycle whose only
 * job is to fail open, so a renewal problem must degrade to "no bars", exactly
 * as before this existed.
 */
export async function autoRenew(opts: AutoRenewOptions): Promise<void> {
  const now = opts.now ?? Date.now();
  if (!shouldAutoRefresh(gate, now)) return;
  gate = { ...gate, inFlight: true, lastAttempt: now };
  try {
    const run = opts.run || runTokenRefresh;
    const r = await run({ probe: opts.probe, spawner: opts.spawner, cwd: opts.cwd });
    if (r.ok) {
      gate = { ...gate, failures: 0 };
      opts.onRenewed?.();
    } else if (r.httpStatus !== 409) {
      // 409 means another call already holds the flight — losing that race is
      // not evidence that renewal is broken, so it must not extend the backoff.
      gate = {
        ...gate,
        failures: gate.failures + 1,
        disabled: gate.disabled || r.cliMissing === true
      };
    }
  } catch {
    gate = { ...gate, failures: gate.failures + 1 };
  } finally {
    gate = { ...gate, inFlight: false };
  }
}
