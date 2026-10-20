# Usage-limit alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two opt-in push events for the 5-hour window — *limit reached* and *limit reset* — decided from the usage readings the recorder already takes and
sent through the existing ntfy path.

**Architecture:** A pure decision function (`decideUsageAlert`) over a one-window-per-account ledger; a thin I/O shell around it that re-reads, decides, writes
and then sends; one call from the `recordUsageHistory` branch of `refreshNow`. `notify.ts` gains a usage sibling of `sendScheduleEvent`. The client gains two
Settings rows and a `?view=usage` deep link.

**Tech Stack:** Node + TypeScript via `tsx` (server, zero new deps), React + Vite (client), node-assert tests registered in `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-10-20-usage-limit-alerts-design.md` — read it first; this plan does not repeat its reasoning.

**Plan convention (overrides the writing-plans template):** this plan specifies behaviour, signatures, exact values and exact test *cases*, never literal code.
Write the bodies yourself, and disagree with the plan where the code proves it wrong — say so in the commit body. Size budgets, where stated, are soft.

## Global Constraints

- No new runtime dependency under `server/`; no new kind of outbound call (`test/outbound.test.ts`, `test/server-deps.test.ts` stay green untouched).
- `shared/types.ts` first, then server, then client. Cross-boundary imports are `import type`.
- Server imports use the `.js` suffix. ESM everywhere.
- Never hardcode a color in `client/src/styles.css`; keep CSS class names stable. Prefer no CSS change at all — the rows reuse `SettingsRow`.
- New text wraps at 160 columns; commit bodies at 72.
- Both events default **off**. Event keys: `'usage-limit'` and `'usage-reset'` (author's call per the spec's *Left to the builder*).
- Push copy, verbatim from the spec:
  - *limit reached* title `5-hour limit reached`; body `Resets at HH:MM.` (today) or `Resets <Ddd> at HH:MM.` (another day, short weekday e.g. `Tue`), or
    `No reset time reported.` for a null stamp; plus the suffix ` Extra usage is on: you are now billed.` when `extraUsage`.
  - *limit reset* title `5-hour limit reset`; body `Usage is available again.`, or `Back on plan usage: extra-usage billing stops.` when `extraUsage` is on
    at reset time.
- Settings copy, verbatim: names `Usage limit reached` / `Usage limit reset`; hints
  `Your 5-hour usage window hit 100%. Ignores the three conditions below. Needs Record usage history (Usage forecast).` and
  `The 5-hour window you hit has reset. Ignores the three conditions below. Needs Record usage history (Usage forecast).`; disabled notes
  `Turn on Record usage history under Usage forecast to use this.` and `Usage is hidden (SHOW_USAGE=false) on this server.`
- Run one suite: `npx tsx --eval "import('./test/<name>.test.ts').then(async m => process.exit(await m.run()))"` (a suite's `run()` returns its failure
  count). `pnpm typecheck` at the end of every task. Never the whole `pnpm test` locally — CI runs it.

## Review Focus

1. **Jittered stamps.** Consecutive readings of one window differ by < 1 s in `resetsAt`; must stay one window — no repeat *reached*, no false *reset*.
   Pinned in Task 2 (`jitter keeps one window`).
2. **`pnpm dev` restarts mid-window at 100%.** The server restarts on every server edit; the ledger file must stop a second *reached*. Pinned in Task 3
   (`restart at 100% sends nothing`).
3. **Expired token / signed-out CLI during a hit.** A non-`ok` status or a null utilization between readings must neither reset nor re-hit. Pinned in Task 2
   (`no-reading in between changes nothing`).
4. **Prod and dev dashboards both recording.** The second process to see a hit must find the claim and not send. Pinned in Task 3
   (`second process finds the claim`).
5. **Checkbox switched on mid-window.** The hit already seen is not pushed, and no reset follows. Pinned in Task 2 (`hit seen while off is recorded, not
   pushed`).

---

### Task 1: Event plumbing — types, settings, notify maps, `usageAvailable`

**Files:**
- Modify: `shared/types.ts` (`NotifyEvent` ~line 967 and its comment; the settings response type that carries `notifyAvailable` ~line 1066)
- Modify: `server/lib/settings.ts:59,65` (`DEFAULT_NOTIFY.events`, `NOTIFY_EVENTS`)
- Modify: `server/lib/notify.ts:133-147` (`PHRASE`, `TAGS`)
- Modify: `server/api.ts:621-629` (`settingsBody`)
- Modify: `test/visual/fixtures/settings.ts:4-20` (its settings literal gains `usageAvailable`)
- Test: `test/settings.test.ts`, `test/api-settings.test.ts`

**Interfaces:**
- Produces: `NotifyEvent` gains `'usage-limit' | 'usage-reset'`. The settings body type gains `usageAvailable: boolean`, filled from `config.showUsage` in
  `settingsBody`, documented beside `notifyAvailable`. `PHRASE`: `'usage-limit': '5-hour limit reached'`, `'usage-reset': '5-hour limit reset'`. `TAGS`:
  `'usage-limit': 'no_entry'`, `'usage-reset': 'arrows_counterclockwise'`.

- [ ] **Step 1: Write the failing tests**
  - `settings.test.ts` — `NOTIFY_EVENTS includes both usage events`: `NOTIFY_EVENTS` contains `'usage-limit'` and `'usage-reset'`; `DEFAULT_NOTIFY.events`
    has both `false`. `a stored policy without the usage keys loads them as false` (an old `.dashboard-settings.json` with only the five keys).
    `POST notify events accepts usage-limit` (the existing patch validator at `settings.ts:162` accepts the new names).
  - `api-settings.test.ts` — `settings body reports usageAvailable from SHOW_USAGE`: `true` with `showUsage: true`, `false` with `showUsage: false`.
- [ ] **Step 2: Run both suites — expect FAIL** on the new cases.
- [ ] **Step 3: Implement.** Update `NotifyEvent`'s comment ("The four session events…") to say what the members are now. `pnpm typecheck` lists every
  remaining `Record<NotifyEvent, …>` that must gain the keys — cover all of them, client included (`SettingsView`'s rows come in Task 4; if typecheck
  demands a client entry now, add the two rows' data there and leave the disabled logic to Task 4).
- [ ] **Step 4: Run both suites and `pnpm typecheck` — expect PASS / clean.**
- [ ] **Step 5: Commit** `feat(notify): usage-limit and usage-reset events`.

### Task 2: The pure detector

**Files:**
- Create: `server/lib/usage-alerts.ts`
- Test: Create `test/usage-alerts.test.ts`; register it in `test/run-all.ts` beside `runScheduleNotify`

**Interfaces:**
- Consumes: `sameWindow(a: string | null, b: string | null): boolean` from `server/lib/usage-history.ts`.
- Produces (all exported):
  - `interface UsageReading { t: number; account: string; utilization: number | null; resetsAt: string | null; ok: boolean }` — `ok` is
    `status === 'ok'`.
  - `interface UsageAlertRecord { account: string; stamp: string | null; hitT: number; pushed: boolean; resetSent: boolean; lastSeenT: number }` — one
    window per account. `stamp` is the first-seen `resetsAt`; `pushed` says whether *reached* actually went out.
  - `interface UsageAlertLedger { windows: Record<string, UsageAlertRecord> }` — keyed by account email.
  - `type UsageAlertKind = 'reached' | 'reset'`.
  - `decideUsageAlert(ledger: UsageAlertLedger, reading: UsageReading, canSend: Record<UsageAlertKind, boolean>):
    { ledger: UsageAlertLedger; push: UsageAlertKind | null }` — pure, never mutates its input.
  - `const RESET_STALE_MS = 60 * 60_000` — a reset whose alerted stamp passed more than this before the reading is recorded (`resetSent: true`) without a
    push (author's call for the spec's staleness cut-off; it also covers recording switched off across the reset).
  - `usageAlertCopy(kind: UsageAlertKind, o: { resetsAt: string | null; extraUsage: boolean; now: number }): { title: string; body: string }` — the
    Global Constraints copy, times in the process's local zone.

**Rules `decideUsageAlert` implements** (from the spec; each is a test below):
Order: not-a-reading, then account switch, then the late-reading guard, then the hit/reset rules. Every judged reading of the record's account sets
`lastSeenT = reading.t`, whether or not it changes anything else.
- Not a reading (`!ok`, `utilization === null`, `account === ''`) → ledger unchanged, no push.
- `reading.t < record.lastSeenT` → ignored (late reading from an abandoned fetch cycle).
- Account switch: any record keyed by an account other than `reading.account` is deleted (its pending reset dropped, never sent), then the reading is
  judged on its own. In practice the ledger holds at most one record. (Unrelated to the existing `server/lib/usage-ledger.ts`.)
- `utilization >= 100` and no record, or a record that is not `sameWindow` → new record (`pushed = canSend.reached`, `resetSent = false`), push `'reached'`
  iff `canSend.reached`. A replaced record's pending reset is dropped.
- `utilization >= 100` and `sameWindow(record.stamp, reading.resetsAt)` → update `lastSeenT` only.
- `utilization < 100` with a record where `pushed && !resetSent`, and (stamp null) or (not `sameWindow`) or (`Date.parse(stamp) <= reading.t`) → reset:
  `resetSent = true`; push `'reset'` iff `canSend.reset` and not stale (scoped stamp passed more than `RESET_STALE_MS` before `reading.t`).
- `utilization < 100` with a record whose hit was not pushed → the record is retired (`resetSent = true`) once the reset condition holds, no push.
- A reset needs the drop below 100: a changed stamp at 100 is a new hit, never a reset.

- [ ] **Step 1: Write the failing tests** (one `test()` each, account `a@x`, stamp `S = '2026-10-20T15:00:00.123Z'`; unless a case gives `t`, the hit is
  at `t = S − 4 h` and each later reading one minute after the one before — so every follow-up stays before `S` and well inside `RESET_STALE_MS`):
  - `99% never alerts` — 99 then 99.9 → no push, ledger empty.
  - `first 100 pushes reached` — 100 → `'reached'`; record `stamp === S`, `pushed`.
  - `jitter keeps one window` — 100 at `S`, then 100 at `S` + 400 ms, then 100 at `S` − 850 ms → only the first pushes.
  - `reset by new window` — hit at `S`; then 60 at stamp `S` + 5 h, `t = S + 1 min` → `'reset'`; then 70 at `S` + 5 h, `t = S + 2 min` → nothing.
  - `reset by time` — hit at `S`; then 40 at stamp `S` (same window), `t = S + 1 min` → `'reset'`.
  - `drop before the stamp is not a reset` — hit at `S`; 95 at `S`, `t = S − 1 min` → nothing (utilization should not fall inside a
    window; treat as noise).
  - `changed stamp at 100 is a new hit, not a reset` — hit at `S`; 100 at `S` + 5 h → `'reached'`, never `'reset'`; old pending reset gone.
  - `unscoped hit then unscoped drop resets` — 100 at null; 30 at null → `'reset'`.
  - `unscoped hit then scoped 100 is a new hit` — 100 at null; 100 at `S` → `'reached'`.
  - `no-reading in between changes nothing` — hit; `{ok:false}`; `{utilization:null}`; `{account:''}`; then 100 again → only the first pushes.
  - `hit seen while off is recorded, not pushed` — 100 with `canSend.reached = false` → no push, record `pushed: false`; 100 again with `canSend` all true →
    nothing; 20 at `S`, `t = S + 1 min` → nothing.
  - `reset push needs the reset checkbox` — hit pushed; drop with `canSend.reset = false` → no push, `resetSent: true`.
  - `account switch deletes the pending record` — hit as `a@x`; 10 as `b@x` → no push, no `a@x` record; 10 as `a@x` later → nothing.
  - `stale reset is retired silently` — hit at `S`; drop at stamp `S`, `t = S + 61 min` → no push, `resetSent: true`.
  - `late reading is ignored` — hit at `t = 10`; reading 20 at `t = 5` → nothing.
  - `copy` — fixed `now` = local 2026-10-20 10:00 (`new Date(2026, 9, 20, 10).getTime()`); `usageAlertCopy('reached', { resetsAt: <local 2026-10-20
    14:30 as ISO>, extraUsage: false, now })` → body `Resets at 14:30.`; local 2026-10-21 09:10 → `Resets Wed at 09:10.`; null → `No reset time reported.`;
    `extraUsage: true` appends ` Extra usage is on: you are now billed.`; `'reset'` bodies both ways; titles exact.
- [ ] **Step 2: Run `usage-alerts` — expect FAIL** (module missing).
- [ ] **Step 3: Implement** `server/lib/usage-alerts.ts` (pure part only; no `fs`, no notify import).
- [ ] **Step 4: Run `usage-alerts` — expect PASS.** Mutation-prove both guards: (a) let a reset fire without `pushed` → `hit seen while off` fails; (b) let a
  reset fire with no record → `99% never alerts` fails; revert each.
- [ ] **Step 5: Commit** `feat(usage): pure detector for 5-hour limit alerts`.

### Task 3: Ledger I/O, send path and wiring

**Files:**
- Modify: `server/lib/usage-alerts.ts` (I/O shell)
- Modify: `server/lib/notify.ts` (add `sendUsageEvent`, `usageClickUrl`)
- Modify: `server/lib/usage.ts:335-358` (call the shell beside `recordTick`)
- Modify: `server/index.ts:526` (arm)
- Test: `test/usage-alerts.test.ts`, `test/notify.test.ts`

**Interfaces:**
- Consumes: Task 2's `decideUsageAlert`, `usageAlertCopy`; `readAccountProfile()` (`server/lib/account.ts`); `getSettings()`.
- Produces:
  - `notify.ts`: `usageClickUrl(config: Config): string` → `${publicUrl}/?view=usage`, `''` without a public URL.
    `sendUsageEvent(event: { kind: 'usage-limit' | 'usage-reset'; title: string; body: string }, config: Config): boolean` — mirrors `sendScheduleEvent`:
    needs `config.ntfyTopic`, master switch and the event's checkbox (`shouldNotify` with the three `require*` zeroed), routes with `routeTo` and
    `usageClickUrl`, fire-and-forget, never throws, returns whether a push was handed to the transport. Also export
    `usageCanSend(kind: UsageAlertKind): boolean` (same gate
    without sending) so the detector can record `pushed` truthfully.
  - `usage-alerts.ts`: `armUsageAlerts(config: Config | null): void` (null disarms; tests use it), `setUsageAlertsFile(file: string | null): void` (test
    seam; default `~/.claude/dashboard/usage-alerts.json`, fixed under the home dir, deliberately not under `SCHEDULES_STATE_ROOT`),
    `resetUsageAlertsMemory(): void` (test seam: drops the in-memory ledger, simulating a restart), `setUsageAlertsHome(dir: string | null): void` (test
    seam passed to `readAccountProfile(homeDir)`; tests call `clearAccountCache()` between cases),
    `onUsageReading(limits: UsageLimits | null, now?: number): void` — never throws. `ok` is `limits !== null` (no `status` is in scope at the call
    site; `refreshNow` derives it later, `usage.ts:379`).

**`onUsageReading` behaviour:** returns at once unless armed and `config.showUsage` and `getSettings().recordUsageHistory`. Reads the profile (null or empty
email → return). Re-reads the ledger file (missing or corrupt → empty ledger), calls `decideUsageAlert` with `canSend` from `usageCanSend`, writes the new
ledger (tmp + `renameSync`, `mkdirSync` recursive), then — only after the write — sends with `sendUsageEvent` and `usageAlertCopy`. A failed write keeps the
ledger in process memory (used as the base when the file cannot be read) and still sends.

- [ ] **Step 1: Write the failing tests** (tmpdir ledger via `setUsageAlertsFile`, `setSender` capturing payloads, `setSettings` for recording/notify,
  `armUsageAlerts` with a config literal; a fixture home via `setUsageAlertsHome`):
  - `unarmed sends nothing` / `recording off sends nothing` / `showUsage off sends nothing`.
  - `hit sends one reached push to the phone with ?view=usage` — payload title `5-hour limit reached`, `click` ends `/?view=usage`, `tags` `no_entry`.
  - `restart at 100% sends nothing` — after a hit, `resetUsageAlertsMemory()`, re-arm, feed 100 again → no payload. Mirror: same, but delete the ledger
    file before the re-feed → a second payload (proves the file, not memory, stopped the repeat).
  - `second process finds the claim` — after a hit, `resetUsageAlertsMemory()` (the other process's view), feed 100 → one payload total.
  - `null fetch changes nothing` — after a hit, `onUsageReading(null)`, then 100 again → no further payload.
  - `write failure still sends` — ledger path inside a read-only dir → payload sent, no throw.
  - `checkbox off at hit, on later` — no payload at the hit, none at the drop.
  - `notify.test.ts`: `usageClickUrl` with and without a public URL; `sendUsageEvent` ignores `requireAfk`/`requireRemoteAnswer`/`requireAutoMode`; returns
    `false` with no topic.
- [ ] **Step 2: Run `usage-alerts` and `notify` — expect FAIL.**
- [ ] **Step 3: Implement.** In `usage.ts`, call `onUsageReading(limits)` inside the existing `recordUsageHistory` branch, inside its `try`, after the
  inner `if (limits && …utilization != null)` block that holds `recordTick` (not inside it) — it must not disturb the recorder on failure.
  In `index.ts`, `armUsageAlerts(config)` beside `startUsageRecording` under the same
  `config.showUsage` condition. Never a second `loadConfig()`.
- [ ] **Step 4: Run `usage-alerts`, `notify`, `usage`, `outbound`, `server-deps` — expect PASS; `pnpm typecheck` clean.**
- [ ] **Step 5: Commit** `feat(usage): send 5-hour limit alerts through the ntfy path`.

### Task 4: Client — Settings rows and `?view=usage`

**Files:**
- Modify: `client/src/lib/deepLink.ts:31-42` (+ the prose at `:2`, `:13-17`, `:59`, `:117`, `:127` that lists the views)
- Modify: `client/src/App.tsx:50-56` (initial-section mapping, + the comment at `:45-46`)
- Modify: `client/src/components/settings/SettingsView.tsx:39-46, 220-230` (incl. the "five push events" comment at `:39`)
- Create: a pure helper in `client/src/lib/notifyRows.ts` (or beside an existing settings helper if one fits)
- Test: `test/deep-link.test.ts`; Create `test/notify-rows.test.ts`, registered in `test/run-all.ts`

**Interfaces:**
- Consumes: `usageAvailable` (Task 1), `recordUsageHistory`, `notifyAvailable` from the settings state.
- Produces: `DeepLinkView = 'git' | 'schedules' | 'usage'`. `notifyRowState(key: NotifyEvent, s: { notifyAvailable: boolean; usageAvailable: boolean;
  recordUsageHistory: boolean }): { disabled: boolean; note: string | null }`.

- [ ] **Step 1: Write the failing tests**
  - `deep-link.test.ts`: `reads view=usage` → `'usage'`.
  - `notify-rows.test.ts`: non-usage keys → `{ disabled: !notifyAvailable, note: null }`; usage key with recording off → disabled, recording note;
    `usageAvailable: false` → disabled, `SHOW_USAGE` note; both off → the `SHOW_USAGE` note wins; only push unconfigured → disabled, `note: null`; push
    unconfigured and recording off → disabled, `note: null` (the recording note shows only with push configured); push unconfigured and `usageAvailable:
    false` → disabled, `SHOW_USAGE` note; all on → enabled, `note: null`. Precedence: `SHOW_USAGE` note > recording note (push configured only) > none.
- [ ] **Step 2: Run `deep-link` and `notify-rows` — expect FAIL.**
- [ ] **Step 3: Implement.** `App.tsx`: `view === 'usage'` → section `'usage'`. Two rows after *Scheduled job failed* with the Global Constraints copy; a
  row's `hint` is `note ?? row.hint`, `disabled` from the helper.
- [ ] **Step 4: Run both suites, `client-settings`, `pnpm typecheck`, `pnpm build` — expect PASS / clean.** Then open the dev client in the browser and
  check: the two rows render after *Scheduled job failed*; with recording off they are disabled with the recording note; `/?view=usage` lands on Usage.
- [ ] **Step 5: Commit** `feat(settings): usage-limit alert rows and ?view=usage`.

### Task 5: Docs

**Files:**
- Modify: `docs/subsystems/push-notify.md` (new section after *The fifth event: `schedule-failed`*; update "fifth member" counting prose)
- Modify: `docs/workflows/push-notify-setup.md` (*Which events need which hook* table: two rows, needs **Record usage history**, no hook)
- Modify: `docs/subsystems/usage-limits.md` (the recorder now also feeds the alert detector; ledger path)
- Modify: `docs/overview.md` — add `usage-alerts.ts` to the `server/lib/*` list (`:207-239`) and `usageAvailable` beside `notifyAvailable` in the
  `/api/settings` row (`:97`)

- [ ] **Step 1:** Write the sections — behaviour in user terms, the ledger path, the "recorded not pushed" rule, the staleness cut-off, the two gates.
- [ ] **Step 2:** Run `docs-links` — expect PASS.
- [ ] **Step 3: Commit** `docs: usage-limit alerts`.
