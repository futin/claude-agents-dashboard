# Launch in the desktop app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases — never literal code bodies** (global CLAUDE.md, overriding writing-plans' "code
> blocks required"). Write the bodies yourself; if a plan line looks wrong against the code, say so in your report rather than transcribing it. Size
> budgets here are soft.

**Goal:** Let a launch from the dashboard (or a hand-over of a dashboard-spawned session) open in the Claude desktop app on this Mac, through
`claude://code/new` and `claude://resume`, fired by the server.

**Architecture:** `POST /api/spawn` gains `surface: 'dashboard' | 'desktop'`. A new server module `server/lib/desktop.ts` owns every `claude://` URL, the
availability probe, the `open` runner, the desktop rail and the per-id hand-over mark. `server/lib/archived.ts` gains a sibling reader of the desktop
registry's live records, which marks rows `desktopOwned`. The client offers a Dashboard | Desktop pick in the launch form, an "Open in desktop app" action
in the chat drawer, and a Shared setting for the default.

**Tech Stack:** Node + TypeScript via `tsx` (server, zero new deps), React + Vite (client), node-assert tests under `test/`.

**Spec:** `docs/superpowers/specs/2026-10-29-desktop-launch-design.md` (read it first; decision numbers below are its numbers).

**Branch:** `feat/desktop-launch`, cut from `docs/desktop-launch-spec` in `.worktrees/desktop-launch`. Never commit to `main`.

## Global Constraints

- `server/` takes no new dependency and no new outbound kind; the only new program launch is `open <claude:// url>` via `execFile` with an args array, no shell.
- macOS only: `desktopAvailable` is `process.platform === 'darwin'` **and** a `stat` of `/Applications/Claude.app` succeeding, memoised. Never `open -R` / `open -Ra`.
- Absent `surface` always means `dashboard`; the server never applies the default setting to a request (decision 1).
- `shared/types.ts` first, then server, then client.
- Desktop prompt limit is `PROMPT_CAP` (4000), the same as headless; the app's own cut (14336, app 4.4212.0) is recorded only as a comment in `desktop.ts`.
- Status codes and bodies, verbatim: 501 `desktop app unavailable`; 500 `open failed`; 429 `too many launches in flight`; 409 `already resuming`;
  409 `session is open in the desktop app`; 400 `prompt is required`; 400 `bad surface`.
- Copy, verbatim (decision 12): `Opened in the desktop app — the row appears in a few seconds.` · `Opened in the desktop app.` ·
  `Couldn't open the desktop app.` · `Stop it first` · `Already open in the desktop app` · form note `The desktop app's own defaults apply to these.`
- Never hardcode a color/shadow in `styles.css` below the token block; keep existing class names; new classes get a `sp-`/`chat-` prefix matching their host.
- Wrap new prose and comments at 160 columns.
- Out of scope: the backlog-manager board's pick (spec decision 7) — a separate PR in that repo, after this ships.
- Run a single test file with: `pnpm exec tsx --eval "import('./test/<file>.test.ts').then(async m => process.exit(await m.run()))"`. A new test file
  is also registered in `test/run-all.ts` (import + `failed += run…()` line, `await` for async ones).

## Review Focus

1. **Double tap / two devices on one hand-over** → second request 409 `already resuming`, the app's import fires once (Task 4 test).
2. **`open` fails after a slot was reserved** → 500 `open failed`, and the slot **and** the hand-over mark are released, so an immediate retry is not 429/409
   (Task 4 test).
3. **Headless resume of a session that was just handed over** (mark live, registry row not yet written) → 409 `already resuming`, never a second writer
   (Task 4 test).
4. **Desktop picked while the whole form's other fields are set** (name, model, oneShot, remoteControl) → server ignores them, 200, no 400 (Task 4 test).
5. **Registry record with `isArchived` absent, or the registry root missing on a fresh Mac** → owned / nothing owned respectively, no throw (Task 3 tests).

---

### Task 1: Types, the default-surface setting, and health fields

**Files:**
- Modify: `shared/types.ts` (`SpawnRequest`, `ServerSettings`, `ServerSettingsPatch`, `HealthResponse`, `Session`; new `LaunchSurface`)
- Modify: `server/lib/settings.ts` (`Stored`, `readStored`, `setSettings`, `getSettings`)
- Modify: `server/api.ts` (`serveHealth`; the 400 text in `serveSettingsWrite`)
- Test: `test/settings.test.ts`, `test/api-settings.test.ts`

**Interfaces:**
- Produces: `type LaunchSurface = 'dashboard' | 'desktop'`; `SpawnRequest.surface?: LaunchSurface` (doc: absent means dashboard, never the setting);
  `ServerSettings.launchSurfaceDefault: LaunchSurface`; `ServerSettingsPatch` picks `launchSurfaceDefault`; `HealthResponse.desktopAvailable?: boolean`
  and `HealthResponse.launchSurfaceDefault?: LaunchSurface`; `Session.desktopOwned?: true` (absent-not-false, like `processLive`).
  `SpawnResponse` is **not** changed here (Task 4 does it, together with its consumers, so typecheck stays green per task).
- `serveHealth` sets `launchSurfaceDefault` from settings now; `desktopAvailable` is wired in Task 2.

- [ ] **Step 1: Write failing tests** in `test/settings.test.ts`: fresh store → `getSettings().launchSurfaceDefault === 'dashboard'`;
  `setSettings({ launchSurfaceDefault: 'desktop' })` → returns settings with `'desktop'` and a fresh `readStored` (reset the cache the way the file's other
  cases do) reads `'desktop'`; `setSettings({ launchSurfaceDefault: 'terminal' })` → `null`; a stored file with `launchSurfaceDefault: 42` → reads
  `'dashboard'`. In `test/api-settings.test.ts`: POST `{launchSurfaceDefault:'desktop'}` → 200 with that value; POST `{launchSurfaceDefault:'x'}` → 400 whose
  error text names `launchSurfaceDefault?: 'dashboard'|'desktop'`.
- [ ] **Step 2: Run both files, expect FAIL** (property missing).
- [ ] **Step 3: Implement** the types, then the store field (default `'dashboard'`, `DEFAULT_LAUNCH_SURFACE` exported beside the other defaults, a parse that
  accepts only the two literals), the patch branch in `setSettings`, the health field, and extend `serveSettingsWrite`'s expected-shape string.
- [ ] **Step 4: Run both files + `pnpm typecheck`, expect PASS.**
- [ ] **Step 5: Commit** `feat(settings): add the launch-surface default and its health field`.

### Task 2: `server/lib/desktop.ts` — links, probe, opener, rail, hand-over marks

**Files:**
- Create: `server/lib/desktop.ts`
- Modify: `server/api.ts` (`serveHealth` gets `desktopAvailable: desktopAvailable()`)
- Test: `test/desktop.test.ts` (new; register in `test/run-all.ts`)

**Interfaces:**
- Produces (all exported from `server/lib/desktop.ts`):
  - `newSessionUrl(folder: string, prompt: string): string` — `claude://code/new?` + `URLSearchParams` of `folder` then `q`.
  - `resumeUrl(sessionId: string): string` — `claude://resume?` + `URLSearchParams` of `session`.
  - `desktopAvailable(): boolean` — memoised `platform === 'darwin' && statSync(appPath)` succeeds; `resetDesktopProbe()` for tests.
  - `openDesktopUrl(url: string): Promise<void>` — runs `open` with `[url]` through the runner; rejects on non-zero / timeout (5000 ms, as `open-folder.ts`).
  - `overrideDesktop(o: { run?: OpenRunner | null; platform?: string | null; appPath?: string | null }): void` — test seam, same `undefined`=leave /
    `null`=restore semantics as `overrideOpenFolder`; changing `platform` or `appPath` also drops the memo. Reuse the `OpenRunner` type from `open-folder.ts`.
  - `DESKTOP_RAIL_MAX = 4`, `DESKTOP_WINDOW_MS = 5000`.
  - `reserveDesktopLaunch(handOverId: string | null, now?: number): 'ok' | 'rail-full' | 'in-flight'` — prunes entries older than the window, then:
    `in-flight` if `handOverId` already has a live mark; `rail-full` if live entries ≥ `DESKTOP_RAIL_MAX`; else records `{at: now, id: handOverId}` and `ok`.
    `in-flight` is checked before `rail-full`.
  - `releaseDesktopLaunch(handOverId: string | null, at: number): void` — removes exactly the entry reserved at `at` (used when `open` fails).
  - `handOverInFlight(id: string, now?: number): boolean` — a live mark exists for `id`.
  - `resetDesktopRail(): void` — tests.
- A comment beside `newSessionUrl` records: the app cuts `q` at 14336 characters (app 4.4212.0, `app.asar`, read 2026-10-29); `PROMPT_CAP` (4000) must
  stay below it, and the links are undocumented (`docs/subsystems/session-surfaces.md`) so this module is the one place to fix a change.

- [ ] **Step 1: Write failing tests** in `test/desktop.test.ts`:
  - `newSessionUrl('/Users/a b/proj', 'fix & ship\nnow')` → parsed with `new URL(...)`: protocol `claude:`, `searchParams.get('folder') === '/Users/a b/proj'`,
    `searchParams.get('q') === 'fix & ship\nnow'`; and the raw string contains no literal space or `&ship`.
  - `resumeUrl('48716273-aaaa')` → `'claude://resume?session=48716273-aaaa'`.
  - probe: `overrideDesktop({platform:'linux', appPath:<existing tmp dir>})` → false; `{platform:'darwin', appPath:<missing path>}` → false;
    `{platform:'darwin', appPath:<existing tmp dir>}` → true.
  - `openDesktopUrl(u)` with a fake runner records exactly `['open', [u]]`; a rejecting runner → the promise rejects.
  - rail with fixed `now`: four `reserveDesktopLaunch(null, 1000)` → `'ok'`; fifth → `'rail-full'`; `reserveDesktopLaunch(null, 1000 + 5001)` → `'ok'` (window expired).
  - marks: `reserveDesktopLaunch('s1', 0)` → `'ok'`; again at 10 → `'in-flight'`; `handOverInFlight('s1', 10)` true; at 5001 → false;
    `releaseDesktopLaunch('s1', 0)` right after reserving → `handOverInFlight('s1', 1)` false and a new reserve → `'ok'`.
  - `in-flight` beats `rail-full`: fill 3 `null` + 1 `'s1'` at 0, then `reserveDesktopLaunch('s1', 1)` → `'in-flight'`.
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** the module and the health field.
- [ ] **Step 4: Run `test/desktop.test.ts` + `pnpm typecheck`, expect PASS.**
- [ ] **Step 5: Commit** `feat(desktop): build claude:// links and gate desktop launches`.

### Task 3: Live desktop records → `desktopOwned` rows

**Files:**
- Modify: `server/lib/archived.ts` (new sibling reader; `classify` untouched)
- Modify: `server/lib/scan.ts` (`ScanOptions`/`RowOptions` gain `desktopOwnedIds`; row sets `desktopOwned`)
- Modify: `server/api.ts` (every `scanSessions` / row call site that injects `archivedIds` also injects `desktopOwnedIds: desktopLiveSessionIds()` —
  at minimum the sessions list and the row-by-id route)
- Test: `test/archived.test.ts`, `test/scan.test.ts`

**Interfaces:**
- Produces: `desktopLiveSessionIds(options?: ArchivedOptions): ReadonlySet<string>` in `archived.ts`, with its own mtime-keyed cache (like `cache`, separate
  map) and `resetArchivedCache()` clearing it too.
  Per record: `isArchived === true` → not live; anything else (`false`, absent, non-boolean) → live, contributing its `cliSessionId` when that is a
  non-empty string. Unreadable file, malformed JSON, or no string `cliSessionId` → skipped, other records still read. Missing root → empty set.
  A prefix fast path is allowed only if it can never *drop* a live id (e.g. trust a prefix-extracted `cliSessionId` only when the prefix also shows
  `"isArchived": false`; otherwise full-parse).
- `Session.desktopOwned` is set only when `surface === 'dashboard'` and the id is in the set (a desktop-started row needs no flag).
- Module doc comment of `archived.ts` gains one paragraph: the second reader's failure direction is the inverse of `classify`'s, and why (spec decision 11).

- [ ] **Step 1: Write failing tests** (tmpdir store laid out `<root>/<install>/<account>/local_<uuid>.json`, as the file's existing fixtures do):
  - records `{cliSessionId:'a', isArchived:false}`, `{cliSessionId:'b', isArchived:true}`, `{cliSessionId:'c'}` (flag absent), `{isArchived:false}` (no id),
    and a file containing `{not json` → `desktopLiveSessionIds({root})` equals `{'a','c'}`.
  - `root` pointing at a missing directory → empty set, no throw.
  - mtime cache: rewrite `a`'s record with `isArchived:true` and a bumped mtime (`fs.utimesSync`) → set no longer has `'a'`.
  - `archivedSessionIds` on the same fixture still equals `{'b'}` (sibling did not change `classify`).
  - scan: a `dashboard`-entrypoint transcript `s1` with `desktopOwnedIds: new Set(['s1'])` → row has `desktopOwned: true`; same with an empty set →
    property absent; a `claude-desktop`-entrypoint transcript whose id is in the set → property absent.
- [ ] **Step 2: Run both files, expect FAIL.**
- [ ] **Step 3: Implement** reader, scan option, api injection.
- [ ] **Step 4: Run `test/archived.test.ts`, `test/scan.test.ts` + `pnpm typecheck`, expect PASS.**
- [ ] **Step 5: Commit** `feat(scan): mark sessions the desktop app holds as desktop-owned`.

### Task 4: `POST /api/spawn` learns `surface`; the response becomes a union

**Files:**
- Modify: `server/lib/spawn.ts` (`parseSpawnRequest`, `ParseResult`)
- Modify: `server/api.ts` (`serveSpawn` and its doc comment)
- Modify: `shared/types.ts` (`SpawnResponse` union)
- Modify: `client/src/hooks/useSpawn.ts`, `client/src/components/SpawnPanel.tsx`, `client/src/components/ResumePanel.tsx`, `client/src/hooks/useGitSync.ts`
  (consumers narrow; behaviour unchanged for headless)
- Test: `test/spawn.test.ts`, `test/spawn-endpoint.test.ts`

**Interfaces:**
- Consumes: Task 2's `newSessionUrl`, `resumeUrl`, `desktopAvailable`, `openDesktopUrl`, `reserveDesktopLaunch`, `releaseDesktopLaunch`, `handOverInFlight`,
  `overrideDesktop`, `resetDesktopRail`; Task 3's `desktopLiveSessionIds`.
- Produces: `ParseResult`'s ok branch gains `surface: LaunchSurface`. `SpawnResponse = { surface: 'dashboard'; sessionId: string } | { surface: 'desktop' }`.
  `SpawnControl.launch(req): Promise<SpawnResponse | null>` (null = failure, as today; doc comment updated).
- Parse rules: `surface` absent → `'dashboard'`; `'dashboard'`/`'desktop'` → itself; anything else present → `{ok:false, error:'bad surface'}` (a silent
  headless launch the user believed was desktop is worse than a 400 — the same reasoning as `resume`). The prompt check is skipped for exactly
  `resume` valid + `surface === 'desktop'`; the input's `prompt` is then `''`. All other prompt rules unchanged.
- Handler order (rewrite the doc comment to match, keeping the two cross-referenced paragraphs' substance): remote-answer toggle (404) → `refuseWrite` →
  read body → `parseSpawnRequest` → surface probe (`probeSpawn` → 404 `spawn unavailable`; `desktopAvailable` → 501 `desktop app unavailable`) →
  surface rail (headless: `MAX_LAUNCHING` as today; desktop: `reserveDesktopLaunch`) → launch.
- Desktop fresh: `resolveProject` exactly as headless (400 `unknown project: …`) → `newSessionUrl(ref.path, parsed.input.prompt)`.
- Desktop hand-over: the headless resume's validation and 409s unchanged and in the same order (unknown session 400, surface 400, held sockets,
  `hasLiveChild`, `liveSessionIds`, launch-store `already resuming`), then `desktopLiveSessionIds().has(rid)` → 409 `session is open in the desktop app`,
  then `reserveDesktopLaunch(rid)` (`in-flight` → 409 `already resuming`, `rail-full` → 429) → `resumeUrl(rid)`.
  `tr.cwd` missing is **not** a refusal for a hand-over (the link carries no folder).
- Headless resume gains the same two checks after its existing `already resuming`: desktop-owned → 409 `session is open in the desktop app`;
  `handOverInFlight(rid)` → 409 `already resuming`.
- `openDesktopUrl` rejects → `releaseDesktopLaunch(id, at)`, log one `console.error` line, 500 `open failed`. Success → 200 `{surface:'desktop'}`.
  Headless success → 200 `{surface:'dashboard', sessionId}`.
- Fields a desktop launch ignores (name, model, effort, permissionMode, remoteControl, oneShot) are accepted and dropped.

- [ ] **Step 1: Write failing parse tests** in `test/spawn.test.ts`: `{resume:'abc', surface:'desktop'}` (no prompt) → ok, `surface:'desktop'`,
  `resumeId:'abc'`; `{resume:'abc'}` (no prompt) → `prompt is required`; `{resume:'abc', surface:'dashboard'}` (no prompt) → `prompt is required`;
  `{prompt:'x', surface:'desktop'}` → ok, `surface:'desktop'`; `{prompt:'x'}` → `surface:'dashboard'`; `{prompt:'x', surface:'Desktop'}` → `bad surface`;
  `{prompt:'x'.repeat(4001), surface:'desktop'}` → the existing `prompt must be at most 4000 characters`.
- [ ] **Step 2: Write failing endpoint tests** in `test/spawn-endpoint.test.ts` (fake runner via `overrideDesktop({run, platform:'darwin', appPath:<tmp dir>})`,
  `resetDesktopRail()` + `resetDesktopProbe()` between cases; resume cases need a tmpdir transcript with a `dashboard` entrypoint reachable through the
  `projectsRoot` the handler reads — follow how the file or `api-harness.ts` points it at a fixture; if neither can, add the smallest seam that can and say so):
  - desktop fresh on a pinned/recent fixture project → 200 `{surface:'desktop'}`; runner saw one `open` whose URL parses to that project's path and the prompt.
  - desktop with `platform:'linux'` → 501 `desktop app unavailable`; runner never called.
  - desktop while `probeSpawn` would be false (no `claudeBin`) → still 200 (the headless probe does not gate desktop).
  - headless while desktop is unavailable → unchanged behaviour (existing cases still pass).
  - five desktop fresh launches back to back → four 200, fifth 429 `too many launches in flight`.
  - hand-over twice back to back for one id → 200 then 409 `already resuming`; runner called once with `claude://resume?session=<id>`.
  - hand-over, then headless resume of the same id with a prompt → 409 `already resuming`.
  - hand-over with a rejecting runner → 500 `open failed`; immediately again with a resolving runner → 200 (slot and mark released).
  - hand-over of an id whose live registry record exists (store fixture via the `ArchivedOptions` root the handler uses — same seam question as above)
    → 409 `session is open in the desktop app`; same for a headless resume of it.
  - desktop body carrying `name`, `model:'opus'`, `oneShot:true`, `remoteControl:true` → 200.
  - `surface:'nope'` → 400 `bad surface`.
  - Existing cases that relied on the old order (429 or 404 returned **before** the body is read, posted with a malformed body) are updated to post a
    well-formed body; each such edit is listed in the commit body.
- [ ] **Step 3: Run both files, expect FAIL.**
- [ ] **Step 4: Implement** parse, handler, union type, and the consumers: `useSpawn.launch` returns the parsed body when it has a valid `surface`
  (a body with a string `sessionId` and no `surface` — an older server — maps to `{surface:'dashboard', sessionId}`), else null; `SpawnPanel` and
  `ResumePanel` treat only `surface === 'dashboard'` as today's success (Task 5/6 add the desktop branch); `useGitSync` takes `sessionId` only from a
  dashboard result.
- [ ] **Step 5: Run `test/spawn.test.ts`, `test/spawn-endpoint.test.ts`, `test/spawn-stop.test.ts` + `pnpm typecheck`, expect PASS.**
- [ ] **Step 6: Commit** `feat(spawn): launch and hand over sessions in the desktop app`.

### Task 5: Launch form — Dashboard | Desktop pick and the after-launch line

**Files:**
- Create: `client/src/lib/launchSurface.ts`
- Modify: `client/src/components/SpawnPanel.tsx`, `client/src/components/SessionsView.tsx`, `client/src/components/AsideBoard.tsx`,
  `client/src/components/sessions/AsideStrip.tsx`, `client/src/styles.css`
- Test: `test/launch-surface.test.ts` (new; register in `run-all.ts`)

**Interfaces:**
- Produces in `launchSurface.ts`:
  - `offeredSurfaces(spawnAvailable: boolean | undefined, desktopAvailable: boolean | undefined): LaunchSurface[]` — strict `=== true` on each, order
    `['dashboard','desktop']`.
  - `initialSurface(offered: LaunchSurface[], preferred: LaunchSurface | undefined): LaunchSurface | null` — `preferred` when offered, else `offered[0]`,
    null when empty.
  - `canOpenLaunchForm(spawnAvailable, desktopAvailable): boolean` — `offeredSurfaces(...).length > 0`.
  - `DESKTOP_LAUNCHED_TEXT`, `DESKTOP_OPENED_TEXT`, `DESKTOP_FAILED_TEXT`, `DESKTOP_DEFAULTS_NOTE` — the spec's exact copy (Global Constraints).
- `SpawnPanel` props gain `spawnAvailable?`, `desktopAvailable?`, `launchSurfaceDefault?`; `onLaunched` becomes `(r: SpawnResponse) => void`.
- `SessionsView` passes the three from its health poll; on `{surface:'dashboard'}` behaves as today; on `{surface:'desktop'}` closes the form and shows
  `DESKTOP_LAUNCHED_TEXT` in a dismissible line (`.spawn-done`, `role="status"`) above `.s-body` that clears itself after 8 s.
- `SpawnPanel`: a two-button segmented control `.sp-surface` (buttons `aria-pressed`) shown only when two surfaces are offered; the head hint reads
  "opens in the desktop app on this Mac" when Desktop is picked; with Desktop picked, name / model / effort / permission / remote control / one-shot
  controls are `disabled` and `.sp-note` shows `DESKTOP_DEFAULTS_NOTE` under them; `surface` is sent only when Desktop is picked (absent = dashboard);
  a 500 `open failed` shows `DESKTOP_FAILED_TEXT` in the existing `.sp-error` slot instead of the raw server text.
- `AsideBoard` / `AsideStrip` show New session when `canOpenLaunchForm(...)`.
- New CSS uses only existing tokens.

- [ ] **Step 1: Write failing tests** for `launchSurface.ts`: `offeredSurfaces(true,true)` → `['dashboard','desktop']`; `(true,undefined)` → `['dashboard']`;
  `(false,true)` → `['desktop']`; `(undefined,undefined)` → `[]`; `initialSurface(['dashboard','desktop'],'desktop')` → `'desktop'`;
  `initialSurface(['dashboard'],'desktop')` → `'dashboard'`; `initialSurface([], 'dashboard')` → null; `canOpenLaunchForm(false,true)` → true; the four
  copy constants equal the spec strings byte for byte.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the lib, then the components.
- [ ] **Step 4: Run the test + `pnpm typecheck` + `pnpm build`, expect PASS.**
- [ ] **Step 5: Commit** `feat(client): pick Dashboard or Desktop in the launch form`.

### Task 6: "Open in desktop app" in the chat drawer

**Files:**
- Modify: `client/src/lib/resume.ts` (`resumeEligible` also false when `desktopOwned`; new `handOverState`)
- Modify: `client/src/components/ChatDrawer.tsx`, `client/src/components/SessionsView.tsx` (pass `desktopAvailable`), `client/src/styles.css`
- Test: `test/resume-eligible.test.ts`

**Interfaces:**
- Consumes: Task 4's `useSpawn().launch` union; Task 5's copy constants.
- Produces: `handOverState(session: Pick<Session,'surface'|'status'|'stopState'|'processLive'|'desktopOwned'>, holds: {question:boolean; plan:boolean;
  message:boolean}, desktopAvailable: boolean | undefined): 'hidden' | 'offer' | 'stop-first' | 'owned'` —
  `hidden` unless `desktopAvailable === true` and `surface === 'dashboard'`; then `owned` if `desktopOwned`; then `stop-first` if any hold, `stopState`,
  `processLive`, or `status === 'working'`; else `offer`.
- `resumeEligible`'s `Pick` gains `desktopOwned`; a desktop-owned session is not eligible.
- ChatDrawer: a button `.chat-desktop` in `.chat-head`, before `.chat-x`, label "Open in desktop app", rendered unless `hidden`; disabled for `stop-first`
  / `owned` with the hint (`Stop it first` / `Already open in the desktop app`) as visible text beside it (no `title` attribute — memory rule); on click
  posts `{resume: session.id, surface: 'desktop'}` via `useSpawn`; success shows `DESKTOP_OPENED_TEXT`, a null result with a 500 shows
  `DESKTOP_FAILED_TEXT`, any other error shows the server's text (e.g. `already resuming`), all inline beside the button.

- [ ] **Step 1: Write failing tests**: `handOverState` for `{surface:'local'}` + available → `hidden`; `{surface:'dashboard'}` + `desktopAvailable` undefined
  → `hidden`; `{surface:'dashboard', status:'idle', desktopOwned:true}` → `owned`; `{…, status:'idle', processLive:true}` → `stop-first`;
  `{…, status:'working'}` → `stop-first`; holds.question true → `stop-first`; `{surface:'dashboard', status:'idle'}`, no holds → `offer`;
  `{…, status:'incomplete'}` → `offer`. `resumeEligible` with an otherwise-eligible session plus `desktopOwned:true` → false.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test + `pnpm typecheck` + `pnpm build`, expect PASS.**
- [ ] **Step 5: Commit** `feat(client): hand a dashboard session over to the desktop app`.

### Task 7: Settings row for the default

**Files:**
- Modify: `client/src/components/settings/SettingsView.tsx` (Shared section, beside `gitFetchSecs`), and whatever client settings hook types the server
  patch (follow `gitFetchSecs`'s path end to end)
- Test: `test/client-settings.test.ts` if it covers the server-settings patch shape; otherwise none (typecheck is the gate) — say which in the report.

**Interfaces:**
- Consumes: Task 1's `launchSurfaceDefault`.
- Row: label "New sessions open in", a select Dashboard | Desktop saving `{launchSurfaceDefault}`; helper line "Preselects the launch form on every device.
  The desktop app is only on this Mac." When the health poll says `desktopAvailable !== true`, the row still shows (the setting is shared) with the helper
  line's second sentence replaced by "The desktop app was not found on the Mac running this dashboard."

- [ ] **Step 1: Write the failing test if the file covers patch shapes; else skip to Step 3 and note it.**
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm typecheck` + `pnpm build` (+ the test), expect PASS.**
- [ ] **Step 5: Commit** `feat(settings): choose where new sessions open by default`.

### Task 8: Docs

**Files:**
- Modify: `docs/subsystems/spawn.md` (surface, new check order, desktop rail and hand-over mark, the two new 409s), `docs/subsystems/session-surfaces.md`
  (the dashboard now fires both links; `desktopOwned`), `docs/overview.md` (§Map line for `server/lib/desktop.ts` and `client/src/lib/launchSurface.ts`),
  `.claude/CLAUDE.md` (Code rules launched-program list: `lib/desktop.ts` launches `open` with a `claude://` URL), the spec's Status line
  (`implemented on feat/desktop-launch`).
- Test: none of its own; any doc-reading suite `scripts/ci-scope.ts` maps these files to (check it) must pass.

- [ ] **Step 1: Edit the docs**, 160-column wrap, no reflow of untouched prose. If a doc carries a provenance stamp, leave the stamp alone (docs-sync owns it).
- [ ] **Step 2: Run the doc-reading suites `ci-scope` names for these paths, expect PASS.**
- [ ] **Step 3: Commit** `docs: document desktop launches and hand-overs`.

### Final verification (controller, after Task 8)

- `pnpm typecheck`, `pnpm build`, the touched test files, and `pnpm test:visual` (macOS, on demand: the launch form and chat drawer changed).
- Live: `pnpm dev` in the worktree on spare ports, open the launch form in the browser pane, confirm the pick, the greyed fields and the setting row.
  Do **not** fire a real desktop launch unattended; list "real `open claude://…` from the UI" as unverified for the human.
