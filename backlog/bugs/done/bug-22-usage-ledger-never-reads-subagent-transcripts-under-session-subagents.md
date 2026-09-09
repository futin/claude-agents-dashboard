---
id: bug-22
title: Usage ledger never reads subagent transcripts under <session>/subagents/
created: 2026-09-09
tags: usage, ledger, rates
updated: 2026-09-09T20:42:32Z
started: 2026-09-09T20:27:24Z
execute-elapsed: 908
execute-tokens: 113928
---

## Symptom

`.usage-ledger.jsonl` undercounts what the account actually spent. Measured 2026-09-09
against a direct sum over every `~/.claude/projects/**/*.jsonl` (deduped on `message.id`):

| UTC day | opus-5 on disk (weighted) | in ledger | ledger/disk |
|---|---|---|---|
| 09-05 | 56.4M | 44.0M | 78% |
| 09-06 | 97.5M | 71.2M | 73% |
| 09-07 | 67.2M | 45.2M | 67% |
| 09-08 | 34.2M | 22.3M | 65% |

Sonnet-5 on 09-08: **25.05M on disk, 0.37M in the ledger** — exactly the top-level slice
(1112 of 1118 sonnet records that day were subagent turns). Nested share of opus tokens
swings 0–66% per day over the last 30 days, so the miss is both large and noisy.

Downstream: every figure on the Token-value card is biased low. Rebuilding the ledger
from disk with the nested files included lifts the opus-5 pooled rate 230k → 318k
weighted tok/1% (baseline) and 180k → 248k (current), i.e. the published level is ~38%
under the measurable truth. (The *deviation* is unchanged at −22%, so this is not the
cause of the drift verdict — that is bug-23.) Intervals that should be `mixed` (opus +
sonnet subagents concurrent) are classified `{model: opus}` because the sonnet tokens are
invisible, so the `DOMINANCE` filter is defeated on exactly the intervals it exists for.

## Repro

```bash
# ledger side vs disk side for one day/model, e.g. 2026-09-08 claude-sonnet-5
node -e 'const fs=require("fs");let w=0;for(const l of fs.readFileSync(".usage-ledger.jsonl","utf8").split("\n")){if(!l)continue;const j=JSON.parse(l);if(new Date(j.t).toISOString().slice(0,10)!=="2026-09-08")continue;const c=(j.tok||{})["claude-sonnet-5"];if(c)w+=c.in+5*c.out+2*c.cc+0.1*c.cr}console.log("ledger",Math.round(w))'
find ~/.claude/projects -path '*/subagents/*.jsonl' | wc -l   # non-zero ⇒ files the ledger never opens
```

Then compare with a recursive walk that sums `message.usage` for assistant records dated
2026-09-08 with `message.model === "claude-sonnet-5"` (the session that found this used
`disk-sum.mjs` in its scratchpad; any recursive walk reproduces it).

## Affects

- `server/lib/scan.ts:119` — `listTranscripts(root)` reads `<root>/<projectDir>/*.jsonl`
  one level deep; `<projectDir>/<sessionId>/subagents/agent-*.jsonl` is never enumerated.
- `server/lib/usage-ledger.ts:15` — imports that enumerator; `collectEvents` inherits the
  blind spot.
- `server/lib/usage-ledger.ts:311` — comment says "sidechain (subagent) turns are counted
  here". Stale: `isSidechain:true` lines no longer replay in the parent transcript (0 such
  lines across 30 days / ~1800 files on CLI 2.1.222–2.1.260). Subagent turns live only in
  the nested files.
- `server/lib/analyze.ts:16` — same stale claim ("Subagent turns replay in the parent
  transcript as `isSidechain:true` records"), and `analyze.ts:128` skips them to avoid
  double counting — so Analytics per-session totals now exclude subagent spend entirely
  rather than counting it once. Same root cause, different consumer; decide in groom
  whether it is in scope here or its own item.
- `scripts/check-token-weights.ts:26` — `pnpm check:weights` imports the same
  `listTranscripts`, so the cache-write tier check is also top-level only ("transcripts
  read: 284" on 2026-09-09 against 380 files on disk since 09-05). The tier verdict is
  probably unchanged — subagents write caches the same way — but it is unproven.
- `scripts/probe-usage-split.ts:77` — `--reconstruct` replays transcripts through the same
  enumerator, so the reconstructed `req` counts task-10's per-request refutation rests on
  also exclude every subagent request. Re-run once the enumerator is fixed (idea-25 notes
  the same).
- `docs/subsystems/usage-limits.md` — the Token-value section describes the ledger as
  measuring "what the account spent".

## Cause

`listTranscripts` predates the CLI writing subagent transcripts to a per-session
`subagents/` directory (present since at least 2026-08-12, CLI 2.1.227 on this machine).
The ledger relies on the parent transcript replaying sidechain turns, which it no longer
does, so ~a quarter to a third of the account's spend has no path into
`.usage-ledger.jsonl`.

A second, smaller loss is unrelated to nesting: the ledger recovers only ~93% of the
*top-level* tokens (synthetic top-only rebuild vs recorded ledger, consistent across
windows). Likely the seeding tick after a restart swallowing pending events, and/or
records whose `timestamp` predates `prevT` when a long turn flushes late (`sumWindow`
drops `ts <= prevT`). Uniform across windows, so it does not move the drift; note it, do
not fix it here unless it falls out.

## Fix

Candidate (groom to confirm):

1. Enumerate `<projectDir>/*/subagents/*.jsonl` alongside the top-level files. Either
   extend `listTranscripts` — but it is shared with `scan.ts`, `management.ts`,
   `analytics.ts`, and `agents.ts` and its callers treat each file as a *session*, so a
   nested agent file must not become a session row — or give the ledger its own
   `listUsageTranscripts` that returns top-level + nested with a `nested`/`parentId` flag.
   The ledger keys events by `message.model`, not by file, so nothing else in
   `collectEvents` changes; per-file cursors already handle new files appearing.
2. Reword the two stale comments (`usage-ledger.ts:311`, `analyze.ts:16`) to describe the
   on-disk layout as it is.
3. Re-baseline the numbers `docs/subsystems/usage-limits.md` quotes (the 4.2× opus:fable
   ratio, `EXTERNAL_WEIGHTED_MAX` derivation, the 09-06 boost probe) — each was measured
   on the undercounted ledger.
4. Test: a fixture project dir with `<session>.jsonl` plus
   `<session>/subagents/agent-x.jsonl`; `recordLedgerTick` must sum both; a session
   listing must still show one session. Mutation-prove it: with the enumeration reverted
   the nested tokens are absent from the tick.

The historical ledger cannot be repaired in place — old ticks stay undercounted. Accept
that; the drift windows age out in 17 days.

## Outcome

2026-09-09 — Fixed. The cause held against the code as it stands: `listTranscripts`
(`server/lib/scan.ts`) reads one level deep, and the CLI's subagent transcripts sit at
`<projectDir>/<sessionId>/subagents/agent-*.jsonl`. Confirmed on this machine's live data
before changing anything: one such nested file exists, it holds 29 assistant records with
`message.usage` (`claude-sonnet-5`), and it is the *only* file under `~/.claude/projects`
containing `isSidechain` at all — the parent transcripts carry none, exactly as the bug
reports.

What changed, following the Fix as written:

1. `scan.ts` gained `listUsageTranscripts(root)` returning `UsageTranscriptRef[]` — the
   top-level files (`parentId: null`) plus the nested subagent files (`parentId` = the
   session dir). Kept as a *second* enumeration rather than a wider `listTranscripts`,
   which is what the Fix preferred: `listTranscripts`' callers treat one file as one
   session, so a nested file reaching them would become an extra session row, an extra
   analytics report and a resolvable `/api/sessions/:id`. `listTranscripts` is byte-for-byte
   equivalent to before (refactored only to share `statRef`/`jsonlNames`).
2. `usage-ledger.ts` `collectEvents` reads `listUsageTranscripts`. Nothing else in the
   ledger changed — it keys events by `message.model`, and the per-file cursor map already
   handles a file appearing mid-run, which is how a `subagents/` dir shows up.
3. The two stale comments are reworded to the on-disk layout (`usage-ledger.ts` ~311,
   `analyze.ts` 16 and 128).
4. `scripts/check-token-weights.ts` and `scripts/probe-usage-split.ts` also switched to
   `listUsageTranscripts` (one line each). Not strictly demanded by the Fix, but
   `--reconstruct` exists to reproduce the ledger, and leaving it on the old enumerator
   would have made it compare unlike things against a ledger that now sees more.

Deliberately NOT done, with reasons:

- **`analyze.ts` behaviour is unchanged.** Investigating it refuted the Affects claim that
  "Analytics per-session totals now exclude subagent spend entirely": subagent tokens
  reach that report through `subagentTotals`, which `agents.ts` parses from the
  `<subagent_tokens>` tags in the parent transcript's Task result — not from usage records.
  The `isSidechain` skip at `analyze.ts:128` is now a guard for older transcripts only.
  Only the comments were false, and they are fixed. No follow-up item needed.
- **Historical ledger ticks stay undercounted** — the Fix accepts this; the tokens they
  never read are not recoverable per tick.
- **The ~93% top-level recovery loss** was left alone, as the Cause section instructs.
- **The numbers in `docs/subsystems/usage-limits.md` could not be re-measured here.**
  This machine has no `.usage-ledger.jsonl` (recording has never been on in this checkout)
  and only 31 transcripts, so there is no ledger data to re-derive the 4.2x ratio, the
  `EXTERNAL_WEIGHTED_MAX` derivation or the 09-06 boost probe from. Instead of leaving them
  reading as current, both blocks now carry an explicit provenance warning naming the fix,
  the direction of the bias and the command to re-run. Re-baselining needs a day of
  post-fix recording and is a separate measurement.

Verification:

```
$ pnpm test
  18 passed, 0 failed
ALL PASS
   (1429 individual cases printed ✓; 18 = suites)

$ pnpm typecheck
> tsc --noEmit
   exit 0
```

Live enumeration probe against the real `~/.claude/projects` (not a fixture):

```
top-level: 31 usage enumeration: 32
nested: agent-a5094a80ba5102782 parent: e9f8759d-601a-4379-88de-49da5de97b12 dir: -home-futin-ubuntu-custom-projects-guide-manager
```

`recordLedgerTick` was deliberately NOT run against the live tree — it writes
`.usage-ledger.jsonl` into the repo root, and this session must not create state files.
The tick path is covered by the fixture test instead.

Contract sweep: 8 sites updated (docs/subsystems/usage-limits.md, docs/overview.md,
docs/learning-notes/session-and-agent-tracking.md, docs/learning-notes/kaizen-and-analytics.md,
docs/learning-notes/kaizen-and-analytics-diagrams.md, test/scan.test.ts stale test name,
scripts/check-token-weights.ts, scripts/probe-usage-split.ts)
Red proof: 3 tests went red with the change reverted

Left standing on purpose: `docs/superpowers/specs/2026-08-28-model-token-rates-design.md:57`
still names `listTranscripts` for the ledger — specs under `docs/superpowers/` are records of
a moment by repo convention, not maintained contracts. The remaining `isSidechain` sites
(`server/lib/chat.ts:135`, `docs/subsystems/chat.md:33`, `docs/subsystems/spawn.md:127`,
`server/lib/scan.ts` `lastMessageMs` note) are still accurate: they describe filtering such
records wherever they do appear, which this change does not alter.

Red proof detail, for the reviewer:

- `listUsageTranscripts adds the nested <session>/subagents files, flagged with their parent id`
  and `a subagent transcript under <session>/subagents is counted in the tick` both failed
  before the fix existed (`scan.listUsageTranscripts is not a function`; the tick held
  `opus-5` only), and both fail again with the nested enumeration reverted to
  `listTranscripts(root).map(ref => ({...ref, parentId: null}))` — 61/62 and 14/15.
- `a nested subagent transcript is never a session: listTranscripts and scanSessions ignore it`
  passes on unfixed code by design — it pins the *choice* of a second enumerator. It was
  mutation-proved instead: widening `listTranscripts` to walk `subagents/` turns it red
  (60/62). A file copy was used for every revert, never `git stash`.
