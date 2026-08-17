# Remote Spawn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a new Claude Code session from the dashboard — pick a project, speak or type a prompt, tap launch — and have the row appear in the live session list within one poll.

**Architecture:** `POST /api/spawn` mints a session id, resolves the requested project against the already-enumerated recent-project set, and spawns a **detached** headless `claude -p` with `--session-id` so the id is known before any transcript exists. Everything CLI-specific lives in one new module, `server/lib/spawn.ts`, whose request parsing, permission clamping and argv building are pure functions, so the test suite never spawns a real CLI. A RAM-only store covers only the gap between launch and the scan's first sighting; adopted launches leave no trace. The client learns the feature exists from a flag on the health payload it already fetches, and the "starting…" row rides the existing 3s sessions poll rather than a new one.

**Tech Stack:** Node built-ins only on the server (`node:child_process`, `node:crypto`) run through `tsx`; React + TypeScript on the client; `node:assert` tests run by `test/run-all.ts`. External binary: the Claude Code CLI (`2.1.233` on this machine).

**Spec:** [docs/superpowers/specs/2026-08-17-remote-spawn-design.md](../specs/2026-08-17-remote-spawn-design.md)

## Global Constraints

- **ESM everywhere.** Server imports carry a `.js` suffix that resolves to `.ts` (`import { launch } from './lib/spawn.js'`).
- **Zero npm runtime dependencies in `server/`.** Node built-ins only. Spawning external binaries is established (`lsof`, `ps`, `ioreg`, `ffmpeg`, `whisper-cli`).
- **`shared/types.ts` is edited first.** It is the single source of truth for the FE/BE contract; producer then consumer.
- **Cross-boundary imports use `import type`** — no runtime coupling.
- **Never hardcode a colour or a shadow in `styles.css`** below the theme-token block. Use the existing tokens or all five themes break.
- **Config precedence is `process.env` > `.env` > defaults**, via `loadConfig()`.
- **`CLAUDE_BIN` empty means the feature is off** — the same "unset means off" rule `NTFY_TOPIC` and `WHISPER_MODEL` already use. No separate boolean.
- **Never `shell: true`; argv is always an array; the prompt never enters argv.** The prompt goes on the child's stdin. Both verified against CLI 2.1.233 in the spec.
- **Caps, copied verbatim from the spec:** `PROMPT_CAP = 4000` chars; `NAME_CAP = 60` chars; `STDERR_TAIL_CAP = 2048` bytes; `LAUNCH_TTL_MS = 60_000`; `FAIL_TTL_MS = 5 * 60_000`; probe spawn timeout `5_000` ms.
- **Permission ladder, lowest to highest:** `plan < acceptEdits < auto < bypassPermissions`. Default and default ceiling are both `auto`. `manual` and `dontAsk` are not in the enum.
- **Every test runs offline and spawns no real CLI.** The spawner is injected.
- **Run `pnpm test` and `pnpm typecheck` before every commit.**
- **Plans specify behaviour and test cases, not literal code** (repo convention): write the implementation yourself from the signatures and expected values below, and push back if a stated expectation looks wrong.

---

### Task 1: Config gate and the pure core

The whole security posture is decided here, in functions that touch no filesystem and no
child process. Deliverable: `server/lib/spawn.ts` exporting three pure functions plus the
constants, fully tested, and two new config keys.

**Files:**
- Modify: `shared/types.ts` (first — `PermissionMode` only; the rest of the contract lands in Tasks 2–3)
- Create: `server/lib/spawn.ts`
- Create: `test/spawn.test.ts`
- Modify: `server/lib/config.ts` (the `Config` interface, `DEFAULTS`, the `loadConfig` return)
- Modify: `test/run-all.ts` (register the new test file)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `Config` from `server/lib/config.ts`.
- Produces in `shared/types.ts`: `type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'`. It goes in the contract file rather than in `spawn.ts` because the launch form sends it and the server clamps it — it crosses the boundary, so the house rule puts it here. `spawn.ts` imports it with `import type` and derives nothing from it except the ladder's order.
- Produces, all exported from `server/lib/spawn.ts`:
  - `PERMISSION_MODES: readonly ['plan','acceptEdits','auto','bypassPermissions']`
  - `MODELS: readonly ['opus','sonnet','haiku','fable']`
  - `EFFORTS: readonly ['low','medium','high','xhigh','max']`
  - `PROMPT_CAP = 4000`, `NAME_CAP = 60`
  - `clampPermission(requested: unknown, ceiling: unknown): PermissionMode`
  - `interface SpawnInput { sessionId: string; prompt: string; permissionMode: PermissionMode; name?: string; model?: string; effort?: string }`
  - `type ParseResult = { ok: true; input: Omit<SpawnInput, 'sessionId'> } | { ok: false; error: string }`
  - `parseSpawnRequest(body: unknown, ceiling: PermissionMode): ParseResult`
  - `buildSpawnArgs(input: SpawnInput): string[]`
- Config gains `claudeBin: string` (from `CLAUDE_BIN`, default `''`) and `spawnMaxPermission: string` (from `SPAWN_MAX_PERMISSION`, default `'auto'`), both `.trim()`ed like `whisperBin`.

`parseSpawnRequest` deliberately **ignores** `body.project` — resolving a project needs
config and the filesystem, so it stays in the handler (Task 3). This function's whole job is
turning an untrusted body into a safe `SpawnInput`, or a reason it can't.

- [ ] **Step 1: Write the failing tests**

Create `test/spawn.test.ts` and register it in `test/run-all.ts` alongside the others. Cover
exactly these cases:

*`clampPermission` — the full ladder:*

| requested | ceiling | expected | why |
|---|---|---|---|
| `'bypassPermissions'` | `'auto'` | `'auto'` | the browser cannot escalate past the host |
| `'plan'` | `'auto'` | `'plan'` | asking for less than the ceiling is always allowed |
| `'auto'` | `'plan'` | `'plan'` | a lowered ceiling lowers everything |
| `'auto'` | `'auto'` | `'auto'` | equal is a no-op |
| `'bypassPermissions'` | `'bypassPermissions'` | `'bypassPermissions'` | an opted-in host can reach the top |
| `'nonsense'` | `'auto'` | `'auto'` | unknown request falls to the default, never to the top |
| `'auto'` | `'nonsense'` | `'auto'` | unknown ceiling falls to the default, never to the top |
| `undefined` | `'plan'` | `'plan'` | absent request defaults to `auto`, then clamps |

*`parseSpawnRequest` (ceiling `'auto'` unless stated):*

- `{prompt: '  do it  '}` → ok, `input.prompt === 'do it'`, `input.permissionMode === 'auto'`
- `{prompt: ''}` and `{prompt: '   '}` → `{ok: false}` with an error mentioning the prompt
- `{prompt: 'a'.repeat(4000)}` → ok (the cap is inclusive)
- `{prompt: 'a'.repeat(4001)}` → `{ok: false}`
- `null`, `'a string'`, `42` → `{ok: false}`
- `{prompt: 'x', model: 'gpt-4'}` → **ok**, `input.model === undefined` (unrecognized knobs are dropped, never fatal — an old client must not be able to fail a launch)
- `{prompt: 'x', model: 'opus'}` → ok, `input.model === 'opus'`
- `{prompt: 'x', effort: 'ludicrous'}` → ok, `input.effort === undefined`
- `{prompt: 'x', name: 'nightly build-2'}` → ok, name kept
- `{prompt: 'x', name: 'x"; rm -rf /; echo "'}` → ok, `input.name === undefined` (charset)
- `{prompt: 'x', name: 'a'.repeat(61)}` → ok, name dropped; 60 chars → kept
- `{prompt: 'x', permissionMode: 'bypassPermissions'}` with ceiling `'auto'` → `input.permissionMode === 'auto'`
- `{prompt: 'x', permissionMode: 'manual'}` → `'auto'` (not in the enum, so it clamps to the default)

*`buildSpawnArgs` — argv shape. Use a fixed uuid such as `'11111111-1111-4111-8111-111111111111'`:*

- minimal (`prompt: 'hi'`, `permissionMode: 'auto'`) → **exactly** `['-p', '--session-id', <uuid>, '--permission-mode', 'auto']`, length 5
- the same case, asserted separately: **no element contains the prompt text** — this is the regression guard for the stdin decision
- `+ model: 'opus'` → the above plus `['--model', 'opus']`
- `+ effort: 'high'` → plus `['--effort', 'high']`
- `+ name: 'nightly build'` → plus `['-n', 'nightly build']`, and assert that name is **one** array element, not two
- all four knobs at once → length 13, and the flag order is stable across calls
- `name: ''` / `model: ''` / `effort: ''` → length stays 5 (empty is absent, not an empty flag value)

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm test
```

Expected: failures naming the missing `server/lib/spawn.ts` module or its undefined exports.

- [ ] **Step 3: Implement the three functions and the constants**

Write `server/lib/spawn.ts` to the signatures above. Notes that matter:

- Implement the ladder as an index lookup over `PERMISSION_MODES`; "lower of the two" is
  `Math.min` of the indices. Anything not found in the array is treated as `'auto'`'s index.
- Keep `buildSpawnArgs` a pure array build with a fixed flag order. No conditionals that
  reorder — the test asserts stability so later diffs stay readable.
- Document at the top of the module *why* the prompt is absent from argv (a prompt beginning
  `--` would otherwise be parsed as a CLI flag; verified in the spec) and why `shell: true`
  is never used.

- [ ] **Step 4: Add the two config keys**

`CLAUDE_BIN` (default `''`) and `SPAWN_MAX_PERMISSION` (default `'auto'`) in `Config`,
`DEFAULTS`, and the `loadConfig` return, following `whisperBin`'s shape exactly. Give
`claudeBin` a doc comment stating that empty disables spawn outright, and `spawnMaxPermission`
one stating it is the ceiling the server clamps every request to.

Add both to `.env.example` with a comment each, including the warning that setting
`SPAWN_MAX_PERMISSION=bypassPermissions` lets anything that can reach the endpoint run
unsandboxed on this machine.

- [ ] **Step 5: Run the tests and typecheck**

```bash
pnpm test && pnpm typecheck
```

Expected: all pass, and the printed case count has grown.

- [ ] **Step 6: Commit**

```bash
git add server/lib/spawn.ts test/spawn.test.ts test/run-all.ts server/lib/config.ts .env.example
git commit -m "feat(spawn): permission ladder, request parsing, argv builder"
```

---

### Task 2: The probe, the launch store, and the spawn itself

⚠️ **This task is logic-heavy (subprocess handling, lifecycle, an injected seam) — it gets a
per-task review agent.** Deliverable: `launch()` works against a fake spawner, and the store
tells the truth about the first ~3 seconds.

**Files:**
- Modify: `shared/types.ts` (first — add `LaunchingSession`)
- Modify: `server/lib/spawn.ts`
- Modify: `test/spawn.test.ts`

**Interfaces:**
- Consumes: `buildSpawnArgs`, `SpawnInput` from Task 1; `ProjectRef` from `server/lib/management.ts`.
- Produces in `shared/types.ts`: `interface LaunchingSession { sessionId: string; projectName: string; projectPath: string; prompt: string; startedAtMs: number; state: 'launching' | 'failed'; exitCode?: number; error?: string }`, with a doc comment stating the store's charter in one line so the next reader does not mistake it for a session registry.
- Produces:
  - `probeSpawn(config: Config): boolean` and `resetSpawnProbe(): void`
  - `setSpawner(fn: Spawner | null): void` — the test seam, mirroring `setIdleReader` in `messages.ts`
  - `launch(config: Config, ref: ProjectRef, input: Omit<SpawnInput,'sessionId'>): string` — returns the minted session id
  - `listLaunching(now?: number): LaunchingSession[]`
  - `adoptLaunched(ids: string[]): number` — returns how many entries it removed
  - `stopLaunch(id: string): boolean`
  - `resetLaunches(): void` — tests only

- [ ] **Step 1: Write the failing tests for the probe**

- `claudeBin: ''` → `probeSpawn` returns false **and** never invokes the spawner (assert a call counter stayed at 0 — an unconfigured server must not shell out on every request)
- `claudeBin: '/bin/echo'` → true (`echo --version` exits 0, so it stands in for a working CLI without installing anything)
- `claudeBin: '/nonexistent/claude'` → false
- memoisation: after a true result, a second call with a *different* config still returns the first answer, and the spawner call counter is still 1
- `resetSpawnProbe()` then call again → the counter increments

- [ ] **Step 2: Write the failing tests for the store**

Call `resetLaunches()` in each case's setup.

- `launch(...)` returns a string matching a v4 uuid shape, and `listLaunching()` has one entry with `state: 'launching'`, the project's name and path, and `startedAtMs` set
- a 300-character prompt → the stored `prompt` is truncated to 120 characters
- `adoptLaunched([id])` → returns `1`, and `listLaunching()` is empty (an adopted launch leaves **no** trace — this is the store's whole charter)
- `adoptLaunched(['some-other-id'])` → returns `0`, the entry survives
- child emits `exit` with code `2` and stderr `'boom'` before adoption → the entry is `state: 'failed'` with `exitCode: 2` and an `error` containing `boom`
- the same, but after `adoptLaunched` already removed it → no entry reappears
- 5000 characters of stderr → the stored error is at most `STDERR_TAIL_CAP` (2048) characters, keeping the **tail**
- child emits `exit` with code `0` before adoption → the entry stays `launching` (a fast clean run finishes before the scan sees it; the transcript is what matters, not the exit)
- expiry: an entry `launching` for longer than `LAUNCH_TTL_MS` is not returned by `listLaunching(now)`; a `failed` entry is dropped after `FAIL_TTL_MS`. Pass `now` explicitly rather than faking the clock.
- `stopLaunch('unknown-id')` → `false`
- `stopLaunch(id)` for a live entry → `true`, and the fake child recorded a `SIGTERM` kill

- [ ] **Step 3: Write the failing tests for the spawn call itself**

With an injected spawner that records its arguments and returns a fake child (an object with
a recording `stdin`, an `stderr` emitter, and a `kill` spy):

- the spawner was called with `config.claudeBin` as the command
- the argv it received contains the same uuid `launch` returned
- the options it received are exactly `cwd: ref.path`, `detached: true`, and a `stdio` array whose stdin is `'pipe'` and stdout is `'ignore'`
- **the prompt was written to the child's stdin and the stream was ended** — assert both, since an unended stdin leaves the CLI waiting forever
- `unref` was called on the child

- [ ] **Step 4: Run the tests and watch them fail**

```bash
pnpm test
```

Expected: failures for the undefined `probeSpawn` / `launch` / store exports.

- [ ] **Step 5: Implement**

Write the probe (cached `boolean | null` at module scope, `spawnSync` with a 5s timeout,
mirroring `probeTranscribe`), the store (a module-scope `Map`), and `launch`.

`launch` mints the id with `crypto.randomUUID()`, registers the entry **before** spawning
(so a spawn that throws still has somewhere to record the failure), spawns via the injected
spawner or `node:child_process.spawn` by default, writes the prompt to stdin and ends it,
attaches the `exit` and `error` handlers that call the fail path, and `unref()`s.

Expiry is evaluated lazily inside `listLaunching(now)` — no timer. The three other stores
each own a reaper because something must fire without a reader; here the client polls every
3 seconds, so a lazy sweep is strictly simpler and cannot hold the process open.

- [ ] **Step 6: Run the tests and typecheck**

```bash
pnpm test && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add server/lib/spawn.ts test/spawn.test.ts
git commit -m "feat(spawn): cached CLI probe, launch store, detached spawn"
```

---

### Task 3: The contract, the endpoints, and the wiring

⚠️ **Logic-heavy (this is the security surface) — it gets a per-task review agent.**
Deliverable: a real launch works end to end from `curl`.

**Files:**
- Modify: `shared/types.ts` (first — it is the contract)
- Modify: `server/api.ts` (new handlers; `serveSessions`; `serveHealth`)
- Modify: `server/index.ts` (routes)

**Interfaces:**
- Consumes: everything exported from `server/lib/spawn.ts` (Tasks 1–2); `resolveProject` from `server/lib/management.ts`; `tokenOk`, `readJsonBody`, `sendJson`, `sendBadBody`, `ID_RE` from `server/api.ts`.
- Produces in `shared/types.ts` (`PermissionMode` and `LaunchingSession` already landed in Tasks 1–2):
  - `interface SpawnRequest { project: string; prompt: string; name?: string; model?: string; effort?: string; permissionMode?: PermissionMode }`
  - `SessionsResponse.launching?: LaunchingSession[]` — **optional**, so an older client ignores it
  - `HealthResponse.spawnAvailable?: boolean`

- [ ] **Step 1: Edit `shared/types.ts` first**

Add the three above with doc comments in the file's house style. `SessionsResponse.launching`
should note that it is served alongside `sessions` deliberately — one poll, not a second
endpoint.

- [ ] **Step 2: Add `serveSpawn` to `api.ts`**

`POST /api/spawn`. Perform the checks **in this order**, because each one leaks less than the
next: feature availability, then auth, then input.

1. `probeSpawn(config)` false → `404 {error: 'spawn unavailable'}`
2. `tokenOk` false → `403 {error: 'bad token'}`
3. `readJsonBody`; `resolveProject(config, body.project)` null → `400` naming the unknown project
4. `parseSpawnRequest(body, config.spawnMaxPermission)` not ok → `400 {error: <its reason>}` via `sendBadBody`
5. `launch(...)` throws → log and `500 {error: 'spawn failed'}`
6. otherwise `200 {sessionId}`

The project must reach the filesystem **only** through `resolveProject`'s membership check —
never `path.join` with request input. Add a comment saying so, pointing at
`serveManagementProject`, which does the same thing for the same reason.

- [ ] **Step 3: Add `serveSpawnStop` to `api.ts`**

`POST /api/spawn/:id/stop`: `tokenOk` → 403; `ID_RE.test(id)` false → 400; `stopLaunch(id)`
false → `404 {error: 'no live launch'}`; otherwise `200 {stopped: true}`. Its doc comment
must state the restart hole: the pid lives in RAM, so after a server restart this 404s and
killing is a terminal job.

- [ ] **Step 4: Wire the two read paths**

In `serveSessions`, call `adoptLaunched(data.sessions.map(s => s.id))` and then attach
`data.launching = listLaunching()` — adopt **before** listing, or a row that just appeared
would render twice for one poll. Attach it on the error snapshot too, next to `usage`: a
failed scan is exactly when a "did my launch work?" answer matters most.

In `serveHealth`, add `spawnAvailable: probeSpawn(config)`.

- [ ] **Step 5: Add the routes to `index.ts`**

Follow the existing `if (u.pathname === '…')` chain. `/api/spawn/:id/stop` must be matched by
an **anchored** regex placed **above** the `/api/spawn` equality check and above the
`startsWith('/api/sessions')` block. Non-POST on either → 405. This is the same route-order
trap chat, question, plan and message all document.

- [ ] **Step 6: Verify by hand — the first real launch**

There are no HTTP-level tests in this suite, so this step is the gate. Set `CLAUDE_BIN=claude`
in `.env`, run `pnpm dev`, then:

```bash
curl -s -X POST localhost:4173/api/spawn -H 'Content-Type: application/json' -d '{"project":"__DIRNAME__","prompt":"Reply with the single word OK and stop.","model":"haiku"}'
```

Get `__DIRNAME__` from `curl -s localhost:4173/api/management | head -c 2000` — it is a
`projects[].dirName`. Expected: `200` with a `sessionId`. Then, in order:

- `curl -s localhost:4173/api/sessions | grep -o '"launching":\[[^]]*\]'` within ~2s → one entry, `state: "launching"`
- the same call ~5s later → `launching` is empty and a session with that id is in `sessions`
- `ls ~/.claude/projects/<dirName>/<sessionId>.jsonl` → the transcript exists
- with a deliberately wrong project name → `400`
- with `CLAUDE_BIN=` (empty) and a restart → `404`
- with `SPAWN_MAX_PERMISSION=plan` and a body asking for `bypassPermissions`, check the spawned process's argv (`ps -o args= -p <pid>`, or add a temporary log) → it must read `--permission-mode plan`

Record the results in the commit message. If any of these disagree with the spec, stop and
say so rather than adjusting the test to match.

- [ ] **Step 7: Run the tests and typecheck, then commit**

```bash
pnpm test && pnpm typecheck
```

```bash
git add shared/types.ts server/api.ts server/index.ts
git commit -m "feat(spawn): POST /api/spawn + stop endpoint, launching rows on the poll"
```

---

### Task 4: The launch panel

Deliverable: the feature is usable from a phone. Self-review plus the final whole-branch
review; no per-task review agent (this is UI assembly over an already-tested contract).

**Files:**
- Create: `client/src/components/SpawnPanel.tsx`
- Create: `client/src/hooks/useSpawn.ts`
- Modify: `client/src/components/Toolbar.tsx`
- Modify: `client/src/components/SessionList.tsx`
- Modify: `client/src/components/SessionsView.tsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: `SpawnRequest`, `LaunchingSession`, `HealthResponse.spawnAvailable`, `SessionsResponse.launching` (Task 3); `MicButton`'s existing props `{ onText: (text: string) => void; disabled?: boolean }`; `useManagementIndex(refreshKey)` for the project list.
- Produces: `useSpawn(): { launch: (req: SpawnRequest) => Promise<string | null>; pending: boolean; error: string | null; needsToken: boolean }`.

- [ ] **Step 1: Write `useSpawn`**

POST to `/api/spawn` with the `Authorization: Bearer` header taken from the
`dashboard.answerToken` persisted key — copy the pattern from `useRemoteAnswer`'s `toggle`
verbatim, including the `403 → needsToken` branch. Resolve to the new session id on success,
`null` otherwise; never throw.

- [ ] **Step 2: Write `SpawnPanel`**

A pinned panel in the same visual family as `MessagePanel`. Controls: a project `<select>`
(options from `useManagementIndex`, `value` = `dirName`, label = `name`, defaulting to the
first/most recent), a prompt `<textarea>` with `maxLength={4000}`, and selects for name,
model, effort and permission mode. `MicButton` sits in the action row and **appends** to the
textarea rather than replacing it — reuse `appendTranscript` from `lib/dictation.ts` if it
fits; if it does not, say so rather than duplicating the logic.

Launch is disabled while the prompt is blank or `pending`. On success, close the panel and
open the chat drawer for the returned id. On `needsToken`, show the same token hint the other
panels show.

- [ ] **Step 3: Wire the entry point**

A `+ New` button in `Toolbar`, rendered **only** when `spawnAvailable` is true on the health
poll the toolbar already runs for the origin badge — one poll, three consumers now. Panel
open/closed state lives in `SessionsView` next to `chatId`, and the panel is `lazy()`-loaded
into its own chunk like `ChatDrawer`.

- [ ] **Step 4: Render the phantom rows**

`SessionList` takes a new optional `launching` prop and renders those entries above the real
rows: project name, the truncated prompt, and a `starting…` state; for `state: 'failed'`,
the error text instead. A phantom row disappears on its own when the real row adopts the id —
no client-side reconciliation, that is the server's `adoptLaunched`.

Keep the empty-state logic honest: with no sessions but one launching entry, the list must
show the phantom row, **not** "No recent sessions in the lookback window."

- [ ] **Step 5: Style it**

New classes in `styles.css` using existing theme tokens only. No literal colours or shadows
below the token block.

- [ ] **Step 6: Verify in the browser**

`pnpm dev`, then with the preview tools: launch a haiku session with the prompt
`Reply with the single word OK and stop.`, confirm the phantom row appears, confirm it is
replaced by a real row within two polls, and confirm the chat drawer opens on that session.
Then check the mobile viewport (375×812) — this is a phone feature — and both themes.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck && pnpm build
```

```bash
git add client/src
git commit -m "feat(spawn): launch panel, toolbar entry, launching rows"
```

---

### Task 5: Documentation

Deliverable: the subsystem is documented to the standard of the other twelve, and the docs
map points at it.

**Files:**
- Create: `docs/subsystems/spawn.md`
- Modify: `docs/overview.md` (the route table, the repo-layout block, the map list)
- Modify: `docs/workflows/configuration.md` (the two new keys)
- Modify: `.claude/CLAUDE.md` (the `server/lib/spawn.ts` and `SpawnPanel` lines in the tree)

- [ ] **Step 1: Write `docs/subsystems/spawn.md`**

Carry the `docs-sync` frontmatter block with `sources:` listing `server/lib/spawn.ts`,
`server/api.ts`, `server/index.ts`, `client/src/components/SpawnPanel.tsx`,
`client/src/hooks/useSpawn.ts`, and `kind: subsystem`. Cover, at minimum: why this is the
first write path the dashboard *initiates*; why headless rather than a terminal; the two
mechanics verified against the CLI binary (`--session-id`, stdin prompt); the permission
ladder and where the ceiling lives; the store's narrow charter and why it has no reaper when
the other three do; the stop endpoint's restart hole; and the security posture in the same
plain terms `remote-message.md` uses.

- [ ] **Step 2: Update `docs/overview.md`**

Add the two routes to the HTTP surface table, `server/lib/spawn.ts` to the repo-layout block,
and a one-line entry to the map. Update the "Principles → Read-only charter" paragraph: it
currently lists the deliberate exceptions, and spawning a process is a new one that belongs
there explicitly rather than being discovered later.

- [ ] **Step 3: Update `docs/workflows/configuration.md` and `.claude/CLAUDE.md`**

Both new keys with their defaults and the security note for `SPAWN_MAX_PERMISSION`; the new
module and component lines in the CLAUDE.md tree.

- [ ] **Step 4: Commit**

```bash
git add docs .claude/CLAUDE.md
git commit -m "docs(spawn): subsystem doc, route table, config keys"
```

---

## Self-review notes for the executor

- **Spec coverage:** every section of the design maps to a task — A → Task 1, B → Tasks 1–3,
  C → Task 4, D → Tasks 1–5. The spec's Risk 2 (soft-deny with no TTY, unproven) is worth one
  deliberate probe during Task 3's manual verification now that a real denial can be
  provoked; if it stalls rather than continuing, record that in `docs/subsystems/spawn.md`
  and stop — do not paper over it.
- **Out of scope, do not add:** resume (`--resume`), worktree isolation (`--worktree`),
  `--max-budget-usd`, streamed output, spawning from a session row. Each was considered and
  deferred; see the spec's Non-goals.
- **The pre-existing `Stop` hook gap** (Risk 4) is not this branch's work, but the reply
  window is how you keep talking to a spawned session — so fix the missing `timeout: 630` in
  `~/.claude/settings.json` before judging the feature end to end.
