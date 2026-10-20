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

- **Usage is read only while something asks for it.** `server/lib/usage.ts` fetches on demand (60 s cache), and the one thing that asks with no page open is the
  usage recorder in `lib/usage-history.ts` (`startUsageRecording`, one refresh per `SAMPLE_INTERVAL_MS` = 60 s), which runs only while **Record usage
  history** is on (`recordUsageHistory`, default off; on on this machine as of 2026-10-20). The user chose: **alerts require recording on**. With recording
  off, both checkboxes are disabled with a note saying why, and no alert is evaluated or sent even if a page happens to be polling. **(user)** No new timer.
- The server stays at zero new runtime deps and makes no new kind of outbound call: the publish is the existing ntfy call in `lib/notify.ts`
  (`test/outbound.test.ts`).
- `shared/types.ts` first, then server, then client (repo rule). `NotifyEvent` gains two members; every `Record<NotifyEvent, …>` (`TAGS`, `NOTIFY_EVENTS`, the
  Settings event list, defaults) must cover them.
- Defaults off, like every event: the feature is opt-in.

## How it behaves

### Gating

Mirror `sendScheduleEvent`: master switch on, the event's own checkbox on, `NTFY_TOPIC` set — and **exempt from `requireAfk`, `requireRemoteAnswer` and
`requireAutoMode`**, which gate interactive sessions, not an account limit. Plus one gate of its own: `recordUsageHistory` on. **(user, via "both places" and
"need recording on")**

### Detecting *limit reached*

On each successful usage read (`status === 'ok'`), look at `fiveHour.utilization`. A reading of **≥ 100** for a window not yet alerted is a hit. A window is
identified by its `resetsAt` — the same identity `UsageHistoryWindow` already uses ("never an assumed 5-hour length"). A hit on a reading whose `resetsAt` is
null is still a hit; identity then falls back to the builder's choice (see *Left to the builder*). **(author's call)**

### Detecting *limit reset*

The alerted window is over when a successful reading shows **either** a `resetsAt` different from the alerted window's **or** utilization below 100 after the
alerted `resetsAt` has passed. Observed, not scheduled: the push says what a reading saw, never what a clock predicted, because a scheduled push would claim
a reset the dashboard never confirmed. **(author's call)** If the server was down across the reset, the first reading after it starts sends the reset push,
provided the hit is still on record and the reset is recent — the builder picks the staleness cut-off (a reset hours old is not worth a push).

### Once per window, across restarts

The state "which window was alerted, and was its reset sent" persists to a small file, written the way `schedule-notify.ts` writes `notified.json` (tmp file,
then `renameSync`). Losing the file costs at most one repeated *limit reached*; it must never produce a *limit reset* without a recorded hit.
**(author's call)**

**One ledger per machine, not per checkout.** Two dashboards can run with recording on at once — prod on 4173 and a worktree dev server, each with its own
cwd-relative `.dashboard-settings.json` — and both read the same account. A per-checkout file would push every hit and reset twice. So the ledger lives
machine-wide under `~/.claude/` (beside `scheduleStateRoot`'s `~/.claude/schedules`; exact path the builder's), and a dashboard **claims** a push by recording
it in the ledger *before* sending: re-read, check, write, then send. Two servers racing within the same second may still both send; that is accepted — the
60 s sample cadence makes it rare, and a lock would cost more than one duplicate. **(author's call, from the builder check)**

**A window belongs to an account.** The key is the signed-in account (`readAccountProfile().email`, `server/lib/account.ts`) plus `resetsAt`. A reading under a
different account than the alerted hit never counts as that hit's reset: an account switch drops the pending reset silently, and the new account's own hits
alert normally. **(author's call, from the builder check)**

### What the push says

No transcript content, as for every push (`docs/subsystems/push-notify.md` §What a push contains).

| Event | Title | Body |
| --- | --- | --- |
| limit reached | `5-hour limit reached` | `Resets at 14:30.` — plus ` Extra usage is on: you are now billed.` when `extraUsage` |
| limit reset | `5-hour limit reset` | `Usage is available again.` — or, when `extraUsage` is on at reset time, `Back on plan usage: extra-usage billing stops.` |

Time in the server's local zone, `HH:MM`, with the day added when the reset is not today. Wording and ntfy tags are the builder's to polish; the content above
is the contract. **(author's call)**

### Tap-through

- Phone: `<DASHBOARD_PUBLIC_URL>/?view=usage`. `client/src/lib/deepLink.ts` gains `usage` as a `DeepLinkView`, opening the Usage rail section. Without a
  public URL the push carries no link, as for every event.
- Desk: unchanged — `deskClickUrl` (`/api/dismiss`), like every desk push.

### Settings

Two rows in the event list in `SettingsView.tsx`, e.g. *Usage limit reached* / *Usage limit reset*, hints stating they ignore the three conditions below and
need **Record usage history**. With recording off the two rows are disabled and say so, linking or pointing to the recording switch. **(user: "checkboxes grey
out with a note saying why")**

## Docs to update in the same change

- `docs/subsystems/push-notify.md` — a section for the two usage events beside *The fifth event: `schedule-failed`*.
- `docs/workflows/push-notify-setup.md` — the *Which events need which hook* table: these two need no hook, they need Record usage history.
- `docs/subsystems/` usage doc that owns the recorder, if it lists the recorder's consumers.

## Left to the builder

- Where the detector hooks in: after each successful fetch in `usage.ts`, or inside the recorder's tick. Either is fine as long as every successful read is
  seen once and the recording gate holds.
- The state file's name, shape and the identity rule for a `resetsAt`-less window.
- The staleness cut-off for a reset seen late (server was down).
- Event key names (`usage-limit` / `usage-reset` or similar) and ntfy tags.
- Test shape: pure detector tests over sequences of readings (hit, repeat hit, restart mid-window, reset by new `resetsAt`, reset by time, 99% never alerts,
  failed reads in between, extra usage body), plus a Settings disabled-state check.

## Verification the user should expect

- Unit tests for the detector and the once-per-window ledger, mutation-proven for the "no reset without a hit" rule.
- A manual end-to-end is only possible when the account actually hits the 5-hour limit; the PR states that as not verified unless it happened.
