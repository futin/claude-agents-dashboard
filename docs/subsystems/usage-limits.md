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
  One cycle at a time (`refreshing`), but that flight is **abandonable**: `shouldRefresh()`
  lets the next call start its own cycle once the current one is past `REFRESH_STALL_MS`
  (45s), and only the newest cycle may write the cache. Without that, a request that hangs
  without ever getting a socket — `https` can only time out a socket it *has* — latched the
  guard permanently and froze `usageStatus` (seen live: a stale `token-expired` served for
  hours against a valid token, curable only by restarting the server).
- **Wiring:** `SessionsResponse.usage?: UsageLimits | null` (in `shared/types.ts`);
  attached in `api.ts` (both success and error branches) only when `config.showUsage`.
  Still **zero npm deps** — `https` + `child_process` are Node built-ins.
- **Status:** `SessionsResponse.usageStatus` says why bars are/aren't shown: `ok`,
  `token-expired` (stored token past expiresAt), `unavailable` (any other fail-open
  cause, incl. the endpoint's own 429 rate limit). The client renders bars only on `ok`;
  `token-expired` shows a plain "token expired" hint (no bars, no action).
- **Toggle:** `SHOW_USAGE=false` disables the feature entirely (no fetch, no keychain
  read). Default on.

### Automatic renewal (`lib/token-refresh.ts`)

A cycle that reads an **expired** token kicks off a background renewal and still returns
`token-expired` for that cycle; a later poll picks up the fresh token (the renewal zeroes
`cachedAt`, so the next poll refetches instead of serving a known-stale status for another
minute).

Two steps, cheapest first:

1. `claude auth status` — a local read, ~0.5s, costs nothing.
2. `claude -p ok --model haiku` — one cheap turn, only if step 1 did not renew.

**Success is a re-probe of the credential store, never an exit code.** `claude` exits 0 in
plenty of states that leave the token untouched — and `--bare` would exit 0 having never
read the keychain at all, so never add it here.

That rule also makes a hanging CLI harmless. Measured on macOS 2026-08-27: `claude -p`
*completed its turn* (the transcript shows the haiku reply) and then did not exit for 90s+
— identically with `--strict-mcp-config` and with `--no-session-persistence`, so it is not
MCP shutdown and no extra flag fixes it. Waiting on the **process** would therefore serve
`token-expired` for a minute after the **token** was already good, so `spawnWatching` polls
the credential store every `PROBE_POLL_MS` (2s) *while* the spawn runs and returns as soon
as it turns over, leaving the spawn to its own timeout. It races the spawn too, so a
fast, well-behaved CLI costs no extra wait.

The argv stays deliberately minimal — `-p ok --model haiku`, nothing newer. Flags that
buy nothing measurable would only add CLI-version coupling to the one path whose job is to
work when things are already broken.

`missing` is deliberately not covered. No spawn conjures credentials that were never
stored — that needs a login.

**Backoff** (`shouldAutoRefresh`, pure): 5 min after the first failure, doubling, capped at
an hour. The common failure is *structural* — logged out, no `claude` on PATH under a
launchd PATH, subscription lapsed — not transient, so a fixed retry would spawn a process
a minute forever against it. `cliMissing` (ENOENT on **both** steps) disables renewal for
the process lifetime: that is the Docker case, and there is nothing to wait for.

**The turn's transcript is filtered out.** It runs in `~/.claude/dashboard-refresh`, and
`scan.ts` drops any transcript whose cwd is that directory — otherwise the dashboard's own
plumbing shows up as a phantom session row.

**Kill switch:** `USAGE_AUTO_REFRESH=false` restores the old hint-only behaviour. It is a
kill switch rather than a feature flag because renewal spawns a process and may spend one
haiku turn; it is server-side, not a per-device UI toggle, for the same reason the usage
recorder is — the renewal happens inside the server's fetch cycle whether or not anyone
has the page open.

⚠️ **Unverified:** whether step 1 alone renews an expired token. It was measured fast and
harmless, but the token was valid at the time, so there was nothing to renew — step 2
exists precisely because that is unproven. Confirming it needs a genuinely expired token.

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

**The active basis and the learned weights are one unit — both are gated on
`confidenceOf(profile) !== 'none'`.** An active rate is a rate per hour *worked*, and only
the weights say how many of the remaining hours those are. `deriveProfile` weights every
hour `1.0` until a bucket clears the trust floor (the deliberate pessimistic default), so
pairing the two halves before the weights land projects an *always-on* week: observed on
2026-08-26 with 8.6 %/active-hour against a real duty cycle near 0.2 — 39% read as 100%
by that evening, five days before the reset. The wall slope needs no weights to be honest,
so at `none` it is what stands, `dutyCycle` is 1, and the strip is the documented
pre-forecast closed form for the whole first week. The recording-gap `null` above belongs
to the active basis too, and is gated with it.

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
  would be absurd. It rides beside the pointer at a *constant* offset — clamped against
  the side edges, but deliberately not vertically: a vertical clamp has an engage point,
  and crossing it reads as the panel drifting around the pointer mid-sweep (near the
  bottom edge the panel may instead lose its last lines, which is the accepted side of
  that trade). One coordinate trap: `.shell{zoom:var(--font-scale)}` means the panel's
  `position:fixed` left/top are *multiplied by the text scale*, while `clientX/Y` and
  `getBoundingClientRect` stay in visual viewport px — at scale 100% the spaces coincide
  and the bug is invisible, at 125% the panel lands 25% down-right of the pointer, an
  error that grows with page position. `placeTip` divides the visual coords by
  `--font-scale` before writing them. It hides on scroll when pointer-shown, and *follows* its mark when
  keyboard-shown, since tabbing to an off-screen cell scrolls it into view and hiding then
  would blank the tooltip the focus had just opened.
- **The forward walk is drawn as a cumulative climb to a 100% ceiling**
  (`WalkStrip` in the same file, over the pure geometry in
  `client/src/lib/walkChart.ts`). The walk carries four numbers per hour — the slice, the
  weight, the per-hour gain, and the running total — and the strip plots the *fourth*:
  the panel exists to answer "when does the weekly window hit 100%", and a curve puts that
  answer at an intersection instead of asking the reader to integrate 117 bars. Three
  things are load-bearing:
  - **Solid = measured, dashed = assumed, and the height is identical either way.** Not a
    reversal of the encoding, a split of it. The forecast genuinely counts an unlearned
    hour at `globalMean`, and that pessimistic edge is deliberate; only the ink says which
    hours are a measurement. This needs a per-step bit the walk did not carry, so
    `ForecastStep` gained `cum`, `weight` and `learned` — `learned` separately from
    `weight` because a measured `1.0` and a fallback `1.0` are the same number and
    different statements, and `cum` server-side because the response has no `utilization`
    to seed a client running-sum from and `exhaustAt` comes off the same partial sums.
    With `confidence: none` the whole line is dashed, which is the honest picture. A
    single `<polyline>` cannot be half dashed, so `splitRuns` cuts the walk into runs of
    equal `learned` with **adjacent runs sharing their boundary point** — otherwise the
    line has a one-hour hole at every encoding change.
  - **One `viewBox`, `preserveAspectRatio="none"`, `vector-effect: non-scaling-stroke`.**
    The strip used to be 118 flex children with fractional CSS widths, and the compositor
    rounded each one's two painted edges to device pixels independently — a ±1px swing
    between neighbours (25% of the bar width at 640px) that no CSS tuning can remove,
    because the rounding is per element. One coordinate space scaled uniformly removes it
    structurally. Labels are HTML overlays positioned by percentage, since
    `preserveAspectRatio="none"` stretches glyphs too. The y domain is fixed at
    `0 … 130%`, never auto-scaled to the endpoint: a week ending at 294.7% would squash
    the 100% rule into the bottom third, and everything above the ceiling is equally over.
  - **"Nothing to draw" is a sentence, not an unmounted section.** `walkAbsent` names
    which precondition failed — `recording-off`, `no-rate` (the RAM-only pace ring reads 0
    when idle, so this fires within minutes of going quiet), or `no-window` — and is
    `null` whenever the walk is non-empty. The old `walk.length > 0` render gate made the
    whole panel appear and disappear with no text saying why, which reads as a broken
    feature rather than as an idle account.
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

## Token value per model (the exchange rate, and its drift)

The bars say a percent was spent. Nothing said what a percent *is* — and the
planning question behind this feature is exactly that: "if 1% of Opus is ~900k
tokens for two weeks and suddenly becomes ~1.5M in week 3, I want to see it."
Anthropic never publishes the window budget, so the rate has to be **measured**,
and both halves are already on this machine: `.usage-history.jsonl` prices each
minute in percent, and the transcripts weigh it in tokens.

Design record: `docs/superpowers/specs/2026-08-28-model-token-rates-design.md`.

### No dollars, only ratios

API pricing survives here as **ratios between token types** and nothing else:
`in 1 · out 5 · cache-write 1.25 · cache-read 0.1` (`TYPE_WEIGHTS`). Those
ratios are uniform across current models, so one set suffices, and per-model
base-price differences are exactly what the fitted per-model rate absorbs.
Carrying absolute prices would double-count them and put a currency in a
product that shows none.

**Drift is judged on the weighted rate only.** Weighted tokens per percent are
mix-invariant *and* effort-invariant — thinking tokens are output tokens, so
raising effort from `high` to `xhigh` raises consumption and utilization
together and leaves the rate flat. The raw "1% ≈ N tokens" figure is a courtesy
translation at the model's recent mix; when raw moves and weighted did not, the
card says **mix shift**, never drift.

### The ledger (`lib/usage-ledger.ts`)

One line per tick to `.usage-ledger.jsonl` (repo root, gitignored, sibling of
the history log), written from the same fetch-success path that calls
`recordTick`, so a ledger line and a history sample describe the same instant.
Each tick reads only the bytes appended to each transcript since the last one
(a RAM map of per-file offsets over `listTranscripts`), sums `message.usage`
per model, and appends `{t, prevT, tok}`.

Five things are deliberate:

- **`prevT` is carried explicitly.** It is what makes a recording gap visible;
  a bare `t` could never show that two lines do not abut, and the fitter would
  bridge downtime silently.
- **A line is written every tick, even an empty one.** `tok: {}` is a *measured
  zero* — nothing was spent here this minute — and that is what separates "no
  local tokens" (another device burned the window) from "not recording".
- **Offsets only advance to a line boundary.** A transcript being written while
  we read it ends mid-line; re-reading that fragment next tick is the only way
  it is ever seen whole. A file shorter than its offset was rotated, so its
  cursor restarts at 0 and the window rule drops what it already covered.
- **Sidechain turns are counted**, unlike in `analyze.ts` — which skips them so
  a session's main-agent totals don't double against `bySubagent`. This ledger
  asks what the *account* spent, and a subagent turn spends like any other. Turn
  ids are remembered per file (a bounded ring) because the records of one turn
  share a `message.id` and each carries a copy of the same usage block.
- **The first tick after start writes nothing**, and switching recording off
  drops the offsets so switching it back on reseeds the same way. One lost
  minute, rather than a backlog dumped into a single interval.

### The fitter (`lib/usage-rate.ts`, pure)

`joinIntervals` pairs consecutive history samples — same window under the same
`sameWindow` slack, utilization not falling — and gathers the ledger's overlap
with each pair. Then each interval is classified:

| Condition | Kind | Used for |
|---|---|---|
| ledger covers < 80% of the span | `gap` | nothing — the server was down |
| `Δutil ≤ 0.01` | `idle` | nothing (but it is a measurement, not a hole) |
| weighted tokens < 5 000 | `external` | the disclosed burn share only |
| one model holds ≥ 90% of weighted tokens | `{model}` | that model's rate |
| otherwise | `mixed` | nothing |

**The join is overlap-weighted, and that was measured rather than chosen.** The
two logs sit on different grids: history samples are write-on-change, so an
interval starts and ends whenever utilization moved, while ledger ticks land
once a minute. Counting only the lines lying *wholly* inside an interval —
the obvious rule, and the one the plan specified — throws away up to a minute at
each edge, which is most of a short interval. Run against real logs it
classified **759 of 759** intervals as `gap`: the feature measured nothing at
all. Consecutive ticks tile the timeline, so summing *overlaps* instead recovers
the full duration whenever the recorder was up and falls short by exactly the
minutes it was not — which is what the coverage floor is meant to test. The two
edge ticks are split pro rata, which assumes uniform spend inside those two
minutes; that is the one approximation, it is bounded, and the alternative was
measuring nothing.

**Dominance, not decomposition.** With a handful of models and one equation per
interval, a least-squares split is under-determined exactly when it matters (two
models always used together), and a wrong split is indistinguishable from drift.
Mixed intervals are discarded; the follow-up is filed if the discard share
proves high.

**Pooled Σtokens / Σutil, not a mean of per-interval ratios.** A mean lets a
0.02% interval with a noisy numerator count as much as an hour of steady work.
Pooling weights each interval by the movement it explains, and the confidence
floors are what keep it robust — which is why a median was not needed.

**Baseline** is `[now−17d, now−3d)`; **current** is `[now−3d, …)`, open at the
top so an interval stamped a moment ahead of the request clock is not dropped at
the very edge the window watches. Floors: 30 intervals **and** 15 cumulative
percentage points for the baseline, 10 and 5 for the current window — both,
because either alone is fooled (200 intervals of 0.02% is a rounding error; one
interval covering 20% is a single unrepeated observation). Verdict order is
`thin` → `drift` (weighted deviation > ±20%) → `mix-shift` (raw > ±25%) →
`stable`, and **thin outranks everything**: a rate fitted on too little data can
deviate by any amount, so calling that drift would make the badge fire hardest
exactly when it knows least.

### The endpoint and the card

`GET /api/usage/rates` (`shapeUsageRates` is the pure part) returns one row per
model that owns at least one attributable interval, richest evidence first, plus
`externalSharePct`. Read-only, unpolled — it reads two files and does
arithmetic, and the numbers move on a scale of days — and it fails open to an
honest empty body exactly like `serveUsageProfile`. A model seen only in mixed,
external or gap intervals gets **no row**: a row of nulls reads as a broken fit
rather than as an absence of evidence.

The **Usage** section is now two sub-tabs — `Forecast | Token value` — through
the Settings page's `.set-seg` control, persisted per device as `usageTab`.
`UsageProfile` is a full week of hour cells and runs to about a screen, so
stacking would bury the shorter view; only the active sub-view mounts, which
also means each one's fetch-per-mount hook fires when its tab is opened rather
than on every visit to the section.

`UsageRates.tsx` leads each row with the **raw** figure (the number you plan
against) and judges with the **weighted** one, shows every rate beside its
evidence (windows + cumulative points), treats `collecting` as a first-class
state rather than an empty row, and discloses the external-burn share in a
footer pill because it is the one systematic bias in the measurement. Every
explanation is real text in the row — no `title` attributes, for the reason the
profile tooltip exists.

⚠️ **Drift detection itself is unproven.** Every pure function is tested and the
plumbing is verified end to end against live logs, but a `drift` or `stable`
verdict needs a 17-day baseline to exist at all, and nothing shorter than weeks
of real recording can confirm it fires when it should and stays quiet when it
should not. What *is* verified is that ledger lines accumulate once a minute,
that real intervals classify to a real model, and that every empty and thin
state is honest.

## Invariants

- **Fail-open everywhere:** no token / expired / network error / non-2xx / unparseable →
  `usage: null` → the header simply omits the bars. Never throws into `scanSessions`
  (which stays pure).
- **We never write credentials ourselves — we make the CLI do it.** Direct OAuth refresh
  is still rejected: undocumented endpoint, and taking a rotated refresh token and then
  dropping it can log the CLI out.
- **The token is renewed automatically** (see *Automatic renewal* above). What changed on
  2026-08-27 is the assumption the previous hint-only behaviour rested on — "the CLI
  renews its own token the next time it runs" — which is false in a desktop-only
  workflow. Measured that day: the keychain item had not been written for 10 hours while
  sessions ran all morning, `expiresAt` was 2h past, and the usage endpoint returned 401.
  Only a real `claude` CLI process writes `Claude Code-credentials`; Claude Code Desktop
  keeps its own store. Nothing renewed it, so "token expired" was permanent rather than
  self-healing, and the only cure was to run the CLI by hand. The earlier removal
  (`backlog/tasks/done/task-1-remove-in-app-oauth-token-refresh.md`) also rejected
  *auto*-refresh as "burning turns silently"; at one haiku turn per 8h, with a free
  `auth status` tried first, that cost is worth a header that heals itself.

<!-- docs-sync:
  sources:
    - server/lib/usage.ts
    - server/lib/usage-pace.ts
    - server/lib/usage-forecast.ts
    - server/lib/usage-history.ts
    - server/lib/usage-ledger.ts
    - server/lib/usage-rate.ts
    - server/lib/token-refresh.ts
    - client/src/lib/pace.ts
    - client/src/lib/usageProfile.ts
    - client/src/lib/walkChart.ts
    - client/src/lib/usageRatesFormat.ts
    - server/api.ts
    - client/src/components/Header.tsx
    - client/src/components/usage/
  kind: subsystem
  verified: 70148d40eb360339eef66e57925983ee3d446889
-->
