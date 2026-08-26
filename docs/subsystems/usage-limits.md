# Usage limits (header bars)

The header shows two mini progress bars — **5h** and **Week** — the same account
rate-limit utilization Claude Code's `/usage` reports. Unlike everything else in the app,
these are **not on disk**: `lib/usage.ts` fetches them live from Anthropic using your
local credentials. Under each bar sits a **time strip** (`lib/usage-pace.ts` +
`client/src/lib/pace.ts`) that answers the question a bare percentage can't: *at this
pace, do I run dry before the window resets?*

## Mechanism

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`, headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`. **Private/undocumented** — may change between CLI
  versions. **Always hits api.anthropic.com** — first-party account API; must NOT follow
  `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_API_BASE_URL` (those aim model inference at a
  proxy/gateway — Bedrock/Vertex/Ollama/LiteLLM — with no such route; that misroute
  returned `null` bars in practice). `CLAUDE_USAGE_BASE_URL` overrides for tests only;
  the request is protocol-aware (http vs https).
- **Response shape:** windows are **top-level**
  (`{ five_hour:{utilization,resets_at}, seven_day:{…}, … }`), *not* wrapped in
  `rate_limits`. `mapUsage()` accepts both shapes defensively and is the one pure/
  unit-tested piece (`test/usage.test.ts`).
- **Token:** read from the macOS keychain
  (`security find-generic-password -s "Claude Code-credentials"`), falling back to
  `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`. Expired tokens are
  skipped. ⚠️ The first keychain read by the dashboard process triggers a macOS GUI
  prompt — approve once with **"Always Allow"**. In Docker the keychain isn't reachable;
  pass the blob in as `CLAUDE_CREDENTIALS_JSON` instead — see
  [docker](../workflows/docker.md).
- **Caching:** `getCachedUsageState()` is **synchronous** — it returns the last value and
  fires a **non-blocking** background refresh when older than 60s. So the 3s
  `/api/sessions` poll never blocks on the network, and Anthropic is hit at most
  ~once/min. First load shows no bars until the first fetch lands (next poll picks it up).
- **Wiring:** `SessionsResponse.usage?: UsageLimits | null` (in `shared/types.ts`);
  attached in `api.ts` (both success and error branches) only when `config.showUsage`.
  Still **zero npm deps** — `https` + `child_process` are Node built-ins.
- **Status:** `SessionsResponse.usageStatus` says why bars are/aren't shown: `ok`,
  `token-expired` (stored token past expiresAt), `unavailable` (any other fail-open
  cause, incl. the endpoint's own 429 rate limit). The client renders bars only on `ok`;
  `token-expired` shows a plain "token expired" hint (no bars, no action).
- **Toggle:** `SHOW_USAGE=false` disables the feature entirely (no fetch, no keychain
  read). Default on.

## Pace + the time strip

**What the 5h window actually is.** It is a **fixed session window**, not a sliding one:
it anchors on the first message after an idle gap and fully resets to 0% at
`resets_at`. Spend does *not* age out token-by-token. Verified empirically on
2026-08-24: `resets_at` stayed at 23:50:00Z across fetches while utilization climbed
32 → 35 → 51, and 23:50 − 5h = 18:50 is exactly when transcripts show the first message
after a 1.5h idle gap. A sliding window would have pushed `resets_at` forward on every
fetch. The richer `limits[]` array in the same payload names this window `kind: "session"`.
This matters because the natural reading of "5h limit" — that you get a fraction back
each hour — is wrong, and the strip exists to make the real shape visible.

- **Sampling:** `lib/usage-pace.ts` keeps a RAM-only ring of `{t, utilization}` per window
  (cap 720 ≈ half a day at one sample/min), appended by `refreshNow()` on each successful
  fetch. No persistence — after a restart the pace fields are null for a few minutes.
- **Slope:** `computePace` is pure: least-recent → most-recent over a lookback window
  (5h: 30 min lookback / 5 min min-span; weekly: 6h / 30 min, since the weekly number
  moves in ~1% integer steps). Under the min span → `null`, and the header renders
  exactly as it did before. A non-positive slope reports `ratePerHour: 0` and no projection.
- **Window rolls** are handled twice over: `prunedSamples` drops anything older than the
  anchor (`resetsAt − window length`), and any utilization *drop* clears the history —
  otherwise a pre-reset 90% would poison the post-reset slope.
- **Contract:** `RateLimit` gained optional `ratePerHour` and `projectedExhaustAt`
  (both `number | null` / `string | null`). Optional on purpose — every consumer must
  survive their absence.
- **The strip** (`client/src/lib/pace.ts`, pure + unit-tested): a second thin track under
  the token bar whose axis is the window's *clock* — elapsed fill, a cyan `now` tick, and
  a red tick where the current pace projects 100%. Verdict on the right: `wall 1:37am ▮
  reset 1:50am` (red) when the projection lands before the reset, `lasts → 1:50am` (green)
  otherwise. The title attribute states the mechanics in words: window start, "fully
  resets to 0%", current burn.
- **`User-Agent`:** `requestHeaders()` sends `claude-code/…`. Without a claude-code UA the
  endpoint routes to an aggressively rate-limited bucket and answers persistent 429s
  ([anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930)).

⚠️ **Unproven:** the *weekly* window's length is assumed to be exactly 7 days
(`SEVEN_DAY_MS`), which is what its elapsed fill is drawn against. Anthropic doesn't
document the weekly reset mechanism and community reports conflict (some observed
72-hour intervals). The weekly **verdict** doesn't depend on this — it only compares
`projectedExhaustAt` to `resetsAt` — but the weekly strip's *position* would be wrong if
the window isn't 7 days. The 5h window is the verified one.

A **second** thing now depends on that assumption: the duty-cycle walk's horizon. It steps
from now to `resetsAt`, so if the weekly window is not 7 days the walk covers the wrong
span — too few hours (an over-pessimistic projection) or too many (an over-optimistic
one). It is also why the walk must tolerate a span of up to 168h slicing into **169**
entries, and why nothing may assume 168.

## Duty-cycle forecasting (the weekly window)

The strip above extrapolates one burn rate across every remaining hour. That is wrong
for the *weekly* window in a specific direction: a Friday-evening rate carried across the
weekend makes the week look like it blows up on Sunday morning. So the weekly projection
is a **forward walk** over a learned duty cycle instead of one division.

Two modules, split at a pure seam:

- **`lib/usage-forecast.ts`** — pure. `walkForward` steps local-hour slices from now to
  the reset, adding `activeRatePerHour × weight(hourOfWeek)` per slice, and returns the
  interpolated crossing, the time-weighted `dutyCycle` over the remaining window, and one
  `{tMs, gain}` step per slice. A flat weight of `1.0` collapses it back to *exactly* the
  old closed form — that is the regression floor, and a test pins it. The timezone is an
  injected `offsetMinutes` (production passes `localOffsetMinutes(now)`; tests pass 0), so
  every calendar edge is testable with no ambient `TZ`. **Accepted limitation:** the offset
  is taken once at `nowMs`, so a DST transition inside the window shifts the projection by
  an hour twice a year.
- **`lib/usage-history.ts`** — the 168 weights, learned from persisted samples of the
  **5h** window, plus its own I/O shell.

**Learn from the 5h window, predict the weekly one.** Only the 5h window is verified
monotonic (see the ⚠️ below), and it sweeps 0 → ~50% in five hours where the weekly crawls
in ~1% steps, so it is by far the better sensor. The 5h window's *own* projection is left
untouched: duty cycle inside five hours is ~1 by construction, and its 30-minute lookback
bounds any idle dilution to the first half hour after you resume work.

### Interval classification

Every consecutive pair of samples is classified, and the accounting follows from that:

| Condition | Kind | Accounting |
|---|---|---|
| `resetsAt` moved more than 2 min, or utilization fell by > 0.5 | `reset` | discarded |
| utilization rose by > 0.5, interval ≤ 5 min | `active` | `observedMin += mins`, `activeMin += mins` |
| utilization rose by > 0.5, interval > 5 min | `ambiguous` | discarded |
| otherwise (flat, **any** duration) | `idle` | `observedMin += mins`, `activeMin += 0` |

Three things here are counter-intuitive and each was gotten backwards once:

1. **A flat interval is a *measurement* of idleness, not missing data.** Utilization is
   cumulative within a window, so two samples bracketing a gap with the same window and
   the same utilization *prove* nothing was spent. "No data means unknown" would defeat
   the feature: the laptop sleeps at night, night is what the profile most needs to learn,
   and those buckets would never collect evidence. **An overnight flat interval is the
   single most valuable input this module gets** — it teaches eight buckets at once.
2. **Ambiguity is a function of duration, not direction.** Two samples a minute apart with
   utilization rising pin that activity to that minute, and that is the only way
   `activeMin` ever grows. Only a *long* rising interval is unattributable.
3. **Window identity is a parsed comparison with 2 minutes of slack, not string
   equality.** The endpoint recomputes `resets_at` per request: four consecutive real
   fetches of one unchanged 5h window returned `21:19:59.657311`, `21:20:00.387292`,
   `21:20:00.404859`, `21:20:00.508567`. Comparing the strings makes *every* interval a
   `reset`, so the profile learns nothing at all, and write-on-change degrades to
   write-always. Two minutes is far above the observed jitter and far below a real window
   change (+5h, or +7d).

A cell is **one hour of the week** — Monday 09:00 and Tuesday 09:00 are different cells,
and nothing is averaged across days. What accumulates across *weeks* is the evidence: a
cell gathers at most 60 minutes per week, so UI copy states evidence in weeks. Weights
fold once a week through an EWMA (`α = 0.3`, ~2-week half-life), and a bucket that goes
quiet **decays** rather than freezing — `observedWeeks` counts only the weeks we were
actually recording, so server downtime ages nothing while ordinary use with that hour idle
ages it normally. The fold happens **before** the decay: the pending accumulators belong to
the bucket's stamped week and the skipped weeks came after it.

### The rate is per *active* hour

`RateLimit.ratePerHour` for the weekly window is the lookback's utilization delta over the
active time the recorder **measured** (`setActiveTimeSource` → `observedActiveMs`), not the
wall slope. This is not cosmetic: once the recording timer feeds the pace ring around the
clock, the raw endpoint slope is idle-diluted, and the walk would then discount idle a
*second* time through the weights — a double discount that reads as a systematically
optimistic forecast, worst in the first hours after you resume work. With recording off
there is no measurement, the raw slope stands, and `dutyCycle` is 1, so the numbers are
exactly today's. A rise the recorder saw no active time for is a recording gap, so rate
and projection both go `null` rather than inventing a number.

Consequence for the client: `ratePerHour × 24` overstates the daily figure by
`1/dutyCycle`. `fmtRate` multiplies by `dutyCycle ?? 1` first.

### Storage, and the opt-in

- `.usage-history.jsonl` — append-only samples, write-on-change plus a 15-minute
  heartbeat (which doubles as the liveness marker separating downtime from quiet),
  trimmed to its newest half past 32 MB.
- `.usage-profile.json` — the learned profile, written atomically (tmp + rename) at most
  every 15 minutes. **This is the profile's source of truth, and the log is not a
  replayable substitute for it:** learning happens live at full one-minute resolution
  against the in-memory previous sample, whereas the sparser log would render a flat
  stretch ending in a rise as one long *ambiguous* interval and discard it.
- Both are gitignored, and both resolve from the **repo root, found by walking up for
  `package.json`** — deliberately *not* `settings.ts`'s `process.cwd()`. A settings file
  that resets when you start the server elsewhere is a nuisance; a history file that does
  is weeks of learning silently replaced by an empty one, with no error.
- Recording is **opt-in, default off** (`recordUsageHistory`, see
  [settings](./settings.md)). Switching it on makes the server call Anthropic about once a
  minute for as long as the process lives, with nobody necessarily watching — that should
  be a choice, not a surprise. The timer exists because sampling is otherwise
  request-driven: `getCachedUsageState` is only called by the `/api/sessions` handler, so
  with no browser open the recorded history would describe when the dashboard was
  *watched* rather than when work happened. It re-reads the setting on every tick, is
  `unref()`'d, and forces the refresh rather than going through the 60s cache TTL (at the
  same 60s the two alternate, and the recorder measured out at ~120s).

### The inspector

`GET /api/usage/profile` (read-only; `server/api.ts`'s `shapeUsageProfile` is the pure
part) returns the 168 cells, the fallback mean, the confidence, and the walk behind the
current projection — **never raw samples and never file paths**, the same posture as
`NTFY_TOPIC` never leaving the server. It re-runs the *same* `walkForward` that produced
the projection, so the inspector cannot drift from what it discloses.
`client/src/components/usage/UsageProfile.tsx` renders it in its own **Usage** rail
section (`UsageView.tsx`, own lazy chunk): 24 rows × 7 columns (the axis needing 24 slots
runs the direction a phone has — at 375px the whole week fits with no horizontal scroll), a
sequential one-hue ramp derived with `color-mix` so all five themes hold, texture rather
than a sixth colour step for no-evidence cells, a bare cell for a *measured* zero (never
working an hour is a different statement from working 15% of it), and a required table view
because the lowest ramp steps fall under 3:1 against the card surface. Cells are square
(`aspect-ratio: 1`), which is what makes the grid read as a calendar rather than a bar chart
on its side, and `max-width` on `.up-grid` is the single knob for the whole thing: `1fr`
columns plus square cells means width sets cell size and therefore height. Every hour row
carries its own label — labelling alternate rows put the only vertical rhythm cue at twice
the row pitch, so the eye chunked rows into pairs and read each pair boundary as a wider
gap (measured at DPR 2 the geometry was exactly even; the artefact was Gestalt, not layout).

Two things the grid alone cannot do:

- **Per-cell evidence rides on a real tooltip element, never the `title` attribute.**
  `title` needs a dwell, is drawn by browser chrome, and — the part that settles it — never
  fires on touch, so on the phone this dashboard is mostly read from it put the evidence
  out of reach entirely. The floating panel answers hover, press (`pointerenter` fires on
  touch-down, so press-and-hold inspects a cell) and keyboard focus; it is written with
  `textContent` plus `white-space: pre-line`, never `innerHTML`, and positioned by writing
  to the node directly rather than through state — re-rendering 168 cells to move one box
  would be absurd. It flips above the pointer near the bottom edge (a finger is usually low
  on the screen), hides on scroll when pointer-shown, and *follows* its mark when
  keyboard-shown, since tabbing to an off-screen cell scrolls it into view and hiding then
  would blank the tooltip the focus had just opened.
- **A status line says where the profile is up to** (`RecordingStatus`, over the pure
  helpers in `client/src/lib/usageProfile.ts`): hours observed of 168, total time recorded,
  and either how many hours carry a weight or which gate is still pending — the
  `TRUST_FLOOR_MIN` evidence floor, then the week roll-over that folds it. Without it the
  first week is 168 identical hatched cells with no sign that recording works, which reads
  as broken rather than as early. The grid stays honest either way (evidence is texture,
  never a colour step); this states in words what the texture cannot.

It is a section of its own rather than a block inside Analytics: that tab is about
*sessions* (the `/kaizen` report cards) and this is about the *account* — they share no
data, no endpoint and no cadence. The obvious next tenant is idea-5's
utilization-over-time charts, which read the same log this profile is learned from.

Confidence is `none` (no trusted buckets — the projection is the flat one) / `thin` /
`ok` (≥ 120 of 168 trusted, roughly two to three weeks of ordinary use). Below `ok` the
strip draws a **band** between the profile projection and the flat-1.0 pessimistic edge; a
single tick would claim precision the data does not have.

⚠️ **The forecast's accuracy is unproven.** Every pure function is tested and the
plumbing is verified, but the profile needs roughly two to three weeks of real samples
before `confidence` leaves `thin`, and no test substitutes for that.

## Invariants

- **Fail-open everywhere:** no token / expired / network error / non-2xx / unparseable →
  `usage: null` → the header simply omits the bars. Never throws into `scanSessions`
  (which stays pure).
- **We never refresh the token** — that would mutate your credentials. An expired token
  just hides the bars; the CLI renews its own token the next time it runs (on host use),
  and the next poll flips `usageStatus` back to `ok`. A "Sync" button that spawned
  `claude -p` to force-refresh was removed — too much machinery (CLI-spawn + Docker/PATH
  resolution) for a cosmetic header feature, and it could never work in Docker (no CLI in
  the container, `~/.claude` mounted read-only). See
  `backlog/tasks/done/task-1-remove-in-app-oauth-token-refresh.md` for the removed design + a
  platform-independent Docker approach to revisit **if** a future feature genuinely needs
  the dashboard to make its own authenticated Anthropic API call.

<!-- docs-sync:
  sources:
    - server/lib/usage.ts
    - server/lib/usage-pace.ts
    - server/lib/usage-forecast.ts
    - server/lib/usage-history.ts
    - client/src/lib/pace.ts
    - client/src/lib/usageProfile.ts
    - server/api.ts
    - client/src/components/Header.tsx
    - client/src/components/usage/
  kind: subsystem
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
