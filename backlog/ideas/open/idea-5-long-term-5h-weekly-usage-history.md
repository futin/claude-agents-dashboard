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

## Rough shape

> **The persistence half landed on 2026-08-25** via task-4 (duty-cycle usage forecast;
> spec `docs/superpowers/specs/2026-08-25-usage-forecast-duty-cycle-design.md`). There are
> now two gitignored state files at the repo root — `.usage-history.jsonl` (append-only
> samples, write-on-change plus a 15-min heartbeat, rotated past 32 MB) and
> `.usage-profile.json` — with `server/lib/usage-history.ts` owning both, resolving them
> from the repo root by walking up for `package.json`, behind the opt-in
> `recordUsageHistory` setting. Two differences from the shape sketched below: the log
> records the **5h window only** (it is the sensor; see
> `docs/subsystems/usage-limits.md`), not both windows in one record, and there is no
> `GET /api/usage/history` — the only endpoint is `GET /api/usage/profile`, which serves
> the *derived* profile and deliberately never returns raw samples. So the remaining work
> here is the **history-view half**, and it would either read the JSONL through a new
> endpoint or widen the record to carry the weekly window too. Whoever grooms this next:
> the keepalive bullet is also still open, and is now more relevant, since recording runs
> unattended by design.

Two halves; the first is useful alone.

- **Persist utilization samples.** Append each successful `refreshNow()` fetch to a
  gitignored JSONL (`{t, fiveHour: {utilization, resetsAt}, sevenDay: {…}}`,
  ~once/min while polling). Server reads it back on demand for a history endpoint
  (e.g. `GET /api/usage/history?days=N`). Downtime/expired-token periods remain
  honest gaps in the data. Mind the ad-hoc-scripts-clobber-state-files lesson: write
  cwd-independent (resolve from repo root), and cap/rotate the file.
- **History view.** Chart(s) somewhere — Analytics tab or a header drill-in: 5h-window
  utilization over the last N days (sawtooth per session window), weekly utilization
  across weeks. Read-only, own lazy chunk like the other tabs.
- **Optional keepalive** so recording continues unattended: something runs a minimal
  headless turn (`claude -p "ok" --model haiku`) every few hours → the CLI renews its
  own creds; the dashboard never touches the keychain. The removed Sync button
  (task-1) did this on-click; its objections are partly stale — `lib/spawn.ts` now
  exists and solves binary resolution. Docker remains impossible (no CLI in
  container, read-only `~/.claude`) — keepalive would be host-only, fail-open.
  Zero-code alternative: user-level launchd/cron, documented instead of built.
- **Complement, not substitute:** transcript-derived per-project token stats
  (idea-4) are retroactive and auth-free but count raw tokens, which don't map to
  Anthropic's opaque utilization %. Recorded utilization is the only source for the
  actual account-limit history.

## Open questions

- Where does the history UI live — Analytics tab section, its own tab, or a
  popover/drill-in from the header bars?
- Retention/rotation policy for the JSONL (cap by days? size?).
- Build the keepalive into the dashboard (cron-ish loop gated on remote-answer mode?
  a settings toggle?) or just document a launchd/cron recipe? In-app spawn burns a
  small prompt and creates a transcript per refresh — needs the scan filter task-1
  removed (or reuse: spawn into a dedicated scratch project and filter by cwd).
- Should sampling density drop when idle (utilization flat) to keep the file small?
- Weekly window length is unproven (docs flag possible non-7-day resets) — history
  charting should key off observed `resetsAt`, not an assumed window length.
