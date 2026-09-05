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
  `token-expired` (stored token past expiresAt), `signed-out` (the credential is present
  but blank — `claude auth logout` leaves it that way), `unavailable` (any other fail-open
  cause, incl. the endpoint's own 429 rate limit). The client renders bars only on `ok`;
  `token-expired` shows a plain "token expired" hint and `signed-out` shows
  "signed out — run claude auth login" (no bars, no action button — the dashboard cannot
  drive an interactive OAuth login). `unavailable` stays silent: most of what lands there
  (non-macOS host, denied keychain read, network) is not something the reader can act on.
  The mapping is `statusForToken()` in `lib/usage.ts`, and `pickTokenState()` resolves the
  three credential stores when they disagree (`ok` > `expired` > `signed-out` > `missing`;
  `expired` outranks `signed-out` so a blank blob in one store cannot suppress a token
  that renews itself in another).
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
| `resetsAt` moved more than 2 min, or utilization fell by > 0.5 | `reset` | discarded, **except** its provably-idle sub-span (below) |
| utilization rose by > 0.5, interval ≤ 5 min | `active` | `observedMin += mins`, `activeMin += mins` |
| utilization rose by > 0.5, interval > 5 min | `ambiguous` | discarded |
| otherwise (flat, **any** duration) | `idle` | `observedMin += mins`, `activeMin += 0` |

Three things here are counter-intuitive and each was gotten backwards once:

1. **A flat interval is a *measurement* of idleness, not missing data.** Utilization is
   cumulative within a window, so two samples bracketing a gap with the same window and
   the same utilization *prove* nothing was spent. "No data means unknown" would defeat
   the feature: the laptop sleeps at night, night is what the profile most needs to learn,
   and those buckets would never collect evidence. **An overnight sleep is the single most
   valuable input this module gets** — it teaches eight buckets at once. Note it usually
   arrives as a window *change* rather than a flat interval, because any sleep past five
   hours outlasts the window; see the sub-span rule below for what survives of it.
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

#### The provably-idle sub-span of a window change

A `reset` interval is not uniformly unattributable. Utilization is cumulative *within* one
window and says nothing across a boundary — but the **existence** of a window carries
across it: between the moment one window expires and the moment the next opens, no window
is open at all, and no window open means nothing was spent.

`provableIdleSpan(a, b)` returns that gap, and `accumulate` credits it as `idle`:

| Edge | Taken from |
|---|---|
| start | `a.resetsAt`, the old window's expiry — or `a.t` itself when `a.resetsAt` is null |
| end | `b.resetsAt − 5h`, the new window's derived opening — or `b.t` when `b.resetsAt` is null |

Both edges are then clamped into `[a.t, b.t]`, and nothing is credited unless the result
has positive length. That single clamp is what rejects clock skew, overlapping stamps, and
an unparseable stamp alike — `Math.max`/`Math.min` propagate `NaN` and every comparison
against it is false, so explicit NaN checks would be dead code.

Two things this deliberately does **not** do. A `resetsAt` of null alongside a non-zero
utilization is a sample contradicting itself, and a contradiction is not evidence — that
pair is discarded. And the remainder either side of the gap stays discarded: before the old
expiry tokens could have been spent and the counter that would have shown it has since
reset, and after the new window opened its own utilization is the only witness.

The 5h subtraction is the one assumption. The payload carries `resets_at` and nothing else,
so a window's *start* can only be derived — and the endpoint's own field name is
`five_hour`, which is what makes it safe. Watch one direction if that ever changes: a real
window **longer** than 5h puts the derived start too late and would credit idleness over a
stretch that did have a window open. A shorter one only under-credits, which is harmless.

Measured on the live log (915 samples, 140h) when this landed: 27 intervals and 151.5
minutes moved from `reset` to `idle`, 15.2% of all reset minutes. Most of it is short
window rollovers worth a minute each; the bulk of the value is the rarer overnight case,
where a single sleep contributed 70 minutes.

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
`in 1 · out 5 · cache-write 2.0 · cache-read 0.1` (`TYPE_WEIGHTS`). Per-model
base-price differences are exactly what the fitted per-model rate absorbs, so
carrying absolute prices would double-count them and put a currency in a
product that shows none.

Checked **2026-09-02** against
[the pricing page](https://platform.claude.com/docs/en/about-claude/pricing).
Two of those four numbers are not what a reader would assume:

- **Cache-write is the 1-hour tier (2.0x), not the 5-minute one (1.25x).** Both
  tiers exist; the ledger stores only the flat `cache_creation_input_tokens` and
  cannot tell them apart per line. Which one applies is therefore a measured
  fact about this machine, not a choice: over 7 days of transcripts, **99.96%**
  of cache-write tokens carried `cache_creation.ephemeral_1h_input_tokens`
  (100.00% for every model except `claude-opus-5` at 99.95%).
- **Cache-read is 0.1x for every model in play *except* Fable 5.1 and Mythos
  5.1, which price it at 0.025x** — a 4x difference the page states explicitly.
  That one exception is why the weights are no longer a single uniform set:
  `MODEL_TYPE_WEIGHT_OVERRIDES` in `usage-ledger.ts` carries per-model
  departures keyed by model-id **prefix**, matched longest-first so a dated
  snapshot id resolves to its own family and a shorter entry cannot swallow a
  longer one. `weightedTokens(tok, model)` applies them; called without a model
  it falls back to the uniform set, which is the unknown-model fallback and not
  a default any caller with an id in scope should take.

`in: 1` and `out: 5` were confirmed unchanged — every current model prices
output at exactly 5x its input.

**`pnpm check:weights` re-checks the part that can rot.** It re-reads the
transcripts, prints the 1h share and the blended cache-write multiplier per
model, and **exits 1** when any model with ≥ 1M cache-write tokens in the window
lands more than 0.05 away from the configured `cc`. It also warns for a model id
outside `CHECKED_MODEL_PREFIXES` — one whose ratios nobody has priced, being
weighted with the uniform set on assumption. The list price itself still has to
be re-read by a human; what the command removes is the need to re-derive the
*tier*.

**Drift is judged on the weighted rate only, and the card leads with it.**
Weighted tokens per percent are mix-invariant *and* effort-invariant — thinking
tokens are output tokens, so raising effort from `high` to `xhigh` raises
consumption and utilization together and leaves the rate flat. That invariance
is why the headline figure, its baseline and the deviation chip are all the
weighted rate. The raw "1% ≈ N tokens" figure is a courtesy translation at the
model's recent mix, kept as a labelled aside beneath the headline (`rawAsideText`
in `client/src/lib/usageRatesFormat.ts`, omitted entirely when there is no raw
rate); when raw moves and weighted did not, the card says **mix shift**, never
drift.

**No rate here is comparable across models.** Each is fitted from this machine's
own usage against a single ratio, so a model that fires more requests per token
carries that per-request window cost inside its token rate — the measured
opus:fable ratio of ~4.2x is that term plus whatever else, not a repricing
(`task-10` splits it out server-side). The card's subtitle says so in as many
words; leading with raw made the number read as a price list, which is `bug-13`.

**The ~4.2x is not a miss against a target.** The API list-price ratio between
fable-5 and opus-5 is exactly **2.00x** as of 2026-09-02 — on input, output,
both cache-write tiers and cache reads alike — but the 5-hour limit's own
per-model weighting is **not published anywhere**, so 2.00x was never something
the fit was obliged to reproduce. See *What the weights are, and are not* below.

### What the weights are, and are not

`TYPE_WEIGHTS` is an **API list-price proxy for an unknown weighting**. That
sentence is the whole of what this repo can honestly claim, and it settles the
questions `idea-17` opened:

- **Is the 5-hour window's per-model weighting published anywhere?** No. Neither
  the pricing page nor the models overview mentions subscription usage limits at
  all — they document API billing, which is a different mechanism. Fitting it
  from this machine's own logs is the only available source, so the fitted
  per-model rates are not a *check* on a published number; they are the
  measurement.
- **Is a measured 4.20 a defect or the answer?** With no published weighting to
  miss, it is the answer until something else explains it. Two candidate
  explanations have since been closed with numbers: a per-request term
  (`task-10`) and mis-set type weights (this doc, above). What would still
  distinguish a defect from a finding is a controlled single-model burn — one
  model, one window, nothing else running.
- **Do cache reads count toward the limit at the 0.1 ratio they are billed at?**
  Unknown, and unknowable from here for the same reason. 0.1 is the *billing*
  ratio, confirmed for opus-5, fable-5, sonnet-5 and haiku-4.5 — and 0.025 for
  Fable/Mythos 5.1. This is the single biggest lever on every number the Usage
  tab prints (97.2% of opus's raw tokens on live logs are cache reads), which
  is exactly why the constant is now sourced and dated rather than assumed.
  `bug-13`'s sensitivity sweep of that weight up to 1.0 was exploring a value no
  price list supports.
- **Should `TYPE_WEIGHTS` become a setting?** No. It is a published fact with a
  source and a date, not a preference — a knob would let an unchecked value
  silently override a checked one, and the resulting rates would carry no
  provenance at all. The mechanism a repricing needs is `pnpm check:weights`:
  re-verify the fact and edit the constant, rather than making it editable.

What is **not** claimed anywhere: that the 5-hour window charges cache writes at
2x, cache reads at 0.1x, or output at 5x *at all*. Those are API list prices
standing in for a weighting nobody outside Anthropic has seen. This makes the
proxy correct and traceable; it does not make it verified.

### The ledger (`lib/usage-ledger.ts`)

One line per tick to `.usage-ledger.jsonl` (repo root, gitignored, sibling of
the history log), written from the same fetch-success path that calls
`recordTick`, so a ledger line and a history sample describe the same instant.
Each tick reads only the bytes appended to each transcript since the last one
(a RAM map of per-file offsets over `listTranscripts`), sums `message.usage`
per model, and appends `{t, prevT, tok, req}` — `tok` weighed in tokens, `req`
counted in requests.

Six things are deliberate:

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
- **`req` is a parallel map, and absent is not zero.** One assistant message is
  one request, so the count is free — it is what `sumWindow` already discards
  after summing. It lives beside `tok` rather than as a fifth key inside it
  because it is not a token type: `weightedTokens` and `scaleCounts` must never
  see it, and per-model absence has to survive a parse that coerces every
  missing token *type* to 0. So `parseLedgerLine` deliberately does **not** run
  it through `num()`: a count that coerced to 0 would claim a measured zero on
  every line written before counts existed. Absent means *not recorded*, `{}`
  on a line with spend means recorded and nothing attributable, and a junk or
  negative count drops that model's key rather than the line.

### The fitter (`lib/usage-rate.ts`, pure)

`joinIntervals` pairs consecutive history samples — same window under the same
`sameWindow` slack, utilization not falling — and gathers the ledger's overlap
with each pair. Then each interval is classified:

| Condition | Kind | Used for |
|---|---|---|
| coverage < 80%, and the span ends at or before the provable start of recording | `pre-ledger` | nothing — but nothing is wrong: the ledger did not exist yet, and this ages out of every window on its own |
| coverage < 80% with **zero** milliseconds covered, after that start | `gap` | nothing — the recorder was down. The only one of the three that reports a fault |
| coverage < 80% with something covered | `partial` | nothing — the recorder ran but the tokens are incomplete, which is not the same as absent |
| `Δutil ≤ 0.01` | `idle` | nothing (but it is a measurement, not a hole) |
| weighted tokens < 5 000 | `external` | the disclosed burn share only |
| one model holds ≥ 90% of weighted tokens | `{model}` | that model's rate |
| otherwise | `mixed` | both joint fits — never a pooled rate |

The first three used to be one kind called `gap`, and splitting them was worth
doing because **92% of what it reported was a startup artifact**: measured over
the 17-day baseline, 752 intervals carrying 438.0 utilization points provably
predate the ledger, 8 intervals carrying 2.0 points are the recorder actually
being down, and 23 intervals carrying 32.0 points are under-covered spans. The
card's scariest number — nearly half of everything the 5-hour counter moved is
unpriced — was mostly the recorder not having existed yet.

All three go through `isUnpriced`, and **every consumer asks through that
predicate rather than naming a kind**. This is not tidiness: the two sites that
compared against `'gap'` literally behaved differently under the split.
`externalShare` fails closed (it names what it skips), but `usableForSplit`
fails *open* — it returns `kind !== 'gap' && kind !== 'external'`, so a kind
merely added beside `gap` would have walked straight into the two-term fit
carrying tokens that are missing by construction.

Every interval also carries `req` (requests per model) and `reqUsable`.
`reqUsable` is false when **any** contributing ledger line recorded no count
for a model it recorded spend for — one unrecorded line poisons the whole
interval's count, because a partial count fitted as if it were whole
understates the per-request term by an unknown amount. Token totals are
untouched either way, so an interval can be count-unusable and still fit the
pooled ratio exactly as it always did. A line with no `req` **and** no spend
poisons nothing: an event with no tokens is never recorded, so zero tokens is
zero requests.

#### The coverage breakdown — two measures, and why they are two

The card discloses two different things about recording, and conflating them
would be the whole bug over again:

- **`coverageBreakdown(intervals, since, until)`** counts *utilization points*
  per kind over the horizon: `priced`, `mixed`, `external`, `preLedger`, `gap`,
  `partial`, and `moved` as the sum of every non-`idle` bucket. Idle is in no
  bucket and out of `moved` for the same reason `externalShare` excludes it —
  it measures nothing moving, and putting it in the denominator would shrink
  every share by however long the machine sat quiet. The other six sum to
  `moved` exactly, so a reader can check the split themselves.
- **`ledgerBreakMs(ledger, since, until)`** sums the milliseconds between two
  consecutive ledger lines that do **not** abut. It takes the ledger rather
  than the intervals on purpose: the server that writes the ledger also writes
  the history log, so most of these breaks overlap no interval at all and the
  point buckets cannot see them. Live, the ledger has ~12.4 h of such breaks
  inside a baseline in which downtime cost 2.0 points — the hours say how much
  *time* went unrecorded, the points say what it *cost*. Publishing only the
  hours would read as 12.4 h of lost spend.

**The start of recording is the ledger's first line's `prevT`, guarded by file
size.** The first line covers `(prevT, t]`, so `prevT` is the instant before
which nothing was ever recorded — but only if no earlier line was ever trimmed
away. `rotateLedgerIfNeeded` trims to `floor(MAX_LEDGER_BYTES / 2)` and the file
then grows back toward the maximum, so a file *under* `LEDGER_UNROTATED_MAX_BYTES`
(exactly half the maximum, and asserted equal to it) has provably never
rotated. At or above it `ledgerStartMs` returns `null` and refuses to guess: the
`pre-ledger` kind then collapses into `gap`, the payload says
`startProvable: false`, and the card states outright that the start is unknown
rather than reporting downtime that never happened. An explicit start *marker*
line was rejected — it would be unparseable to every existing reader and would
say nothing about the data already on disk, which is the data that raised the
question. At the current ~85 bytes a line that is ~287 days of continuous
recording away, but the guard is not decoration: a heavy multi-model line is
several hundred bytes.

**An interval that straddles the start of recording is `gap`, not
`pre-ledger`** — the test is on `toT`, not `fromT`. Such an interval is not
provably unrecorded, so it classifies on its actual coverage. That overstates
the recorder-down bucket by at most one interval per install; testing `fromT`
instead would swallow a genuine hole that happens to abut the boundary, which
is the direction that hides a fault.

**Request counts are pro-rated at the edges as a float, exactly like tokens.**
A count is an integer event stream, so half a tick's requests is not a thing
that happened — but attributing a straddling tick's count whole to one side
would make the two regressors disagree about the same two edge minutes, and it
is their *ratio* the split fit measures. The fraction is unbiased under the
same uniform-spend assumption the tokens already make, and bounded by the same
two ticks per interval.

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

**Dominance, not decomposition — for the *rate*.** With a handful of models and
one equation per interval, a least-squares split of one interval is
under-determined exactly when it matters (two models always used together), and
a wrong split is indistinguishable from drift. So every number the drift
comparison rests on — `rawPerPct`, `weightedPerPct`, the baselines, the
deviation and the verdict — still comes from `DOMINANCE`-owned intervals only,
and `mixed` is discarded for them.

**`mixed` is discarded by no fit at all, though.** Both joint fits below — the
two-term split and the one-term rate — are joint across models, so they need no
ownership and read `mixed` too. That is where the information about telling two
models apart actually lives (on live logs, 50 of 58 `mixed` intervals contained
fable, against its 16 owned ones). `DOMINANCE` is therefore load-bearing for the
pooled rate and the drift verdict, and irrelevant to either joint fit.

**Pooled Σtokens / Σutil, not a mean of per-interval ratios.** A mean lets a
0.02% interval with a noisy numerator count as much as an hour of steady work.
Pooling weights each interval by the movement it explains, and the confidence
floors are what keep it robust — which is why a median was not needed.

**Baseline** is `[now−17d, now−3d)`; **current** is `[now−3d, …)`, open at the
top so an interval stamped a moment ahead of the request clock is not dropped at
the very edge the window watches. Floors: 30 intervals **and** 15 cumulative
percentage points **and 7 distinct UTC dates** for the baseline, 10 / 5 / 2 for
the current window — all three, because each alone is fooled (200 intervals of
0.02% is a rounding error; one interval covering 20% is a single unrepeated
observation; 60 intervals from one morning are a single day's habit wearing a
fortnight's clothes). The day floor counts **distinct dates**, not
`max(toT) − min(toT)`: a span is cleared by two clusters at either end of the
window with nothing in between, which is the same lie one day tells in a
different shape. 7 and 2 are the cheapest pair putting the measured day-to-day
dispersion of this machine's own rates (cv ≈ 24%, so a 1σ deviation error of
`√(cv²/7 + cv²/2)` ≈ 19.2%) under the 20% band, and 7 is half the baseline
window's width, so a verdict needs a baseline at least half-populated. Both day
counts are reported on the row whatever the verdict — `days` and
`baselineDays` — since with every baseline rate null they are the only thing
separating "no baseline yet" from "still forming". Verdict order is
`thin` → `drift` (weighted deviation > ±20%) → `mix-shift` (raw > ±25%) →
`stable`, and **thin outranks everything**: a rate fitted on too little data can
deviate by any amount, so calling that drift would make the badge fire hardest
exactly when it knows least.

### The two-term fit: tokens and requests, separated

The pooled ratio above is only a *price* if the 5-hour counter is charged purely
per token. It is not. Anything charged per request lands in the `dUtil`
denominator with no tokens beside it, so a single ratio has nowhere to put it
and hands all of it to the token term. Measured on live logs (2026-09-01), the
opus:fable cost per weighted token came out at 4.2-4.4x from two estimators with
different selection biases, where the API list-price ratio is 2.00x — `bug-13`
eliminated weighting, sample size and the `DOMINANCE` filter as explanations,
which left a missing term. The list price is a *reference point* for that gap,
not a target the fit is failing to hit: the limit's own weighting is unpublished
(below).

Correcting `cc` from 1.25 to 2.0 did not close the gap either. Recomputed over
the same 7 days, weighted totals rise 10.7% (opus-5) to 14.9% (fable-5) and the
opus:fable ratio of weighted-token totals moves **10.184 → 9.816** — 3.6%. With
`task-10` having refuted the per-request hypothesis and this refuting the
weighting one, whatever the residual is, it is neither.

`explainSplits` fits `dUtil` against **two** regressors per model — weighted
tokens (in millions) and request count — jointly over every usable interval, no
intercept. `fitSplits` is the same thing keeping only the models it will stand
behind. Five decisions carry it:

- **Which intervals.** `gap` is out (minutes are missing, so the tokens are
  not all there) and `external` is out (utilization moved on almost no local
  spend, which is another device — fitting it would price our models for
  someone else's turns). `mixed` is in, per above. **`idle` is in**, and that is
  the load-bearing one: utilization is read coarsely, so spend often lands in
  one interval and its visible rise in the next, and keeping only the intervals
  where utilization moved is selection on the dependent variable. It inflates
  every coefficient. The zeros are measurements — this document already says so
  — and including them is what makes the sum over intervals add back up.
- **Column order is load-bearing.** Every model's token column is offered to the
  solver first, then every model's request column. When the rank pass has to
  drop something it therefore drops a request column, so a model whose split
  cannot be identified still keeps a column with which to explain its own
  utilization instead of having that utilization pushed onto whichever models
  remain.
- **A rank-revealing solve, not normal equations.** Real designs here are
  *routinely* rank-deficient and it is not a pathology: a model used in a single
  interval contributes two columns spanning one dimension. Measured live, one
  such model (`claude-opus-4-8`, one interval) made the whole joint solve
  singular and every model reported no split. Modified Gram-Schmidt drops only
  the offending column — a column whose residual against the columns already
  accepted is under `SPLIT_RANK_TOL` (1e-3 of its own unit length) carries no
  information the fit does not already have — and every other model keeps its
  answer.
- **A cross-model conditioning floor, because neither other gate looks across
  models.** `SPLIT_MAX_R2` compares a model's own two columns and says nothing
  about model A's tokens against model B's; `SPLIT_RANK_TOL` is the *numerical*
  floor the solve needs, and a residual of 1e-3 is r² ≈ 0.999999, so it only
  fires on columns collinear to six decimal places. Between them lies a wide
  band where the solve is severely ill-conditioned, nothing fires, and every
  model is published `fitted`. Measured at r²(A_tok, B_tok) = 0.99998, two
  models generated from 0.500 and 1.200 pt/Mtok came back 0.66 and 1.00 — the
  cross-model ratio wrong by 1.6x, which is exactly the comparison this feature
  exists to make. So `SPLIT_MIN_INDEPENDENT_SHARE` (0.1, the same variance
  inflation of 100 the r² ceiling encodes) refuses any model whose least
  independent column survives less than a tenth of itself once **every other**
  column is projected out. Symmetric on purpose: measured only against the
  columns offered earlier, the *first* of a collinear pair is published while
  only the second is caught — and if the second is dropped from the solve
  instead, the first silently absorbs its utilization and is published further
  from the truth than before. `SplitDiagnostic.independentShare` reports it. On
  this machine's real data every model sits at 0.22-0.999, so the floor is not
  live today; it is the guard `DOMINANCE` provides for the pooled rate and the
  two-term fit otherwise had nothing in place of.
- **Floors and separability.** `SPLIT_FLOORS` is 20 intervals **and** 10
  cumulative percentage points, twice `CURRENT_FLOORS`' numbers for twice the
  parameters. Note it is **not** twice the evidence: these count every interval
  the model spent anything in, where `CURRENT_FLOORS` counts only intervals it
  *owns*, so the gate is looser than the doubling suggests (measured, fable-5
  clears it at 86 intervals / 100.0 points while its owned evidence is 16 /
  17.0). That is intended — a joint fit genuinely draws information from
  co-occurrence, which is the point of reading `mixed` at all — but the two
  numbers are not comparable. Separately, a model whose two regressors
  have uncentered r² above `SPLIT_MAX_R2` (0.99, a variance inflation of 100) is
  not offered a request column at all — uncentered because a fit with no
  intercept is collinear precisely when one column is a scalar multiple of the
  other. Past that ceiling the split is decided by the couple of intervals that
  happen to break the proportionality, which is a coin toss dressed as a
  measurement.
- **A negative coefficient is a refusal, not a clamp.** Both a per-token and a
  per-request cost are physically non-negative, so a negative one means this
  data cannot separate the terms. Clamping to 0 would publish "requests are
  free" as a measurement nobody made; refusing keeps the null meaning "not
  enough evidence to say", which is what every null here means. Models are
  refused one at a time and the fit is never re-run on a set chosen by its own
  output.

`SplitDiagnostic` reports the reasoning for every model whether it fitted or
not — `collinear`, `thin-evidence`, `unidentified` or `negative`, plus its
`independentShare` and the raw signed coefficients. `unidentified` covers both
an exactly dependent column and one merely too near the span of the others. The raw pair is diagnostic only and nothing surfaces it;
`scripts/probe-usage-split.ts` needs it to say *which* term came back
impossible, because that is the difference between "the model is missing a term"
and "this data cannot see the term".

⚠️ **On this machine's data, the per-request hypothesis is refuted.** Run
`pnpm probe:usage-split -- --dir . --reconstruct --days 3` — it replays the
transcripts to synthesize counts for ledger lines written before counts existed,
so the fit can be exercised before a day of live recording exists. Measured
2026-09-02 over 407 usable intervals: `claude-opus-5` fits at 2.198 pt/Mtok +
0.00586 pt/request, with the request term explaining only **6.6%** of the 368
points it appears in and its per-token coefficient falling just 11% from the
one-term 2.468. `claude-fable-5` is **refused**: least squares wants
−0.0572 pt/request for it and pushes its per-token cost *up*, from 10.71 to
13.15. Lift the sign refusal and the opus:fable ratio goes to **5.98x** — the
gap widens rather than closing on the 2.00x list-price ratio. So the split fit is correct and honest,
and the thing it was built to explain is still unexplained; that finding belongs
to `bug-13`, not to a new number on the card. (The logs keep growing, so a
re-run moves these figures in the last digit or two; the direction is the
finding, not the decimals.)

⚠️ **But the probe has never seen a live-recorded count.** `--reconstruct`
dedups `message.id` globally over whole transcripts while the recorder dedups
per transcript from a byte cursor, and measured on the real transcripts 263 of
5614 assistant turn ids in the last four days appear in more than one file — so
the reconstruction under-counts requests by roughly 4.5%, unevenly across ticks.
Re-run `pnpm probe:usage-split` after a day of real recording and re-confirm the
refutation against recorded counts before acting on it. The full caveat list is
in `backlog/tasks/done/task-10-*.md` under *Not verified*.

### The one-term joint fit: a rate for every model, mixed windows included

`explainRates` / `fitRates` fit utilization against **one** regressor per model —
its weighted tokens in millions — jointly across every usable interval, with no
intercept, reusing the same `project` / `independentShares` / `leastSquares`
primitives as the two-term fit. `fitRates` is the filtered form; `explainRates`
reports one `RateDiagnostic` per model whatever the outcome.

Why it exists, and it is not the pooled rate's failure mode:

- The pooled rate needs one model to hold `DOMINANCE` of a window. A model used
  only as a **subagent beside a driver model** never holds it, owns nothing, and
  under the old rule got no row on the card at all. That was the concrete
  user-visible defect, not a theoretical gap.
- The two estimators disagree by far more than `DRIFT_PCT`. Measured over the
  17-day baseline on 2026-09-05, at the server's own 3-day fit window:
  `claude-opus-5` pooled 0.2100M weighted/pt against fitted 0.3160M
  (**+50.4%**), `claude-fable-5-1` pooled 0.0451M against fitted 0.0817M
  (**+81.0%**). Over the full 17-day span five models clear the gates:
  `claude-opus-5` 0.3558M, `claude-sonnet-5` 0.3933M, `claude-fable-5` 0.1219M,
  `claude-fable-5-1` 0.1163M and `claude-haiku-4-5-20251001` 0.3002M. All five
  own intervals over that span — 855, 5, 16, 28 and 2 respectively — so all five
  already had a pooled rate; what the fit changes for them is the *number*, not
  whether there is one.

**The headline case — a model that owns nothing — is on this machine and is
currently refused.** `claude-opus-4-8` owns **zero** intervals over the whole
17-day window, so `pool()` gives it nothing at any floor and it has never had a
row on the card. It also does not get one now: it appears on exactly **one**
ledger line, so `explainRates` refuses it `thin-evidence` (1 interval, 1.0 point,
1 day) at the 17-day horizon and it is outside the server's 3-day window
entirely. Its ungated coefficient is `raw = 4.1204 pt/Mtok` ≈ 0.243M
weighted/pt — the arithmetic works, and the floors correctly decline to publish
one interval as a measurement. That is the fit behaving as designed, not the
feature failing: the mechanism that would price a subagent-only model is in
place and gated, and the first such model to accumulate ten intervals over two
days will get a row. Do **not** cite any of the five fitted models above as the
zero-owned case; measured 2026-09-05, none of them is.

**Which intervals** — `usableForRate` admits `{model}`, `mixed` and `idle`, and
rejects `external` plus everything `isUnpriced` names, for the reasons
`usableForSplit` gives. It **does not test `reqUsable`**, and that difference is
deliberate: that flag is a two-term-only requirement, because the split's second
regressor *is* the request column. A missing request count says nothing about
the token totals. Copying `usableForSplit` wholesale would have thrown away the
2000 of 5019 live ledger lines written before the recorder produced counts —
~40% of the evidence — for nothing. `test/usage-rate-fit.test.ts` names that
regression in a test title.

**Which gates** — `SPLIT_RANK_TOL` for the solve, and
`SPLIT_MIN_INDEPENDENT_SHARE` for the answer. The second is the one that
matters here: with one column per model, cross-model collinearity is the *entire*
risk, and `independentShares` is the only instrument that looks across models.
`SPLIT_MAX_R2` is **deliberately not applied** — it compares a model's own two
regressors against each other, and this fit gives a model one, so it has nothing
to say. A non-positive coefficient is a refusal, not a clamp, with one edge of
its own: the published rate is `1M / coefficient`, so a clamped zero would read
as an *infinite* price rather than a free one.

**Which floors** — `CURRENT_FLOORS` (10 / 5 / 2), not `SPLIT_FLOORS` (20 / 10 / 1).
`SPLIT_FLOORS` is doubled because the split fits two parameters per model; this
fits one, the same count the pooled ratio fits, so it earns the same floor. That
is a decision, and it is written down here because the next reader will
otherwise assume the higher floor was an oversight. The refusal vocabulary is
`RateRefusal`: `thin-evidence` → `unidentified` → `negative`, reported
most-informative first.

**And it is excluded from every drift verdict.** The pooled rate stays the
headline and stays the quantity `verdict` and `deviationPct` are computed on.
Three reasons, all of them about not knowing rather than about preference:
`BASELINE_FLOORS` / `CURRENT_FLOORS` and `DRIFT_PCT` were tuned against the
*measured* day-to-day dispersion of the pooled ratio (cv ≈ 24%) and nothing has
measured the fitted rate's; swapping the drift quantity would silently rewrite
every verdict with no way for a reader to see it happened; and the two-term
fit's own cross-model ratio came back **refuted** on live data, so a fitted
number is not automatically the more trustworthy one. `bug-13`'s limit —
this card must not claim cross-model comparability — applies to the fitted rate
exactly as it does to the pooled one. Regularising toward the clean-interval
rate was also considered and rejected: this file answers ill-conditioning by
refusing, and a prior would make the fitted number partly an echo of the pooled
number it exists to check independently.

### The endpoint and the card

`GET /api/usage/rates` (`shapeUsageRates` is the pure part) returns one row per
model that either owns an attributable interval **or** is identified by the
one-term joint fit, richest evidence first, plus `externalSharePct` and a
`coverage` object. Read-only, unpolled — it reads two files and does
arithmetic, and the numbers move on a scale of days — and it fails open to an
honest empty body exactly like `serveUsageProfile`. A model with **neither**
still gets no row: a row of nulls reads as a broken fit rather than as an
absence of evidence.

A fitted-only row is legitimately all-null on the pooled side — no rates,
`verdict: 'thin'`, and `intervals` / `utilSum` / `days` at zero — with
`fittedWeightedPerPct` as the only number on it. That is honest and is not
special-cased anywhere; `driftRow` produces it unaided. The sort key is
unchanged (`utilSum` desc, then model name), so fitted-only rows land last.

Each row also carries `pctPerMWeighted`, `pctPerRequest` and `splitVerdict`
from the two-term fit, and `fittedWeightedPerPct`, `fitVerdict` and
`fitDeviationPct` from the one-term fit. **Both fits run over the same
`currentRange(nowMs)` window the row's own pooled rate describes**, so a row's
three numbers never describe different spans. `splitVerdict: 'thin'` and
`fitVerdict: 'thin'` each cover every refusal of their own fit — the row does
not say which, and `scripts/probe-usage-split.ts` is where the reasons live.
`fitDeviationPct` is computed on the server (`fitDeviation`) so the comparison
lives in one place and the card owns no threshold; it is null when either rate
is null and null rather than `Infinity` when the pooled rate is not positive.
Every drift field on the row is the single-ratio number it always was: both
fits are **additive**.

On the card the fitted rate is a third line under the raw aside
(`fittedAsideText`, omitted entirely when there is no fitted rate — never a
dash), and the badge above it is still the pooled rate's verdict. The empty
state names both routes onto the card, because 90% dominance is no longer the
only one.

`coverage` (`UsageCoverage`) is the disclosure the three unpriced kinds exist
for: `movedPct` as the denominator, `pricedPct` for what reached a rate, then
`mixedPct`, `externalPct`, `preLedgerPct`, `missingPct` and `partialPct`, which
sum to `movedPct`. The wire name is `missingPct` rather than `gapPct` — the
field should say what the bucket *means* now that `gap` no longer means all
three. Two fields are not utilization points: `recorderBreakHours` is hours,
because it is read by a person, and `startProvable` is false when
`ledgerStartMs` came back null. Unlike the rates beside them these are
**counters, not fits** — there are no nulls, a zero is a measured zero, and
`emptyRates` therefore carries a fully zeroed instance so the field is never
absent. `coverage` is computed over `[now − BASELINE_MS, ∞)`, deliberately the
**same horizon `externalSharePct` uses**: two disclosure figures on one card
that quietly spanned different windows would be a defect, not a nuance.

The **Usage** section is now two sub-tabs — `Forecast | Token value` — through
the Settings page's `.set-seg` control, persisted per device as `usageTab`.
`UsageProfile` is a full week of hour cells and runs to about a screen, so
stacking would bury the shorter view; only the active sub-view mounts, which
also means each one's fetch-per-mount hook fires when its tab is opened rather
than on every visit to the section.

`UsageRates.tsx` leads each row with the **weighted** figure (the one drift is
judged on) and carries the raw figure as a labelled aside beneath it — see *No
dollars, only ratios* above for why that order, and `bug-13` for the version
that had it the other way round. It shows every rate beside its
evidence (windows + **recorded days** + cumulative points), states the
baseline's own day count in the same line (`no baseline yet` /
`baseline forming · 1 day` / `baseline 163k · 9 days`), treats `collecting` as a
first-class state rather than an empty row — with a hint naming both day floors,
so the card says what it is waiting for — and discloses the external-burn share
in a footer pill because it is the one systematic bias in the measurement. Every
explanation is real text in the row — no `title` attributes, for the reason the
profile tooltip exists.

A second `.rates-foot` row states the coverage split, formatted by pure
functions in `usageRatesFormat.ts` (`pricedPillText`, `coverageClauses`) so the
sentences the card makes are testable without a browser. It **leads with the
priced share**, then names each refusal that actually cost something, largest
first — because leading with the refusals made a startup artifact read as a
fault, which is exactly what the single `gap` counter did. A bucket worth zero
points prints nothing at all: a row of zeroes reads as a broken measurement.
Shares under 1% keep one decimal (`formatShareOf`), so the genuinely tiny
recorder-down bucket cannot render as `0%`; the recorder-down clause always
names its hours *and* its points together; and with `startProvable: false` the
pre-ledger clause is replaced by a caveat that the ledger has rotated, so the
start is unknown and `missingPct` has absorbed whatever predates it.

⚠️ **Drift detection itself is unproven.** Every pure function is tested and the
plumbing is verified end to end against live logs, but a `drift` or `stable`
verdict needs a 17-day baseline to exist at all, and nothing shorter than weeks
of real recording can confirm it fires when it should and stays quiet when it
should not. What *is* verified is that ledger lines accumulate once a minute,
that real intervals classify to a real model, and that every empty and thin
state is honest.

It has misfired once, and the day floors above are the fix. On 2026-09-03, three
days into recording, `claude-opus-5` was badged `drift` at +27.8% against a
"14-day baseline" that was in fact the recorder's first 10.8 hours: 60 intervals
and 65 points cleared the 30 / 15 floors easily, because those floors counted
how much evidence the pool held and never how far apart it was spread. Measured
per day, this machine's own weighted rate varies 173k → 281k (cv ≈ 24%), so a
one-day pool on **either** side of the comparison clears the 20% band by itself.
Two residuals are stated rather than fixed: at 7 / 2 the 1σ deviation error is
19.2% against a 20% band, so a crossing by chance alone is still not rare; and
the current window is 3 days wide by construction, which makes it the dominant
noise term whatever the baseline does. Widening the band is a question for more
than four days of data.

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
    - scripts/probe-usage-split.ts
    - scripts/check-token-weights.ts
    - server/api.ts
    - client/src/components/Header.tsx
    - client/src/components/usage/
  kind: subsystem
  verified: 84519e7f39aa5faf2d43acd7097b1730d4dc5645
-->
