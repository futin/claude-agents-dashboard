---
id: task-28
title: Kaizen review should trend the ctx figures it already logs
created: 2026-09-20
tags: kaizen, analytics
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
