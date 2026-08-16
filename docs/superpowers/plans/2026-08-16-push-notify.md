# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard server sends ntfy push notifications for four session events, gated by a layered policy the user edits in Settings.

**Architecture:** A new `server/lib/notify.ts` owns a pure predicate (`shouldNotify`) and a fire-and-forget sender. Three of the four events already arrive as hook POSTs to existing endpoints, so those handlers call `maybeSend` inline; the fourth (`stop`) gets a new fire-and-forget endpoint. Policy lives in the existing `.dashboard-settings.json` store; the ntfy topic lives in `.env` and is never returned by any endpoint.

**Tech Stack:** TypeScript, Node built-ins only (`node:https`, `node:child_process`), React 18, bash hooks. No new dependencies — the backend is zero-runtime-dep by design.

**Spec:** `docs/superpowers/specs/2026-08-16-push-notify-design.md`

## Global Constraints

- **Zero new runtime dependencies in `server/`.** Node built-ins only.
- **ESM everywhere.** Server imports use a `.js` suffix (`from './settings.js'`), which resolves to `.ts` under Bundler resolution + tsx.
- **Cross-boundary imports use `import type`** — no runtime coupling between `client/` and `server/`.
- **`shared/types.ts` is edited first** when adding an API field, then the producer, then the consumer.
- **The ntfy topic is a secret.** No endpoint returns it. ntfy topics are unauthenticated: anyone who learns the string can read and publish.
- **Push bodies carry no work content** — session label and event phrase only. Never question text, plan markdown, tool names, or transcript content. The one identifier that does leave is the session id, and only inside the `Click` deep link (Task 3 / Task 7).
- **Never hardcode a color or shadow in `styles.css`** below the theme-token block.
- **Every new setting defaults to `false`/off.** This feature is opt-in.
- **Auto-ish permission modes:** exactly `auto`, `bypassPermissions`, `dontAsk`.
- Run `pnpm test` and `pnpm typecheck` before every commit.

---

### Task 1: The `notify` policy in the settings store

Adds the persisted policy block. No sending yet — this task ends with a policy that round-trips through `GET`/`POST /api/settings`.

**Files:**
- Modify: `shared/types.ts` (after `ServerSettings`, around line 229)
- Modify: `server/lib/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NotifyEvent`, `NotifyPolicy`, `DEFAULT_NOTIFY`, `ServerSettings.notify`, `ServerSettings.notifyAvailable`.

- [ ] **Step 1: Add the contract types**

In `shared/types.ts`, immediately before `export interface ServerSettings`:

```ts
/** The four session events a push can announce. */
export type NotifyEvent = 'question' | 'stop' | 'permission' | 'plan';

/**
 * When to send a push. Every clause is AND-ed, and every layer is independently
 * optional — adding one later means adding one clause. All fields default false:
 * this feature is opt-in.
 *
 * See `docs/subsystems/push-notify.md`.
 */
export interface NotifyPolicy {
  /** Master switch. Off → nothing is ever sent. */
  enabled: boolean;
  /** Per-event opt-in. An event absent from the user's picks is never sent. */
  events: Record<NotifyEvent, boolean>;
  /** Only push while the remote-answer toggle is on. */
  requireRemoteAnswer: boolean;
  /** Only push once you have been away from the keyboard for `idleSecs`. */
  requireAfk: boolean;
  /** Only push from sessions in an auto-ish permission mode. */
  requireAutoMode: boolean;
}
```

Then add two fields to `ServerSettings`, after `answerOverride`:

```ts
  /** When to send ntfy pushes. See {@link NotifyPolicy}. */
  notify: NotifyPolicy;
  /**
   * Whether `NTFY_TOPIC` is configured. The topic itself is never returned:
   * ntfy topics are unauthenticated, so anyone who can read this payload could
   * both read and publish to the channel.
   */
  notifyAvailable: boolean;
```

- [ ] **Step 2: Write the failing tests**

Append to `test/settings.test.ts`, inside the existing `run()` body, immediately before the `console.log(\`\n  ${p} passed, ${f} failed\`)` line. Add `DEFAULT_NOTIFY` to the existing import from `../server/lib/settings.js`.

The file's idiom is `if (test('name', fn)) p++; else f++;` with `assert.strictEqual` — match it exactly:

```ts
  if (test('notify defaults to every switch off', () => {
    inTmpCwd(() => {
      const s = getSettings();
      assert.deepStrictEqual(s.notify, DEFAULT_NOTIFY);
      assert.strictEqual(s.notify.enabled, false);
      assert.strictEqual(s.notify.events.question, false);
    });
  })) p++; else f++;

  if (test('a notify patch merges instead of replacing', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true } });
      setSettings({ notify: { events: { question: true } } });
      const s = getSettings();
      assert.strictEqual(s.notify.enabled, true, 'enabled survived the second patch');
      assert.strictEqual(s.notify.events.question, true);
      assert.strictEqual(s.notify.events.stop, false, 'untouched events stay off');
    });
  })) p++; else f++;

  if (test('a stored notify policy survives a restart', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true, requireAfk: true } });
      resetSettings(); // simulate the server restarting
      const s = getSettings();
      assert.strictEqual(s.notify.enabled, true);
      assert.strictEqual(s.notify.requireAfk, true);
    });
  })) p++; else f++;

  if (test('a bad notify value rejects the whole patch', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true } });
      assert.strictEqual(setSettings({ notify: { enabled: 'yes' } }), null);
      assert.strictEqual(getSettings().notify.enabled, true, 'previous value untouched');
    });
  })) p++; else f++;

  if (test('a bad or unknown event key rejects the whole patch', () => {
    inTmpCwd(() => {
      assert.strictEqual(setSettings({ notify: { events: { question: 1 } } }), null);
      assert.strictEqual(setSettings({ notify: { events: { nope: true } } }), null);
    });
  })) p++; else f++;

  if (test('an unreadable settings file yields notify defaults', () => {
    inTmpCwd(dir => {
      fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{not json', 'utf8');
      resetSettings();
      assert.deepStrictEqual(getSettings().notify, DEFAULT_NOTIFY);
    });
  })) p++; else f++;
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm test 2>&1 | grep -A2 'notify'
```

Expected: FAIL — `DEFAULT_NOTIFY` is not exported, and `notify` is undefined on the settings object.

- [ ] **Step 4: Implement the store changes**

In `server/lib/settings.ts`, add the import and the default beside the other constants:

```ts
import type { EnvOverride, NotifyEvent, NotifyPolicy, ServerSettings } from '../../shared/types.js';

/** Every switch off. This feature is opt-in, like `alertsEnabled` on the client. */
export const DEFAULT_NOTIFY: NotifyPolicy = {
  enabled: false,
  events: { question: false, stop: false, permission: false, plan: false },
  requireRemoteAnswer: false,
  requireAfk: false,
  requireAutoMode: false
};

const NOTIFY_EVENTS: readonly NotifyEvent[] = ['question', 'stop', 'permission', 'plan'];
```

Widen `Stored`:

```ts
interface Stored {
  idleSecs: number;
  answerSecs: number;
  notify: NotifyPolicy;
}
```

Add the validator. It returns `undefined` for "nothing to change" and `null` for "reject the whole patch", which is the distinction `setSettings` already relies on for the scalar keys:

```ts
/**
 * Merge a partial notify patch over the current policy.
 *
 * Returns `null` when any present key is unusable — the caller turns that into a
 * 400 for the whole patch, because a half-applied save is the one outcome the UI
 * cannot report honestly. Absent keys keep their current value, so the UI can
 * send a single changed checkbox.
 */
export function mergeNotify(current: NotifyPolicy, patch: unknown): NotifyPolicy | null {
  if (!patch || typeof patch !== 'object') return null;
  const p = patch as Record<string, unknown>;
  const next: NotifyPolicy = { ...current, events: { ...current.events } };

  for (const key of ['enabled', 'requireRemoteAnswer', 'requireAfk', 'requireAutoMode'] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== 'boolean') return null;
    next[key] = p[key] as boolean;
  }

  if (p.events !== undefined) {
    if (!p.events || typeof p.events !== 'object') return null;
    for (const [name, value] of Object.entries(p.events as Record<string, unknown>)) {
      if (!NOTIFY_EVENTS.includes(name as NotifyEvent)) return null;
      if (typeof value !== 'boolean') return null;
      next.events[name as NotifyEvent] = value;
    }
  }
  return next;
}
```

Read it back in `readStored`, falling back per-key like the scalars:

```ts
  const fallback: Stored = {
    idleSecs: DEFAULT_IDLE_SECS,
    answerSecs: DEFAULT_ANSWER_SECS,
    notify: DEFAULT_NOTIFY
  };
```

and inside the `try`, add to the returned object:

```ts
      notify: mergeNotify(DEFAULT_NOTIFY, raw.notify) ?? DEFAULT_NOTIFY
```

Accept it in `setSettings`, alongside the two scalar branches:

```ts
  if (body.notify !== undefined) {
    if (cached === null) cached = readStored();
    const notify = mergeNotify(cached.notify, body.notify);
    if (notify === null) return null;
    next.notify = notify;
  }
```

and widen the body type on the line above:

```ts
  const body = patch as { idleSecs?: unknown; answerSecs?: unknown; notify?: unknown } | null;
```

Finally, `getSettings` returns the new field. `notifyAvailable` is filled by the caller in Task 3 — for now hardcode `false` and leave a comment, so the type is satisfied without inventing a config read this task does not own:

```ts
    // Overwritten by the API layer, which is where Config is available (Task 4).
    notifyAvailable: false
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test 2>&1 | tail -5
```

Expected: `ALL PASS`, with the new notify cases listed.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts server/lib/settings.ts test/settings.test.ts
git commit -m "feat(notify): persist the push-notification policy"
```

---

### Task 2: The predicate

The heart of the feature and its whole test surface. Pure — no I/O, no config, no network.

**Files:**
- Create: `server/lib/notify.ts`
- Create: `test/notify.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: `NotifyEvent`, `NotifyPolicy` from Task 1.
- Produces: `AUTO_MODES`, `PredicateContext`, `shouldNotify(event, policy, ctx): boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/notify.test.ts`:

```ts
import assert from 'node:assert';

import { AUTO_MODES, shouldNotify } from '../server/lib/notify.js';
import { DEFAULT_NOTIFY } from '../server/lib/settings.js';
import type { PredicateContext } from '../server/lib/notify.js';
import type { NotifyPolicy } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A policy with the master on, one event on, and no optional layers. */
function policy(over: Partial<NotifyPolicy> = {}): NotifyPolicy {
  return {
    ...DEFAULT_NOTIFY,
    enabled: true,
    events: { ...DEFAULT_NOTIFY.events, question: true },
    ...over
  };
}

/** A context that satisfies every layer, so each test can break exactly one. */
function ctx(over: Partial<PredicateContext> = {}): PredicateContext {
  return {
    remoteAnswer: true,
    thresholdSecs: 60,
    permissionMode: 'bypassPermissions',
    readIdle: () => 300,
    ...over
  };
}

export async function run(): Promise<number> {
  console.log('\n=== notify.ts ===\n');
  let p = 0, f = 0;

  if (test('sends when every gate passes', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx()), true);
  })) p++; else f++;

  if (test('master off blocks everything', () => {
    assert.strictEqual(shouldNotify('question', policy({ enabled: false }), ctx()), false);
  })) p++; else f++;

  if (test('an unselected event is never sent', () => {
    assert.strictEqual(shouldNotify('stop', policy(), ctx()), false);
    assert.strictEqual(shouldNotify('plan', policy(), ctx()), false);
    assert.strictEqual(shouldNotify('permission', policy(), ctx()), false);
  })) p++; else f++;

  if (test('requireRemoteAnswer honours the toggle', () => {
    const pol = policy({ requireRemoteAnswer: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: true })), true);
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: false })), false);
  })) p++; else f++;

  if (test('requireRemoteAnswer off ignores the toggle', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx({ remoteAnswer: false })), true);
  })) p++; else f++;

  if (test('requireAfk compares idle against the threshold', () => {
    const pol = policy({ requireAfk: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 61 })), true);
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 60 })), true, 'equal counts as away');
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 59 })), false);
  })) p++; else f++;

  if (test('unreadable idle pushes anyway', () => {
    const pol = policy({ requireAfk: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => null })), true);
  })) p++; else f++;

  if (test('requireAfk off never reads idle', () => {
    let calls = 0;
    shouldNotify('question', policy(), ctx({ readIdle: () => { calls++; return 0; } }));
    assert.strictEqual(calls, 0, 'the ioreg spawn must be skipped entirely');
  })) p++; else f++;

  if (test('a failing cheap gate short-circuits before idle', () => {
    let calls = 0;
    const pol = policy({ enabled: false, requireAfk: true });
    shouldNotify('question', pol, ctx({ readIdle: () => { calls++; return 0; } }));
    assert.strictEqual(calls, 0);
  })) p++; else f++;

  if (test('requireAutoMode accepts only auto-ish modes', () => {
    const pol = policy({ requireAutoMode: true });
    for (const mode of AUTO_MODES) {
      assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: mode })), true, mode);
    }
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'default' })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'plan' })), false);
  })) p++; else f++;

  if (test('a missing permission mode is not auto-ish', () => {
    const pol = policy({ requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: undefined })), false);
  })) p++; else f++;

  if (test('requireAutoMode off ignores the mode', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx({ permissionMode: undefined })), true);
  })) p++; else f++;

  if (test('all three layers on, all satisfied', () => {
    const pol = policy({ requireRemoteAnswer: true, requireAfk: true, requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx()), true);
  })) p++; else f++;

  if (test('all three layers on, any one violated blocks', () => {
    const pol = policy({ requireRemoteAnswer: true, requireAfk: true, requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: false })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 5 })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'default' })), false);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
```

`run` is `async` from the start even though this task's cases are all synchronous: Task 3 adds two `await`-ing cases, and several existing modules (`pending`, `plans`, `permissions`, `alert-stream`) are already registered with `await`. Declaring it now avoids changing the signature and the registration a second time.

- [ ] **Step 2: Register the module and run it to verify it fails**

In `test/run-all.ts`, add the import after the `runAlertStream` line:

```ts
import { run as runNotify } from './notify.test.js';
```

and the call after `failed += await runAlertStream();`:

```ts
failed += await runNotify();
```

Run:

```bash
pnpm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../server/lib/notify.js'`.

- [ ] **Step 3: Write the predicate**

Create `server/lib/notify.ts`:

```ts
/**
 * notify.ts — server-sent ntfy pushes for "a session needs you".
 *
 * Why the server sends rather than the hooks: three of the four events already
 * arrive here as hook POSTs (`/api/questions/wait`, `/api/plans/wait`,
 * `/api/permissions/notify`), each with the granularity the user picks events
 * at, at the exact moment they happen. Delivering from here keeps the whole
 * policy in one testable place instead of re-implementing it in four shell
 * scripts — which is what this replaces.
 *
 * This is the one part of the backend that talks to the internet. It stays
 * zero-dependency (`node:https`), fire-and-forget, and can never fail or delay
 * the request that triggered it.
 *
 * See `docs/subsystems/push-notify.md`.
 */

import type { NotifyEvent, NotifyPolicy } from '../../shared/types.js';

/**
 * Permission modes that count as "running unattended".
 *
 * Deliberately duplicated from `MODES` in `scripts/remote-decision-hook.sh`
 * rather than shared: one is TypeScript and the other is bash, and three words
 * of rule is not worth coupling a shell script to a module. The same call was
 * made for `NEEDS_YOU` across `alertStream.ts` and `client/src/lib/alerts.ts`.
 * Change one, change the other.
 */
export const AUTO_MODES: ReadonlySet<string> = new Set(['auto', 'bypassPermissions', 'dontAsk']);

export interface PredicateContext {
  /** `remoteState.getState().remoteAnswer` — the env gate AND the UI toggle. */
  remoteAnswer: boolean;
  /** `settings.idleSecs` — the same threshold the remote-answer hooks use. */
  thresholdSecs: number;
  /** From the hook payload. Absent on paths that cannot see it. */
  permissionMode?: string;
  /**
   * Seconds since the last HID event, or null when unreadable. A thunk, not a
   * value: reading it spawns `ioreg`, and the whole point of the clause order
   * below is that a policy without `requireAfk` never pays for that.
   */
  readIdle: () => number | null;
}

/**
 * The whole policy. Clauses are ordered cheapest-first and short-circuit, so
 * `readIdle` is called only when every free check has already passed.
 */
export function shouldNotify(event: NotifyEvent, policy: NotifyPolicy, ctx: PredicateContext): boolean {
  if (!policy.enabled) return false;
  if (!policy.events[event]) return false;
  if (policy.requireRemoteAnswer && !ctx.remoteAnswer) return false;
  if (policy.requireAutoMode && !AUTO_MODES.has(ctx.permissionMode ?? '')) return false;

  if (policy.requireAfk) {
    const idle = ctx.readIdle();
    // Unreadable (Docker, non-macOS) → push anyway. Failing silent here would
    // reintroduce the missed-notification bug this feature exists to fix, and a
    // wrong guess costs one extra push rather than a hidden dialog — which is
    // why this fails the opposite way to `ask-remote-hook.sh`.
    if (idle !== null && idle < ctx.thresholdSecs) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test 2>&1 | tail -20
```

Expected: `ALL PASS`, with 14 new `notify` cases.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add server/lib/notify.ts test/notify.test.ts test/run-all.ts
git commit -m "feat(notify): add the push predicate"
```

---

### Task 3: Delivery — config gate, transport, idle, label

Turns the predicate into something that actually sends. Ends with `maybeSend` fully exercised through an injected transport; no test opens a socket.

**Files:**
- Modify: `server/lib/config.ts`
- Modify: `server/lib/notify.ts`
- Test: `test/notify.test.ts`

**Interfaces:**
- Consumes: `shouldNotify`, `PredicateContext` (Task 2); `getSettings` (Task 1); `getState` from `remoteState.js`; `scanSessions` from `scan.js`.
- Produces: `Config.ntfyTopic`, `Config.ntfyServer`, `Config.publicUrl`, `Sender`, `NotifyPayload`, `maybeSend(config, event, ctx)`, `sendTest(config)`, `resolveLabel(config, sessionId)`, `clickUrl(config, sessionId)`, `readIdleSecs()`, and the test seams `setSender(fn)`, `setLabelResolver(fn)`, `resetNotify()`.

- [ ] **Step 1: Write the failing tests**

Append to `test/notify.test.ts` — add these imports at the top:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { maybeSend, resetNotify, resolveLabel, sendTest, setLabelResolver, setSender } from '../server/lib/notify.js';
import { SETTINGS_FILE, resetSettings, setSettings } from '../server/lib/settings.js';
import { resetState } from '../server/lib/remoteState.js';
import type { Config } from '../server/lib/config.js';
import type { NotifyPayload } from '../server/lib/notify.js';
```

and these helpers below the existing ones:

```ts
/** Only the fields notify reads. */
function conf(over: Partial<Config> = {}): Config {
  return {
    remoteAnswer: true,
    ntfyTopic: 'test-topic',
    ntfyServer: 'https://ntfy.example',
    publicUrl: 'https://dash.example',
    ...over
  } as Config;
}

/**
 * Settings and remote state resolve from cwd, so these tests run in a tmpdir
 * with the transport swapped for a recorder. Async so the two `sendTest` cases
 * can await inside it — a sync-only helper would tear the tmpdir down before
 * their assertions ran.
 */
async function inTmpCwd(fn: (sent: NotifyPayload[]) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-notify-'));
  const prev = process.cwd();
  const sent: NotifyPayload[] = [];
  try {
    process.chdir(dir);
    resetSettings();
    resetState();
    resetNotify();
    setSender(p => { sent.push(p); });
    // Otherwise every delivery test scans the developer's real ~/.claude/projects.
    setLabelResolver(() => 'demo-project');
    await fn(sent);
  } finally {
    process.chdir(prev);
    setSender(null);
    resetNotify();
    resetSettings();
    resetState();
  }
}

/** `test`, but for a case whose body awaits. Same pass/fail contract. */
async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}
```

Because `inTmpCwd` is now async, **every** case in this task uses `testAsync` and `await`, not the sync `test` from Task 2. The Task 2 cases stay synchronous — they never touch the filesystem.

Then these cases inside `run()`:

```ts
  const SID = 'abc12345-0000-0000-0000-000000000000';

  if (await testAsync('maybeSend delivers when the policy passes', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].title, 'Claude Code');
    assert.match(sent[0].body, /task finished$/);
  }))) p++; else f++;

  if (await testAsync('maybeSend is silent when the policy fails', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: false, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 0);
  }))) p++; else f++;

  if (await testAsync('no topic configured means nothing is sent', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf({ ntfyTopic: '' }), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 0);
  }))) p++; else f++;

  if (await testAsync('the visible payload carries no work content', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf(), 'question', { sessionId: SID, permissionMode: 'bypassPermissions' });
    assert.strictEqual(sent.length, 1);
    // The click URL legitimately holds the id; nothing the user reads may.
    const visible = `${sent[0].title} ${sent[0].body} ${sent[0].tags}`;
    for (const leak of ['bypassPermissions', SID]) {
      assert.ok(!visible.includes(leak), `visible payload must not contain ${leak}`);
    }
  }))) p++; else f++;

  if (await testAsync('the click URL deep-links to the session', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf(), 'question', { sessionId: SID });
    assert.strictEqual(sent[0].click, `https://dash.example/?session=${SID}`);
  }))) p++; else f++;

  if (await testAsync('no public URL means no click header', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf({ publicUrl: '' }), 'question', { sessionId: SID });
    assert.strictEqual(sent.length, 1, 'the push still goes out');
    assert.strictEqual(sent[0].click, '');
  }))) p++; else f++;

  if (await testAsync('the label reaches the body', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent[0].body, 'demo-project — task finished');
  }))) p++; else f++;

  // The one case that exercises the real lookup, so the fallback is covered
  // rather than stubbed. Runs one scan; no id this shaped can ever match.
  if (test('an unknown session falls back to a short id', () => {
    resetNotify();
    assert.strictEqual(resolveLabel(conf(), 'deadbeef-0000-0000-0000-000000000000'), 'deadbeef');
  })) p++; else f++;

  if (await testAsync('a throwing sender never escapes maybeSend', () => inTmpCwd(() => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    setSender(() => { throw new Error('network down'); });
    maybeSend(conf(), 'stop', { sessionId: SID }); // must not throw
  }))) p++; else f++;

  if (await testAsync('sendTest fires regardless of the policy', () => inTmpCwd(async sent => {
    // Master switch left off — the test button must still send.
    const outcome = await sendTest(conf());
    assert.strictEqual(sent.length, 1);
    assert.match(outcome, /sent/);
  }))) p++; else f++;

  if (await testAsync('sendTest reports a missing topic instead of throwing', () => inTmpCwd(async () => {
    const outcome = await sendTest(conf({ ntfyTopic: '' }));
    assert.match(outcome, /NTFY_TOPIC/);
  }))) p++; else f++;
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test 2>&1 | grep -c '✗'
```

Expected: a nonzero count — `maybeSend` and friends do not exist.

- [ ] **Step 3: Add the config gate**

In `server/lib/config.ts`, add to `Config` after `answerToken`:

```ts
  /**
   * ntfy topic for push notifications. Empty (default) disables pushes outright,
   * the same way `REMOTE_ANSWER=false` disables remote answers. Kept in `.env`
   * and never returned by an endpoint: ntfy topics are unauthenticated, so the
   * string is both the address and the credential.
   */
  ntfyTopic: string;
  /** Base URL of the ntfy server. Override for a self-hosted instance. */
  ntfyServer: string;
  /**
   * How a phone reaches this dashboard, used for the notification's tap-through
   * link. Cannot be inferred: a push is not triggered by a browser request, so
   * there is no Host header to read. The localhost default works at the desk and
   * is useless on a phone — set it to the tailnet hostname.
   */
  publicUrl: string;
```

to `DEFAULTS`:

```ts
  NTFY_TOPIC: '',
  NTFY_SERVER: 'https://ntfy.sh',
  DASHBOARD_PUBLIC_URL: ''
```

and to the object `loadConfig` returns — note `publicUrl` falls back to the resolved
port, so it must be computed after it:

```ts
    ntfyTopic: (src('NTFY_TOPIC') || DEFAULTS.NTFY_TOPIC).trim(),
    ntfyServer: (src('NTFY_SERVER') || DEFAULTS.NTFY_SERVER).trim().replace(/\/+$/, ''),
    publicUrl: (src('DASHBOARD_PUBLIC_URL') || `http://localhost:${toPosInt(src('PORT'), DEFAULTS.PORT)}`)
      .trim()
      .replace(/\/+$/, '')
```

- [ ] **Step 4: Implement delivery**

Append to `server/lib/notify.ts`:

```ts
import { execFileSync } from 'node:child_process';
import https from 'node:https';

import { getState } from './remoteState.js';
import { scanSessions } from './scan.js';
import { getSettings } from './settings.js';
import type { Config } from './config.js';

/**
 * What reaches ntfy. Deliberately has no field that could carry work content —
 * `click` is the single exception, and carries only an id and this dashboard's
 * own address so the notification can be tapped through to the right chat.
 */
export interface NotifyPayload {
  title: string;
  body: string;
  tags: string;
  /** Tap-through URL, or '' when no public URL is configured. */
  click: string;
}

export type Sender = (payload: NotifyPayload, config: Config) => void;

/** One phrase per event. The only prose the user receives. */
const PHRASE: Record<NotifyEvent, string> = {
  question: 'question waiting',
  plan: 'plan waiting for review',
  permission: 'permission dialog open',
  stop: 'task finished'
};

const TAGS: Record<NotifyEvent, string> = {
  question: 'question',
  plan: 'clipboard',
  permission: 'lock',
  stop: 'white_check_mark'
};

let sender: Sender | null = null;
let labelResolver: ((config: Config, sessionId: string) => string) | null = null;

/** Test seam: swap the transport so no test opens a socket. `null` restores https. */
export function setSender(fn: Sender | null): void {
  sender = fn;
}

/**
 * Test seam: swap the label lookup. Without it every delivery test would run a
 * real scan of `~/.claude/projects` — slow, and dependent on whatever sessions
 * the developer happens to have on disk.
 */
export function setLabelResolver(fn: ((config: Config, sessionId: string) => string) | null): void {
  labelResolver = fn;
}

export function resetNotify(): void {
  sender = null;
  labelResolver = null;
}

/**
 * Seconds since the last keyboard/mouse event, or null when unreadable.
 *
 * Same source `ask-remote-hook.sh` uses. Unreadable means non-macOS or a
 * container, and the predicate treats that as "push anyway" — see
 * {@link shouldNotify}.
 */
export function readIdleSecs(): number | null {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', timeout: 1000 });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return null;
    return Math.floor(Number(match[1]) / 1_000_000_000);
  } catch {
    return null;
  }
}

/**
 * Human label for a session. Every caller has an id and none has a name — the
 * hooks cannot know it and the registration handlers never needed it — so it is
 * resolved the way the rest of the app does. Called only after the predicate has
 * passed, so the scan is never paid for a push that will not be sent.
 */
export function resolveLabel(config: Config, sessionId: string): string {
  if (labelResolver) return labelResolver(config, sessionId);
  try {
    const found = scanSessions(config).sessions.find(s => s.id === sessionId);
    if (found) return found.sessionName || found.project;
  } catch {
    /* scan failed — a poor label beats no push */
  }
  return sessionId.slice(0, 8);
}

/**
 * Where tapping the notification lands: this session's chat drawer, which is
 * where every action surface already lives (`QuestionPanel`, `PlanPanel`,
 * `PermissionBanner`). Consumed by `AppShell` on load — see Task 7.
 *
 * Empty when no public URL is configured, which drops the header rather than
 * shipping a localhost link a phone cannot follow.
 */
export function clickUrl(config: Config, sessionId: string): string {
  if (!config.publicUrl) return '';
  return `${config.publicUrl}/?session=${encodeURIComponent(sessionId)}`;
}

/** The default transport. Fire-and-forget: nothing awaits it, nothing throws out of it. */
function httpsSend(payload: NotifyPayload, config: Config): void {
  try {
    const url = new URL(`${config.ntfyServer}/${config.ntfyTopic}`);
    const headers: Record<string, string> = {
      Title: payload.title,
      Tags: payload.tags,
      'Content-Type': 'text/plain'
    };
    // ntfy opens this when the notification is tapped. Omitted rather than sent
    // empty: an empty Click is a malformed header, not a no-op.
    if (payload.click) headers.Click = payload.click;

    const req = https.request(
      url,
      { method: 'POST', timeout: 2000, headers },
      res => res.resume() // drain, ignore
    );
    req.on('error', () => { /* offline, DNS, TLS — never surfaces */ });
    req.on('timeout', () => req.destroy());
    req.end(payload.body);
  } catch {
    /* malformed URL from a hand-edited .env */
  }
}

function deliver(payload: NotifyPayload, config: Config): void {
  (sender ?? httpsSend)(payload, config);
}

/**
 * Evaluate the policy and, if it passes, send. Returns immediately and never
 * throws: every caller is a request handler that must not be delayed or failed
 * by a notification.
 */
export function maybeSend(
  config: Config,
  event: NotifyEvent,
  ctx: { sessionId: string; permissionMode?: string }
): void {
  try {
    if (!config.ntfyTopic) return;
    const settings = getSettings();
    const passes = shouldNotify(event, settings.notify, {
      remoteAnswer: getState(config).remoteAnswer,
      thresholdSecs: settings.idleSecs,
      permissionMode: ctx.permissionMode,
      readIdle: readIdleSecs
    });
    if (!passes) return;

    deliver(
      {
        title: 'Claude Code',
        body: `${resolveLabel(config, ctx.sessionId)} — ${PHRASE[event]}`,
        tags: TAGS[event],
        click: clickUrl(config, ctx.sessionId)
      },
      config
    );
  } catch {
    /* a notification must never break the request that triggered it */
  }
}

/**
 * Fire one push regardless of policy and say what happened.
 *
 * Every failure in this feature is invisible from the outside — an off switch, a
 * missing topic and a dropped packet all look identical — so the only honest
 * answer to "is this working?" is to fire one and report. Mirrors
 * `fireTestAlert` in `client/src/hooks/useSessionAlerts.ts`.
 */
export async function sendTest(config: Config): Promise<string> {
  if (!config.ntfyTopic) return 'no NTFY_TOPIC set in .env — nothing to send to';
  try {
    deliver(
      { title: 'Claude Code', body: 'Test push — notifications are working', tags: 'robot', click: config.publicUrl },
      config
    );
    return config.publicUrl
      ? `sent to ${config.ntfyServer} · taps open ${config.publicUrl}`
      : `sent to ${config.ntfyServer} · no DASHBOARD_PUBLIC_URL, so taps won't open the dashboard`;
  } catch (err) {
    return `send failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test 2>&1 | tail -20
```

Expected: `ALL PASS`.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add server/lib/config.ts server/lib/notify.ts test/notify.test.ts
git commit -m "feat(notify): deliver pushes over ntfy"
```

---

### Task 4: HTTP surface

Wires the three existing registration points and adds the two new routes.

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/api.ts` (`serveQuestionWait:349`, `servePlanWait:414`, `servePermissionNotify:483`, `serveSettingsRead:299`, `serveSettingsWrite:308`)
- Modify: `server/index.ts` (route table, around line 101-121)

**Interfaces:**
- Consumes: `maybeSend`, `sendTest` (Task 3).
- Produces: `POST /api/notify/event`, `POST /api/notify/test`, `serveNotifyEvent`, `serveNotifyTest`.

- [ ] **Step 1: Add the request types**

In `shared/types.ts`, after `NotifyPolicy`:

```ts
/** `POST /api/notify/event` — the `stop` hook's path into the notifier. */
export interface NotifyEventRequest {
  sessionId: string;
  event: NotifyEvent;
  /** From the hook payload; omitted where the event does not carry it. */
  permissionMode?: string;
}

/** `POST /api/notify/test` — what the Settings button reports back. */
export interface NotifyTestResponse {
  outcome: string;
}
```

Add `permissionMode?: string` with this comment to whichever of `QuestionWaitRequest`, `PlanWaitRequest` and `PermissionNotifyRequest` are declared in this file; if a request shape is only expressed inline in `api.ts`, widen the inline cast there instead:

```ts
  /** The session's permission mode, for the notifier's auto-mode layer. Optional so an un-upgraded hook keeps working. */
  permissionMode?: string;
```

- [ ] **Step 2: Wire the three existing handlers**

In `server/api.ts`, add the import:

```ts
import { maybeSend, sendTest } from './lib/notify.js';
```

In `serveQuestionWait`, widen the body cast and add the call immediately after `register(...)` returns:

```ts
  const body = await readJsonBody(req) as
    { sessionId?: unknown; toolInput?: unknown; timeoutMs?: unknown; permissionMode?: unknown } | null;
```

```ts
  // After the wait is registered, so a failed registration never pushes.
  maybeSend(config, 'question', {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
```

Place it after the `if (res.destroyed) cancelPending(...)` line — the response is held open, so this is the last statement in the handler.

In `servePlanWait`, the identical change with `'plan'`, placed after `if (res.destroyed) cancelPlan(...)`.

In `servePermissionNotify`, widen the cast the same way and add the call between `notifyPermission(...)` and `sendJson(...)`:

```ts
  notifyPermission(sessionId, body.message);
  maybeSend(config, 'permission', {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
  sendJson(res, 200, { ok: true });
```

- [ ] **Step 3: Add the two new handlers**

In `server/api.ts`, after `servePermissionNotify`:

```ts
/**
 * `POST /api/notify/event` — the `stop` hook's path in. Fire-and-forget like
 * `/api/permissions/notify`: the hook does not care what happens next, and a
 * push must never delay the end of a turn.
 *
 * The three other events do not use this route — they are already registering
 * something here, so they notify inline.
 */
export async function serveNotifyEvent(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });

  const body = await readJsonBody(req) as
    { sessionId?: unknown; event?: unknown; permissionMode?: unknown } | null;
  if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad body' });

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId || !ID_RE.test(sessionId)) return sendJson(res, 400, { error: 'bad sessionId' });

  const event = body.event;
  if (event !== 'question' && event !== 'stop' && event !== 'permission' && event !== 'plan') {
    return sendJson(res, 400, { error: 'bad event' });
  }

  maybeSend(config, event, {
    sessionId,
    permissionMode: typeof body.permissionMode === 'string' ? body.permissionMode : undefined
  });
  sendJson(res, 200, { ok: true });
}

/** `POST /api/notify/test` — fire one push regardless of policy and report the outcome. */
export async function serveNotifyTest(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  sendJson(res, 200, { outcome: await sendTest(config) });
}
```

Note: unlike the wait endpoints, this does **not** call `sessionExists`. A `stop` hook fires as the turn ends, which is exactly when the transcript may not yet be on disk for the scan to see; rejecting there would drop the most common push. The id is still shape-checked by `ID_RE` and is never joined into a path.

- [ ] **Step 4: Populate `notifyAvailable` and widen the settings error**

In `serveSettingsRead`, the config is not currently a parameter. Change the signature and both call sites:

```ts
/** `GET /api/settings` — the settings that aren't per-device (see lib/settings.ts). */
export function serveSettingsRead(config: Config, res: ServerResponse): void {
  sendJson(res, 200, { ...getSettings(), notifyAvailable: config.ntfyTopic !== '' });
}
```

In `serveSettingsWrite`, do the same on the success path and widen the 400 message:

```ts
  if (!next) {
    return sendJson(res, 400, { error: 'expected {idleSecs?: number, answerSecs?: number, notify?: NotifyPolicy}' });
  }
  sendJson(res, 200, { ...next, notifyAvailable: config.ntfyTopic !== '' });
```

Also update `serveHealth` — it spreads `getSettings()` piecemeal today and needs no change, but confirm it does not leak `notify`; it reads only `idleSecs` and `answerSecs`, so leave it alone.

- [ ] **Step 5: Add the routes**

In `server/index.ts`, beside the other write endpoints:

```ts
  if (u.pathname === '/api/settings') {
    if (req.method === 'POST') return void serveSettingsWrite(config, req, res);
    return void serveSettingsRead(config, res);
  }
```

and after the `/api/permissions/notify` block:

```ts
  // Fire-and-forget push trigger for the Stop hook — the other three events
  // notify from the endpoint they were already POSTing to.
  if (u.pathname === '/api/notify/event') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveNotifyEvent(config, req, res);
  }
  if (u.pathname === '/api/notify/test') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveNotifyTest(config, req, res);
  }
```

Add both to the import from `./api.js`.

- [ ] **Step 6: Verify by hand against a running server**

```bash
pnpm dev
```

In a second terminal:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"sessionId":"deadbeef-0000-0000-0000-000000000000","event":"stop"}' http://127.0.0.1:4173/api/notify/event
```

Expected: `{"ok":true}` and no push (the policy is all-off by default).

```bash
curl -s http://127.0.0.1:4173/api/settings | jq '{notifyAvailable, notify}'
```

Expected: `notifyAvailable: false` with no `NTFY_TOPIC` set, and the all-off policy. Confirm no topic string appears anywhere in the payload.

- [ ] **Step 7: Test, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add shared/types.ts server/api.ts server/index.ts
git commit -m "feat(notify): expose the push endpoints and wire the hook paths"
```

---

### Task 5: The hooks

Three hooks gain one field; the fourth moves into the repo and loses its hardcoded topic.

**Files:**
- Modify: `scripts/ask-remote-hook.sh:72-82`
- Modify: `scripts/plan-remote-hook.sh` (its equivalent body-building block)
- Modify: `scripts/permission-notify-hook.sh:87`
- Create: `scripts/stop-notify-hook.sh`

**Interfaces:**
- Consumes: `POST /api/notify/event` (Task 4).
- Produces: hook payloads carrying `permissionMode`.

- [ ] **Step 1: Add `permissionMode` to `ask-remote-hook.sh`**

After the `TOOL_INPUT` block, add:

```bash
# Carried for the notifier's auto-mode layer (server/lib/notify.ts). Absent on
# older CLIs, which simply never satisfy that layer.
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')
```

and widen the body:

```bash
BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg pm "$PERM_MODE" \
  --argjson ti "$TOOL_INPUT" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, toolInput: $ti, timeoutMs: $t, permissionMode: $pm}') || exit 0
```

- [ ] **Step 2: Make the same change in `plan-remote-hook.sh`**

Its body block is at lines 79-89 and has the same shape. Replace:

```bash
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // empty')
[ -n "$TOOL_INPUT" ] || exit 0

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --argjson ti "$TOOL_INPUT" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, toolInput: $ti, timeoutMs: $t}') || exit 0
```

with:

```bash
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // empty')
[ -n "$TOOL_INPUT" ] || exit 0

# Carried for the notifier's auto-mode layer (server/lib/notify.ts). Absent on
# older CLIs, which simply never satisfy that layer.
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg pm "$PERM_MODE" \
  --argjson ti "$TOOL_INPUT" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, toolInput: $ti, timeoutMs: $t, permissionMode: $pm}') || exit 0
```

- [ ] **Step 3: Make the same change in `permission-notify-hook.sh`**

Before the `BODY=` line at 87:

```bash
# PermissionRequest payloads carry the mode; the legacy Notification fallback may
# not. Sent when present — an absent mode simply never satisfies requireAutoMode.
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)
```

and:

```bash
BODY=$(jq -cn --arg sid "$SESSION_ID" --arg m "$MSG" --arg pm "$PERM_MODE" \
  '{sessionId: $sid, message: $m, permissionMode: $pm}') || exit 0
```

- [ ] **Step 4: Write the new stop hook**

Create `scripts/stop-notify-hook.sh`:

```bash
#!/bin/bash
# stop-notify-hook.sh — Stop hook: tell the dashboard a turn finished, so it can
# decide whether that is worth a push.
#
# The decision is NOT made here. Whether a push goes out, and to which topic, is
# the dashboard's policy (Settings → Push notifications, server/lib/notify.ts).
# This hook only reports the event and the two things only it can see: the
# session's permission mode, and whether background work is still in flight.
#
# Replaces the old ~/.claude/hooks/stop-notify.sh, which held a hardcoded ntfy
# topic and a CLAUDE_NTFY env gate. Both are gone.
#
# Install:
#   ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
# then in ~/.claude/settings.json under Stop:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"" }
#
# Requires: curl, jq. See docs/subsystems/push-notify.md in the dashboard repo.

INPUT=$(cat)

[ "$CLAUDECODE" = "1" ] || exit 0
command -v jq > /dev/null 2>&1 || exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

# Never re-trigger loop (we never block, but guard anyway).
[ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

# Count in-flight background work. Missing keys -> [] -> 0 (safe fallback: notify).
# Only the hook payload carries this, which is why the guard stays here rather
# than moving into the server's predicate with the rest of the policy.
bg=$(printf '%s' "$INPUT" | jq '((.background_tasks // []) | length) + ((.session_crons // []) | length)' 2>/dev/null || echo 0)
[ "${bg:-0}" -gt 0 ] 2>/dev/null && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')

BODY=$(jq -cn --arg sid "$SESSION_ID" --arg pm "$PERM_MODE" \
  '{sessionId: $sid, event: "stop", permissionMode: $pm}') || exit 0

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# Best-effort, 1s cap. Dashboard down or push disabled → the turn ends exactly as
# it did before this hook existed.
curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/notify/event" > /dev/null 2>&1 || true
exit 0
```

- [ ] **Step 5: Make it executable and verify the payloads**

```bash
chmod +x scripts/stop-notify-hook.sh
```

Verify the stop hook builds a valid body and reaches the endpoint:

```bash
echo '{"session_id":"deadbeef-0000-0000-0000-000000000000","permission_mode":"bypassPermissions"}' | CLAUDECODE=1 bash scripts/stop-notify-hook.sh; echo "exit=$?"
```

Expected: `exit=0`, and the dev server logs no error.

Verify the background-work guard still suppresses:

```bash
echo '{"session_id":"deadbeef-0000-0000-0000-000000000000","background_tasks":[{"id":"x"}]}' | CLAUDECODE=1 bash scripts/stop-notify-hook.sh; echo "exit=$?"
```

Expected: `exit=0` with no request made (confirm against the server's access behaviour or by temporarily adding `-v` to the curl).

Verify the three modified hooks still emit parseable JSON:

```bash
echo '{"session_id":"deadbeef-0000-0000-0000-000000000000","permission_mode":"auto","message":"needs permission","hook_event_name":"PermissionRequest","tool_name":"Bash"}' | CLAUDECODE=1 bash scripts/permission-notify-hook.sh; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 6: Swap the symlink and delete the old hook**

```bash
ln -sf "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
rm -f ~/.claude/hooks/stop-notify.sh.bak
```

Then remove the `CLAUDE_NTFY=1` prefix from the `Stop` command in `~/.claude/settings.json` if present, leaving:

```
bash "$HOME/.claude/hooks/stop-notify.sh"
```

and validate:

```bash
jq -e . ~/.claude/settings.json > /dev/null && echo "settings.json valid"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/
git commit -m "feat(notify): move push delivery out of the hooks"
```

---

### Task 6: The Settings group

**Files:**
- Modify: `client/src/components/settings/SettingsView.tsx` (after the "Alerts · this device" group, which ends at line 325)
- Modify: `client/src/hooks/useServerSettings.ts:34`

**Interfaces:**
- Consumes: `ServerSettings.notify`, `ServerSettings.notifyAvailable` (Task 1), `POST /api/notify/test` (Task 4).
- Produces: no exports — this is the leaf.

- [ ] **Step 1: Widen the hook's response guard**

`useServerSettings` currently accepts a response only when `typeof body?.idleSecs === 'number'`. That still holds, so no change is required for reading — but add a `notify` convenience saver so the view does not hand-build nested patches:

```ts
export interface ServerSettingsControl {
  state: ServerSettings | null;
  saving: boolean;
  needsToken: boolean;
  save: (patch: Partial<ServerSettings>) => Promise<void>;
  /** Patch one or more notify keys. Merged server-side, so send only what changed. */
  saveNotify: (patch: Partial<ServerSettings['notify']>) => Promise<void>;
}
```

```ts
  const saveNotify = useCallback(
    (patch: Partial<ServerSettings['notify']>) => save({ notify: patch } as Partial<ServerSettings>),
    [save]
  );

  return { state, saving, needsToken, save, saveNotify };
```

Also update the hook's doc comment — it currently says "Today that is the idle threshold and the answer window", which this task makes wrong. Add the notify policy to that sentence.

- [ ] **Step 2: Add the group**

In `SettingsView.tsx`, after the closing `</SettingsGroup>` of "Alerts · this device" and before the "Reset" group. Note the title convention: server-backed groups say `· every device` (see "Remote answers · every device"), per-device ones say `· this device`.

```tsx
      <SettingsGroup title="Push notifications · every device">
        <SettingsRow
          name="Send push notifications"
          hint={
            server.state && !server.state.notifyAvailable
              ? 'Set NTFY_TOPIC in .env and restart the server to enable. The topic is a secret — anyone who knows it can read and send your notifications.'
              : 'Pushes to your phone through ntfy, so alerts arrive with the browser closed. Unlike the alerts above, this is set once for every device.'
          }
        >
          <Segmented
            value={server.state?.notify.enabled ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => void server.saveNotify({ enabled: v === 'on' })}
          />
        </SettingsRow>

        {NOTIFY_EVENT_ROWS.map(row => (
          <SettingsRow key={row.key} name={row.name} hint={row.hint}>
            <Segmented
              value={server.state?.notify.events[row.key] ? 'on' : 'off'}
              options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
              onChange={v => void server.saveNotify({ events: { [row.key]: v === 'on' } })}
            />
          </SettingsRow>
        ))}

        <SettingsRow
          name="Only while accepting remote answers"
          hint="Ties pushes to the Remote answers switch above, so one toggle covers both."
        >
          <Segmented
            value={server.state?.notify.requireRemoteAnswer ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => void server.saveNotify({ requireRemoteAnswer: v === 'on' })}
          />
        </SettingsRow>

        <SettingsRow
          name="Only when I'm away"
          hint={`No push until you've been away from the keyboard for ${server.state?.idleSecs ?? 60}s — the same threshold the remote-answer hooks use.`}
        >
          <Segmented
            value={server.state?.notify.requireAfk ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => void server.saveNotify({ requireAfk: v === 'on' })}
          />
        </SettingsRow>

        <SettingsRow
          name="Only in auto permission modes"
          hint="Limits pushes to sessions running as auto, bypassPermissions or dontAsk. Older CLIs don't report the mode, so permission-dialog pushes stop too."
        >
          <Segmented
            value={server.state?.notify.requireAutoMode ? 'on' : 'off'}
            options={[{ value: 'off' as const, label: 'Off' }, { value: 'on' as const, label: 'On' }]}
            onChange={v => void server.saveNotify({ requireAutoMode: v === 'on' })}
          />
        </SettingsRow>

        <SettingsRow
          name="Test push"
          hint={pushTestResult ?? 'Sends one push right now, ignoring every switch above, and says what happened.'}
        >
          <button onClick={() => void sendTestPush()}>Send test push</button>
        </SettingsRow>
      </SettingsGroup>
```

Add the row table above the component:

```tsx
/** The four events, in the order they matter when you are away from the desk. */
const NOTIFY_EVENT_ROWS = [
  { key: 'question' as const, name: 'Question waiting', hint: 'A session is asking something you can answer from the dashboard.' },
  { key: 'permission' as const, name: 'Permission dialog open', hint: 'A terminal permission dialog is blocking a session until you return.' },
  { key: 'plan' as const, name: 'Plan waiting for review', hint: 'A proposed plan is held for a remote send-back.' },
  { key: 'stop' as const, name: 'Task finished', hint: 'A session finished its turn. Suppressed while background agents are still running.' }
];
```

and the test handler beside `sendTestAlert`:

```tsx
  const [pushTestResult, setPushTestResult] = useState<string | null>(null);

  async function sendTestPush(): Promise<void> {
    setPushTestResult('sending…');
    try {
      const res = await fetch('/api/notify/test', { method: 'POST' });
      const body = (await res.json()) as { outcome?: string; error?: string };
      setPushTestResult(body.outcome ?? body.error ?? 'no response');
    } catch {
      setPushTestResult('the dashboard did not answer');
    }
  }
```

- [ ] **Step 3: Verify in the browser**

```bash
pnpm dev
```

Open the Settings section. Confirm:
- The group renders after "Alerts · this device".
- With no `NTFY_TOPIC` set, the master row's hint names `.env`.
- Toggling any row persists across a page reload (it round-trips to the server).
- "Send test push" reports `no NTFY_TOPIC set in .env — nothing to send to`.

Then set a topic and restart:

```bash
echo 'NTFY_TOPIC=your-topic-here' >> .env
```

Confirm the hint changes and the test button reports `sent to https://ntfy.sh`.

- [ ] **Step 4: Test, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add client/src/components/settings/SettingsView.tsx client/src/hooks/useServerSettings.ts
git commit -m "feat(notify): add the push-notification settings group"
```

---

### Task 7: Tapping the notification opens that session's chat

The client half of the deep link. Without this the `Click` header lands on the dashboard's front page and you still hunt for the row.

**Files:**
- Create: `client/src/lib/deepLink.ts`
- Create: `test/deep-link.test.ts`
- Modify: `test/run-all.ts`
- Modify: `client/src/App.tsx:37` (the `section` initializer)
- Modify: `client/src/components/SessionsView.tsx:30` (the `chatId` initializer)

**Interfaces:**
- Consumes: the `?session=<id>` URL produced by `clickUrl` (Task 3).
- Produces: `readSessionParam(search)`, `deepLinkSession()`.

- [ ] **Step 1: Write the failing test**

Create `test/deep-link.test.ts`:

```ts
import assert from 'node:assert';

import { readSessionParam } from '../client/src/lib/deepLink.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== deepLink.ts ===\n');
  let p = 0, f = 0;

  if (test('reads a session id', () => {
    assert.strictEqual(
      readSessionParam('?session=abc12345-0000-0000-0000-000000000000'),
      'abc12345-0000-0000-0000-000000000000'
    );
  })) p++; else f++;

  if (test('reads it alongside other params', () => {
    assert.strictEqual(readSessionParam('?x=1&session=abc12345&y=2'), 'abc12345');
  })) p++; else f++;

  if (test('no param yields null', () => {
    assert.strictEqual(readSessionParam(''), null);
    assert.strictEqual(readSessionParam('?other=1'), null);
    assert.strictEqual(readSessionParam('?session='), null);
  })) p++; else f++;

  if (test('rejects anything not shaped like a session id', () => {
    // The value reaches a find() over the poll's list, never a path — but a
    // shape check keeps junk out of the drawer key and out of any future use.
    assert.strictEqual(readSessionParam('?session=../../etc/passwd'), null);
    assert.strictEqual(readSessionParam('?session=<script>'), null);
    assert.strictEqual(readSessionParam('?session=' + 'a'.repeat(200)), null);
  })) p++; else f++;

  if (test('survives a malformed query string', () => {
    assert.strictEqual(readSessionParam('?%'), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
```

Register it in `test/run-all.ts` beside the others:

```ts
import { run as runDeepLink } from './deep-link.test.js';
```

```ts
failed += runDeepLink();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm test 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '../client/src/lib/deepLink.js'`.

- [ ] **Step 3: Write the module**

Create `client/src/lib/deepLink.ts`:

```ts
/**
 * deepLink.ts — the `?session=<id>` entry point.
 *
 * A push notification's whole value is landing you on the thing that needs a
 * decision, not on the dashboard's front page. `server/lib/notify.ts` puts this
 * URL in ntfy's `Click` header; this module is what the page does with it.
 *
 * The id is consumed once and stripped from the URL: session ids churn, so a
 * bookmarked or refreshed deep link would reopen a drawer for a session that no
 * longer exists — the same reasoning that keeps `chatId` out of persisted state
 * (see `docs/subsystems/view-persistence.md`).
 */

/** A session id is a UUID; anything else is junk and is ignored. Pure — tested. */
export function readSessionParam(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('session');
    if (!id || id.length > 64) return null;
    return /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : null;
  } catch {
    return null; // malformed query string
  }
}

let consumed = false;
let value: string | null = null;

/**
 * The id this page was opened with, or null.
 *
 * Memoised, and the URL is stripped on the first call, so the two callers
 * (`AppShell` picking the section, `SessionsView` opening the drawer) see the
 * same answer no matter which renders first.
 */
export function deepLinkSession(): string | null {
  if (consumed) return value;
  consumed = true;
  value = readSessionParam(window.location.search);
  if (value) {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      /* older engines / file:// — the param staying put is harmless */
    }
  }
  return value;
}
```

- [ ] **Step 4: Force the Sessions section on a deep link**

In `client/src/App.tsx`, add the import:

```ts
import { deepLinkSession } from './lib/deepLink';
```

and change the `section` initializer at line 37:

```tsx
  // A `landing` other than 'last' pins the opening tab. Resolved once, in the
  // initializer, so there's no flash of the previously-open section; after that
  // navigation is normal and the last section is still remembered for next time.
  // A `?session=` deep link (a tapped push notification) beats both: it exists
  // only to put you on that session's chat.
  const [section, setSection] = useState<Section>(() =>
    deepLinkSession() ? 'sessions' : settings.landing === 'last' ? stored : settings.landing
  );
```

- [ ] **Step 5: Open the drawer for that session**

In `client/src/components/SessionsView.tsx`, add the import:

```ts
import { deepLinkSession } from '../lib/deepLink';
```

and change the `chatId` initializer at line 30:

```tsx
  // Not persisted: session ids churn, so a restored selection would be stale
  // (same reasoning as row expansion — see docs/subsystems/view-persistence.md).
  // Seeded from a `?session=` deep link, which is consumed once and stripped.
  const [chatId, setChatId] = useState<string | null>(() => deepLinkSession());
```

No further change is needed: line 37 already resolves `chatSession` from the poll's list, so the drawer opens as soon as the first snapshot arrives, and an id no longer in the scan window simply never opens one.

- [ ] **Step 6: Verify in the browser**

```bash
pnpm dev
```

Take a real session id from the list:

```bash
curl -s http://127.0.0.1:4173/api/sessions | jq -r '.sessions[0].id'
```

Open `http://localhost:5173/?session=<that-id>`. Confirm:
- The Sessions section opens even if you were last on Settings.
- That session's chat drawer is open.
- The address bar shows `http://localhost:5173/` — the parameter is gone.
- Reloading does **not** reopen the drawer.
- `http://localhost:5173/?session=nonexistent-id` opens Sessions with no drawer and no error in the console.

- [ ] **Step 7: Test, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add client/src/lib/deepLink.ts client/src/App.tsx client/src/components/SessionsView.tsx test/deep-link.test.ts test/run-all.ts
git commit -m "feat(notify): open the session's chat from a tapped push"
```

---

### Task 8: Rewrite the `notify-remote-toggle` skill

**Files:**
- Modify: the `notify-remote-toggle` skill markdown (locate with `find ~/.claude -ipath '*notify-remote-toggle*' -name '*.md'`)

**Interfaces:**
- Consumes: `GET`/`POST /api/settings` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Replace the body**

The current skill is ~80 lines of instructions for hand-editing two places in `~/.claude/settings.json` and keeping them in sync — most of its length is warnings about clobbering unrelated array entries. None of that applies now. Replace the whole file body (keep the frontmatter `name`, update `description`) with:

```markdown
Toggle ntfy push notifications on or off.

The policy lives in the dashboard, not in `~/.claude/settings.json` — this skill
only flips the master switch. Which events push, and the AFK / remote-answer /
auto-mode layers, are set in the dashboard's Settings → Push notifications.

Steps:
1. Read the current state:
   `curl -sf -m 2 http://127.0.0.1:4173/api/settings | jq '.notify.enabled, .notifyAvailable'`
2. If the dashboard is unreachable, say so and stop — there is nothing to toggle
   and no fallback path any more.
3. If `notifyAvailable` is `false`, report that `NTFY_TOPIC` is unset in the
   dashboard's `.env` and stop. Turning the switch on would do nothing.
4. POST the inverse:
   `curl -sf -m 2 -X POST -H 'Content-Type: application/json' -d '{"notify":{"enabled":true}}' http://127.0.0.1:4173/api/settings`
   (or `false`).
5. Report "Push notifications ON 🔔" or "Push notifications OFF 🔕".

Never edit `~/.claude/settings.json`. The old version of this skill did, and
keeping two hook entries in sync by hand was its entire failure mode.
```

- [ ] **Step 2: Verify**

Run `/notify-remote-toggle` twice and confirm the reported state flips each time and matches:

```bash
curl -sf http://127.0.0.1:4173/api/settings | jq .notify.enabled
```

- [ ] **Step 3: Commit**

The skill lives outside the repo, so there is nothing to commit here unless it is vendored. If `find` located it under a repo path, commit it:

```bash
git add -A && git commit -m "feat(notify): point the toggle skill at the dashboard"
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/subsystems/push-notify.md`
- Modify: `docs/subsystems/settings.md`, `docs/overview.md`, `.claude/CLAUDE.md`
- Modify: `docs/subsystems/remote-answer.md`, `docs/subsystems/remote-plan.md`, `docs/subsystems/permission-notify.md`

- [ ] **Step 1: Write the subsystem doc**

Create `docs/subsystems/push-notify.md` following the house pattern of the existing subsystem docs (read `docs/subsystems/permission-notify.md` first for the register). Cover, in this order: why it exists (WebKit has no `Notification` API in a tab, so the browser alert path cannot reach an iPhone); the four events and where each enters; the predicate and its clause order; the fail-direction table from spec §1; why the topic is in `.env` and never returned; why push bodies carry no work content, and the one identifier that is the exception; the `Click` deep link and why `DASHBOARD_PUBLIC_URL` cannot be inferred; and the deferred cooldown.

Also document the two new `.env` keys wherever the existing ones are listed (`docs/workflows/configuration.md`), including that `DASHBOARD_PUBLIC_URL` must be the address the phone uses, not `localhost`.

- [ ] **Step 2: Update `docs/subsystems/settings.md`**

Add a `## Push notifications` section describing the new group and the device-vs-machine split — alerts are per-browser localStorage, this policy is server-backed and shared.

- [ ] **Step 3: Update `docs/overview.md`**

Add the `push-notify.md` map entry beside the other subsystem rows.

- [ ] **Step 4: Update `.claude/CLAUDE.md`**

Add to the server file map, in `server/lib/` order:

```
  lib/notify.ts   server-sent ntfy pushes — layered policy (events × remote-answer ×
                  AFK × auto-mode), the one place the backend calls out to the
                  internet (see docs/subsystems/push-notify.md)
```

Amend the zero-dep bullet so it stays true:

```
- Backend is zero-runtime-dep by design (only Node built-ins). Keep new deps out of `server/`.
  It reads from disk and makes exactly one kind of outbound call: the ntfy push in `lib/notify.ts`.
```

- [ ] **Step 5: One line each in the three hook docs**

In `remote-answer.md`, `remote-plan.md` and `permission-notify.md`, note that the hook's POST body now carries an optional `permissionMode`, read only by the notifier's auto-mode layer.

- [ ] **Step 6: Commit**

```bash
git add docs/ .claude/CLAUDE.md
git commit -m "docs: describe the push-notification subsystem"
```

---

## Verification

After Task 9, from a clean tree:

```bash
pnpm test && pnpm typecheck
```

Expected: `ALL PASS` with 25 new `notify` cases (14 predicate + 11 delivery), 5 new `deepLink` cases, and 6 new `settings` cases, plus no typecheck output.

End-to-end, with `NTFY_TOPIC` and `DASHBOARD_PUBLIC_URL` set and the ntfy app subscribed on the phone:

1. Settings → Push notifications → On, **Question waiting** → On, every layer Off.
2. Trigger an `AskUserQuestion` in any session.
3. Expect one push: `Claude Code / <session> — question waiting`.
4. **Tap it.** The dashboard opens on the Sessions section with that session's chat drawer up and its `QuestionPanel` visible — answerable without another tap.
5. Turn **Only when I'm away** On, repeat at the keyboard — expect no push.
6. Wait past `idleSecs`, repeat — expect the push.

`DASHBOARD_PUBLIC_URL` must be the address the *phone* uses (the `.ts.net` hostname), not `localhost`. With it unset the push still arrives; tapping it just does nothing useful, and the Settings test button says so.
