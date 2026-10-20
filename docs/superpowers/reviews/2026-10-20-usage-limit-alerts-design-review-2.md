# Review 2 — Usage-limit alerts design

Document: `docs/superpowers/specs/2026-10-20-usage-limit-alerts-design.md` (at `505926c`, "docs: address spec review 1"). Reviewer: fresh Fable
session, 2026-10-20. Code read in `claude-agents-dashboard` at `70ee0be` (this checkout's base; `.claude/CLAUDE.md` identical). Lookout's push spec read
at `~/Documents/custom-projects/lookout` (`7bd126a`, PR #24 merged). Every claim below was checked against the files cited; the document's own
description of the code was not trusted.

## Verdict: APPROVE WITH FIXES

Review 1's Critical and all eight Important findings are resolved in this revision — window identity by `sameWindow`, the drop-below-100 requirement,
the "reading" definition, the `showUsage` gate, the hook point in `refreshNow`, the machine-wide ledger, account scoping and the exact Settings copy all
check out against the code. What remains is five Important edge-case / ambiguity gaps, all in the detector and ledger rules, none of which changes the
design's shape. No Critical.

## Important

### I1 — a null-stamp hit can never reset and silences every later unscoped hit (spec:69-74)

The spec stores an unscoped hit "with a null stamp" (spec:70) and defines a reset as "utilization below 100 **and either** its `resetsAt` is not
`sameWindow` as the alerted stamp **or** the alerted stamp has passed" (spec:71-72). With a null alerted stamp neither clause can ever hold for a later
unscoped reading: `sameWindow(null, null)` is `true` (`server/lib/usage-history.ts:97`, `if (a === b) return true`), and a null stamp has no time to
"pass". So an unscoped hit followed by unscoped readings at 3% stays pending forever. Worse, the hit rule "≥ 100 for a window not yet alerted" (spec:69)
then treats every later unscoped window as the already-alerted one — one *limit reached* ever, until a scoped reading happens to arrive. Only a scoped
reading below 100 breaks the lock (`sameWindow(null, scoped)` is false, `usage-history.ts:98`).

The corroboration clause is also redundant on the scoped path: utilization is monotonic inside a window (`server/lib/usage.ts:331-332`, "verified
monotonic"), and the recorder's own classifier calls any drop a `reset` with no stamp check (`usage-history.ts:187-188`). The stamp clause therefore only
ever *blocks*, and the one case it blocks is the null one.

Fix: either (a) for a null alerted stamp, the drop below 100 alone is the reset — mirror `classifyInterval`'s drop rule and cite it — or (b) record the
hit time beside the stamp and let the staleness cut-off (spec:84-85) expire a null-stamp record. Add "unscoped hit, then unscoped 3%" to the test list at
spec:154.

### I2 — a hit on a new window while a reset is still pending is unspecified (spec:69, 71-74, 93-96)

Server down across a whole window, or the user asleep: the first reading after a pending reset for W1 can be a *different* window already at 100%. Under
the rules as written the reset clause fails (not below 100), the hit clause fires for W2, and the spec says the ledger holds "the first-seen stamp of the
alerted window" (spec:70, singular). Whether W1's pending reset is dropped silently, sent now (the window is demonstrably over), or sent when W2 later
drops below 100 (which would then describe W2's reset as W1's) is the implementer's guess, and the mutation-proof rule "no reset without a hit"
(spec:159) does not settle it.

Fix: one sentence in §Once per window: the ledger holds one window; a hit on a different window replaces it and the earlier pending reset is dropped
(a *limit reached* already says the previous window ended). Add the case to spec:154.

### I3 — ledger write failure: does the push go out when the claim cannot be written? (spec:99-101)

"a dashboard **claims** a push by recording it in the ledger *before* sending: re-read, check, write, then send" — the write can fail (`~/.claude`
unwritable, disk full, mid-rename race), and the spec names the failure of neither the directory creation nor the write. The model it cites,
`notified.json`, swallows the failure and keeps the in-memory claim, so the push still goes and only a restart can repeat it
(`server/lib/schedule-notify.ts:76-85`, "the in-memory set still dedupes this process; only a restart could resend"). The anti-goals (spec:38-41) argue
for the same choice here, but "write, then send" reads as a precondition.

Fix: state it: a failed write keeps the in-process claim and the push is still sent; at most one repeat after a restart, as for `notified.json`.

### I4 — a hit seen while the event is declined: recorded as alerted, or not? (spec:16-17, 69, 93)

Goals say "one push the first time a 5-hour window is seen at 100%" (spec:16); the detector says "a reading of ≥ 100 for a window not yet **alerted**"
(spec:69); the ledger records "which window was alerted" (spec:93). If the *Usage limit reached* checkbox, the master switch or `NTFY_TOPIC` is off when the
hit is first seen and the user enables it ten minutes later with the window still at 100%, the first reading says "already seen", the second and third
say "not yet alerted → push". The schedule ledger took a position on exactly this (`schedule-notify.ts:98-99`: marked seen when first sighted *even if the
policy then declines it*, so enabling the switch later does not flood). The spec's reset rule (spec:17, "only after a *limit reached* push went out")
also depends on which it is.

Fix: pick one and say it. Recommended, matching `notified.json`: a hit seen while declined is recorded as seen without a push, and no reset follows it.

### I5 — the detector needs `Config`, and `usage.ts` has none (spec:60-65)

The detector lives in `refreshNow`'s recording branch and gates on `config.showUsage` (spec:61), publishes through `notify.ts` (which takes a `Config`:
`server/lib/notify.ts:419`, `sendScheduleEvent(event, config)`) and builds a `publicUrl` link. `server/lib/usage.ts` imports no config
(`usage.ts:17-29`), `refreshNow(force)` takes none (`usage.ts:300`), and its callers `getCachedUsageState()` / `refreshUsageNow()` pass none
(`usage.ts:430-442`). The spec does not say how the config reaches the detector, and the tempting shortcut — a second `loadConfig()` inside the lib — is
the failure `push-notify.md` §"a `.env` edited after startup" documents.

Fix: one line: the config is armed once from `server/index.ts` beside `startUsageRecording` (`server/index.ts:526`), through a setter in the style of
`setSender` / `setForecastProfile`; never a second `loadConfig()`.

## Minor

- **M1 (spec:114 vs 117)** — `Resets at 14:30.` versus `Resets Tue 09:10.`: the weekday form drops "at". Make it one form (`Resets Tue at 09:10.`
  or drop "at" from both).
- **M2 (spec:137-139)** — when both disable reasons hold (`SHOW_USAGE=false` and recording off) the replacement hint is unspecified; say which wins
  (`showUsage` first is the natural order — it is the outer gate). Also say the row keeps its normal hint when `pushUnconfigured` (the existing rows do:
  `client/src/components/settings/SettingsView.tsx:208-212` shows the callout instead).
- **M3 (spec:140)** — "If the client cannot see `showUsage` today": it cannot. No field in `shared/types.ts` carries it; `server/api.ts:202` and `:982`
  merely omit `usage` / `usageStatus` when it is off. State the fact so the builder does not spend a round looking.
- **M4 (spec:63-65)** — the recording branch of `refreshNow` runs for a cycle the gate already abandoned as stalled (`usage.ts:334-362` sit before the
  `mine === cycleSeq` ownership check at `usage.ts:389`), so the detector can see a reading older than the one it saw last. Harmless under the current rules
  (a stale 100% of the alerted window is "already alerted"; a stale sub-100 of the *previous* window needs a pending reset for a window that was hit after
  it, which the 45 s stall and the request timeout make unreachable), but worth a sentence: the detector ignores a reading whose time precedes the ledger's
  last-seen time, or runs only when `mine === cycleSeq`.
- **M5 (spec:123-125)** — the prose that enumerates the views also needs the new one: `client/src/lib/deepLink.ts:2`, `:13-17`, `:59` and the
  `App.tsx:45-46` comment. Add them to the docs list or to the Tap-through bullet.
- **M6 (spec:84-85)** — "recording toggled off across the reset" is the same situation as "server was down across the reset" (no readings, then one);
  say the staleness cut-off covers both.
- **M7 (spec:99)** — `scheduleStateRoot` honours a `SCHEDULES_STATE_ROOT` override (`server/lib/schedule-config.ts:52-55`); "beside `~/.claude/schedules`"
  is the default only. Either say "beside the schedules state root" or pin the ledger to `~/.claude/` independently of that override — the two-servers
  argument (spec:97-98) wants a path no per-checkout `.env` can move.
- **M8 (spec:147)** — the usage doc that owns the recorder is `docs/subsystems/usage-limits.md` (`:119`, `:297`); name it instead of "if it lists".
- **M9 (spec:154)** — the test list is missing the cases I1–I4 add (unscoped hit then unscoped drop; new-window hit with a reset pending; ledger write
  failure; hit seen while the event is off; account switch deletes the pending record — the last is specified at spec:105 but not listed).

## Verified true (no finding)

- Lookout §10 leaves "usage at N%" and "limit reached" to the dashboard with `Click` on its usage page
  (`lookout/docs/superpowers/specs/2026-10-20-lookout-push-notifications-design.md:284-287`); PR #24 is merged (`7bd126a`). spec:3, :24.
- 60 s cache (`usage.ts:44`), recorder tick per `SAMPLE_INTERVAL_MS` = 60 s (`usage-history.ts:717`, `:848-853`), recording default off
  (`settings.ts:68`), on on this machine (`.dashboard-settings.json`), started only under `config.showUsage` (`server/index.ts:526`), Lookout's
  hub poll calls `getCachedUsageState` (`hub-widgets.ts:80`). spec:45-48.
- "Reading" = the recorder's own test (`usage.ts:336`); `toRateLimit` yields nulls (`usage.ts:164-170`); `mapUsage` accepts a body with one window
  (`usage.ts:181`). spec:65-67.
- `sameWindow` with 120 s slack, scoped ⇄ unscoped a real change (`usage-history.ts:93-103`). spec:69-70.
- `sendScheduleEvent`'s gating and exemptions (`notify.ts:419-425`); `deliver` fire-and-forget (`notify.ts:354-356`, `:429`); desk routing via `routeTo`
  (`notify.ts:302-312`); `deskClickUrl` = `/api/dismiss` (`notify.ts:277-279`); no link without `publicUrl` (`notify.ts:252`, `:258`). spec:60-62, :96, :123-126.
- `notified.json` written tmp + `renameSync` (`schedule-notify.ts:80-82`). spec:94.
- `.dashboard-settings.json` is cwd-relative (`settings.ts:39`, `:102`). spec:97-98.
- `readAccountProfile` returns `null` or a profile whose `email` may be `''` (`account.ts:75-88`, `:103-125`); `extraUsage` = `hasExtraUsageEnabled`
  (`shared/types.ts:777`, `account.ts:88`). spec:22, :103-104.
- `NotifyEvent`'s "four session events" comment (`shared/types.ts:967`), `PHRASE` / `TAGS` as `Record<NotifyEvent, …>` (`notify.ts:133-147`),
  `NOTIFY_EVENTS` and defaults (`settings.ts:59`, `:65`), push-notify.md "fifth member" (`:259`). spec:53-55.
- `DeepLinkView` / `readViewParam` whitelist (`deepLink.ts:32`, `:38`); `App.tsx:53` mapping verbatim; `test/deep-link.test.ts:44-45` has the `?view=git`
  case. spec:123-125.
- Settings: group "Push notifications" under "Settings · Shared" (`SettingsView.tsx:176`, `:188`); *Scheduled job failed* is last with the "Ignores the
  three conditions below." sentence (`:45`); `pushUnconfigured` (`:101`); *Record usage history* under *Usage forecast* (`:435-437`); `SettingsRow` has no
  link affordance (`SettingsRow.tsx:10-25`). spec:19, :130-139.
- `pnpm dev` restarts the server on edit (`package.json:7`, `tsx watch`). spec:38.
- Docs named exist: push-notify.md §"The fifth event" (`:257`), push-notify-setup.md §"Which events need which hook" (`:90-100`). spec:145-146.
- CLAUDE.md hard rules: `shared/types.ts` first (spec:53), no new dep and no new outbound kind (spec:51-52; `test/outbound.test.ts:68-69` pins
  `usage.ts` to `node:http`/`node:https`, which a relative import of `notify.js` does not disturb), measured figure dated inline (spec:47). Respected.
