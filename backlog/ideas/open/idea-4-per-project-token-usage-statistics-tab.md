---
id: idea-4
title: Per-project token usage statistics tab
created: 2026-08-25
tags: analytics, tokens, ui
---

## Problem

Claude Code reports usage **per model** (`/usage`, `/cost`) and this dashboard reports
it **per session** (the row readout, the Analytics report cards). Nothing answers the
question a person with 33 projects on disk actually asks: **which project is spending
the tokens, over a time range I choose.**

We are well placed to answer it — every transcript already carries `message.usage` on
each assistant record plus an ISO `timestamp`, and the project is simply the transcript's
parent directory. No new data source, no daemon, no hooks.

Held at idea rather than task on purpose: the research below is settled, but **whether
this information is worth surfacing at all is not decided yet** (2026-08-25), and no
variant has been picked.

**Context:** `docs/subsystems/analytics.md` (the existing offline totals),
`docs/subsystems/usage-limits.md` (the live account-limit strip this must not duplicate),
bug-1 in this backlog (a hard prerequisite — see below), idea-2 (the per-turn cousin).

## Rough shape

### Measured on this machine (2026-08-25, ~/.claude/projects)

Every number here came from a throwaway audit script over the real store, not an
estimate:

| measure | value |
|---|---|
| transcripts | **968** files, 630 MB, 33 projects |
| …of which nested `<session>/subagents/agent-*.jsonl` | **575** files, 182 MB |
| usage-bearing records | 88,506 |
| **distinct** `(message.id, requestId)` | **40,131** |
| duplicate records *within* one file | 39,350 (~44%) |
| duplicate records *across* files | **8,714** (~10%, 3,013 keys) |
| records with no `message.id` | 311 |
| `message.id`s with >1 `requestId` | 0 |
| full cold scan, single-threaded Node | **4.4 s** |

Four consequences, each load-bearing:

1. **Dedup must be global across files, not per file.** The 44% within-file duplication
   is bug-1's split-turn copies (one record per content block, same usage on each). The
   ~10% cross-file duplication is separate and comes from `--resume`/fork — the same
   `msg_…` appears in three sibling transcripts of the same project. Summing naively
   inflates ~2×; deduping per file still inflates ~10%.
2. **Nested subagent transcripts are 182 MB of real spend that a flat `readdir` misses.**
   Verified they do *not* duplicate into the parent transcript (sampled a subagent's
   `msg_…` against its parent: 0 hits), so they are purely additive. A recursive walk is
   required, and sidechain records must be **counted**, not skipped — the opposite of
   `analyze.ts`, where skipping them is right for turn analysis.
3. **`message.id` alone is a sufficient key here** (0 ids carried multiple request ids),
   but keep the pair — see the ccusage note below for the case that motivates it.
4. **4.4 s cold is already tolerable** for a lazily-opened tab, so the cache below is
   about warm requests and history retention, not about making it feasible at all.

### Ideas taken from ccusage (read, not installed)

`ryoppippi/ccusage` solves the same problem over the same files. Worth stealing, from
`rust/adapters/claude/src/daily.rs`:

- Dedup key is `(message.id, requestId)`, hashed, **global across all loaded files**, and
  **fail-open** when the id is absent. Their comment names the case the pair guards:
  *"/btw sidechain logs can replay parent messages with new request IDs."*
- On a duplicate they **keep the better copy** rather than the first — prefer the
  non-sidechain record, then the larger token total, then the larger cost. Mid-stream
  copies can be incomplete.
- Entries are **validated away** before counting: empty `sessionId` / `requestId` /
  `message.id` / model, non-semver `version`, and model `"<synthetic>"` (an error record,
  no real API call).
- Per-file **earliest timestamp** is tracked so a whole file can be skipped when it falls
  outside the requested range.
- Cost comes from a **vendored static pricing snapshot** (models.dev/LiteLLM, refreshed by
  CI) with `auto` / `calculate` / `display` modes — zero network at runtime. Compatible
  with our zero-dep backend *if* we ever want USD, which v1 does not.
- Format quirks their parser defends against and ours would meet: `cache_creation` is
  sometimes an object (ephemeral 5m/1h split), "advisor" usage blocks are nested inside a
  single line, and agent-progress lines carry usage too.

### Recompute strategy — stale-session caching (the user's instinct, mechanised)

Don't recompute everything per request, and don't track "staleness" as its own state
either: sessions reopen (`--resume`, which our own spawn panel does), so a stale flag
goes wrong. Same effect, simpler and self-correcting:

- **Per-file digest keyed `(mtime, size)`.** Unchanged file → cache hit, which is every
  finished session automatically. Only changed files are re-parsed.
- **Computed on tab open, not on the 3 s poll** — the Analytics pattern. A busy day costs
  nothing until someone looks.
- **Persist the digests** to a gitignored JSON. Two things fall out for free: history
  survives server restarts, and it survives Claude Code's own transcript pruning
  (`cleanupPeriodDays`, ~30 d default) — so the series can outlive the raw data on disk.
  Without this, any range older than retention silently undercounts.
- Digest content: per entry `(messageId, day, model, 4 token fields)`, deduped within the
  file; **cross-file dedup happens at aggregation time**, since the audit proved
  per-file-only dedup still inflates ~10%. ~40 k entries is a few MB; aggregation is ms.

### Weighting

Raw totals mislead: `cacheRead` dominates every project by ~20× and is the cheapest
token there is, so a project full of long idle sessions outranks one that actually
generated code. Show the four types split out, plus a price-ratio proxy for ranking —
`input×1 + cacheCreate×1.25 + cacheRead×0.1 + output×5`. Tokens only in v1, no USD (user
decision, 2026-08-25), which also means no pricing table to keep current.

### Shape of the change

- `server/lib/project-usage.ts` — pure parser + digest store. Recursive walk, global
  `message.id` dedup (fail-open, keep-larger), sidechains included, `<synthetic>` skipped,
  buckets by `(project, day)`.
- `GET /api/usage/projects?from&to` — new endpoint in `server/api.ts`.
- New **side-rail tab** (user decision, 2026-08-25) — own lazy chunk, unpolled, like
  Guides/Analytics.
- `shared/types.ts` first, per the repo convention.
- Read-only, zero new deps, no new outbound call — fits the existing posture.

### Three UI treatments, mocked

Rendered in the app's own Midnight theme with its real class vocabulary, published as an
artifact on 2026-08-25: <https://claude.ai/code/artifact/f6329c18-ec4f-4204-8de7-3f3542b9e6bb>
(source kept at `docs/superpowers/` only if this gets picked up; otherwise the artifact
is the record).

- **A · Leaderboard** — ranked bars, one row per project, per-type split inline, range
  presets. Smallest thing that fully answers the question. No chart code at all.
- **B · Leaderboard + timeline** — A plus a stacked daily strip, top-4 projects colored
  and the tail folded to a gray "Other". Adds *when*: spikes, dead days, who owned a
  spike. Series colors were validated for colour-blind separation against the strip
  surface (`#182238`): the app's own `--cyan → --magenta → --green → --amber` order
  passes; the obvious `green` beside `mustard` ordering **fails** the normal-vision floor
  (ΔE 14.6 < 15), so the order is not cosmetic.
- **C · Master–detail** — Management-tab pattern: projects left, drilldown right with a
  per-project sparkline, per-model split, and priciest sessions linking into the existing
  chat drawer. Answers *why* a project is expensive, not just *which*.

**A ⊂ B ⊂ C on the endpoint** — each variant's payload is a subset of the next, so
shipping A first forecloses nothing.

### Deliberately out of v1

USD costs; a custom from–to picker (presets only, but the endpoint takes `from&to` from
day one); live polling; 5 h-block history (the usage-pace strip already owns the live
window); a per-model × per-project matrix.

## Open questions

- **Is this worth surfacing at all?** The open question, and the reason this is an idea.
  `npx ccusage` already prints per-project daily tables from the same files with zero
  build — this only earns its place if having it *in* the dashboard, next to the sessions
  it explains, is worth the surface. No variant picked yet either.
- **bug-1 is a prerequisite in spirit, not in code.** A new parser can dedup correctly
  from day one without touching `analyze.ts`. But shipping this while the Analytics tab
  still prints 1.7–2.6× inflated numbers means **two token readouts in one app that
  disagree**, which is worse than either alone. Fix bug-1 first, or ship them together.
- **Where does the weighting live** — server (one authoritative number, but bakes a
  pricing assumption into the API) or client (a UI concern, but every consumer
  re-derives it)? Leaning server, exposed alongside the four raw totals so the weighting
  is never the only thing on offer.
- **Project identity is the directory name**, so a moved or renamed project appears as
  two projects, and two checkouts of the same repo appear as one. Probably acceptable;
  worth confirming before anyone reads the numbers as authoritative.
- **Does the 5-theme constraint make B's series colors expensive?** The validation above
  was run against Midnight's strip only. Amber CRT is deliberately monochrome — a 4-series
  stacked chart may be unable to carry identity by hue there at all, which would push B
  toward texture or direct labels on that theme.
