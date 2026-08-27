---
id: idea-5
title: Long-term 5h/weekly usage history
created: 2026-08-25
---

## Problem

The header's 5h/Week bars show only the *current* utilization. Two gaps:

1. **No history.** Pace samples live in a RAM-only ring (`server/lib/usage-pace.ts`,
   cap 720 ≈ half a day) and vanish on server restart. There is no way to see how
   utilization moved across days or weeks — when windows filled, which days burn
   hottest, whether the weekly limit trends toward exhaustion.
2. **Recording stops while away.** The dashboard never refreshes OAuth creds
   (deliberate invariant, `server/lib/usage.ts`). The access token's TTL is a few
   hours, so away-from-terminal — exactly the remote-monitoring use case — the bars
   flip to `token-expired` and sampling stops until the next CLI run on the host.
   Clarified 2026-08-25: this is *not* a daily-manual-login problem — the CLI
   auto-renews the access token from the refresh token (~1 month TTL, rolls forward)
   on any run. The gap is only "no CLI run for a few hours while the dashboard is
   the sole consumer".

## Status (re-verified 2026-08-27)

**Landed** — the *sensing* half, via task-4 (duty-cycle usage forecast; spec
`docs/superpowers/specs/2026-08-25-usage-forecast-duty-cycle-design.md`) and task-5
(the walk strip):

- Persistence. Two gitignored state files at the repo root —
  `.usage-history.jsonl` (append-only samples, write-on-change plus a 15-min
  heartbeat) and `.usage-profile.json` — with `server/lib/usage-history.ts` owning
  both, resolving them from the repo root by walking up for `package.json`, behind
  the opt-in `recordUsageHistory` setting.
- The **retention** open question below: answered — `MAX_HISTORY_BYTES` = 32 MB
  (`usage-history.ts:304`), rotated in place, ~2 years of write-on-change samples.
- The **idle sampling density** open question below: answered — write-on-change
  plus a 15-minute heartbeat, so a flat night costs 4 lines/hour.
- A Usage tab exists (`client/src/components/usage/`), with a 24×7 hour-of-week
  heatmap and a forward-walk strip.

**Still open** — the *history-view* half, and the keepalive.

The heatmap is **not** this idea's history view, and the distinction is the whole
remaining point. It renders `UsageProfileCell` — `weight` / `observedMin` /
`staleWeeks`, i.e. EWMA-folded hour-of-week *duty cycle* — and carries no
utilization at all. It answers "which hours do you usually work"; idea-5 asks "how
full was the window last Tuesday". The walk strip is likewise *forward*-looking.
Different axis, different question, no overlap.

Three concrete gaps:

1. **The record is 5h-only.** `UsageSample` (`usage-history.ts:97`) is
   `{t, utilization, resetsAt}` for the 5-hour window — it is the sensor the
   profile is learned from (see `docs/subsystems/usage-limits.md`). There is no
   weekly series on disk to chart, so weekly history needs the record widened
   (and existing lines treated as legitimately weekly-less, not corrupt).
2. **No endpoint serves raw samples.** The only route is `GET /api/usage/profile`,
   whose contract says so out loud — `UsageProfileResponse` in `shared/types.ts` is
   documented "read-only. Never includes raw samples." A history view needs a new
   endpoint; widening this one would break a deliberate boundary.
3. **No backward chart.** `UsageView.tsx` names this idea as its own next tenant.

## Remaining work

- **Widen the record** to carry the weekly window alongside the 5h one, versioned
  so pre-existing 5h-only lines still replay into the profile unchanged.
- **History endpoint** — e.g. `GET /api/usage/history?days=N`, serving downsampled
  samples. Downtime and expired-token periods stay honest gaps in the data.
- **History view** in the Usage tab, below the forecast section: 5h-window
  utilization over the last N days (sawtooth per session window), weekly
  utilization across weeks. Read-only; the tab is already its own lazy chunk.
- **Optional keepalive** so recording continues unattended — still entirely
  unbuilt, and now *more* relevant, since recording runs unattended by design and
  `token-expired` (`usage.ts:230`) is a dead-end state with no action. Something
  runs a minimal headless turn (`claude -p "ok" --model haiku`) every few hours →
  the CLI renews its own creds; the dashboard never touches the keychain. The
  removed Sync button (task-1) did this on-click; its objections are partly stale —
  `lib/spawn.ts` now exists and solves binary resolution. Docker remains impossible
  (no CLI in container, read-only `~/.claude`) — keepalive would be host-only,
  fail-open. Zero-code alternative: user-level launchd/cron, documented instead of
  built.
- **Complement, not substitute:** transcript-derived per-project token stats
  (idea-4) are retroactive and auth-free but count raw tokens, which don't map to
  Anthropic's opaque utilization %. Recorded utilization is the only source for the
  actual account-limit history.

## Open questions

- ~~Where does the history UI live~~ — settled by the Usage tab existing: a second
  section under the forecast, same lazy chunk.
- ~~Retention/rotation policy for the JSONL~~ — settled: 32 MB, rotate in place.
- ~~Should sampling density drop when idle~~ — settled: write-on-change plus a
  15-min heartbeat.
- How does the widened record version itself so old 5h-only lines keep replaying
  into `usage-history.ts`'s classifier without a migration pass?
- Build the keepalive into the dashboard (cron-ish loop gated on remote-answer mode?
  a settings toggle?) or just document a launchd/cron recipe? In-app spawn burns a
  small prompt and creates a transcript per refresh — needs a scan filter (or reuse:
  spawn into a dedicated scratch project and filter by cwd).
- Weekly window length is unproven (docs flag possible non-7-day resets) — history
  charting should key off observed `resetsAt`, not an assumed window length.
