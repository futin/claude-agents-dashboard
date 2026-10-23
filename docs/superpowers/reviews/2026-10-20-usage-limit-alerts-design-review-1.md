# Review 1 — Usage-limit alerts design

Document: `docs/superpowers/specs/2026-10-20-usage-limit-alerts-design.md` (at `565d0a6`). Reviewer: fresh Fable session, 2026-10-20, code read in the
same checkout (identical to `claude-agents-dashboard` `main` at `70ee0be` plus the spec). Every claim below was checked against the files cited; the
document's own description of the code was not trusted.

## Verdict: REVISE

One Critical: the window-identity rule, as written, would ship a reached/reset push pair every minute. Eight Important, mostly missing edge cases and
unspecified copy. Nothing else in the design is in doubt — the intent, gating, ledger placement and docs list all check out against the code.

## Critical

### C1 — `resetsAt` identity by equality fires a false reset on every reading (spec:65-67, 71)

The spec identifies a window by its `resetsAt` and calls a reset "a `resetsAt` different from the alerted window's". The endpoint recomputes the stamp on
every request: `server/lib/usage-history.ts:80-93` records four consecutive fetches of one unchanged window returning stamps ~0.85 s apart, and says
outright that comparing the strings "would classify *every* interval as a `reset`". The recorder therefore compares with `sameWindow()`
(`usage-history.ts:96-103`, 120 s slack), and `UsageHistoryWindow` — the identity the spec says it is reusing — is built by `windowsOf`
(`server/lib/usage-history-series.ts:39-40`) through `classifyInterval`'s reset rule, i.e. the same slack. "Identity is the observed `resetsAt` only"
(`shared/types.ts:499`) means *not an assumed length*, not string equality.

Built as written: reading 1 at 100% → hit, alerted window = `21:19:59.657`. Reading 2, 60 s later, still 100%, stamp `21:20:00.387` → "different
`resetsAt`" → **limit reset** push; the "new" window is at 100% and not yet alerted → **limit reached** push. Repeats every sample until the real reset.

Fix: define identity as `sameWindow(alerted.resetsAt, reading.resetsAt)` (cite `usage-history.ts:96`) and store the first-seen stamp; the ledger key in
§Once per window (spec:88) is then "account + first-seen stamp, matched with `sameWindow`".

## Important

### I1 — "different `resetsAt`" alone is a reset even while utilization is still 100 (spec:67, 71)

Even with C1 fixed, the spec's own null-`resetsAt` hit (spec:67) breaks the rule: `sameWindow(null, '…')` is false by design (`usage-history.ts:98`,
"scoped ⇄ unscoped is a real change"), so the first scoped reading after an unscoped 100% hit is "different" → reset push at 100%, then a fresh hit.
Fix: a reset requires an observed utilization **below 100**; a `resetsAt` change is corroboration, not a trigger on its own. (Nothing is lost: a real
reset always shows < 100 on its first reading.)

### I2 — a `status === 'ok'` reading can carry null fields, and `null < 100` is true (spec:65, 71)

`mapUsage` returns a `UsageLimits` whenever *either* window is present (`server/lib/usage.ts:181-185`); `toRateLimit` yields `utilization: null,
resetsAt: null` for a missing or malformed `five_hour` (`usage.ts:164-170`). Such a cycle sets `status: 'ok'` (`usage.ts:380`). Under the spec's rules a
null utilization reads as "below 100" and a null `resetsAt` as "a different window" — a reset the user did not earn, which spec:40-41 lists as an anti-goal.
The recorder already skips exactly these readings (`usage.ts:336`). Fix: define "a successful reading" as `status === 'ok' && fiveHour.utilization !== null`;
everything else is "no reading".

### I3 — the recorder only runs when `SHOW_USAGE` is on; the spec's gate is incomplete (spec:45-48, 59-61, 112-114)

`startUsageRecording` is called only `if (config.showUsage)` (`server/index.ts:526`). With `SHOW_USAGE=false`, **Record usage history** can be on
(the row is unconditional, `client/src/components/settings/SettingsView.tsx:436-446`) yet nothing fetches, so the alert rows would read as enabled and
never fire. Separately, "the one thing that asks with no page open is the usage recorder" (spec:45) is not quite true: `getCachedUsageState` triggers a
refresh when stale (`usage.ts:439-441`) and Lookout's hub endpoint calls it (`server/lib/hub-widgets.ts:80`) — harmless for the design, since the
recording gate is the switch, but the sentence should not be built on. Fix: either gate the two rows (and their note) on `showUsage` as well, or state
that with `SHOW_USAGE=false` the alerts are off and say so in the hint.

### I4 — "inside the recorder's tick" is not a place that sees readings (spec:124)

The tick (`usage-history.ts:848-853`) only calls `refresh()` — `refreshUsageNow`, fire-and-forget — and never observes a result; the cache it could read
lags and would be seen more than once. The one place every successful read passes, with the recording gate already applied, is the
`getSettings().recordUsageHistory` branch of `refreshNow` (`usage.ts:335-358`, where `recordTick` is called). Fix: name that branch as the hook point and
drop the tick option.

### I5 — push body undefined for an unscoped hit; day format unspecified (spec:67, 98, 101)

spec:67 makes a null-`resetsAt` reading a hit; spec:98 says the body is `Resets at HH:MM.`, which needs a stamp. Spec:101 adds "the day" without saying
how (`tomorrow 02:30`? `Tue 02:30`?). Fix: give the unscoped body (e.g. `Reset time unknown.`) and one day form.

### I6 — ledger key when the profile is null or has no email; "drops" undefined (spec:88-90)

`shapeProfile` returns `null` when the record has neither name nor email (`server/lib/account.ts:75-81`) and `email: ''` when only a name is set
(`account.ts:80`). The spec keys the ledger on `readAccountProfile().email` and does not say what happens then. "An account switch drops the pending
reset silently" does not say whether the record is deleted or merely ignored: ignored, a return to the first account hours later still has the hit on
record and the staleness cut-off (spec:74, builder's) is the only thing standing between it and a stale reset push. Fix: define the key for a null/empty
profile (recommended: no alerts evaluated — no account, no window) and state that a switch deletes the pending record.

### I7 — Settings copy is "e.g."; the disabled note and its link are unspecified; `pushUnconfigured` not mentioned (spec:112-114)

Checklist item 4 wants exact user-facing copy. The existing rows are literal (`SettingsView.tsx:40-46`, hint style "Ignores the three conditions below.").
The spec gives row names as examples, no hint text, no note text, and "linking or pointing to the recording switch" — `SettingsRow` has no link affordance
and the recording row sits in a different group (**Usage forecast**, `SettingsView.tsx:436`). Every event row is also disabled on `pushUnconfigured`
(`SettingsView.tsx:226`); the new rows must be disabled on `pushUnconfigured || !recordUsageHistory`. Fix: write the two names, two hints and the
disabled note verbatim, say "pointing" (text), and state both disabled conditions.

### I8 — `usage` as a `DeepLinkView` lands on Management unless App's mapping changes too (spec:106)

`readViewParam` is a literal whitelist (`client/src/lib/deepLink.ts:35-42`) and `App.tsx:53` maps the view with `view === 'schedules' ? 'schedules' :
'management'`, with a tab mapping at `App.tsx:63-64`. Adding the member to the type alone routes `?view=usage` to Management. Fix: say `App.tsx`'s
section mapping gains `usage → 'usage'` (no tab) and `test/deep-link.test.ts:44-49` gains the `usage` case.

## Minor

- M1 (spec:51) — `NOTIFY_EVENTS` is a `readonly NotifyEvent[]` in `server/lib/settings.ts:65`, not a `Record`; the list omits `PHRASE`
  (`server/lib/notify.ts:133`, a `Record<NotifyEvent, string>` that must cover the members — a phrase of `''` is fine, but it must exist), the
  `NotifyEvent` doc comment "The four session events" (`shared/types.ts:967`) and the "fifth member" prose in `docs/subsystems/push-notify.md:257-259`.
- M2 (spec:78-79, 85) — publish failure is not addressed. `deliver` is fire-and-forget (`notify.ts:429`); a claimed hit whose POST failed is never
  retried, and its reset still goes out. That matches every existing event, but say so — checklist item 3 asks for the failure of each external call.
- M3 (spec:74) — abandoned fetch cycles still run the recording branch (`usage.ts:335-348` precedes the `mine === cycleSeq` guard at `:389`), so the
  detector can see readings slightly out of order. Harmless under monotonic rules; worth one of the listed detector test cases.
- M4 (spec:101) — "server's local zone": under `dev:docker` (`package.json:8`) that is the container's zone, and the phone's may differ anyway. Consider
  naming the zone in the body or accepting the mismatch explicitly.
- M5 (spec:98) — title style: session pushes title `Claude Code` (`notify.ts:398`), schedule pushes `<job> · <state>` (`server/lib/schedule-log.ts:338-347`).
  `5-hour limit reached` is a third style. Taste only.
- M6 (spec:84) — `scheduleStateRoot` honours a `SCHEDULES_STATE_ROOT` override (`server/lib/schedule-config.ts:52-56`), so "beside `~/.claude/schedules`"
  is only the default. The spec leaves the path to the builder, so this is wording.
- M7 (spec:17, 79) — "never produce a *limit reset* without a recorded hit" and "claims before sending" together mean a lost ledger file loses the pending
  reset too (spec:38-39 says it "must not lose a pending *limit reset*" on restart — true for a restart, not for a lost file). Reconcile the two sentences.

## Verified true (no finding)

- spec:3, 24 — Lookout §10 (`lookout/docs/superpowers/specs/2026-10-20-lookout-push-notifications-design.md:284-287`) defers "usage at N%" and "limit
  reached" to the dashboard, via its ntfy path, click at its usage page; `futin/lookout` PR 24 is merged under that title.
- spec:19, 34 — five existing rows (`SettingsView.tsx:40-46`), section **Settings · Shared › Push notifications** (`SettingsView.tsx:176, 188`).
- spec:22 — `AccountProfile.extraUsage` ← `hasExtraUsageEnabled` (`account.ts:88`, `shared/types.ts:777`).
- spec:38 — `pnpm dev` runs `tsx watch server/index.ts` (`package.json:7`).
- spec:45-47 — `CACHE_TTL_MS = 60_000` (`usage.ts:44`), `SAMPLE_INTERVAL_MS = 60_000` (`usage-history.ts:717`), `DEFAULT_RECORD_USAGE_HISTORY = false`
  (`settings.ts:68`), `"recordUsageHistory":true` in the prod checkout's `.dashboard-settings.json` on 2026-10-20.
- spec:49-50 — `test/outbound.test.ts:66-70` pins `notify.ts` → `node:https`, `usage.ts` → `node:http(s)`.
- spec:59-61 — `sendScheduleEvent` (`notify.ts:419-433`) checks `config.ntfyTopic`, zeroes the three requires, routes with `routeTo`; desk routing needs
  `NTFY_TOPIC_DESK` and falls back to the phone topic (`notify.ts:302-312`).
- spec:78 — `notified.json` written tmp + `renameSync` (`server/lib/schedule-notify.ts:80-82`).
- spec:82-83 — settings file is `path.join(process.cwd(), '.dashboard-settings.json')` (`settings.ts:39, 102`).
- spec:94, 118-120 — `push-notify.md` §What a push contains (:235), §The fifth event (:257); `push-notify-setup.md` §Which events need which hook (:90);
  `docs/subsystems/usage-limits.md` mentions the recorder (:119, :297).
- spec:106, 108 — no `Click` header without a public URL (`notify.ts:251-254, 330`); `deskClickUrl` → `/api/dismiss` (`notify.ts:277-278`).
- spec:51-53 — CLAUDE.md rules respected: types-first ordering, no new dep, no new outbound kind, defaults off.
