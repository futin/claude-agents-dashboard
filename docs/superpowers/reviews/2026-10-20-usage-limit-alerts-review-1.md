# Plan review 1 — usage-limit alerts

Reviewed: `docs/superpowers/plans/2026-10-20-usage-limit-alerts.md` at commit 9528e30, against
`docs/superpowers/specs/2026-10-20-usage-limit-alerts-design.md` and the code in this worktree. Every code claim below was checked by reading the file at
the cited line; the document's own description of the code was not trusted.

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Four Important findings, each a one-line edit to the plan. The plan covers every spec section and every spec
test case, the copy strings match the spec verbatim, every Modify path and line range resolves, every Create path is absent, and no task consumes a name
a later task produces.

## Important

### I1 — plan:177 passes a `status` that is not in scope at the call site

Plan line 177 says "call `onUsageReading(limits, status)` inside the existing `recordUsageHistory` branch, inside its `try`, after `recordTick`", and the
signature at plan:159 is `onUsageReading(limits: UsageLimits | null, status: UsageStatus, now?: number)`. In `server/lib/usage.ts` the branch at
`usage.ts:334-363` has `limits` (`usage.ts:329`) but no `status`: the status is derived later, at `usage.ts:373-380`, as `limits ? 'ok' : 'unavailable'`
when `next` is built. Expired/signed-out tokens never reach the branch at all (`usage.ts:309-328` return early). An implementer must therefore invent the
value. Fix: either state "pass `limits ? 'ok' : 'unavailable'`" at plan:177, or drop the parameter — `onUsageReading(limits: UsageLimits | null, now?)`
with `ok = limits !== null`, since inside the branch a non-null `limits` is by construction an `ok` fetch.

### I2 — plan:199-201 leaves the "push unconfigured AND recording off" row state unspecified

`notifyRowState` test cases at plan:199-201 cover recording off, `usageAvailable` off, both off, and "only push unconfigured", but not `notifyAvailable:
false` together with `recordUsageHistory: false`. The spec pins it: spec:156 says the recording note replaces the hint "While disabled for recording
**(and push is configured)**", and spec:158 that with only `pushUnconfigured` the row keeps its normal hint. So the plan's helper has three precedence
tiers (SHOW_USAGE note > recording note, recording note only when push is configured) and the test list pins only two. Fix: add the case
`{ notifyAvailable: false, usageAvailable: true, recordUsageHistory: false }` → `{ disabled: true, note: null }` to plan:199-201, and state the precedence
in the Produces line at plan:194-195. (Whether the SHOW_USAGE note also shows with push unconfigured is not in the spec either; spec:158 calls
`showUsage` "the outer gate", so recommend it does, and say so.)

### I3 — plan:132 calls `usageAlertCopy` without the `now` the signature at plan:99 requires

Plan:99 produces `usageAlertCopy(kind, o: { resetsAt; extraUsage; now: number })` — `now` is what decides "today" versus "another day" for the
`Resets at HH:MM.` / `Resets <Ddd> at HH:MM.` split (spec:135). The test case at plan:132 calls it with `{ resetsAt: <today 14:30 local>, extraUsage:
false }` and no `now`, and "today" is then whatever the machine clock says when the suite runs, so the case is non-deterministic across midnight and
does not type-check against the stated signature. Fix: give the test a fixed `now` (e.g. a Tuesday 10:00 local) and derive both the "today 14:30" and
the "another day" stamps from it; keep `now` required.

### I4 — plan:119-120 and plan:130 reset-test readings do not say when `t` is, and `RESET_STALE_MS` (plan:97) decides the outcome

The pure rules at plan:110-111 push `'reset'` only when the scoped stamp passed no more than `RESET_STALE_MS` (60 min) before `reading.t`. The tests
`reset by new window` (plan:119, "60 at `S` + 5 h") and `reset by time` (plan:120, "with `t` after `S`") name the stamp but not `t`; with
`t = S + 61 min` the plan's own `stale reset is retired silently` case (plan:130) applies and these two expect the opposite result. The preamble
"readings at `t` minutes apart" (plan:115) does not fix the hit's `t` relative to `S` either. Fix: state the hit at `t = S − 4 h` and each follow-up
reading's `t` explicitly (`reset by time`: `t = S + 1 min`; `reset by new window`: `t = S + 1 min` with stamp `S + 5 h`; `drop before the stamp`:
`t = S − 1 min`), so the three tests and the stale rule are consistent by inspection.

## Minor

- plan:170-171 — `restart at 100% sends nothing` says "re-arm (fresh module state, same file)" and `second process finds the claim` says "two in-memory
  states sharing one file", but nothing in Task 3's Produces (plan:157-159) clears the in-memory ledger: `armUsageAlerts(null)` is described as
  "disarms", not "forgets". Because plan:164 lets the in-memory ledger stand in when the file cannot be read, an implementation that consults memory
  first passes both tests without ever reading the file, and Review Focus 2 and 4 (plan:43-48) are then unproven. Say that `armUsageAlerts(null)` (or a
  `resetUsageAlerts()` seam) drops the in-memory ledger, and add the mirror check: delete the file between the hit and the re-feed and expect a second
  push — that is what proves the file, not memory, stopped the repeat.
- plan:155 — `usageCanSend(kind)` gives no type for `kind`; `UsageAlertKind` (`'reached' | 'reset'`) and the `NotifyEvent` keys (`'usage-limit' |
  'usage-reset'`) are both plausible. Pick one; the shell at plan:162 maps between them either way.
- plan:103-105 — rule order is not fixed: a late reading (plan:104) from a different account (plan:105) is both "ignored" and "deletes the record".
  Say which rule runs first (account switch first is the safe reading of spec:122-123).
- plan:109, plan:121 — `lastSeenT` is updated on a same-window ≥ 100 reading but the plan does not say whether a < 100 reading that is *not* a reset
  (`drop before the stamp is not a reset`) updates it. State it, or the late-reading guard (plan:104) has a hole an implementer fills either way.
- plan:177 — "after `recordTick`": `recordTick` sits inside the inner `if (limits && limits.fiveHour.utilization != null)` at `usage.ts:336-353`. Say
  whether the call goes inside that `if` (then a null-utilization fetch never reaches the detector, which plan:103 already treats as a no-op) or after it.
- plan:167 — the account seam ("stubbed through a seam you add") is not in Task 3's Produces; `readAccountProfile` (`server/lib/account.ts:103`) takes a
  `homeDir` and memoises on mtime+size (`account.ts:108-123`, `clearAccountCache` at `:96`), so a `setUsageAlertsHome(dir | null)` passed through plus
  `clearAccountCache()` between cases is enough. Name it so the test and the shell agree.
- plan:57, plan:74-76 — typecheck will also flag the `ServerSettings` literal at `test/visual/fixtures/settings.ts:4-20` (gains `usageAvailable`), and
  `docs/overview.md:97` lists `notifyAvailable` in the `/api/settings` row — add `usageAvailable` there in Task 5. Neither is named.
- plan:136-137 — the mutation named proves "no reset without a *pushed* hit"; spec:182 asks for "no reset without a hit". `99% never alerts` (plan:116)
  pins the no-record half (a reset fired with no record would push there). Name both mutations so the proof is explicit.
- plan:186 — the view-list prose in `client/src/lib/deepLink.ts` also sits at `:117` and `:127`, not only `:2`, `:13-17`, `:59`.
- plan:188 — `SettingsView.tsx:39` reads "The five push events" above `NOTIFY_EVENT_ROWS`; Task 4 should update it with the rows.
- plan:215 — "only if it lists `server/lib/*` files one per line": `docs/overview.md:207-239` does, so the condition always holds; make it unconditional.
- plan:45-46 (Review Focus 3) — the shell-level mapping from a fetch to `UsageReading.ok` is tested only through the pure function in Task 2; after I1
  the mapping is a one-liner at the call site, so this is acceptable, but a Task 3 case feeding `limits = null` would close it.

## Checklist results

### 1. Coverage — spec section → task

| Spec | Lines | Task |
| --- | --- | --- |
| Goals: two events, own checkboxes, desk+phone routing, extra usage, tap → Usage, plain ntfy | 16-25 | 1, 3, 4 |
| Constraints: recording + `showUsage` gates, zero deps, `NotifyEvent` maps and prose, defaults off | 45-56 | 1 (maps, comment), 3 (gates), 5 (prose) |
| Gating mirrors `sendScheduleEvent`, exempt from the three `require*` | 62-64 | 3 (`sendUsageEvent`, notify test) |
| Detector in `refreshNow`'s recording branch; armed by setter, no second `loadConfig` | 66-72 | 3 |
| Hit seen while off is recorded, not pushed | 74-77 | 2 (`hit seen while off…`), 3 (`checkbox off at hit, on later`) |
| Reading definition; `sameWindow` identity; null-stamp hit | 81-88 | 2 |
| Reset rule incl. null stamp; one window per account; observed not scheduled; staleness | 92-105 | 2 (`RESET_STALE_MS`) |
| Persisted ledger, tmp+rename, claim before send, machine-wide path, failed write still sends | 109-119 | 3 |
| Account key; empty profile → nothing; account switch deletes | 121-124 | 2, 3 |
| Push copy | 128-138 | Global Constraints + Task 2 `copy` |
| Tap-through: deepLink + App mapping + test | 142-145 | 4 |
| Settings rows, disabled logic, `showUsage` field | 149-162 | 1 (`usageAvailable`), 4 |
| Docs | 166-168 | 5 |
| Verification: mutation-proof, manual E2E not verifiable | 182-183 | 2 Step 4; PR text not in plan (acceptable — PR rules live in CLAUDE.md) |

Spec test list (175-178) → plan cases: hit (117), repeat hit / jitter (118), restart mid-window (170), reset by new `resetsAt` (119), reset by time
(120), unscoped hit then drop (123), new-window hit with reset pending (122), 99% (116), failed and null reads (125), hit while off (126), account switch
(129), ledger write failure (172), extra usage bodies (132-133), Settings disabled-state (199-201), `?view=usage` (198), late reading (131). None missing.

### 2. Values

Push titles/bodies at plan:28-31 match spec:132-137 character for character. Settings names, hints and both disabled notes at plan:32-35 match spec:153-158.
`RESET_STALE_MS`, event keys, tags and the ledger path are builder's calls the spec delegates (spec:172-174). I3 and I4 are the only value problems.

### 3. Reality

Exists (Modify): `shared/types.ts:968` (`NotifyEvent`), `:1066` (`notifyAvailable` on `ServerSettings`); `server/lib/settings.ts:57` (`DEFAULT_NOTIFY`),
`:65` (`NOTIFY_EVENTS`), `:162` (validator), `:242` (`getSettings`), `:265` (`setSettings`), `:373` (`resetSettings`); `server/lib/notify.ts:133,141`
(`PHRASE`, `TAGS`), `:72` (`shouldNotify`), `:154` (`setSender`), `:277` (`deskClickUrl`), `:302` (`routeTo`), `:354` (`deliver`), `:419`
(`sendScheduleEvent`); `server/api.ts:622-629` (`settingsBody`); `server/lib/usage.ts:334-363` (branch), `:347` (`recordTick`); `server/index.ts:526`;
`server/lib/usage-history.ts:96` (`sameWindow(a: string | null, b: string | null)`), `:717` (`SAMPLE_INTERVAL_MS`); `server/lib/account.ts:103`
(`readAccountProfile(homeDir?)`), `shared/types.ts:777` (`extraUsage`); `server/lib/schedule-notify.ts:76-82` (tmp + `renameSync`);
`server/lib/usage-ledger.ts` (the unrelated ledger, as plan:106 says); `client/src/lib/deepLink.ts:31-42`; `client/src/App.tsx:45-56`;
`client/src/components/settings/SettingsView.tsx:39-46, 221-230`; `client/src/lib/sections.ts:11` (`Section` already has `'usage'`); `test/run-all.ts:154`
(`runScheduleNotify`); all nine named test files; all four docs. `withServer(envBody, …)` (`test/api-harness.ts:119`) takes an env string, so
`SHOW_USAGE=` per case (plan:72) is possible.

Absent (Create): `server/lib/usage-alerts.ts`, `test/usage-alerts.test.ts`, `test/notify-rows.test.ts`, `client/src/lib/notifyRows.ts`.

`App.tsx:61-65`'s `takeDeepLinkTab` effect only acts on `'git'` and `'schedules'`, so a `'usage'` view falls through harmlessly — plan:203's one-line change
to the initializer is sufficient.

### 4. Interfaces

Task 3 consumes `decideUsageAlert`, `usageAlertCopy`, `UsageReading`, `UsageAlertLedger` (Task 2, same spelling); `getSettings`, `readAccountProfile`
(existing). Task 4 consumes `usageAvailable` (Task 1), `recordUsageHistory`, `notifyAvailable` (existing). `sendUsageEvent`'s `kind` is a `NotifyEvent`
member after Task 1. Only I3 (`now`) and the `usageCanSend` type (Minor) mismatch.

### 5. Order

1 → 2 → 3 → 4 → 5; no backward dependency. Task 2 is pure and does not need Task 1. No migrations or other plans are prerequisites.

### 6. Tests

Every Task 2 case fails before the module exists; Task 3 cases fail without `onUsageReading`/`sendUsageEvent`; Task 4 cases fail on `readViewParam`'s
whitelist and the missing helper. They pin behaviour (push or not, ledger shape) rather than internals. Review Focus 1, 3, 5 map to Task 2 cases; 2 and 4
map to Task 3 cases, with the proof weakness noted in the first Minor item.

### 7. Conventions

Plan:16-17 promises behaviour, signatures, values and cases but no literal code — held throughout. Wrap width ≤ 160 — held. CLAUDE.md rules on deps,
`import type`, `.js` suffix, types-first, no CSS literals, no local full `pnpm test` — all restated at plan:21-37 and not contradicted anywhere.
