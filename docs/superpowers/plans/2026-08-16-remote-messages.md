# Remote Messages (Turn-End Reply Window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send free text from the dashboard's chat drawer into a live session at turn end — the Stop hook holds the turn open while you are away, and your reply continues the model.

**Architecture:** Third parallel wait store (`messages.ts`, mirroring `pending.ts`/`plans.ts`), three mirrored endpoints, the existing `stop-notify-hook.sh` upgraded from fire-and-forget to gated hold, and a `MessagePanel`/`usePendingMessage` client pair mirroring `PlanPanel`/`usePendingPlan`. Delivery mechanism: Stop hook prints top-level `{"decision":"block","reason":"<composed>"}` (verified against CLI 2.1.233's binary — NOT `hookSpecificOutput`).

**Tech Stack:** Node built-ins only on the server (tsx, ESM), bash+curl+jq hooks, React+Vite client, node-assert tests via `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-08-16-remote-message-design.md` — read it first; it carries the verified CLI facts (8-block cap, `stop_hook_active` re-fire, hook `timeout` kill) this plan argues from.

## Global Constraints

- ESM everywhere; server imports use `.js` suffix (`import ... from './messages.js'` resolves to `.ts`).
- Cross FE/BE boundary imports are `import type ... from '../../shared/types'` only.
- Server stays zero-runtime-dep: `node:crypto`, `node:http` etc. only. No new outbound call kinds (the push already exists).
- `shared/types.ts` is edited FIRST in any task that changes the API contract.
- Never hardcode a color/shadow in `client/src/styles.css` — this plan adds NO css (reuses `qpanel`/`qp-*`/`ag-pill` classes).
- Tests: node-assert modules exporting `run(): Promise<number>` (or `number`), registered in `test/run-all.ts`; run with `pnpm test`, types with `pnpm typecheck`.
- The ntfy topic and `ANSWER_TOKEN` must never appear in logs, test output, or client code.
- Session ids are shape-checked with the existing `ID_RE` and NEVER joined into a path.
- Commits: conventional-ish one-liners (`feat(messages): …`, `docs: …`), each task commits separately.

---

### Task 1: `server/lib/messages.ts` store + shared types + tests

**Files:**
- Modify: `shared/types.ts` (after `PlanWaitResult`, ~line 418)
- Modify: `shared/types.ts` (`Session`, after `remotePlan` ~line 43)
- Create: `server/lib/messages.ts`
- Create: `test/messages.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2, 4, 6): types `PendingMessage {messageId, askedAt, expiresAt}`, `SessionMessage {id, pending, error?}`, `MessageAnswerRequest {messageId, text?, dismiss?}`, `MessageWaitResult {status: 'answered'|'timeout'|'superseded'|'dismissed'|'released', reason?}`, `Session.remoteReply: boolean`; functions `TEXT_CAP`, `composeReason(text)`, `register(sessionId, timeoutMs, resolve) → messageId`, `getPendingMessage(sessionId)`, `messageSessionIds()`, `answer(sessionId, body) → 'ok'|'not-found'|'mismatch'|'malformed'`, `cancel(sessionId, messageId)`, `dismissAll() → number`, `resetStore()`.

- [ ] **Step 1: Add the types to `shared/types.ts`**

Insert after the `PlanWaitResult` interface (~line 418):

```ts
/** A turn-end reply window a session is holding open, as the browser sees it. */
export interface PendingMessage {
  /** Server nonce. A send must echo it, so a stale tab can't answer the next window. */
  messageId: string;
  askedAt: string;
  /** When the window closes on its own — feeds the panel's countdown. */
  expiresAt: string;
}

/** Payload of `GET /api/sessions/:id/message`. */
export interface SessionMessage {
  id: string;
  pending: PendingMessage | null;
  error?: boolean;
}

/**
 * Body of `POST /api/sessions/:id/message-answer`.
 * `text` continues the model with your message; `dismiss` releases the hold so
 * the session stops now instead of sitting out the window.
 */
export interface MessageAnswerRequest {
  messageId: string;
  /** The follow-up, sent to the model verbatim inside a composed reason. */
  text?: string;
  dismiss?: boolean;
}

/**
 * Body of the held `POST /api/messages/wait` response — how a reply window
 * ended. Only `answered` makes the hook block the stop; every other status
 * exits 0 and the session stops normally. `released` is the auto-release: you
 * came back to the keyboard, so every hold let go.
 */
export interface MessageWaitResult {
  status: 'answered' | 'timeout' | 'superseded' | 'dismissed' | 'released';
  /** Prose the hook prints as the Stop block's `reason`. Composed server-side. */
  reason?: string;
}
```

Insert into `Session` directly after the `remotePlan` field (~line 43):

```ts
  /**
   * True while a turn-end reply window is held for this session — the Stop hook
   * is holding the turn open for a follow-up. Same mechanism and same lead over
   * the transcript as {@link remoteQuestion}; the separate flag lets the row say
   * `reply?`. See {@link MessageAnswerRequest}.
   */
  remoteReply: boolean;
```

- [ ] **Step 2: Write the failing tests — `test/messages.test.ts`**

Mirror `test/plans.test.ts`'s structure exactly (same `test`/`testAsync` helpers, same console-count contract):

```ts
import assert from 'node:assert';

import {
  TEXT_CAP,
  answer, cancel, composeReason, dismissAll, getPendingMessage, messageSessionIds,
  register, resetStore
} from '../server/lib/messages.js';
import type { MessageWaitResult } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A collector standing in for the hook's held HTTP response. */
function waiter(): { results: MessageWaitResult[]; resolve: (r: MessageWaitResult) => void } {
  const results: MessageWaitResult[] = [];
  return { results, resolve: r => { results.push(r); } };
}

export async function run(): Promise<number> {
  console.log('\n=== messages.ts ===\n');
  let p = 0, f = 0;
  resetStore();

  /* ----------------------------------------------------- composeReason (pure) */

  if (test('reason carries the text and the away-mode reminder', () => {
    const reason = composeReason('  now run the tests  ');
    assert.ok(reason.includes('now run the tests'));
    assert.ok(reason.includes('AskUserQuestion'));
    assert.ok(reason.includes('away'));
  })) p++; else f++;

  /* ------------------------------------------------------------ state machine */

  if (test('register exposes the window with a deadline and flags the session', () => {
    resetStore();
    const w = waiter();
    const before = Date.now();
    const messageId = register('s1', 60_000, w.resolve);
    const pending = getPendingMessage('s1')!;
    assert.strictEqual(pending.messageId, messageId);
    const expires = Date.parse(pending.expiresAt);
    assert.ok(expires >= before + 59_000 && expires <= Date.now() + 61_000);
    assert.deepStrictEqual([...messageSessionIds()], ['s1']);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('a text answer resolves the waiter with a composed reason and clears the entry', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, text: 'also update the docs' }), 'ok');
    assert.strictEqual(w.results.length, 1);
    assert.strictEqual(w.results[0].status, 'answered');
    assert.ok(w.results[0].reason!.includes('also update the docs'));
    assert.strictEqual(getPendingMessage('s1'), null);
  })) p++; else f++;

  if (test('text is capped at TEXT_CAP', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, text: 'y'.repeat(TEXT_CAP + 500) }), 'ok');
    // composeReason adds fixed prose around the text, so the cap bounds the text, not the reason
    assert.ok(w.results[0].reason!.includes('y'.repeat(TEXT_CAP)));
    assert.ok(!w.results[0].reason!.includes('y'.repeat(TEXT_CAP + 1)));
  })) p++; else f++;

  if (test('dismiss resolves dismissed — the session just stops', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, dismiss: true }), 'ok');
    assert.deepStrictEqual(w.results, [{ status: 'dismissed' }]);
  })) p++; else f++;

  if (test('malformed answers are refused without touching the entry', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', null), 'malformed');
    assert.strictEqual(answer('s1', {}), 'malformed');
    assert.strictEqual(answer('s1', { messageId }), 'malformed');            // neither text nor dismiss
    assert.strictEqual(answer('s1', { messageId, text: '   ' }), 'malformed'); // blank text
    assert.strictEqual(answer('s1', { messageId: 'nope', text: 'hi' }), 'mismatch');
    assert.strictEqual(answer('s2', { messageId, text: 'hi' }), 'not-found');
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('re-register supersedes the previous hold', () => {
    resetStore();
    const w1 = waiter(); const w2 = waiter();
    register('s1', 60_000, w1.resolve);
    const second = register('s1', 60_000, w2.resolve);
    assert.deepStrictEqual(w1.results, [{ status: 'superseded' }]);
    assert.strictEqual(getPendingMessage('s1')!.messageId, second);
  })) p++; else f++;

  if (test('cancel with a stale messageId is a no-op', () => {
    resetStore();
    const w = waiter();
    register('s1', 60_000, w.resolve);
    cancel('s1', 'stale-id');
    assert.notStrictEqual(getPendingMessage('s1'), null);
  })) p++; else f++;

  if (test('cancel drops the entry without resolving', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    cancel('s1', messageId);
    assert.strictEqual(getPendingMessage('s1'), null);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('dismissAll releases every hold and reports the count', () => {
    resetStore();
    const w1 = waiter(); const w2 = waiter();
    register('s1', 60_000, w1.resolve);
    register('s2', 60_000, w2.resolve);
    assert.strictEqual(dismissAll(), 2);
    assert.deepStrictEqual(w1.results, [{ status: 'dismissed' }]);
    assert.deepStrictEqual(w2.results, [{ status: 'dismissed' }]);
    assert.strictEqual(messageSessionIds().size, 0);
  })) p++; else f++;

  if (await testAsync('the deadline resolves timeout and a late answer finds nothing', async () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 10, w.resolve);
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(w.results, [{ status: 'timeout' }]);
    assert.strictEqual(answer('s1', { messageId, text: 'too late' }), 'not-found');
  })) p++; else f++;

  resetStore();
  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(f => process.exit(f > 0 ? 1 : 0));
```

- [ ] **Step 3: Register in `test/run-all.ts`**

Add with the other imports: `import { run as runMessages } from './messages.test.js';`
Add after `failed += await runPlans();`: `failed += await runMessages();`

- [ ] **Step 4: Run to verify failure**

Run: `npx tsx test/messages.test.ts`
Expected: FAIL — cannot find module `../server/lib/messages.js`.

- [ ] **Step 5: Implement `server/lib/messages.ts`**

Model on `server/lib/plans.ts` (read it side by side). Full content:

```ts
/**
 * messages.ts — the turn-end reply-window store behind remote messages.
 *
 * A session's Stop hook POSTs to `/api/messages/wait` when a turn finishes
 * while you are away, and the HTTP response is held open. The browser sees the
 * window, you type a follow-up in the chat drawer, and that resolves the held
 * response — the hook then blocks the stop with your text as the reason, which
 * the model reads and continues with. No reply → the hook exits 0 and the
 * session stops exactly as it did before this existed.
 *
 * Everything is in memory: a restart drops every hold and the sessions stop.
 *
 * Third parallel store, same state machine as `pending.ts`/`plans.ts` (same
 * injected `resolve`, same one-entry-per-session rule), separate module for the
 * same reason `plans.ts` is: the payloads and verdicts share nothing.
 *
 * See `docs/subsystems/remote-message.md`.
 */

import { randomUUID } from 'node:crypto';

import type { MessageAnswerRequest, MessageWaitResult, PendingMessage } from '../../shared/types.js';

/** Cap on the follow-up that reaches the model verbatim. */
export const TEXT_CAP = 4000;

/** How a submitted answer was judged. Mirrors `plans.ts`'s outcome union. */
export type MessageOutcome = 'ok' | 'not-found' | 'mismatch' | 'malformed';

interface Entry {
  messageId: string;
  sessionId: string;
  askedAt: string;
  expiresAt: string;
  timer: NodeJS.Timeout;
  /** Completes the hook's held response. Called at most once. */
  resolve: (r: MessageWaitResult) => void;
}

const entries = new Map<string, Entry>();

/**
 * The prose the hook prints as the Stop block's `reason`. Two jobs: carry the
 * text, and carry the away-mode instructions — `UserPromptSubmit` hooks (the
 * remote-decision injection) do NOT fire on hook-continued turns, so this is
 * the only place the reminder can ride.
 */
export function composeReason(text: string): string {
  const trimmed = text.trim();
  return 'The user is away from the terminal and sent this follow-up from the dashboard; '
    + `treat it as their next message:\n${trimmed}\n\n`
    + 'Continue working on it now. The user is still away: put any decision through the '
    + 'AskUserQuestion tool, never end the turn on a prose question, and prefer '
    + 'already-permitted tools — a permission dialog would park the session until they return.';
}

/** Finish an entry: fire `resolve` once, clear its timer, drop it from the map. */
function settle(entry: Entry, result: MessageWaitResult): void {
  clearTimeout(entry.timer);
  if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  entry.resolve(result);
}

/**
 * Register a reply window and take ownership of the caller's held response.
 * Returns the `messageId` the browser must echo when sending.
 *
 * An existing entry for the session is superseded — a retried or duplicated
 * hook releases the older waiter rather than leaking it.
 */
export function register(
  sessionId: string,
  timeoutMs: number,
  resolve: (r: MessageWaitResult) => void
): string {
  const prev = entries.get(sessionId);
  if (prev) settle(prev, { status: 'superseded' });

  const messageId = randomUUID();
  const now = Date.now();
  const entry: Entry = {
    messageId,
    sessionId,
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    timer: setTimeout(() => settle(entry, { status: 'timeout' }), timeoutMs),
    resolve
  };
  entries.set(sessionId, entry);
  return messageId;
}

/** The reply window a session is holding, or null. */
export function getPendingMessage(sessionId: string): PendingMessage | null {
  const entry = entries.get(sessionId);
  if (!entry) return null;
  return { messageId: entry.messageId, askedAt: entry.askedAt, expiresAt: entry.expiresAt };
}

/**
 * Every session holding a reply window right now. Read by the session scan so
 * the row can show `reply?`. A fresh Set: callers never get the store's keys.
 */
export function messageSessionIds(): Set<string> {
  return new Set(entries.keys());
}

/**
 * Deliver the user's follow-up (or `dismiss: true` to let the session stop
 * now). Synchronous by design, same as `pending.answer`: two tabs racing means
 * the first wins and the second sees `not-found`, with no locking.
 */
export function answer(sessionId: string, body: unknown): MessageOutcome {
  const entry = entries.get(sessionId);
  if (!entry) return 'not-found';

  const req = body as MessageAnswerRequest | null;
  if (!req || typeof req !== 'object' || typeof req.messageId !== 'string') return 'malformed';
  if (req.messageId !== entry.messageId) return 'mismatch';

  if (req.dismiss === true) {
    settle(entry, { status: 'dismissed' });
    return 'ok';
  }

  const text = typeof req.text === 'string' ? req.text.slice(0, TEXT_CAP) : '';
  if (!text.trim()) return 'malformed';

  settle(entry, { status: 'answered', reason: composeReason(text) });
  return 'ok';
}

/**
 * Drop a hold whose peer is gone (the hook's socket closed — session
 * interrupted, hook killed, CLI hook timeout). No `resolve`: nobody is left to
 * answer to. A stale `messageId` is a no-op, so a late close can't evict a
 * newer entry.
 */
export function cancel(sessionId: string, messageId: string): void {
  const entry = entries.get(sessionId);
  if (!entry || entry.messageId !== messageId) return;
  clearTimeout(entry.timer);
  entries.delete(sessionId);
}

/**
 * Release every hold — the sessions stop normally. Used when the remote-answer
 * toggle switches off, alongside the question and plan `dismissAll()`s.
 * Returns how many were released.
 */
export function dismissAll(): number {
  const waiting = [...entries.values()];
  for (const entry of waiting) settle(entry, { status: 'dismissed' });
  return waiting.length;
}

/** Test seam: drop every entry without resolving. */
export function resetStore(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear();
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx tsx test/messages.test.ts` — Expected: all ✓, `Failed: 0`.
Run: `pnpm test` — Expected: ALL PASS (new module counted).
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts server/lib/messages.ts test/messages.test.ts test/run-all.ts
git commit -m "feat(messages): turn-end reply-window store + contract types"
```

---

### Task 2: Auto-release on keyboard return (idle sweep in `messages.ts`)

**Files:**
- Modify: `server/lib/messages.ts`
- Modify: `test/messages.test.ts`

**Interfaces:**
- Consumes: `readIdleSecs` from `./notify.js`, `getSettings` from `./settings.js` (both already exported).
- Produces (used by nothing else — self-contained): `sweepIdle(): number` (exported for tests), `setIdleReader(fn | null)` (test seam). The 5s interval is internal: started on first `register`, stopped when the store empties.

- [ ] **Step 1: Write the failing tests (append to `test/messages.test.ts` before the final `resetStore()`)**

```ts
  /* ----------------------------------------------------- idle auto-release */

  const { setIdleReader, sweepIdle } = await import('../server/lib/messages.js');
  const { setSettingsPathForTest } = await import('../server/lib/settings.js'); // if no such seam exists, drive via setIdleReader + default idleSecs (60) instead — see note below

  if (test('sweepIdle releases every hold when you are back at the keyboard', () => {
    resetStore();
    const w = waiter();
    register('s1', 60_000, w.resolve);
    setIdleReader(() => 3); // 3s idle < any real threshold
    assert.strictEqual(sweepIdle(), 1);
    assert.deepStrictEqual(w.results, [{ status: 'released' }]);
    setIdleReader(null);
  })) p++; else f++;

  if (test('sweepIdle does nothing while still away', () => {
    resetStore();
    const w = waiter();
    register('s1', 60_000, w.resolve);
    setIdleReader(() => 9999);
    assert.strictEqual(sweepIdle(), 0);
    assert.strictEqual(w.results.length, 0);
    setIdleReader(null);
  })) p++; else f++;

  if (test('unreadable idle never auto-releases (Docker/non-macOS)', () => {
    resetStore();
    const w = waiter();
    register('s1', 60_000, w.resolve);
    setIdleReader(() => null);
    assert.strictEqual(sweepIdle(), 0);
    setIdleReader(null);
  })) p++; else f++;
```

NOTE for the implementer: the threshold comes from `getSettings().idleSecs` at sweep time. `test/settings.test.ts` shows how settings are faked in tests — reuse that mechanism if one exists; if the settings module reads a file with no seam, add nothing: the defaults (`idleSecs` 60) make the three cases above pass as written (3 < 60 releases, 9999 ≥ 60 holds, null holds). Also handle `idleSecs === 0` inside `sweepIdle` (return 0 immediately — 0 means "the idle check is disabled", so auto-release must be too). Add a fourth test for it by temporarily setting settings if a seam exists; otherwise assert the guard by code review in the task's review step.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx test/messages.test.ts`
Expected: FAIL — `setIdleReader`/`sweepIdle` not exported.

- [ ] **Step 3: Implement in `server/lib/messages.ts`**

Add imports at the top:

```ts
import { readIdleSecs } from './notify.js';
import { getSettings } from './settings.js';
```

Add below `resetStore` (and wire the two hooks noted after):

```ts
/* ------------------------------------------------- idle auto-release */

let idleReader: (() => number | null) | null = null;
let reaper: NodeJS.Timeout | null = null;

/** Test seam: swap the idle source so no test spawns `ioreg`. `null` restores it. */
export function setIdleReader(fn: (() => number | null) | null): void {
  idleReader = fn;
}

/**
 * Release every hold if the user is back at the keyboard. Returns how many.
 *
 * Fail directions: unreadable idle (Docker, non-macOS) → never release — the
 * deadline timer is the reaper of last resort. `idleSecs === 0` means the idle
 * gate is disabled everywhere else, so it disables auto-release too.
 */
export function sweepIdle(): number {
  if (entries.size === 0) return 0;
  const thresholdSecs = getSettings().idleSecs;
  if (thresholdSecs === 0) return 0;
  const idle = (idleReader ?? readIdleSecs)();
  if (idle === null || idle >= thresholdSecs) return 0;
  const waiting = [...entries.values()];
  for (const entry of waiting) settle(entry, { status: 'released' });
  return waiting.length;
}

/**
 * The 5s reaper behind {@link sweepIdle}. Runs only while holds exist — an
 * idle server never spawns `ioreg`. `unref()` so it cannot hold the process
 * open.
 */
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    sweepIdle();
    if (entries.size === 0 && reaper) { clearInterval(reaper); reaper = null; }
  }, 5_000);
  reaper.unref();
}
```

Wire it in:
- In `register`, after `entries.set(sessionId, entry);` add `ensureReaper();`
- In `resetStore`, add at the end: `if (reaper) { clearInterval(reaper); reaper = null; }`

- [ ] **Step 4: Run tests and typecheck**

Run: `npx tsx test/messages.test.ts` then `pnpm test` then `pnpm typecheck`. Expected: all pass. (If `pnpm test` hangs at exit, the reaper missed `unref()` — fix that, don't add process.exit.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/messages.ts test/messages.test.ts
git commit -m "feat(messages): auto-release holds when the keyboard wakes"
```

---

### Task 3: `notify.ts` phrase override + test

**Files:**
- Modify: `server/lib/notify.ts:251-282` (`maybeSend`)
- Modify: `test/notify.test.ts`

**Interfaces:**
- Produces (used by Task 4): `maybeSend(config, event, ctx)` where `ctx` gains optional `phrase?: string`; the push body becomes `` `${label} — ${ctx.phrase ?? PHRASE[event]}` ``.

- [ ] **Step 1: Write the failing test**

Open `test/notify.test.ts`, find the existing `maybeSend` delivery cases (they use `setSender`/`setLabelResolver` seams). Add one case alongside them, reusing that file's local helpers verbatim (its `test()` helper, its fake config, its policy fixture with `enabled: true` and `events.stop: true`, all other `require*` false):

```ts
  if (test('a phrase override replaces the stock event phrase', () => {
    const sent: NotifyPayload[] = [];
    setSender(payload => { sent.push(payload); });
    setLabelResolver(() => 'proj');
    // use this file's existing helper for writing policy/settings, exactly as
    // the neighboring 'stop' delivery test does
    maybeSend(config, 'stop', { sessionId: 'abc12345', phrase: 'finished — reply window open' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].body, 'proj — finished — reply window open');
    resetNotify();
  })) p++; else f++;
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx test/notify.test.ts`
Expected: FAIL — body is `proj — task finished` (override ignored / TS error on `phrase`).

- [ ] **Step 3: Implement**

In `maybeSend`'s signature change the ctx type:

```ts
  ctx: { sessionId: string; permissionMode?: string; phrase?: string }
```

and in the payload change the body line to:

```ts
        body: `${resolveLabel(config, ctx.sessionId)} — ${ctx.phrase ?? PHRASE[event]}`,
```

- [ ] **Step 4: Run `npx tsx test/notify.test.ts`, `pnpm test`, `pnpm typecheck`** — all pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/notify.ts test/notify.test.ts
git commit -m "feat(notify): optional per-send phrase override"
```

---

### Task 4: Endpoints, routes, toggle join, scan flag

**Files:**
- Modify: `server/api.ts` (imports ~line 23-27; new handlers after `serveSessionPlanAnswer` ~line 461; `serveSessions` options ~line 84; toggle ~line 311)
- Modify: `server/index.ts` (routes: after line 109 and after line 145)
- Modify: `server/lib/scan.ts` (options ~line 44; flags ~line 212; status chain ~line 223; session object ~line 230)

**Interfaces:**
- Consumes: everything Task 1-3 produced.
- Produces (used by Tasks 5, 6): `POST /api/messages/wait` (body `{sessionId, timeoutMs, permissionMode?, stopHookActive?}` → held `MessageWaitResult`), `GET /api/sessions/:id/message` → `SessionMessage`, `POST /api/sessions/:id/message-answer` (body `MessageAnswerRequest` → 200/400/403/404/409), `Session.remoteReply` populated.

- [ ] **Step 1: `server/api.ts` — imports**

Extend the plans import block pattern with a messages one (names collide with pending/plans, so alias like the file already does for `answerPlan`/`cancelPlan`/`dismissAllPlans` — open lines 17-27 and mirror):

```ts
import {
  answer as answerMessage, cancel as cancelMessage, dismissAll as dismissAllMessages,
  getPendingMessage, messageSessionIds, register as registerMessage
} from './lib/messages.js';
```

Add `SessionMessage`, `MessageWaitResult` to the `import type` list from `../shared/types.js`.

- [ ] **Step 2: `server/api.ts` — handlers (insert after `serveSessionPlanAnswer`)**

```ts
/**
 * `POST /api/messages/wait` — a session's Stop hook reports a finished turn and
 * holds here for a follow-up. Held exactly like the question wait; any non-200
 * (and any non-`answered` result) makes the hook exit 0, so the session stops
 * exactly as it did before the feature existed.
 *
 * Deliberately NO `sessionExists` check, unlike the question/plan waits: a Stop
 * hook fires as the turn ends, which is exactly when the transcript may not yet
 * be flushed for the scan to see (same reasoning as `serveNotifyEvent`). The id
 * is still shape-checked and never joined into a path — the store is RAM-keyed.
 */
export async function serveMessageWait(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; timeoutMs?: unknown; permissionMode?: unknown; stopHookActive?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });

  let messageId = '';
  res.on('close', () => { if (messageId) cancelMessage(sessionId, messageId); });
  messageId = registerMessage(sessionId, clampTimeout(body.timeoutMs), (result: MessageWaitResult) => {
    if (res.writableEnded) return;
    sendJson(res, 200, result);
  });
  if (res.destroyed) cancelMessage(sessionId, messageId);

  // Mid-conversation stops (stop_hook_active) don't re-push — you are already
  // in the drawer typing. First stops do, with a phrase that says the window is
  // open; the user's per-event `stop` switch keeps governing both.
  if (body.stopHookActive !== true) {
    maybeSend(config, 'stop', {
      sessionId,
      permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined,
      phrase: 'finished — reply window open'
    });
  }
}

/** `GET /api/sessions/:id/message` — the reply window this session holds, if any. */
export function serveSessionMessage(id: string, res: ServerResponse): void {
  if (!ID_RE.test(id)) {
    const body: SessionMessage = { id, pending: null, error: true };
    return sendJson(res, 400, body);
  }
  sendJson(res, 200, { id, pending: getPendingMessage(id) } satisfies SessionMessage);
}

/**
 * `POST /api/sessions/:id/message-answer` — deliver the follow-up
 * (`{messageId, text}`) or release the hold (`{messageId, dismiss: true}`).
 * 404 means the window is already over: expired, released, or the hook is gone.
 */
export async function serveSessionMessageAnswer(
  config: Config, id: string, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!config.remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'bad body' });

  switch (answerMessage(id, body)) {
    case 'ok': return sendJson(res, 200, { ok: true });
    case 'not-found': return sendJson(res, 404, { error: 'no reply window is open' });
    case 'mismatch': return sendJson(res, 409, { error: 'that window is no longer the one open' });
    default: return sendJson(res, 400, { error: 'bad message' });
  }
}
```

NOTE: `serveSessionMessageAnswer` gates on `config.remoteAnswer` (the env switch) exactly as `serveSessionAnswer`/`serveSessionPlanAnswer` do — copy their first line verbatim if it differs from the above when you open the file.

- [ ] **Step 3: `server/api.ts` — toggle join + scan feed**

In `serveRemoteAnswerToggle` (~line 311) change:

```ts
  const released = body.enabled ? 0 : dismissAll() + dismissAllPlans();
```

to:

```ts
  const released = body.enabled ? 0 : dismissAll() + dismissAllPlans() + dismissAllMessages();
```

In `serveSessions`'s `scanSessions` options (~line 84), after `planIds: planSessionIds(),` add:

```ts
      messageIds: messageSessionIds(),
```

- [ ] **Step 4: `server/index.ts` — routes**

Import the three handlers alongside the plan ones (line 28 region). After the `/api/plans/wait` block (line 106-109) add:

```ts
  if (u.pathname === '/api/messages/wait') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveMessageWait(config, req, res);
  }
```

After the `planAnswer` block (line 141-145), still ABOVE the chat/detail regexes, add:

```ts
  const message = u.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (message) return void serveSessionMessage(decodeURIComponent(message[1]), res);
  const messageAnswer = u.pathname.match(/^\/api\/sessions\/([^/]+)\/message-answer$/);
  if (messageAnswer) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveSessionMessageAnswer(config, decodeURIComponent(messageAnswer[1]), req, res);
  }
```

- [ ] **Step 5: `server/lib/scan.ts` — the flag**

In `ScanOptions` after `planIds` (~line 44):

```ts
  /**
   * Sessions holding a turn-end reply window, same injected-Set pattern as
   * {@link pendingIds}. Omitted/null ⇒ no session is flagged.
   */
  messageIds?: ReadonlySet<string> | null;
```

After the `remotePlan` line (212):

```ts
    // A held reply window is the same kind of evidence again — the Stop hook is
    // holding a socket open right now — so it joins the chain above the gates.
    const remoteReply = !remoteQuestion && !remotePlan
      && (options.messageIds ? options.messageIds.has(c.id) : false);
```

In the status chain, after `else if (remotePlan) status = 'question';` (line 223):

```ts
    else if (remoteReply) status = 'question';                         // blue — a reply window is open
```

In the pushed session object (line 230 region), next to `remotePlan`, add `remoteReply,` — and update the `permissionWait` computation (line 220) to also require `!remoteReply`.

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck` and `pnpm test`. Expected: clean / ALL PASS. (`scan.test.ts` has no planIds precedent, so no new scan unit — the flag is covered by the Task 8 smoke.)

- [ ] **Step 7: Curl smoke against a dev server**

Terminal A: `REMOTE_ANSWER=true pnpm dev` (or export in `.env`). Terminal B:

```bash
curl -s http://127.0.0.1:5173/api/health | jq '.remoteAnswer'
```

Expected: `true` (via the Vite proxy; use the API port directly if you prefer). Then:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"sessionId":"11111111-1111-1111-1111-111111111111","timeoutMs":30000}' \
  http://127.0.0.1:5173/api/messages/wait &
sleep 1
curl -s http://127.0.0.1:5173/api/sessions/11111111-1111-1111-1111-111111111111/message | jq .
```

Expected: `pending.messageId` + `expiresAt` set. Then answer it (echo the printed messageId):

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"messageId":"<paste>","text":"smoke test"}' \
  http://127.0.0.1:5173/api/sessions/11111111-1111-1111-1111-111111111111/message-answer | jq .
```

Expected: `{"ok":true}`, and the backgrounded curl prints `{"status":"answered","reason":"…smoke test…"}`. If `ANSWER_TOKEN` is set in your `.env`, add `-H "Authorization: Bearer <token>"` to both POSTs.

- [ ] **Step 8: Commit**

```bash
git add server/api.ts server/index.ts server/lib/scan.ts
git commit -m "feat(messages): wait/read/answer endpoints, scan flag, toggle join"
```

---

### Task 5: Hook — upgrade `scripts/stop-notify-hook.sh` to a gated hold

**Files:**
- Modify: `scripts/stop-notify-hook.sh` (full rewrite below; same filename and symlink target on purpose)

**Interfaces:**
- Consumes: `/api/health` (`remoteAnswer`, `idleSecs`, `answerSecs`), `/api/messages/wait`, `/api/notify/event` (unchanged fallback).
- Produces: on an answered wait, stdout `{"decision":"block","reason":"…"}` — the verified CLI 2.1.233 contract (top-level, NOT `hookSpecificOutput`).

- [ ] **Step 1: Replace the script body**

```bash
#!/bin/bash
# stop-notify-hook.sh — Stop hook: report a finished turn, and, when you are
# away, hold the turn open so a follow-up typed in the dashboard can continue
# the model (docs/subsystems/remote-message.md).
#
# Two paths out of every run:
#   at the desk / feature off → POST /api/notify/event (the old fire-and-forget
#     push trigger) and exit 0 — byte-for-byte the pre-feature behaviour;
#   away + remote answers on  → POST /api/messages/wait, held. A reply becomes
#     {"decision":"block","reason":…} on stdout — the ONLY output shape the CLI
#     accepts for a Stop block (verified against 2.1.233; reason is fed to the
#     model). ANY other outcome exits 0 and the session stops normally.
#
# The CLI caps consecutive Stop blocks at 8 (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP),
# then force-ends the turn — so a phone conversation is at most 8 replies per
# stretch. stop_hook_active no longer short-circuits: mid-conversation stops
# must re-hold (that IS the chat loop); it rides in the POST body instead so the
# server skips the push you would not want mid-chat.
#
# Install:
#   ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
# then in ~/.claude/settings.json under Stop:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"",
#     "timeout": 630 }
# The timeout MUST exceed the wait window (Settings → Answer window, ≤600s) or
# the CLI kills the hook mid-hold — which only degrades to a normal stop.
#
# Requires: curl, jq.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0
command -v jq > /dev/null 2>&1 || exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

SHA=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')

# Count in-flight background work. Missing keys -> [] -> 0 (safe fallback).
# Only the hook payload carries this, which is why the guard stays here.
bg=$(printf '%s' "$INPUT" | jq '((.background_tasks // []) | length) + ((.session_crons // []) | length)' 2>/dev/null || echo 0)
[ "${bg:-0}" -gt 0 ] 2>/dev/null && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# The pre-feature behaviour: tell the dashboard a turn finished (it decides
# whether that is worth a push) and end the turn. Mid-conversation stops
# (SHA=true) skip it — the old script exited before notifying there too.
notify_fallback() {
  [ "$SHA" = "true" ] && exit 0
  BODY=$(jq -cn --arg sid "$SESSION_ID" --arg pm "$PERM_MODE" \
    '{sessionId: $sid, event: "stop", permissionMode: $pm}') || exit 0
  curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
    -d "$BODY" "$DASH/api/notify/event" > /dev/null 2>&1 || true
  exit 0
}

# Reachability probe, hard 1s cap. Dashboard down → nothing to notify or hold.
HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null) || exit 0
[ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false')" = "true" ] || notify_fallback

# Same three-way resolution as ask-remote-hook.sh: explicit env var wins, then
# the dashboard's Settings (carried on the probe), then the default.
IDLE_MIN_S="${CLAUDE_DASHBOARD_IDLE_SECS:-$(printf '%s' "$HEALTH" | jq -r '.idleSecs // 60')}"
case "$IDLE_MIN_S" in ''|*[!0-9]*) IDLE_MIN_S=60 ;; esac

# At the keyboard → no hold (you can just type in the terminal). Unreadable
# idle counts as at-desk — never park a session on a guess.
if [ "$IDLE_MIN_S" != "0" ]; then
  IDLE_S=$(ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ {print int($NF / 1000000000); exit}')
  case "$IDLE_S" in
    ''|*[!0-9]*) notify_fallback ;;
    *) [ "$IDLE_S" -lt "$IDLE_MIN_S" ] && notify_fallback ;;
  esac
fi

TIMEOUT_S="${CLAUDE_DASHBOARD_ANSWER_TIMEOUT:-$(printf '%s' "$HEALTH" | jq -r '.answerSecs // 600')}"
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S=600 ;; esac

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg pm "$PERM_MODE" \
  --argjson sha "$SHA" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, timeoutMs: $t, permissionMode: $pm, stopHookActive: $sha}') || notify_fallback

# Register and hold. The server resolves this at the deadline (or the moment
# you touch the keyboard — the idle sweep); curl's cap is only a backstop. A
# non-2xx (feature flipped off mid-flight, restart) falls back to the plain
# notify so the "task finished" push never regresses.
RESP=$(curl -sf -m "$((TIMEOUT_S + 15))" -X POST \
  -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/messages/wait" 2>/dev/null) || notify_fallback

[ "$(printf '%s' "$RESP" | jq -r '.status // empty')" = "answered" ] || exit 0
REASON=$(printf '%s' "$RESP" | jq -r '.reason // empty')
[ -n "$REASON" ] || exit 0

# Block the stop. Top-level decision/reason — the one shape the CLI parses for
# Stop hooks; the reason is composed server-side (messages.ts composeReason).
jq -cn --arg r "$REASON" '{decision: "block", reason: $r}'
exit 0
```

- [ ] **Step 2: Syntax + logic dry-run**

```bash
bash -n scripts/stop-notify-hook.sh
```

Expected: silence. Then a no-dashboard dry run (must exit 0 fast, print nothing):

```bash
printf '{"session_id":"11111111-1111-1111-1111-111111111111","stop_hook_active":false}' \
  | CLAUDECODE=1 CLAUDE_DASHBOARD_URL=http://127.0.0.1:1 bash scripts/stop-notify-hook.sh; echo "exit=$?"
```

Expected: `exit=0`, no output.

- [ ] **Step 3: Held-path dry run against the dev server (from Task 4 Step 7 setup)**

```bash
printf '{"session_id":"11111111-1111-1111-1111-111111111111","stop_hook_active":false,"permission_mode":"auto"}' \
  | CLAUDECODE=1 CLAUDE_DASHBOARD_URL=http://127.0.0.1:5173 CLAUDE_DASHBOARD_IDLE_SECS=0 \
    CLAUDE_DASHBOARD_ANSWER_TIMEOUT=30 bash scripts/stop-notify-hook.sh
```

(`IDLE_SECS=0` skips the at-desk gate for the test.) While it hangs, answer from another terminal exactly as in Task 4 Step 7. Expected stdout: `{"decision":"block","reason":"The user is away…smoke test…"}` and exit 0. Repeat and let it time out instead: expected silent exit 0 after ~30s.

- [ ] **Step 4: Commit**

```bash
git add scripts/stop-notify-hook.sh
git commit -m "feat(hook): stop hook holds a reply window when away"
```

---

### Task 6: Client — `usePendingMessage` + `MessagePanel` + drawer mount

**Files:**
- Create: `client/src/hooks/usePendingMessage.ts`
- Create: `client/src/components/MessagePanel.tsx`
- Modify: `client/src/components/ChatDrawer.tsx` (imports ~line 5-9; hook call ~line 78; mount ~line 190)

**Interfaces:**
- Consumes: `GET /api/sessions/:id/message`, `POST /api/sessions/:id/message-answer`, types from Task 1.
- Produces: `usePendingMessage(id) → PendingMessageState {pending, phase, needsToken, send(text), dismiss(), setToken}`; `<MessagePanel state={…} />`.

- [ ] **Step 1: `client/src/hooks/usePendingMessage.ts`**

Copy `usePendingPlan.ts` as the base and adapt — full content:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { usePersistedState } from './usePersistedState';
import { useSettings } from './useSettings';
import type { MessageAnswerRequest, PendingMessage, SessionMessage } from '../../../shared/types';

/**
 * idle       — nothing sent for the current window
 * submitting — a POST is in flight
 * sent       — accepted; the model is continuing with the follow-up
 * gone       — the window closed without us: expired, released (you came back
 *              to the keyboard), or another tab got there first
 */
export type MessagePhase = 'idle' | 'submitting' | 'sent' | 'gone';

export interface PendingMessageState {
  pending: PendingMessage | null;
  phase: MessagePhase;
  /** Set when the server refused the token — the panel prompts for one. */
  needsToken: boolean;
  /** Continue the model with this follow-up. Text is required — see messages.ts. */
  send: (text: string) => Promise<void>;
  /** Release the hold: the session stops now instead of sitting out the window. */
  dismiss: () => Promise<void>;
  setToken: (t: string) => void;
}

/**
 * Poll `/api/sessions/:id/message` while the drawer is open and post a
 * follow-up back. Same shape as {@link usePendingPlan}; the window carries no
 * content of its own (the turn's last message is already in the transcript
 * above), so the panel is purely a composer.
 */
export function usePendingMessage(id: string): PendingMessageState {
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [phase, setPhase] = useState<MessagePhase>('idle');
  const [needsToken, setNeedsToken] = useState(false);
  // Shared with the question and plan panels — one dashboard, one token.
  const [token, setToken] = usePersistedState<string>('dashboard.answerToken', '');
  const { settings: { refreshMs } } = useSettings();

  /** messageId the current phase refers to — a new window resets the panel. */
  const phaseFor = useRef<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Kept separate from the poll below: retuning the refresh rate restarts the
  // interval, and it must not wipe the panel of a window already on screen.
  useEffect(() => {
    setPending(null);
    setPhase('idle');
    phaseFor.current = null;
  }, [id]);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      let body: SessionMessage | null = null;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/message`);
        body = (await res.json()) as SessionMessage;
      } catch {
        return; // keep the last snapshot; the next tick retries
      }
      if (!live || !body || body.error) return;

      const next = body.pending;
      setPending(next);
      if (!next) {
        // The window is over. Keep a fresh "sent" banner; otherwise reset.
        if (phaseFor.current !== null) setPhase(cur => (cur === 'sent' ? cur : 'idle'));
        return;
      }
      if (phaseFor.current !== next.messageId) {
        // A new turn ended — a fresh window replaces any stale banner/error.
        phaseFor.current = next.messageId;
        setPhase('idle');
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  const post = useCallback(async (body: MessageAnswerRequest): Promise<'ok' | 'gone' | 'token' | 'error'> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenRef.current) headers.Authorization = `Bearer ${tokenRef.current}`;
    let status = 0;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/message-answer`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      status = res.status;
    } catch {
      return 'error';
    }
    if (status === 200) return 'ok';
    if (status === 403) return 'token';
    // 404 (nothing open) and 409 (a newer window now) both mean the window we
    // were looking at is no longer answerable.
    if (status === 404 || status === 409) return 'gone';
    return 'error';
  }, [id]);

  const send = useCallback(async (text: string) => {
    const current = pending;
    if (!current || phase === 'submitting' || !text.trim()) return;
    setPhase('submitting');
    const outcome = await post({ messageId: current.messageId, text });
    if (outcome === 'ok') {
      setNeedsToken(false);
      setPhase('sent');
    } else if (outcome === 'token') {
      setNeedsToken(true);
      setPhase('idle');
    } else if (outcome === 'gone') {
      setPhase('gone');
    } else {
      setPhase('idle');
    }
  }, [pending, phase, post]);

  const dismiss = useCallback(async () => {
    const current = pending;
    if (!current || phase === 'submitting') return;
    setPhase('submitting');
    const outcome = await post({ messageId: current.messageId, dismiss: true });
    if (outcome === 'token') setNeedsToken(true);
    setPhase(outcome === 'gone' ? 'gone' : 'idle');
    if (outcome === 'ok') setPending(null);
  }, [pending, phase, post]);

  return { pending, phase, needsToken, send, dismiss, setToken };
}
```

- [ ] **Step 2: `client/src/components/MessagePanel.tsx`**

Copy `PlanPanel.tsx` as the base — full content:

```tsx
import { useEffect, useState } from 'react';

import type { PendingMessageState } from '../hooks/usePendingMessage';

/** Seconds left in the window, clamped at 0. */
function secsLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

function fmtLeft(s: number): string {
  return s >= 120 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

/**
 * The composer for a turn-end reply window. The session finished a turn while
 * you were away and is holding briefly — anything typed here continues the
 * model as its next instruction; "let it stop" releases the hold instead.
 *
 * Coming back to the keyboard also releases every hold within ~5s (the server
 * sweeps idle), so this panel can vanish on its own — that is the feature, not
 * a bug. The window carries no content: the turn's final message is already the
 * last message in the transcript above.
 */
export default function MessagePanel({ state }: { state: PendingMessageState }) {
  const { pending, phase, needsToken, send, dismiss, setToken } = state;
  const [text, setText] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [left, setLeft] = useState(0);

  // A new window (or a fresh drawer) starts from a clean slate.
  const messageId = pending?.messageId ?? null;
  useEffect(() => {
    setText('');
  }, [messageId]);

  // 1s countdown while a window is open — typing against an invisible
  // deadline is worse than watching it tick.
  const expiresAt = pending?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) return;
    setLeft(secsLeft(expiresAt));
    const timer = setInterval(() => setLeft(secsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (phase === 'gone') {
    return (
      <div className="qpanel gone">
        <span className="qp-note">That window closed — the session stopped, or another tab replied.</span>
      </div>
    );
  }

  // Checked before `pending`: the poll can take a tick to notice the wait is
  // over, and until then the form must not re-offer a send that would just 404.
  if (phase === 'sent') {
    return (
      <div className="qpanel sent">
        <span className="qp-note">✓ Sent · the session is continuing with your follow-up</span>
      </div>
    );
  }

  if (!pending) return null;

  const busy = phase === 'submitting';

  return (
    <div className="qpanel">
      <div className="qp-head">
        <span className="qp-badge">turn finished</span>
        <span className="qp-hint">reply to continue it · closes in {fmtLeft(left)}</span>
      </div>

      {needsToken && (
        <div className="qp-token">
          <span className="qp-note">This dashboard needs its answer token.</span>
          <input
            className="qp-other"
            type="password"
            placeholder="ANSWER_TOKEN"
            value={tokenDraft}
            onChange={e => setTokenDraft(e.target.value)}
          />
          <button type="button" className="qp-send" onClick={() => setToken(tokenDraft.trim())}>
            save
          </button>
        </div>
      )}

      <textarea
        className="qp-feedback"
        maxLength={4000}
        rows={3}
        placeholder="Follow-up for this session (sent to the model verbatim)"
        value={text}
        disabled={busy}
        onChange={e => setText(e.target.value)}
      />

      <div className="qp-actions">
        <button
          type="button"
          className="qp-send"
          disabled={busy || !text.trim()}
          onClick={() => void send(text)}
        >
          {busy ? 'sending…' : 'send'}
        </button>
        <button type="button" className="qp-term" disabled={busy} onClick={() => void dismiss()}>
          let it stop
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount in `ChatDrawer.tsx`**

Imports (next to the PlanPanel pair, lines 5-9):

```tsx
import MessagePanel from './MessagePanel';
import { usePendingMessage } from '../hooks/usePendingMessage';
```

Hook call after `const plan = usePendingPlan(session.id);` (line 78):

```tsx
  const message = usePendingMessage(session.id);
```

Mount after `<PlanPanel state={plan} />` (line 190):

```tsx
        {/* And for a turn-end reply window. One-entry-per-session per store and
            a session parks on one thing at a time, so at most one of the three
            panels renders. */}
        <MessagePanel state={message} />
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck` and `pnpm build`. Expected: clean.

- [ ] **Step 5: Browser verification**

With the Task 4 dev server running and a wait registered via the Task 5 Step 3 hook command: open the dashboard, open that session's drawer (any session row — the fake id won't match a row, so instead re-run the hook command with a REAL session id copied from the dashboard). Type a reply, send, confirm the hook prints the block JSON and the panel flips to "✓ Sent". Confirm "let it stop" releases the held curl with `{"status":"dismissed"}`.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/usePendingMessage.ts client/src/components/MessagePanel.tsx client/src/components/ChatDrawer.tsx
git commit -m "feat(client): reply-window composer in the chat drawer"
```

---

### Task 7: `reply?` pill on the session row

**Files:**
- Modify: `client/src/components/SessionRow.tsx` (after the `remotePlan` pill, ~line 64)

**Interfaces:**
- Consumes: `Session.remoteReply` (Task 4).

- [ ] **Step 1: Add the pill between the `plan?` pill and the `permissionWait` pill**

```tsx
        {/* A reply window is open — the turn finished while you were away and
            the session is holding for a follow-up from the drawer. */}
        {s.remoteReply && !s.remoteQuestion && !s.remotePlan && (
          <button
            className="ag-pill answer"
            onClick={e => { e.stopPropagation(); onOpenChat(); }}
            title="Turn finished — reply from the chat drawer, or let it stop"
          >
            reply?
          </button>
        )}
```

Also extend the `permissionWait` pill's condition (line 68) to `{s.permissionWait && !s.remoteQuestion && !s.remotePlan && !s.remoteReply && (` — one pill at a time, same chain as the scan.

- [ ] **Step 2: Typecheck, then visual check**

Run: `pnpm typecheck`. Then with a hold registered for a real session id (Task 6 Step 5 setup), confirm the row shows a pulsing blue `reply?` pill within one refresh, and that it opens the drawer.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/SessionRow.tsx
git commit -m "feat(client): reply? pill for held reply windows"
```

---

### Task 8: End-to-end smoke with a real session

**Files:** none (verification only; fixes discovered here belong to the task that owns the file).

- [ ] **Step 1: Install the hook for real**

Confirm `~/.claude/hooks/stop-notify.sh` symlinks to this repo's script (`ls -la ~/.claude/hooks/`). In `~/.claude/settings.json`, the Stop entry must read `"timeout": 630`. If it lacks the timeout, add it.

- [ ] **Step 2: Live test**

- Dashboard running with `REMOTE_ANSWER=true`; remote-answer toggle ON.
- Settings → Away after: note the threshold; either wait it out or export `CLAUDE_DASHBOARD_IDLE_SECS=5` in the shell that runs the test session.
- Start a throwaway Claude Code session in some directory, give it a trivial task ("echo hi and stop"), take your hands off the keyboard past the threshold before it finishes.
- Expected: turn end holds; dashboard row flips blue `reply?`; (if ntfy configured) push says `— finished — reply window open`; drawer shows the composer with a live countdown.
- Send "now say goodbye": the session continues and does it; the panel shows ✓; the next turn end holds AGAIN (stop_hook_active loop) with no second push.
- Reply nothing this time; touch the keyboard/mouse: the hold releases within ~5s and the session stops (auto-release).
- Flip the remote-answer toggle off during a third hold: it releases immediately (`dismissAll` join).

- [ ] **Step 3: Confirm the suite still passes**

Run: `pnpm test && pnpm typecheck`.

---

### Task 9: Docs

**Files:**
- Create: `docs/subsystems/remote-message.md`
- Modify: `docs/subsystems/push-notify.md`, `docs/subsystems/settings.md`, `docs/subsystems/remote-answer.md`, `docs/workflows/push-notify-setup.md`, `docs/overview.md`, `.claude/CLAUDE.md`

**Interfaces:** none — prose only.

- [ ] **Step 1: Write `docs/subsystems/remote-message.md`**

Differences-only doc modeled on `remote-plan.md` (read that first; keep its frontmatter shape with `docs-sync.sources` listing `server/lib/messages.ts`, `server/api.ts`, `server/index.ts`, `server/lib/scan.ts`, `scripts/stop-notify-hook.sh`, `client/src/components/MessagePanel.tsx`, `client/src/hooks/usePendingMessage.ts`; leave `verified:` at the current HEAD hash). Must cover, at minimum:
- The mechanism deltas vs `remote-answer.md`: Stop hook (not PreToolUse), block-with-reason (not deny), the verified top-level output shape, the 8-block cap, `stop_hook_active` semantics, no `sessionExists` on the wait (turn-end flush timing).
- The `released` status and the idle sweep (5s, `readIdleSecs`, `idleSecs=0`/unreadable guards).
- The endpoints table (three routes + codes) and the route-order invariant.
- The security widening paragraph from the spec (every AFK turn-end is steerable; `ANSWER_TOKEN`; tailnet perimeter).
- The install block (symlink unchanged; `"timeout": 630` now required).

- [ ] **Step 2: Touch the neighbors**

- `push-notify.md`: the `stop` event now enters at two routes (`/api/notify/event` at the desk, `/api/messages/wait` away); phrase override `finished — reply window open`; no push on `stopHookActive`; update the events-entering table and the idle-gate table row for `stop` (it now HAS an idle gate on the hold path).
- `settings.md`: Answer window now sizes three waits (questions, plans, replies); Away after now also gates the Stop hold and the auto-release sweep.
- `remote-answer.md`: one line in the intro noting the third write path and linking `remote-message.md`.
- `docs/workflows/push-notify-setup.md`: the Stop entry now needs `"timeout": 630`; what breaks without it (holds die at the CLI's default hook timeout).
- `docs/overview.md`: add the subsystem to the map.
- `.claude/CLAUDE.md`: add `lib/messages.ts` and `MessagePanel.tsx` lines to the tree, mirroring how `plans.ts`/`PlanPanel` are described.

- [ ] **Step 3: Commit**

```bash
git add docs/ .claude/CLAUDE.md
git commit -m "docs: remote-message subsystem + neighbor updates"
```

---

## Self-review (done at write time)

- **Spec coverage:** hook (Task 5), store+types (1), auto-release (2), push phrase/suppression (3+4), endpoints/routes/toggle/scan (4), composer+pill (6+7), tests (1-3), docs+security callout (9), e2e incl. cap/auto-release/toggle behaviors (8). Spec's "wait POST failure → notify fallback" — Task 5 script `|| notify_fallback`. Spec's "no sessionExists" — Task 4 Step 2.
- **Type consistency:** `MessageWaitResult.status` union matches store settles (`answered/timeout/superseded/dismissed/released`); `PendingMessage.expiresAt` produced in `register`, consumed by panel countdown; alias names (`answerMessage`/`cancelMessage`/`dismissAllMessages`/`registerMessage`) consistent between api.ts steps.
- **Placeholder scan:** every code step is full code; the two deliberate look-it-up notes (settings seam in Task 2, exact gate line in Task 4 Step 2) name the file and the neighbor to copy, not "TBD".
