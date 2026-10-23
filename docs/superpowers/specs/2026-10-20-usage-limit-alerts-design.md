# Usage-limit alerts — design

Date: 2026-10-20. Origin: Lookout's push spec §10 (futin/lookout PR 24) left "usage at N%" and "limit reached" to the dashboard, to be decided from the usage
data it already reads and sent through its existing ntfy publish path, so a plain ntfy.sh user gets them too. Brainstormed 2026-10-20; every decision marked
**(user)** was answered by the user in that session, everything marked **(author's call)** was settled by the author and is open to change on review.

## Intent

The user runs agents unattended and walks away with only the phone. When the 5-hour window hits 100% the work stalls, and today nothing says so: the user finds
out on coming back. Then, once the window resets, there is again nothing to say agents can run, so the restart waits on the user remembering to look.

Two pushes close that gap: **limit reached** when the 5-hour window hits 100%, and **limit reset** when that window is over and usage is available again.

## Goals

- **limit reached** — one push the first time a 5-hour window is seen at 100%. **(user)**
- **limit reset** — one push when that same window has reset. Sent only after a *limit reached* push went out for it: a window that never hit 100% resets
  silently. **(user, scoping of "only after a hit" is the author's call)**
- Each is its own event with its own Settings checkbox, beside the existing five, in Settings → **Shared › Push notifications**. **(author's call)**
- Both route desk/phone exactly like the other events — the desk topic when at the keyboard, the phone topic when away — and both fire **at the desk too**.
  **(user)**
- Fires even when extra usage (paid overage, `AccountProfile.extraUsage`) is on, because then the moment of the hit is the moment billing starts; the body
  says so. **(user)**
- The phone push's tap opens the dashboard's Usage view. **(Lookout §10, kept)**
- Works for plain ntfy.sh users and for Lookout alike: it is a normal publish through `lib/notify.ts`'s transport, nothing Lookout-specific.

## Non-goals

- **No percentage warnings** ("usage at 80%"). The user said a heads-up before the limit would not change anything they do from the phone; only the hit and
  the reset matter. **(user)** This drops Lookout §10's "usage at N%" on purpose.
- **No weekly window.** 5-hour only. **(user)**
- No forecast-driven warning ("will hit before reset"). Offered, not wanted.
- No new background polling. See *Constraints*.
- No change to the Test push, to the four session events or to `schedule-failed`.

## Anti-goals

- A push repeated for the same window. A server restart (which `pnpm dev` does on every server edit) while the window sits at 100% must not send *limit
  reached* again, and must not lose a pending *limit reset*.
- A *limit reset* the user did not earn — e.g. after a restart, a reading with no record of a hit, or a window that only ever reached 99%.
- A push built from a failed or stale read. An expired token, a signed-out CLI or an unreachable endpoint is "no reading", never "0%".

## Constraints

- **Usage is read only while something asks for it.** `server/lib/usage.ts` fetches on demand (60 s cache). With no dashboard page open, the steady asker is
  the usage recorder in `lib/usage-history.ts` (`startUsageRecording`, one refresh per `SAMPLE_INTERVAL_MS` = 60 s), which ticks only while **Record usage
  history** is on (`recordUsageHistory`, default off; on on this machine as of 2026-10-20) — and is started at all only when `SHOW_USAGE` is on
  (`config.showUsage`, `server/index.ts`). Other readers exist (Lookout's hub widget poll calls `getCachedUsageState` via `lib/hub-widgets.ts`), but none is
  guaranteed. The user chose: **alerts require recording on**. With recording off — or `SHOW_USAGE` off — both rows are disabled with a note saying why,
  and no alert is evaluated or sent even if something else triggers a read. **(user; the `showUsage` gate from doc-review 1)** No new timer.
- The server stays at zero new runtime deps and makes no new kind of outbound call: the publish is the existing ntfy call in `lib/notify.ts`
  (`test/outbound.test.ts`).
- `shared/types.ts` first, then server, then client (repo rule). `NotifyEvent` gains two members; everything keyed by it must cover them — the
  `Record<NotifyEvent, …>` maps `TAGS` and `PHRASE` in `lib/notify.ts`, the `NOTIFY_EVENTS` list and defaults in `lib/settings.ts`, the Settings
  event list — and the prose that counts them (`NotifyEvent`'s "four session events" comment, push-notify.md's "fifth member").
- Defaults off, like every event: the feature is opt-in.

## How it behaves

### Gating

Mirror `sendScheduleEvent`: master switch on, the event's own checkbox on, `NTFY_TOPIC` set — and **exempt from `requireAfk`, `requireRemoteAnswer` and
`requireAutoMode`**, which gate interactive sessions, not an account limit. Plus two gates of its own: `config.showUsage` and `recordUsageHistory` both on.
**(user, via "both places" and "need recording on")**

The detector runs in exactly one place: the `recordUsageHistory` branch of `refreshNow` in `server/lib/usage.ts`, beside `recordTick`. Every successful fetch
passes there with the recording gate already applied, whoever triggered it. Not in the recorder's tick: that only fires a fire-and-forget `refresh()` and
never sees the result. **(doc-review 1)**

`usage.ts` has no `Config` today and `refreshNow`'s callers pass none. The detector's config (`showUsage`, the ntfy fields) is armed once through a setter
called from `server/index.ts` beside `startUsageRecording`; never a second `loadConfig()`. Unarmed (as in tests that do not arm it) means no alerts.
**(doc-review 2)**

**A hit seen while the push is off is recorded, not pushed.** The detector records every hit it sees whenever its own two gates hold, whatever the master
switch, the event checkbox or `NTFY_TOPIC` say; only the send is gated by those. So turning the checkbox on mid-window does not push the hit already seen, and
a window whose hit was not pushed gets no *limit reset* either — the same "marked seen when declined" rule as `notified.json`. **(doc-review 2, author's
call)**

### Detecting *limit reached*

A **reading** is a fetch with `status === 'ok'` **and** `fiveHour.utilization !== null` — the same test the recorder applies before `recordTick`
(`server/lib/usage.ts`, the `recordUsageHistory` branch of `refreshNow`). Anything else — a failed fetch, an expired token, an `ok` body with no 5-hour
utilization — is "no reading": it neither hits nor resets anything. `null < 100` must never count as a drop.

A reading of **≥ 100** for a window not yet alerted is a hit. A window is identified with `sameWindow()` (`server/lib/usage-history.ts`), **never string
equality**: the endpoint recomputes `resetsAt` on every fetch with sub-second jitter, and `sameWindow` gives two stamps 120 s of slack — the same rule that
groups `UsageHistoryWindow`. The ledger stores the first-seen stamp of the alerted window and compares later readings to it with `sameWindow`. A hit on a
reading whose `resetsAt` is null (an unscoped window) is still a hit, stored with a null stamp. **(author's call; identity rule from doc-review 1)**

### Detecting *limit reset*

The alerted window is over when a reading shows **utilization below 100** and **either** its `resetsAt` is not `sameWindow` as the alerted stamp **or** the
alerted stamp has passed. A changed stamp alone is never a reset — `sameWindow(null, scoped)` is false by design, so an unscoped hit followed by a scoped
reading still at 100% would otherwise reset falsely; the drop below 100 is required, the stamp is corroboration. For a **null** alerted stamp neither
corroboration exists (`sameWindow(null, null)` is true and a null stamp never passes), so there the drop below 100 alone is the reset — the same drop rule
`classifyInterval` uses. **(doc-review 2)**

**The ledger holds one window per account.** A ≥ 100 reading on a window that is not `sameWindow` as the recorded one, while that one's reset is still
pending, is a new hit: it replaces the record, and the earlier window's pending reset is dropped without a push (the user is limited again, so "usage is
available" would be false). **(doc-review 2, author's call)**

Observed, not scheduled: the push says what
a reading saw, never what a clock predicted, because a scheduled push would claim a reset the dashboard never confirmed. **(author's call)**
If the server was down across the reset, the first reading after it starts sends the reset push,
provided the hit is still on record and the reset is recent — the builder picks the staleness cut-off (a reset hours old is not worth a push).

### Once per window, across restarts

The state "which window was alerted, and was its reset sent" persists to a small file, written the way `schedule-notify.ts` writes `notified.json` (tmp file,
then `renameSync`). Losing the file costs at most one repeated *limit reached* and the pending *limit reset* of that window (a restart keeps both; a lost file
does not); it must never produce a *limit reset* without a recorded hit. A publish that fails after the claim is not retried, as for every existing event:
`deliver` is fire-and-forget. **(author's call; M2/M7 from doc-review 1)**

**One ledger per machine, not per checkout.** Two dashboards can run with recording on at once — prod on 4173 and a worktree dev server, each with its own
cwd-relative `.dashboard-settings.json` — and both read the same account. A per-checkout file would push every hit and reset twice. So the ledger lives
machine-wide under `~/.claude/` (beside `scheduleStateRoot`'s `~/.claude/schedules`; exact path the builder's), and a dashboard **claims** a push by recording
it in the ledger *before* sending: re-read, check, write, then send. Two servers racing within the same second may still both send; that is accepted — the
60 s sample cadence makes it rare, and a lock would cost more than one duplicate. **(author's call, from the builder check)** A failed ledger write keeps the
claim in process memory and the push is still sent, as `notified.json`'s `persist` does: the cost is at most one repeat after a restart. **(doc-review 2)**

**A window belongs to an account.** The key is the signed-in account (`readAccountProfile().email`, `server/lib/account.ts`) plus the window stamp. When the
profile is `null` or its email is `''`, no alert is evaluated at all — no key, no push. A reading under a different account than the alerted hit never counts
as that hit's reset: an account switch **deletes** the pending record without a push, so returning to the first account later cannot fire a stale reset; the
new account's own hits alert normally. **(author's call, from the builder check; empty-profile and delete rules from doc-review 1)**

### What the push says

No transcript content, as for every push (`docs/subsystems/push-notify.md` §What a push contains).

| Event | Title | Body |
| --- | --- | --- |
| limit reached | `5-hour limit reached` | `Resets at 14:30.` — plus ` Extra usage is on: you are now billed.` when `extraUsage` |
| limit reset | `5-hour limit reset` | `Usage is available again.` — or, when `extraUsage` is on at reset time, `Back on plan usage: extra-usage billing stops.` |

Time in the server's local zone, `HH:MM`; when the reset is not today, prefixed with the short weekday (`Resets Tue at 09:10.`). An unscoped hit (null stamp)
has
no time to give: its body is `No reset time reported.`, with the same extra-usage suffix. Wording and ntfy tags are the builder's to polish; the content above
is the contract. **(author's call)**

### Tap-through

- Phone: `<DASHBOARD_PUBLIC_URL>/?view=usage`. `client/src/lib/deepLink.ts` gains `usage` in both `DeepLinkView` and `readViewParam`'s whitelist, and
  `App.tsx`'s initial-section mapping (today `view === 'schedules' ? 'schedules' : 'management'`) gains `usage → 'usage'` — without that second change the
  link lands on Management. `test/deep-link.test.ts` gains the `?view=usage` case. Without a public URL the push carries no link, as for every event.
- Desk: unchanged — `deskClickUrl` (`/api/dismiss`), like every desk push.

### Settings

Two rows in the event list in `SettingsView.tsx`, after *Scheduled job failed*, verbatim:

| Name | Hint |
| --- | --- |
| `Usage limit reached` | `Your 5-hour usage window hit 100%. Ignores the three conditions below. Needs Record usage history (Usage forecast).` |
| `Usage limit reset` | `The 5-hour window you hit has reset. Ignores the three conditions below. Needs Record usage history (Usage forecast).` |

A row's control is disabled when `pushUnconfigured || !recordUsageHistory || !showUsage`. While disabled for recording (and push is configured), the hint is
replaced by `Turn on Record usage history under Usage forecast to use this.`; disabled for `showUsage`, by `Usage is hidden (SHOW_USAGE=false) on this
server.` When both hold, the `showUsage` note wins (it is the outer gate); when only `pushUnconfigured` holds, the row keeps its normal hint, as the existing
rows do. A plain text pointer, not a link: `SettingsRow` has no link affordance and the recording switch sits in another group. The client cannot see
`showUsage` today — no field in `shared/types.ts` carries it — so the builder adds one to the existing settings or health payload.
**(user: "checkboxes grey out with a note saying why"; copy from
doc-review 1, author's call)**

## Docs to update in the same change

- `docs/subsystems/push-notify.md` — a section for the two usage events beside *The fifth event: `schedule-failed`*.
- `docs/workflows/push-notify-setup.md` — the *Which events need which hook* table: these two need no hook, they need Record usage history.
- `docs/subsystems/usage-limits.md` — the recorder's doc: the recorder now also feeds the alert detector.

## Left to the builder

- The state file's name and shape.
- The staleness cut-off for a reset seen late (server was down).
- Event key names (`usage-limit` / `usage-reset` or similar) and ntfy tags.
- Test shape: pure detector tests over sequences of readings (hit, repeat hit, jittered stamps within 120 s, restart mid-window, reset by new `resetsAt`, reset
  by time, unscoped hit then unscoped drop, new-window hit with a reset pending, 99% never alerts, failed and null-utilization reads in between, hit seen
  while the event is off, account switch deletes the pending record, ledger write failure, extra usage bodies), plus a Settings disabled-state check and the
  `?view=usage` deep-link case. A reading older than the ledger's last-seen time is ignored (an abandoned fetch cycle can land late).

## Verification the user should expect

- Unit tests for the detector and the once-per-window ledger, mutation-proven for the "no reset without a hit" rule.
- A manual end-to-end is only possible when the account actually hits the 5-hour limit; the PR states that as not verified unless it happened.
