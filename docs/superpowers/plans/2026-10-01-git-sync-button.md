# Git Sync button (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact expected values and test *cases* — never literal code. The
> template's "code blocks required" rule does not apply here (user's global CLAUDE.md, Learnings). Write the code yourself from the behaviour; if a case
> below looks wrong against the real code, say so instead of transcribing it. Line counts mentioned anywhere are soft targets.

**Goal:** one **Sync** button per pinned repo on Management › Git that launches `/claude-agents-dashboard:git-sync` in that repo with per-device Settings
defaults, shows the run while it lasts, opens its chat in a drawer inside Management, and re-polls the repo when the run ends.

**Architecture:** client only — no server change. A pure module `client/src/lib/gitSync.ts` owns every rule (who gets a button, the spawn request, the
run's phase, the stored-runs parser, the button and note strings) and is tested with node-assert. A hook `useGitSync` wires it to `useSpawn`, a gated
`useSessions` poll and `useRemoteAnswer`'s health snapshot. `GitView` owns the hook and the drawer; the three layouts get one shared `GitSyncButton`.

**Tech Stack:** React + TypeScript (Vite), node-assert tests run by `test/run-all.ts` through `tsx`.

**Spec:** [docs/superpowers/specs/2026-10-01-git-stats-design.md](../specs/2026-10-01-git-stats-design.md) §9 (amended 2026-10-01). Read §6 too: the Cards /
Table / Triage shapes this plan adds a button to are defined there. Subsystem docs to read first: `docs/subsystems/git-stats.md` (§Client),
`docs/subsystems/spawn.md` (§The permission ladder, §Project selection is a membership check), `docs/subsystems/settings.md`.

## Global Constraints

- **No server change.** Nothing under `server/` or `shared/types.ts` moves. `test/outbound.test.ts` does not change. If a task seems to need one, stop and
  ask — the spec says Phase 2 needs none.
- **No plugin import.** Client code never imports anything under `plugin/` (`.claude/CLAUDE.md`). The prompt is the literal string
  `/claude-agents-dashboard:git-sync`.
- **Spawn goes through `useSpawn`** and `POST /api/spawn` with `project` = the pin's `dirName`. Never send a path.
- **No hardcoded color or shadow** in `client/src/styles.css` below the theme-token block; new rules use existing tokens only. Keep existing class names
  stable; new classes are prefixed `git-sync`.
- **Settings stay flat** (`client/src/lib/settings.ts` header ⚠️): four new top-level fields, no nested object.
- **Copy is exact.** Every user-visible string below is a constant or pure function in `gitSync.ts` and is asserted by a test. Strings:
  - button idle: `Sync`; POST in flight: `Starting…`; launching or unseen: `Syncing…`; running: `Syncing · open`.
  - note on 403: `Sync needs the Answer token — set it under Settings › Local › Connection.`
  - note on other launch failure: `Sync in <repo name> couldn't start: <server error>`.
  - note on a failed launch the store reported: `git-sync in <repo name> failed to start: <error>` (or `… failed to start.` when the store gave no error).
  - session name sent with the launch: `git-sync <repo name>`, passed through `syncSessionName` (Task 2) so it always satisfies the server's `NAME_RE`
    and `NAME_CAP` — the server drops a non-matching name silently (`server/lib/spawn.ts:91,178-180`), so `·` or any repo name outside
    `[A-Za-z0-9 ._-]` would launch unnamed.
- New text wraps at 160 columns; commit bodies at 72. Conventional Commits subjects (`feat(management):`, `feat(settings):`, `docs:`).

## Review Focus

Most likely to bite a real user, none of them exercised by the spec's own examples. Each line's test lives in the task named.

1. **A running sync drops out of the sessions payload.** The scan ranks by transcript mtime and caps the rows; a sync parked on git-sync's question writes
   nothing while other sessions do. It must read `Syncing…` (unseen), not be declared ended, forgotten and re-polled. An unseen run's drawer cannot open
   from Management (no row to give it); its question is answered from Sessions or the phone. → Task 2 cases P5, P6.
2. **Two pins on one repo** (a pin on the root and one on a subdirectory share a toplevel). Launching from either shows the run on both, and neither can
   start a second one. → Task 2 case K1, Task 4 manual check.
3. **Permission ceiling below the setting.** Setting `bypassPermissions` on a host whose ceiling is `plan` must send `plan` — the server would clamp anyway,
   but the client must not claim a mode it won't get. → Task 2 cases R4, R5.
4. **Junk in `localStorage`** (older build, hand edit, half-written JSON). A malformed stored-runs blob must yield an empty map or drop only the bad entries,
   never throw during render. → Task 2 cases S1–S5.
5. **A repo stops being `ok` mid-run** (folder moved, git error). Its button disappears, but the run is still tracked and still ends cleanly when its
   session ends; no crash on a toplevel no repo reports any more. → Task 2 case P8, Task 3 case H3.

---

## Decisions this plan rests on (from the 2026-10-01 planning session)

| #   | Decision |
| --- | -------- |
| Q1  | Click launches **immediately**, no `SpawnPanel` and no confirm. Defaults come from Settings › Local › **Git Sync**: model, effort, permission mode, remote control — its own four fields, not the New sessions pair. |
| Q2  | Run tracking is **per device** in `localStorage['management.syncRuns']`, keyed by **toplevel**. Not in `OWNED_KEYS`: it is live state, not a preference, so Reset leaves it (an ended run prunes itself). |
| Q3  | "Syncing · open" opens `ChatDrawer` **inside Management**; Management polls `/api/sessions` only while a run is tracked or that drawer is open. |
| Q4  | The session runs in the **pin's path** (`dirName`), not the toplevel — the spawn route takes no path. |
| Q5  | Running = session status `working` or `question`; ended = `idle` or `incomplete` (a finished `claude -p` turn reads `incomplete` while recent, then `idle`). A Stop-hook reply window reads `question`, so the run stays "open" until it closes — accepted. |
| Q6  | The gated sessions poll asks for `limit=50` (the server's `SCAN_CAPS.limit`), keeping the user's lookback and active window, so an unseen run is rare. A run unseen for **24h** after launch is treated as ended. |

---

### Task 1: Git Sync settings

**Files:**
- Modify: `client/src/lib/settings.ts` (interface `Settings`, `DEFAULT_SETTINGS`, `clampSettings`)
- Modify: `client/src/components/settings/SettingsView.tsx` (new group after "New sessions", Local tab)
- Test: `test/client-settings.test.ts`

**Interfaces:**
- Produces on `Settings`: `syncModel: SpawnDefaultModel` (default `''`), `syncEffort: SpawnDefaultEffort` (default `''`),
  `syncPermissionMode: PermissionMode` (default `'auto'`), `syncRemoteControl: boolean` (default `true`). `''` means "send no flag", as for the New
  sessions pair. Defaults mirror what the launch sheet preselects today (`auto` when allowed, remote control on).

**Behaviour:**
- `clampSettings` validates each field independently with the existing `pickOne` / `pickBool`: model against `['', ...MODELS]`, effort against
  `['', ...EFFORTS]`, permission mode against `PERMISSION_MODES`.
- Settings › Local gets a `SettingsGroup` titled `Git Sync`, sub `Used by the Sync button on Management › Git; no launch sheet`, with four rows:
  Model and Effort (`Select`, first option `CLI default`, same lists as New sessions), Permission mode (`Select` over
  `allowedPermissionModes(remote.state?.spawnMaxPermission)` — `SettingsView` already holds `remote = useRemoteAnswer()`; labels from
  `PERMISSION_MODE_LABEL`), Remote control (the existing on/off control style used elsewhere in the file). If the stored mode is above the ceiling, the
  select shows the ceiling and the row hint says the host limits launches to it (copy the launch sheet's `permissionTitle` sentence, a local literal in `SpawnPanel.tsx`, not an export).

- [ ] **Step 1: Write the failing tests** in `test/client-settings.test.ts`, cases:
  - C1 `clampSettings({})` has `syncModel ''`, `syncEffort ''`, `syncPermissionMode 'auto'`, `syncRemoteControl true`.
  - C2 a valid blob (`syncModel` = first entry of `MODELS`, `syncEffort` = first of `EFFORTS`, `syncPermissionMode 'plan'`, `syncRemoteControl false`) round-trips unchanged.
  - C3 junk per field — `syncModel 'gpt-4'`, `syncEffort 7`, `syncPermissionMode 'root'`, `syncRemoteControl 'yes'` — each falls back to its default
    while a valid `theme` in the same blob survives.
  - C4 the New sessions pair is independent: a blob setting only `spawnDefaultModel` leaves `syncModel ''`.
- [ ] **Step 2:** `pnpm test` — the four cases fail (fields missing).
- [ ] **Step 3:** add the fields, defaults and clamps; add the Settings group.
- [ ] **Step 4:** `pnpm test` and `pnpm typecheck` green.
- [ ] **Step 5:** commit `feat(settings): Git Sync launch defaults`.

### Task 2: Pure sync rules — `client/src/lib/gitSync.ts`

**Files:**
- Create: `client/src/lib/gitSync.ts`
- Create: `test/git-sync-client.test.ts`, registered in `test/run-all.ts` beside `git-stats-client`
- Modify: `client/src/lib/spawnOptions.ts` (a `NAME_RE` mirror beside `NAME_CAP`)

**Interfaces:**
- Consumes: `RepoGitStats`, `Session`, `LaunchingSession`, `SessionsResponse`, `SpawnRequest`, `PermissionMode` (`shared/types.ts`, `import type`);
  `allowedPermissionModes` (`client/src/lib/spawnOptions.ts`); the `Settings` type and the four Task 1 fields (`client/src/lib/settings.ts`).
- Produces (later tasks rely on these exact names):
  - `GIT_SYNC_PROMPT = '/claude-agents-dashboard:git-sync'`, `SYNC_RUNS_KEY = 'management.syncRuns'`, `SYNC_SCAN_LIMIT = 50`,
    `SYNC_UNSEEN_TTL_MS = 24 * 60 * 60 * 1000`.
  - `type SyncRun = { sessionId: string; dirName: string; name: string /* repo.name, not the session name */; launchedAtMs: number }`; `type SyncRuns = Record<string /* toplevel */, SyncRun>`.
  - `canSync(repo: RepoGitStats): boolean`.
  - `syncRequest(repo: OkRepo, s: Pick<Settings, 'syncModel'|'syncEffort'|'syncPermissionMode'|'syncRemoteControl'>, ceiling: PermissionMode | undefined): SpawnRequest`.
  - `type SyncPhase = { kind: 'launching' } | { kind: 'running'; session: Session } | { kind: 'unseen' } | { kind: 'ended' } | { kind: 'failed'; error: string | null }`.
  - `syncPhase(run: SyncRun, data: SessionsResponse | null, nowMs: number): SyncPhase`.
  - `parseSyncRuns(raw: unknown): SyncRuns`.
  - `syncSessionName(repoName: string): string` — `git-sync ` + the repo name with every character outside `[A-Za-z0-9 ._-]` replaced by `-`, cut to
    `NAME_CAP` (60). Uses a client `NAME_RE` mirror added to `client/src/lib/spawnOptions.ts` beside `NAME_CAP`, with the same "Mirrors
    server/lib/spawn.ts" comment.
  - `runFor(runs: SyncRuns, repo: RepoGitStats): SyncRun | null` — `runs[repo.toplevel]` for an ok repo, `null` for every other state.
  - `syncButtonText(phase: SyncPhase | null, pending: boolean): string`; `syncFailedText(name: string, error: string | null): string`;
    `syncLaunchErrorText(name: string, error: string): string`; `SYNC_NEEDS_TOKEN` (the 403 note).
  - `OkRepo` is already exported from `GitParts.tsx`; since a lib must not import a component, define `OkRepo` here (same `Extract`) and have
    `GitParts.tsx` re-export it from `gitSync.ts`, or move it to `gitStatsText.ts` — implementer's choice, one definition only.

**Behaviour:**
- `canSync`: true only for `state: 'ok'` with `hasOrigin: true`.
- `syncRequest`: `project` = `repo.dirName`, `prompt` = `GIT_SYNC_PROMPT`, `name` = `syncSessionName(repo.name)`, `remoteControl` = the setting; `model` /
  `effort` present only when non-empty; `permissionMode` = the setting if it is in `allowedPermissionModes(ceiling)`, else that list's last entry.
- `syncPhase`, first match wins:
  1. `data` null → `unseen` (no poll answered yet; never `ended`).
  2. a `data.launching` entry with this `sessionId`: `state 'launching'` → `launching`; `state 'failed'` → `failed` with its `error ?? null`.
  3. a `data.sessions` row with this id: status `working` / `question` → `running` with the row; `idle` / `incomplete` → `ended`.
  4. otherwise `nowMs - launchedAtMs < SYNC_UNSEEN_TTL_MS` → `unseen`, else `ended`.
- `parseSyncRuns`: accepts only a plain object; keeps an entry only when its key is a non-empty string and the value has string `sessionId`, `dirName`,
  `name` and a finite number `launchedAtMs`. Anything else → `{}` or the entry dropped. Never throws.
- `syncButtonText`: `pending` → `Starting…`; phase null → `Sync`; `running` → `Syncing · open`; `launching` / `unseen` → `Syncing…`; `ended` / `failed` →
  `Sync` (the hook prunes these, but the text must not lie for the one render in between).

- [ ] **Step 1: Write the failing tests**, exact cases. Fixture: an `okRepo(name, over)` builder like `test/git-stats-client.test.ts`'s, a `session(id,
  status)` builder, and `run = { sessionId: 's1', dirName: 'd1', name: 'repo', launchedAtMs: 1_000_000 }`.
  - G1 `canSync`: ok + `hasOrigin` → true; ok without origin → false; `missing`, `not-git`, `error` → false.
  - R1 `syncRequest` with all four settings at defaults and ceiling `'auto'` → exactly `{ project: 'd1', prompt: GIT_SYNC_PROMPT, name: 'git-sync repo',
    permissionMode: 'auto', remoteControl: true }` — no `model`, no `effort` keys (`deepStrictEqual`, so absent ≠ `undefined`).
  - N1 `syncSessionName('claude-agents-dashboard')` = `git-sync claude-agents-dashboard`; `syncSessionName('café+ü')` = `git-sync caf---`.
  - N2 a 70-character repo name → result length exactly 60 and starts with `git-sync `.
  - N3 every N1/N2 result matches the client `NAME_RE`; and the client `NAME_RE.source` equals the regex literal in `server/lib/spawn.ts`'s
    `const NAME_RE = …` line, read as source text (the `test/tailnet.test.ts` pattern) — a parity check, not an import of server code.
  - R2 `syncModel` = first `MODELS` entry, `syncEffort` = first `EFFORTS` entry → both keys present with those values.
  - R3 `syncRemoteControl false` → `remoteControl: false`.
  - R4 setting `bypassPermissions`, ceiling `plan` → `permissionMode: 'plan'`.
  - R5 setting `bypassPermissions`, ceiling `undefined` → `'auto'` (the `allowedPermissionModes` fallback).
  - R6 setting `acceptEdits`, ceiling `bypassPermissions` → `'acceptEdits'` (a lower pick is never raised).
  - P1 `data` null → `unseen`.
  - P2 launching entry `{ sessionId: 's1', state: 'launching' }` → `launching`.
  - P3 launching entry `failed` with `error: 'boom'` → `{ kind: 'failed', error: 'boom' }`; without `error` → `error: null`.
  - P4 session row `s1` status `working` → `running` carrying that row; status `question` → `running`.
  - P5 no row, no launching entry, `nowMs = launchedAtMs + 1h` → `unseen`.
  - P6 same at `launchedAtMs + 24h - 1` → `unseen`; at `launchedAtMs + 24h` → `ended`.
  - P7 row status `idle` → `ended`; status `incomplete` → `ended`.
  - P8 a row with a *different* id plus nothing for `s1` → decided by the TTL alone (repo state is not an input: P5's result).
  - P9 both a `launching` entry and a session row for `s1` (a resume-like overlap) → the launching rule wins (rule order).
  - K1 two `okRepo`s with different `dirName`s and the same `toplevel`: `runFor` returns the same run for both; a `missing` repo with the same
    `dirName` returns `null`.
  - S1 `parseSyncRuns(null)`, `'x'`, `[]`, `42` → `{}`.
  - S2 a valid two-entry object → returned equal.
  - S3 one valid entry plus one with `launchedAtMs: 'soon'` → only the valid one.
  - S4 an entry missing `name` → dropped.
  - S5 an entry under key `''` → dropped.
  - T1 `syncButtonText`: `(null, false)` `Sync`; `(null, true)` `Starting…`; `running` `Syncing · open`; `launching` and `unseen` `Syncing…`; `ended` and
    `failed` `Sync`.
  - T2 `syncFailedText('repo', 'boom')` = `git-sync in repo failed to start: boom`; `syncFailedText('repo', null)` = `git-sync in repo failed to start.`
  - T3 `syncLaunchErrorText('repo', 'unknown project')` = `Sync in repo couldn't start: unknown project`.
  - T4 `SYNC_NEEDS_TOKEN` equals the Global Constraints string byte for byte.
  - T5 `SYNC_RUNS_KEY === 'management.syncRuns'`.
- [ ] **Step 2:** `pnpm test` — the new file fails to import.
- [ ] **Step 3:** implement `gitSync.ts`.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` green.
- [ ] **Step 5:** commit `feat(management): pure rules for the Git Sync button`.

### Task 3: `useGitSync` hook and the gated sessions poll

**Files:**
- Modify: `client/src/hooks/useSessions.ts` (optional options), `client/src/lib/settings.ts` (`scanQuery` gains an optional limit override)
- Create: `client/src/hooks/useGitSync.ts`, and the pure reducer `client/src/lib/gitSyncRuns.ts` (the part tested without React)
- Test: `test/git-sync-client.test.ts` (extend), `test/client-settings.test.ts` (`scanQuery`; the Reset sweep's `exempt` set gains `management.syncRuns`)

**Interfaces:**
- Consumes: Task 2's exports; `useSpawn()` (`launch`, `pending`, `error`, `needsToken`); `useRemoteAnswer().state` (`spawnAvailable`,
  `spawnMaxPermission`); `usePersistedState`; `useSettings`.
- Produces:
  - `useSessions(opts?: { enabled?: boolean; limit?: number })` — omitted options keep today's behaviour exactly (SessionsView passes nothing).
    `enabled: false` → no fetch and no timer, `data` null. `limit` replaces only the `limit=` param.
  - `scanQuery(s: Settings, limit?: number): string`.
  - `useGitSync(onEnded: () => void): GitSyncControl` with
    `{ available: boolean; phaseFor(repo: RepoGitStats): SyncPhase | null; start(repo: OkRepo): void; pending: boolean; note: string | null; chat: Session | null; openChat(id: string): void; closeChat(): void }`.
    `available` = `spawnAvailable === true`. `note` is the single line GitView shows under the band (403 text, launch error text, or failed-launch text;
    null otherwise, cleared by the next `start`). `chat` is the drawer's session: the live row for the opened id while the payload has it, else the last
    row seen for it (so a run that ends under an open drawer does not yank it), null once `closeChat` runs.
  - `reconcileRuns(runs: SyncRuns, data: SessionsResponse | null, nowMs: number): { runs: SyncRuns; ended: string[]; failed: { name: string; error: string | null }[] }`
    (the pure reducer): drops every run whose phase is `ended` or `failed`, reporting toplevels in `ended` and failures in `failed`. Returns the **same
    object** when nothing was dropped, so the hook can skip a write.

**Behaviour:**
- Runs live in `usePersistedState('management.syncRuns', {})` — the **literal** key, not `SYNC_RUNS_KEY`, so the Reset sweep in
  `test/client-settings.test.ts:18-27,326-335` sees it — read through `parseSyncRuns`. That sweep fails on any persisted key outside `OWNED_KEYS`
  unless exempted: add `management.syncRuns` to its `exempt` set with Q2's reason (live state, not a preference). A test asserts
  `SYNC_RUNS_KEY === 'management.syncRuns'` so the two spellings cannot drift.
- The sessions poll is `useSessions({ enabled: <at least one run> || <a chat is open>, limit: SYNC_SCAN_LIMIT })` — the open drawer keeps it alive after
  its run is pruned, so the drawer's row stays live until closed.
- On every new sessions payload, `reconcileRuns`; if anything was dropped, write the new map, set `note` from the first `failed` entry, and call
  `onEnded()` **once** for the whole batch (GitView passes `useGitStats().refresh`).
- `start(repo)`: refuses when `pending`, when `!available`, when `!canSync(repo)` or when `runFor(runs, repo)` exists. Otherwise
  `launch(syncRequest(...))`; on an id, store `{ sessionId, dirName: repo.dirName, name: repo.name, launchedAtMs: Date.now() }` under `repo.toplevel`.
- The launch-failure note **cannot** be read inside `start` after `await launch()`: `useSpawn` reports `needsToken` / `error` through React state
  (`client/src/hooks/useSpawn.ts:49-63`), so the closure still holds the previous render's values. Nor can an effect keyed on `needsToken` / `error`
  work: `needsToken` is not reset before a launch (`useSpawn.ts:40-52`), so a second 403 in a row changes no dependency and shows no note. Derive it
  on the **`pending` true → false transition** instead: an effect on `[pending]` plus a "start outstanding" ref set by `start`; when `pending` drops
  with the ref set, read that render's `needsToken` / `error` (batched with `setPending(false)`, `useSpawn.ts:50,59,62` before `:65`), clear the ref,
  and set `needsToken` → `SYNC_NEEDS_TOKEN` (beats `error`), else `error` → `syncLaunchErrorText(<name of the repo last started>, error)`, else
  nothing. `start` clears the note and remembers which repo it started.

- [ ] **Step 1: Write the failing tests:**
  - Q1 `scanQuery(DEFAULT_SETTINGS)` unchanged from today (`?limit=5&lookback=48&active=5`); `scanQuery(DEFAULT_SETTINGS, 50)` = `?limit=50&lookback=48&active=5`.
  - H1 `reconcileRuns` with one running run → same object, `ended: []`.
  - H2 one running + one whose row is `idle` → new map without the idle one, `ended` = its toplevel.
  - H3 a run whose toplevel no repo reports any more, session `incomplete` → dropped, `ended` = that toplevel (repos are not an input).
  - H4 a `failed` launching entry → dropped, `failed: [{ name, error }]`, not in `ended`.
  - H5 `data` null → same object (nothing ends before a poll answers).
  - H6 an unseen run past the 24h TTL → dropped into `ended`.
- [ ] **Step 2:** `pnpm test` fails.
- [ ] **Step 3:** implement `scanQuery`'s override, `useSessions` options, `reconcileRuns`, `useGitSync`.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` green; `git grep -n "useSessions(" client/src` shows SessionsView unchanged.
- [ ] **Step 5:** commit `feat(management): track Git Sync runs per device`.

### Task 4: The button in three layouts, the drawer, the note

**Files:**
- Modify: `client/src/components/management/GitParts.tsx` (new `GitSyncButton`), `GitCards.tsx`, `GitTable.tsx`, `GitTriage.tsx`, `GitView.tsx`
- Modify: `client/src/styles.css` (`.git-sync*` rules, tokens only)

**Interfaces:**
- Consumes: `GitSyncControl` from Task 3; `ChatDrawer` (default export, props `session`, `onClose`, `spawnAvailable`), lazy like `SessionsView` does.
- Produces: `GitSyncButton({ repo, sync })` — renders nothing when `!sync.available || !canSync(repo)`; otherwise a `<button type="button">` with
  `syncButtonText(phase, sync.pending)`, disabled unless the phase is null (idle) or `running`; click → `sync.start(repo)` when idle,
  `sync.openChat(phase.session.id)` when running. `aria-label` = `Sync <repo name>` / `Open the git-sync chat for <repo name>`.

**Behaviour:**
- `GitView` owns `useGitSync(refresh)` and passes `sync` down to whichever layout draws. `ChatDrawer` renders while `sync.chat` is non-null, keyed by
  its id like SessionsView's, with `onClose={sync.closeChat}` and `spawnAvailable` from the same health snapshot.
- The `note`, when non-null, is one line directly under the band (`.git-sync-note`, muted danger token like `.git-band-off`).
- **Cards:** the button is the last child of `.git-head`, pushed right (a spacer or `margin-left:auto`), on ok repos only.
- **Table:** a seventh column with an empty `<th>` (`aria-label="Sync"`); `COLS` becomes 7. Off rows add **no** cell: their sentence already spans `COLS - 1` (`GitTable.tsx:38`) and absorbs the new column; the sub-row
  `colSpan={COLS}` cells (`:75-101`) widen with it. The button's click calls
  `stopPropagation` so it does not toggle the row's sub-rows.
- **Triage:** busy rows — last child of `.git-head`. Quiet rows — the head is itself a `<button>`, and a button cannot nest in a button: wrap the row
  button and `GitSyncButton` as siblings in a flex container (the row button keeps `flex:1`), keep `git-rowbtn` on the row button, keep its caret. Can't-read
  rows get no button (they fail `canSync` anyway).
- Phone (375px): the button wraps with the head like the other chips; nothing scrolls sideways.

- [ ] **Step 1:** implement `GitSyncButton` and wire Cards, Table, Triage, GitView, CSS.
- [ ] **Step 2:** `pnpm test`, `pnpm typecheck`, `pnpm build` green.
- [ ] **Step 3: Live check in the browser pane** (`pnpm dev` via `preview_start`, port 5174) — read-only only, **do not click Sync on a real repo**:
  - every ok + origin repo shows `Sync` in Cards, Table and Triage; a no-origin repo (ixray) and any `missing` / `error` pin show none.
  - Table: clicking a row still expands; the Sync cell is the seventh column.
  - Triage quiet row: `read_page` shows the row button and the Sync button as siblings, not nested.
  - Phone (`resize_window` mobile): `document.documentElement.scrollWidth <= innerWidth`; reset to desktop after.
  - Seed a fake run to check the states without spawning: `localStorage['management.syncRuns']` with an unknown session id and `launchedAtMs: Date.now()`
    under this repo's toplevel → its button reads `Syncing…` disabled, and a second pin on the same toplevel (if pinned) does too; with
    `launchedAtMs` 25h ago → the run is dropped on the next sessions poll and the button reads `Sync`. Remove the key after.
- [ ] **Step 4:** commit `feat(management): Sync button on Git Stats`.

### Task 5: Docs

**Files:**
- Modify: `docs/subsystems/git-stats.md` (§Client: a **Sync** paragraph — when the button shows, the launch, the runs key and its phases, the gated
  poll and its limit, the drawer, re-poll on end; cite `gitSync.ts`, `useGitSync.ts`)
- Modify: `docs/subsystems/settings.md` (the four `sync*` keys and the new Git Sync group in §Where each setting lives)
- Modify: `docs/subsystems/spawn.md` (§The pieces or §The launch form is a modal: a second launcher, the Sync button, which posts without the sheet)
- Modify: `docs/overview.md` §Map / file map lines for `client/src/lib/gitSync.ts`, `gitSyncRuns.ts`, `client/src/hooks/useGitSync.ts`

- [ ] **Step 1:** write the edits; cross-check every name against the code as merged (no names from this plan that the code didn't keep).
- [ ] **Step 2:** commit `docs: Git Sync button`.

## Verification (PR)

- `pnpm test`, `pnpm typecheck`, `pnpm build` output quoted in the PR.
- Task 4 Step 3's live checks, with a screenshot of Cards and of Triage.
- **Not verified, needs a human:** one real Sync click on a repo with something to sync — that the session launches in the pin's path with the Git Sync
  defaults, that "Syncing · open" opens a drawer where git-sync's decision round can be answered, and that the repo re-polls when the run ends. An agent
  must not press it: git-sync pushes and prunes after its decision round. Also unverified: how the button reads against the mockup.
