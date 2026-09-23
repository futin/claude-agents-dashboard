---
id: task-28
title: Kaizen review should trend the ctx figures it already logs
created: 2026-09-20
tags: kaizen, analytics
updated: 2026-09-23T10:57:51Z
started: 2026-09-23T10:46:10Z
execute-elapsed: 701
execute-tokens: 86390
---

## Goal

`/kaizen review` should detect a cost trend across sessions, not only a repeated prose lesson. The numbers it needs are already on disk and have been all
along — they are simply never read back.

The log grammar in SKILL.md ("Log grammar (the contract)", around line 101) already specifies a per-session line carrying both figures:

```
- 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: <takeaway>.
```

Today's review mode sweeps those lines for lessons recurring across 4+ projects — a text pattern over what somebody wrote — and never compares the `ctx`
figures as a series. That is why the drift found on 2026-09-20 went unreported for as long as it did: every individual kaizen run saw one big session and had
no cohort to call it an outlier against. Across 105 sessions / 7 days the pattern was unmistakable (33 sessions past 200k context = 87% of 2,614M tokens
moved), but no single run could see it.

## Plan

- Parse the `N billable (M ctx)` figures out of the existing lesson lines in `~/.claude/session-analytics-log.md`. The grammar is fixed and documented, so
  this is a read of data already being written — no new collection, and no change to what a normal kaizen run appends.
- Report the series in the review output: per project and overall, enough to see a trend rather than a single number.
- Decide what counts as drift worth reporting. This is the genuinely open part of the item and the implementer should choose and defend it — a ratio against
  the project's own trailing median is one option, an absolute ctx threshold another. Whatever is chosen, the review must not fire on a single large session;
  the whole point is the cohort.
- Handle the log honestly: it is shared by every session on this machine and is strictly append-only (SKILL.md, "Append-only, always"). Review already
  appends its own `review:` marker line. Do not sort, rewrite, or de-duplicate anything while reading.
- Lines that predate the grammar, or are free prose, must be skipped rather than parsed — the grammar itself says non-conforming lines are prose and ignored.
- Lockstep `docs/subsystems/analytics.md` per the repo rule.

## Test cases

- A log with ten lines whose ctx figures climb steadily: drift reported.
- A log with ten flat lines and one spike: NOT reported as drift — one big session is not a trend, and this is the case the item exists to get right.
- Mixed-project log: figures are grouped per project, and a climb in one project does not drag another into the report.
- Lines that do not match the grammar at all (free prose, `status` lines, `review` markers): skipped silently, no parse error, and not counted as sessions.
- A line carrying `billable` but no `(N ctx)` figure: skipped for trend purposes without discarding the whole sweep.
- An empty log, and a log with one line: no crash, nothing reported.
- Unit-parse the figures against both `k` and `M` suffixes, since the grammar's own example uses `210k` and `1.4M` in the same line.

## Done when

`/kaizen review` on this machine's existing log reports the context trend across sessions, and would have flagged the 2026-09-20 drift from the log alone
without anyone re-measuring transcripts by hand.

## Outcome

2026-09-23 — `kaizen.mjs --trend [/abs/log.md]` added: parses the `<billable> billable (<ctx> ctx` prefix out of lesson lines (k/M/B, decimals,
thousands commas, trailing `, N turns` ignored), newest line per `[project] id` wins in memory, and prints per-project + overall ctx series with a drift
verdict. Chosen rule: median ctx of a group's newest 3 sessions ≥ 1.5× the median of all earlier ones, needing 6+ sessions — medians on both sides mean one
spike can never fire it (it takes two of the newest three), and the group's own history as baseline means a project that always runs large is not flagged.
An absolute ctx threshold was rejected because it fires on exactly the single big session. `/kaizen review` gained step 2 (old steps 2–6 renumbered 3–7),
the grammar's lesson bullet now says its figures are read back as data, and `docs/subsystems/analytics.md` has an invariant bullet defending the rule.
Kaizen-only by design: no server module or Analytics view reads it, so `test/kaizen-trend.test.ts` spawns the vendored script (the `analyze.test.ts`
parity pattern).

Done-when check — the rule run over this machine's real log truncated to lines dated ≤ 2026-09-20 (only groups with enough sessions to judge):

```
overall: 20 sessions 2026-07-12..2026-09-06, baseline 47.3M -> recent 10.5M, ratio 0.22, drift false
claude-agents-dashboard: 7 sessions 2026-07-12..2026-08-27, baseline 13.35M -> recent 26.2M, ratio 1.96, drift true
```

The dashboard project reads as drifting from 2026-08-27 onward, i.e. the log alone flagged it weeks before the 2026-09-20 hand measurement. Caveat: the
log holds only 21 figure-bearing lesson lines against the 105 sessions measured on 09-20, and the overall series had already flipped to a falling ratio
(0.22) by 09-10 because the latest logged sessions happen to be small, so the trend is only as dense as the kaizen runs that feed it.

```
=== kaizen.mjs --trend ===
  ✓ ten steadily climbing sessions: drift reported
  ✓ ten flat sessions and one spike: NOT drift, wherever the spike lands
  ✓ five climbing sessions: too short to judge, not drift (needs 6)
  ✓ mixed projects: grouped per project, a climb in one does not flag the other
  ✓ prose, status and review lines are skipped silently and not counted
  ✓ a billable line with no (N ctx) figure is skipped without discarding the sweep
  ✓ empty log, one-line log and a missing log: no crash, nothing reported
  ✓ figures parse with k and M suffixes, decimals and thousands commas
  ✓ a later line for the same session replaces the earlier one instead of counting twice
  9/9
```

Full `pnpm test`: 1677 ✓, 1 ✗ — `api-usage-rates.test.ts` "a near-miss path is not the rates endpoint" (`it falls through to the static handler`),
because this fresh worktree has no `client/dist` (gitignored, never built here) so there is no SPA shell to fall through to. Untouched by this diff
(no server/client file changed). `pnpm typecheck`: clean (`tsc --noEmit`, no output).

Not verified: the global `~/.claude/skills/kaizen/` copy is not updated — the vendored copy's own note says edits take effect only once copied there, and
this unattended session writes nowhere outside its worktree. A real `/kaizen review` run using step 2 end-to-end was not exercised.

Contract sweep: 1 site updated (.claude/skills/kaizen/kaizen.mjs PROVENANCE header now names --trend as the TS-twin exception); left standing on purpose: scripts/session-analytics.ts usage string, the TS twin of the per-session CLI, which does not and should not gain --trend
Red proof: 9 tests went red with the change reverted (whole --trend branch removed: 8/8 red; targeted mutations — recent mean instead of median, no newest-wins, no per-project grouping, M suffix wrong, ctx optional, min-sessions 2 — each turned its pinning test red; the min-sessions case was green until the "five climbing sessions" test was added)

### Fix loop 1

2026-09-23 — the merge gate saw one intermittent `FAILED (1)`. Caught on the first of a repeated `pnpm test` loop:

```
  ✗ usableLsofStdout: a real execFileSync timeout is discarded, output and all
    the killed child did write stdout first
```

That case is at `test/scan.test.ts:388`. It runs `execFileSync('sh', ['-c', 'echo n/a/b; sleep 5'], { timeout: 200 })` and asserts that the killed child
had already written stdout. The 200ms timeout is the child's whole budget to spawn `sh` and echo, so on a loaded machine node's SIGTERM can arrive
first: stdout is empty, and the test's premise assertion fails (`usableLsofStdout` itself was never wrong). A standalone repro of exactly that call,
12 copies at once, 15 calls each: timeout 200ms → 21/180 calls killed before writing; timeout 2000ms → 0/180.

It predates this branch: this branch touches neither `server/lib/scan.ts` nor `test/scan.test.ts`, and the `scan` suite runs long before
`kaizen-trend` in `test/run-all.ts`, so nothing in `--trend` or its test can reach it. Timing is the actual cause, so the fix is the timing budget:
`timeout: 2000` (still well short of the 5s sleep, so the case still proves a real timeout kill), with a comment saying why. No other test uses a
sub-second `timeout:` (`grep -rnE "timeout: ?[0-9]{1,3}[,} ]" test/` → nothing).

Stress, whole `scan` suite, 12 copies at once through a temp runner (removed afterwards):

```
HEAD's test/scan.test.ts (timeout 200):   ran 12/12, failed 12   — all 12 on "the killed child did write stdout first"
fixed test/scan.test.ts (timeout 2000):   ran 12/12, failed 0
```

Verification after the fix, foreground (`pnpm --pm-on-fail=ignore …`: this machine's pnpm is now v11.13.0 against the pinned 10.33.4 and refuses
bare `pnpm test` with a version-check error — an environment change, not a code one):

```
run 1: exit 0, 1678 ✓, 0 ✗, ALL PASS
run 2: exit 0, 1678 ✓, 0 ✗, ALL PASS
run 3: exit 0, 1678 ✓, 0 ✗, ALL PASS
typecheck: exit 0   (tsc --noEmit, no output)
build: exit 0       (✓ built in 1.33s)
```

The earlier `api-usage-rates` "near-miss path" failure noted above was the missing `client/dist`. That directory exists now, and the case passes in all
three runs.

Contract sweep: none found
Red proof: 1 test went red with the change reverted (HEAD's 200ms version failed the timeout case in 12/12 concurrent runs, the fixed one in 0/12)
