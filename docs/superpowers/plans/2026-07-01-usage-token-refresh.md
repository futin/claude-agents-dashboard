# Usage-Bar Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the stored OAuth token expires, the header shows "token expired" + a Sync button that makes the server spawn a headless `claude -p` turn so the CLI refreshes its own token.

**Architecture:** `usage.ts` gains a `UsageStatus` alongside the cached limits (`ok` / `token-expired` / `unavailable`), exposed on `SessionsResponse.usageStatus`. A new `server/lib/token-refresh.ts` spawns `claude -p "ok" --model haiku` in a dedicated cwd (`~/.claude/dashboard-refresh/`), single-flight, injectable spawner. `POST /api/usage/refresh` runs it then force-refreshes the usage cache. `scan.ts` filters the phantom transcript the spawn creates. The client renders bars on `ok`, hint+button on `token-expired`, nothing otherwise.

**Tech Stack:** Node built-ins only on the server (zero-dep rule), React + TS on the client, node-assert tests via tsx.

**Spec:** `docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md`

**Conventions that apply everywhere:** ESM with `.js` import suffixes on the server; cross-boundary imports are `import type`; run tests with `pnpm test`, types with `pnpm typecheck`.

---

### Task 1: API contract (`shared/types.ts`)

**Files:**
- Modify: `shared/types.ts`

Types only — no test to write first; `pnpm typecheck` is the verification.

- [ ] **Step 1: Add `UsageStatus` + `UsageRefreshResponse`, extend `SessionsResponse`**

In `shared/types.ts`, insert after the `UsageLimits` interface (after line 54):

```ts
/** Why the header usage section is (or isn't) populated. */
export type UsageStatus = 'ok' | 'token-expired' | 'unavailable';

/** Payload of `POST /api/usage/refresh`. */
export interface UsageRefreshResponse {
  ok: boolean;
  /** Set on failure (409 refresh already running, 502 spawn failed, 404 disabled). */
  error?: string;
  /** Fresh snapshot after a successful refresh. */
  usage?: UsageLimits | null;
  usageStatus?: UsageStatus;
}
```

In `SessionsResponse`, add below the existing `usage` field (after line 109):

```ts
  /**
   * Why `usage` is or isn't populated: 'ok' → bars render; 'token-expired' →
   * stored OAuth token is past expiresAt (recoverable via POST /api/usage/refresh);
   * 'unavailable' → any other fail-open cause (no token, network, bad payload).
   * Absent when SHOW_USAGE is off and on the error snapshot.
   */
  usageStatus?: UsageStatus;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean exit (types are additive).

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat(types): usageStatus + UsageRefreshResponse in API contract"
```

---

### Task 2: Status plumbing in `server/lib/usage.ts` + wiring in `server/api.ts`

One task because renaming `getCachedUsage` → `getCachedUsageState` breaks `api.ts` unless both move together.

**Files:**
- Modify: `server/lib/usage.ts`
- Modify: `server/api.ts:11` and `server/api.ts:36`
- Test: `test/usage.test.ts`

- [ ] **Step 1: Write failing tests for `tokenFromCredsBlob`**

Append inside `run()` in `test/usage.test.ts`, before the `console.log('\nPassed: …` line. `NOW` makes expiry deterministic — the function takes an injected clock.

```ts
  const NOW = 1_700_000_000_000;

  if (test('tokenFromCredsBlob: valid token → ok', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW + 60_000 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'ok', token: 'tok-1' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: past expiresAt → expired', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW - 1 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'expired' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: no expiresAt → ok (never skipped)', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1' } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'ok', token: 'tok-1' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: garbage / missing token → missing', () => {
    assert.deepStrictEqual(usage.tokenFromCredsBlob('not json', NOW), { state: 'missing' });
    assert.deepStrictEqual(usage.tokenFromCredsBlob('{}', NOW), { state: 'missing' });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(JSON.stringify({ claudeAiOauth: {} }), NOW), { state: 'missing' });
  })) p++; else f++;
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `pnpm test`
Expected: the four new cases FAIL (`tokenFromCredsBlob` is not exported / wrong shape); the four existing `mapUsage` cases still pass.

- [ ] **Step 3: Implement in `usage.ts`**

Add near the top (after the imports and constants):

```ts
import type { UsageLimits, RateLimit, UsageStatus } from '../../shared/types.js';

/** Outcome of looking for a stored OAuth token. */
export type TokenState =
  | { state: 'ok'; token: string }
  | { state: 'expired' }
  | { state: 'missing' };
```

(replace the existing `import type { UsageLimits, RateLimit }` line with the three-name version.)

Replace `tokenFromCredsBlob` (lines 79–94) with the exported, clock-injected version. Same parse logic; "expired" becomes a distinct state instead of collapsing to null:

```ts
/**
 * The keychain/file payload is JSON `{ claudeAiOauth: { accessToken, expiresAt, ... } }`.
 * Distinguishes a usable token from an expired one so the client can offer
 * recovery (see token-refresh.ts). We still never refresh creds ourselves.
 */
export function tokenFromCredsBlob(blob: string, now = Date.now()): TokenState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { state: 'missing' };
  }
  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
  if (!token) return { state: 'missing' };
  if (typeof oauth!.expiresAt === 'number' && oauth!.expiresAt <= now) return { state: 'expired' };
  return { state: 'ok', token };
}
```

Replace `readToken` (lines 49–73) so it returns `TokenState`. An expired keychain token still falls through to the creds file (which might hold a fresh one); "expired anywhere" beats "missing":

```ts
export function readToken(): TokenState {
  let sawExpired = false;

  // 1. macOS keychain.
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const t = tokenFromCredsBlob(out);
    if (t.state === 'ok') return t;
    if (t.state === 'expired') sawExpired = true;
  } catch {
    /* no keychain item / not macOS / access denied — try the file */
  }

  // 2. ~/.claude/.credentials.json fallback.
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const t = tokenFromCredsBlob(raw);
    if (t.state === 'ok') return t;
    if (t.state === 'expired') sawExpired = true;
  } catch {
    /* no file — give up */
  }

  return { state: sawExpired ? 'expired' : 'missing' };
}
```

(keep the existing doc comment about the keychain GUI prompt on `readToken`.)

Replace the whole cache section (lines 175–207) with a status-carrying, promise-based version. `refreshing` becomes the in-flight promise so `forceUsageRefresh` can await it:

```ts
// ── Cache: serve a synchronous snapshot; refresh in the background on TTL ──
let cached: UsageLimits | null = null;
let cachedStatus: UsageStatus = 'unavailable';
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

export interface UsageState {
  usage: UsageLimits | null;
  status: UsageStatus;
}

/** One fetch cycle: token → endpoint → cache. Single-flight via `refreshing`. */
function refreshNow(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const t = readToken();
      if (t.state !== 'ok') {
        cached = null;
        cachedStatus = t.state === 'expired' ? 'token-expired' : 'unavailable';
        return;
      }
      const limits = await fetchUsage(t.token);
      cached = limits;
      cachedStatus = limits ? 'ok' : 'unavailable';
    } finally {
      cachedAt = Date.now();
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Current usage snapshot + status (synchronous). Returns the last fetched value
 * and triggers a non-blocking background refresh when stale. The very first
 * call returns `unavailable` until the first fetch lands (next poll picks it up).
 */
export function getCachedUsageState(): UsageState {
  if (!refreshing && (cachedAt === 0 || Date.now() - cachedAt > CACHE_TTL_MS)) void refreshNow();
  return { usage: cached, status: cachedStatus };
}

/**
 * Bypass the TTL and fetch now — used after a token refresh so the new token is
 * picked up immediately. Awaits any in-flight cycle first (it may have started
 * with the old token), then runs a fresh one.
 */
export async function forceUsageRefresh(): Promise<UsageState> {
  if (refreshing) await refreshing;
  await refreshNow();
  return { usage: cached, status: cachedStatus };
}
```

Delete the old `maybeRefresh` and `getCachedUsage` — `getCachedUsageState` replaces both.

- [ ] **Step 4: Wire `api.ts`**

`server/api.ts:11` — change the import:

```ts
import { getCachedUsageState } from './lib/usage.js';
```

`server/api.ts:36` — replace the single usage line:

```ts
  if (config.showUsage) {
    const u = getCachedUsageState();
    data.usage = u.usage;
    data.usageStatus = u.status;
  }
```

- [ ] **Step 5: Run tests + typecheck, verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all pass, including the 4 new usage cases (62 → 66).

- [ ] **Step 6: Commit**

```bash
git add server/lib/usage.ts server/api.ts test/usage.test.ts
git commit -m "feat(usage): carry token/usage status through the cache to the API"
```

---

### Task 3: `server/lib/token-refresh.ts` (spawn + single-flight)

**Files:**
- Create: `server/lib/token-refresh.ts`
- Create: `test/token-refresh.test.ts`
- Modify: `test/run-all.ts`

- [ ] **Step 1: Write the failing test file**

Create `test/token-refresh.test.ts`. Async `run()` — the concurrency case needs a deferred spawner (run-all gains a top-level `await` in step 4):

```ts
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tr from '../server/lib/token-refresh.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function tmpCwd(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-refresh-')), 'dashboard-refresh');
}

export async function run(): Promise<number> {
  console.log('\n=== token-refresh.ts ===\n');
  let p = 0, f = 0;

  if (await test('success: exit 0 → ok, cwd created, claude -p invoked', async () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const spawner: tr.Spawner = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return Promise.resolve({ code: 0 });
    };
    const cwd = tmpCwd();
    const out = await tr.runTokenRefresh(spawner, cwd);
    assert.deepStrictEqual(out, { ok: true });
    assert.ok(fs.existsSync(cwd), 'refresh cwd created');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'claude');
    assert.deepStrictEqual(calls[0].args, ['-p', 'ok', '--model', 'haiku']);
    assert.strictEqual(calls[0].cwd, cwd);
  })) p++; else f++;

  if (await test('non-zero exit → 502 with message', async () => {
    const spawner: tr.Spawner = () => Promise.resolve({ code: 1, error: 'claude exited with code 1' });
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.match(out.error, /exited/);
    }
  })) p++; else f++;

  if (await test('ENOENT (claude not on PATH) → 502 with clear message', async () => {
    const spawner: tr.Spawner = () => Promise.resolve({ code: null, error: 'claude CLI not found on PATH' });
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.match(out.error, /not found/);
    }
  })) p++; else f++;

  if (await test('spawner rejection → 502, in-flight flag released', async () => {
    const spawner: tr.Spawner = () => Promise.reject(new Error('boom'));
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) assert.strictEqual(out.httpStatus, 502);
    // flag released → a following call runs (doesn't 409)
    const again = await tr.runTokenRefresh(() => Promise.resolve({ code: 0 }), tmpCwd());
    assert.deepStrictEqual(again, { ok: true });
  })) p++; else f++;

  if (await test('concurrent call while one runs → 409; first still succeeds', async () => {
    let release!: () => void;
    const gate = new Promise<tr.SpawnResult>((resolve) => { release = () => resolve({ code: 0 }); });
    const slow: tr.Spawner = () => gate;
    const cwd = tmpCwd();
    const first = tr.runTokenRefresh(slow, cwd);          // not awaited — in flight
    const second = await tr.runTokenRefresh(slow, cwd);   // must bounce
    assert.strictEqual(second.ok, false);
    if (!second.ok) assert.strictEqual(second.httpStatus, 409);
    release();
    assert.deepStrictEqual(await first, { ok: true });
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm exec tsx test/token-refresh.test.ts`
Expected: FAIL — cannot find module `../server/lib/token-refresh.js`.

- [ ] **Step 3: Implement `server/lib/token-refresh.ts`**

```ts
/**
 * token-refresh.ts — recover an expired OAuth token by spawning one headless
 * `claude -p` turn. The CLI refreshes and persists its own credentials; the
 * dashboard never writes them (direct OAuth refresh was rejected — see
 * docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md).
 *
 * The turn runs in a dedicated cwd so the transcript it writes lands under a
 * known project dir, which scan.ts filters out (phantom-session mitigation).
 * Zero runtime deps — Node built-ins only.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPAWN_TIMEOUT_MS = 60_000;

/** cwd for the spawned turn. Exported so scan.ts can filter its transcript. */
export function refreshCwd(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude', 'dashboard-refresh');
}

export interface SpawnResult {
  /** Exit code; null when the process never ran or was killed (ENOENT/timeout). */
  code: number | null;
  error?: string;
}

/** Injectable for tests — the real one execFiles `claude`. */
export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number }
) => Promise<SpawnResult>;

const defaultSpawner: Spawner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout }, (err) => {
      if (!err) return resolve({ code: 0 });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return resolve({ code: null, error: 'claude CLI not found on PATH' });
      if (e.killed) return resolve({ code: null, error: 'claude timed out' });
      resolve({
        code: typeof e.code === 'number' ? e.code : null,
        error: typeof e.code === 'number' ? `claude exited with code ${e.code}` : e.message
      });
    });
  });

export type RefreshOutcome =
  | { ok: true }
  | { ok: false; httpStatus: 409 | 502; error: string };

let inFlight = false;

/**
 * Spawn one headless `claude -p "ok" --model haiku` so the CLI refreshes its
 * token. Single-flight: a second call while one runs bounces with 409. Costs
 * one (haiku) subscription turn per successful call — only ever user-initiated.
 */
export async function runTokenRefresh(
  spawner: Spawner = defaultSpawner,
  cwd = refreshCwd()
): Promise<RefreshOutcome> {
  if (inFlight) return { ok: false, httpStatus: 409, error: 'refresh already running' };
  inFlight = true;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    const r = await spawner('claude', ['-p', 'ok', '--model', 'haiku'], { cwd, timeout: SPAWN_TIMEOUT_MS });
    if (r.code === 0) return { ok: true };
    return { ok: false, httpStatus: 502, error: r.error || `claude exited with code ${r.code}` };
  } catch (e) {
    return { ok: false, httpStatus: 502, error: (e as Error).message };
  } finally {
    inFlight = false;
  }
}
```

- [ ] **Step 4: Register in `test/run-all.ts`**

Replace the whole file (adds the import and the `await`):

```ts
/** Run every test module and exit nonzero if any fail. */
import { run as runTranscript } from './transcript.test.js';
import { run as runScan } from './scan.test.js';
import { run as runUsage } from './usage.test.js';
import { run as runAgents } from './agents.test.js';
import { run as runAgentsCache } from './agents-cache.test.js';
import { run as runFilterSort } from './filter-sort.test.js';
import { run as runTokenRefresh } from './token-refresh.test.js';

let failed = 0;
failed += runTranscript();
failed += runScan();
failed += runUsage();
failed += runAgents();
failed += runAgentsCache();
failed += runFilterSort();
failed += await runTokenRefresh();

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 5: Run tests + typecheck, verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all pass (66 → 71).

- [ ] **Step 6: Commit**

```bash
git add server/lib/token-refresh.ts test/token-refresh.test.ts test/run-all.ts
git commit -m "feat(server): single-flight claude spawn for token refresh"
```

---

### Task 4: `POST /api/usage/refresh` endpoint

**Files:**
- Modify: `server/api.ts`
- Modify: `server/index.ts:57-66`
- Modify: `test/token-refresh.test.ts` (handler cases live here — same domain)

- [ ] **Step 1: Write failing handler tests**

Append inside `run()` in `test/token-refresh.test.ts`, before the final `console.log`. The fake `res` captures status + body; `refreshUsage` is stubbed so no real keychain/network I/O runs:

```ts
  const { serveUsageRefresh } = await import('../server/api.js');

  interface FakeRes { code: number; body: string }
  function fakeRes(): FakeRes & { res: unknown } {
    const state = { code: 0, body: '' } as FakeRes & { res: unknown };
    state.res = {
      writeHead(code: number) { state.code = code; },
      end(body: string) { state.body = body; }
    };
    return state;
  }
  const cfg = (showUsage: boolean) => ({ showUsage }) as import('../server/lib/config.js').Config;

  if (await test('serveUsageRefresh: SHOW_USAGE off → 404', async () => {
    const r = fakeRes();
    await serveUsageRefresh(cfg(false), r.res as never, {});
    assert.strictEqual(r.code, 404);
    assert.strictEqual(JSON.parse(r.body).ok, false);
  })) p++; else f++;

  if (await test('serveUsageRefresh: spawn ok → 200 with fresh usage snapshot', async () => {
    const r = fakeRes();
    await serveUsageRefresh(cfg(true), r.res as never, {
      spawner: () => Promise.resolve({ code: 0 }),
      cwd: tmpCwd(),
      refreshUsage: () => Promise.resolve({
        usage: { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null } },
        status: 'ok' as const
      })
    });
    assert.strictEqual(r.code, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.usageStatus, 'ok');
    assert.strictEqual(body.usage.fiveHour.utilization, 12);
  })) p++; else f++;

  if (await test('serveUsageRefresh: spawn fails → 502, no usage fetch', async () => {
    const r = fakeRes();
    let fetched = false;
    await serveUsageRefresh(cfg(true), r.res as never, {
      spawner: () => Promise.resolve({ code: null, error: 'claude CLI not found on PATH' }),
      cwd: tmpCwd(),
      refreshUsage: () => { fetched = true; return Promise.resolve({ usage: null, status: 'unavailable' as const }); }
    });
    assert.strictEqual(r.code, 502);
    assert.match(JSON.parse(r.body).error, /not found/);
    assert.strictEqual(fetched, false);
  })) p++; else f++;
```

- [ ] **Step 2: Run, verify the three new cases fail**

Run: `pnpm exec tsx test/token-refresh.test.ts`
Expected: FAIL — `serveUsageRefresh` is not exported from `../server/api.js`.

- [ ] **Step 3: Implement the handler in `server/api.ts`**

Add to the imports at the top:

```ts
import { getCachedUsageState, forceUsageRefresh } from './lib/usage.js';
import { runTokenRefresh, refreshCwd } from './lib/token-refresh.js';
import type { Spawner } from './lib/token-refresh.js';
import type { UsageState } from './lib/usage.js';
import type { SessionsResponse, SessionDetail, UsageRefreshResponse } from '../shared/types.js';
```

(the `getCachedUsageState` line replaces the import edited in Task 2; the last line replaces the existing shared-types import.)

Append at the bottom of `api.ts`:

```ts
/**
 * `POST /api/usage/refresh` — recover from an expired OAuth token. Spawns one
 * headless `claude -p` turn (the CLI refreshes its own creds), then bypasses
 * the usage-cache TTL so the fresh token is used immediately. Single-flight:
 * concurrent requests get 409. Gated by SHOW_USAGE like the bars themselves.
 * `deps` is a test seam (fake spawner / usage fetcher / cwd).
 */
export async function serveUsageRefresh(
  config: Config,
  res: ServerResponse,
  deps: { spawner?: Spawner; cwd?: string; refreshUsage?: () => Promise<UsageState> } = {}
): Promise<void> {
  const send = (code: number, body: UsageRefreshResponse): void => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!config.showUsage) return send(404, { ok: false, error: 'usage disabled' });
  const outcome = await runTokenRefresh(deps.spawner, deps.cwd ?? refreshCwd());
  if (!outcome.ok) return send(outcome.httpStatus, { ok: false, error: outcome.error });
  const state = await (deps.refreshUsage ?? forceUsageRefresh)();
  send(200, { ok: true, usage: state.usage, usageStatus: state.status });
}
```

- [ ] **Step 4: Route it in `server/index.ts`**

Import the handler (line 20):

```ts
import { serveSessions, serveSessionDetail, serveUsageRefresh } from './api.js';
```

In the `http.createServer` callback, add the refresh route first (before the detail-route match at line 60):

```ts
  if (req.method === 'POST' && req.url && req.url.split('?')[0] === '/api/usage/refresh') {
    return void serveUsageRefresh(config, res);
  }
```

- [ ] **Step 5: Run tests + typecheck, verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all pass (71 → 74).

- [ ] **Step 6: Commit**

```bash
git add server/api.ts server/index.ts test/token-refresh.test.ts
git commit -m "feat(api): POST /api/usage/refresh spawns claude to renew token"
```

---

### Task 5: Phantom-session filter in `server/lib/scan.ts`

**Files:**
- Modify: `server/lib/scan.ts`
- Test: `test/scan.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `run()` in `test/scan.test.ts`, before the final `console.log`. Add the import at the top of the file:

```ts
import { refreshCwd } from '../server/lib/token-refresh.js';
```

```ts
  if (test('token-refresh transcript (cwd = refreshCwd) is excluded', () => {
    // The dashboard's own POST /api/usage/refresh spawns `claude -p` in a
    // dedicated cwd; that turn writes a real transcript which must not show up
    // as a session row.
    const now = 1_700_000_000_000;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-home-'));
    const freshTs = new Date(now - 30 * 1000).toISOString();
    const root = makeRoot([
      { dirName: '-refresh', id: 'phantom', mtimeMs: now - 10 * 1000, records: [metaRec(refreshCwd(home), 'main'), at(assistantDone(), freshTs)] },
      { dirName: '-a-real2', id: 'real2', mtimeMs: now - 60 * 1000, records: [metaRec('/a/real2', 'main'), at(assistantPending(), freshTs)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, homeDir: home, liveCwds: null });
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].project, 'real2');
  })) p++; else f++;
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx test/scan.test.ts`
Expected: the new case FAILS (2 sessions shown, phantom included); all prior cases pass.

- [ ] **Step 3: Implement the filter**

In `server/lib/scan.ts`, add the import:

```ts
import { refreshCwd } from './token-refresh.js';
```

In `scanSessions`, right after `const projectPath = parsed.cwd || null;` (line 160), before the `project` line:

```ts
    // The dashboard's own token-refresh turns (POST /api/usage/refresh) run in
    // a dedicated cwd; their transcripts are plumbing, not a session to display.
    if (projectPath && normCwd(projectPath) === normCwd(refreshCwd(options.homeDir))) continue;
```

- [ ] **Step 4: Run tests + typecheck, verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all pass (74 → 75).

- [ ] **Step 5: Commit**

```bash
git add server/lib/scan.ts test/scan.test.ts
git commit -m "feat(scan): hide the dashboard's own token-refresh transcripts"
```

---

### Task 6: Client — expired-state hint + Sync button

No client unit-test infra exists; verification is typecheck + build + live preview (Task 7).

**Files:**
- Modify: `client/src/components/Header.tsx`
- Modify: `client/src/styles.css` (append after line 32, the `.u-pct` rule)

- [ ] **Step 1: Rework `Header.tsx`**

Replace the file contents with:

```tsx
import { useState } from 'react';

import type { SessionsResponse, RateLimit, UsageLimits, UsageRefreshResponse } from '../../../shared/types';

/** Title bar + summary line (generated time, active count, running claude procs). */
export function Header({ data }: { data: SessionsResponse | null }) {
  const meta = data ? new Date(data.generatedAt).toLocaleTimeString() : '';

  let sub: React.ReactNode = '';
  if (data) {
    const procs = data.runningClaudeProcs == null
      ? ''
      : ` · ${data.runningClaudeProcs} claude proc${data.runningClaudeProcs === 1 ? '' : 's'}`;
    sub = <><b>{data.totals.active}</b>{` active · top ${data.maxSessions}${procs}`}</>;
  }

  return (
    <>
      <div className="head">
        <h1>⚡ Claude Sessions</h1>
        <span className="meta">{meta}</span>
      </div>
      <div className="sub">{sub}</div>
      {data?.usageStatus === 'token-expired'
        ? <UsageExpired />
        : <UsageBars usage={data ? data.usage : null} />}
    </>
  );
}

/**
 * Shown instead of the bars when the stored OAuth token is expired. The Sync
 * button asks the server to spawn a headless `claude -p` turn (the CLI renews
 * its own token); the next 3s poll flips usageStatus back to 'ok' and the bars
 * return. Costs one haiku subscription turn per click.
 */
function UsageExpired() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/usage/refresh', { method: 'POST' });
      const body: UsageRefreshResponse = await res.json();
      if (!body.ok) setError(body.error || 'refresh failed');
    } catch {
      setError('request failed');
    }
    setBusy(false);
  }

  return (
    <div className="usage">
      <span className="u-label">Usage</span>
      <span className="u-msg">token expired</span>
      <button className="u-sync" onClick={sync} disabled={busy}>
        {busy ? 'refreshing…' : 'Sync'}
      </button>
      {error && <span className="u-err">{error}</span>}
    </div>
  );
}

/** The two account rate-limit bars (5h + weekly). Renders nothing when unavailable. */
function UsageBars({ usage }: { usage: UsageLimits | null | undefined }) {
  if (!usage) return null;
  const bars = [
    { label: '5h', rl: usage.fiveHour },
    { label: 'Week', rl: usage.sevenDay }
  ].filter((b) => b.rl.utilization != null);
  if (bars.length === 0) return null;

  return (
    <div className="usage">
      {bars.map((b) => (
        <UsageBar key={b.label} label={b.label} rl={b.rl} />
      ))}
    </div>
  );
}

function UsageBar({ label, rl }: { label: string; rl: RateLimit }) {
  const pct = Math.max(0, Math.min(100, Math.round(rl.utilization as number)));
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
  const title = rl.resetsAt ? `Resets ${new Date(rl.resetsAt).toLocaleString()}` : undefined;
  return (
    <div className="u" title={title}>
      <span className="u-label">{label}</span>
      <div className="u-bar">
        <div className={`u-fill ${level}`.trim()} style={{ width: `${pct}%` }} />
      </div>
      <span className="u-pct">{pct}%</span>
    </div>
  );
}
```

(`UsageBars`/`UsageBar` are unchanged; only the imports, the `Header` return, and the new `UsageExpired` component differ.)

- [ ] **Step 2: Append styles to `client/src/styles.css`**

After the `.usage .u-pct` rule (line 32), matching the existing compact one-line style:

```css
.usage .u-msg{font-size:11px;color:var(--text3)}
.usage .u-sync{font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--surface2);background:var(--surface2);color:var(--text2);cursor:pointer}
.usage .u-sync:hover:not(:disabled){color:var(--text)}
.usage .u-sync:disabled{opacity:.6;cursor:default}
.usage .u-err{font-size:11px;color:var(--red)}
```

Note: verify `--text` exists in the `:root` block of styles.css; if the variable is named differently (e.g. `--text1`), use that in the `:hover` rule.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/Header.tsx client/src/styles.css
git commit -m "feat(client): token-expired hint + Sync button in header"
```

---

### Task 7: End-to-end verification + docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Usage limits section)

- [ ] **Step 1: Full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: ALL PASS (75 cases), clean typecheck.

- [ ] **Step 2: Live verification (preview tools)**

Start the dev server and check the header:
1. `GET /api/sessions` → payload contains `usageStatus` (likely `"ok"` — bars render as before, no regression).
2. Force the expired path without waiting 8h: `curl -X POST localhost:<port>/api/usage/refresh` → expect `200 { ok: true, … }` (token valid, spawn succeeds — proves the whole pipeline) or a clean `502` if `claude` isn't on the server's PATH.
3. Screenshot the header for the user.

To eyeball the expired UI itself, temporarily hardcode `usageStatus = 'token-expired'` in the Header props via React devtools or a one-line local edit — do NOT commit that.

- [ ] **Step 3: Update `.claude/CLAUDE.md`**

In the "Usage limits (header bars)" section, append two bullets:

```markdown
- **Status:** `SessionsResponse.usageStatus` says why bars are/aren't shown: `ok`,
  `token-expired` (stored token past expiresAt), `unavailable` (any other fail-open
  cause). Client renders bars only on `ok`; `token-expired` shows a hint + **Sync**
  button.
- **Token recovery:** `POST /api/usage/refresh` (lib/token-refresh.ts) spawns one
  headless `claude -p "ok" --model haiku` in `~/.claude/dashboard-refresh/` — the CLI
  renews its own creds; we still never write them. Single-flight (409 on concurrent),
  60s timeout, 502 on spawn failure, gated by SHOW_USAGE. The spawned turn's
  transcript is filtered out of the session list by scan.ts (cwd match on
  refreshCwd()). Costs one haiku subscription turn per click.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: usage token-refresh endpoint + status field"
```
