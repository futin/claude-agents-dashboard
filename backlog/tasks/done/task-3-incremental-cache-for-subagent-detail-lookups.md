---
id: task-3
title: Incremental cache for subagent detail lookups
created: 2026-08-24
from: idea-1
---

## Goal

`server/lib/agents.ts` `readAgents` re-parses the **entire** transcript from
scratch on every call. That's fine for on-demand use, but idea-1 flagged the
O(file size) cost and asked whether an incremental, offset-following cache was
worth building. Scope narrowed during grooming to the one place it's actually
needed: `GET /api/sessions/:id` (the on-demand subagent detail endpoint) —
**not** the 3s session-list poll, which stays on the whole-file path for every
session regardless of whether anyone is viewing it.

## Plan

Per-transcript state, held in memory, keyed by file path:

```
offset        bytes consumed so far
openLaunches  map: tool_use_id | agentId -> launch info (not yet resolved)
settled       finished AgentJob[] already computed (never re-parsed)
partial       trailing partial line buffered from last read
```

Correct checkpoint is the oldest still-running launch, not "last finished job"
— completions do not arrive in launch order (a background agent's
`<task-notification>` can land far downstream of a later sync agent's
result), so freezing at the last-finished point would permanently miss a
still-open background launch.

Implemented simplification vs. the idea's original design: because the
reducer's open-launch maps (`byToolUseId` / `byAgentId` in `ScanState`)
persist across calls, there is **no separate low-water-mark checkpoint at
all** — an out-of-order completion resolves against the still-registered
launch, settled jobs never re-parse, and the offset simply advances to EOF.

Each call: `fstat`; unchanged size → return cache; `size < offset` →
truncated/rotated → reset and re-read from 0; otherwise seek to `offset`,
read `[offset, size)`, prepend buffered `partial`, parse complete lines,
buffer the trailing partial line, advance `offset` to the last newline.
`readAgents` remains the whole-file oracle test fixtures are checked against.

Only the detail endpoint uses the cache; the list poll is untouched, so the
always-on cost scales with what's actually being watched rather than with the
total number of transcripts on disk — the tradeoff idea-1 flagged as the one
to settle before building.

## Test cases

`test/agents-cache.test.ts`, oracle-equivalence style against the whole-file
`readAgents`:

- oracle equivalence under chunked appends
- chunk boundary mid multibyte UTF-8 char
- half a JSON line buffered until completed
- final record without trailing newline is included
- out-of-order async completion resolves across incremental reads
- truncation resets state and matches oracle of new content
- unchanged file: consecutive calls deep-equal
- missing file → null
- LRU cap: cache size stays bounded

## Done when

`server/lib/agents-cache.ts` exists, is used by `GET /api/sessions/:id`, and
`test/agents-cache.test.ts` passes with byte-for-byte equivalence to
`readAgents` under chunked appends.

## Outcome

Shipped (scope: detail-endpoint only) prior to this backlog existing — see
`server/lib/agents-cache.ts`. Migrated into this backlog on 2026-08-24; re-ran
`test/agents-cache.test.ts` directly at migration time to confirm it still
passes:

```
=== agents-cache.ts ===

  ✓ oracle equivalence under chunked appends
  ✓ chunk boundary mid multibyte UTF-8 char
  ✓ half a JSON line buffered until completed
  ✓ final record without trailing newline is included
  ✓ out-of-order async completion resolves across incremental reads
  ✓ truncation resets state and matches oracle of new content
  ✓ unchanged file: consecutive calls deep-equal
  ✓ missing file → null
  ✓ LRU cap: cache size stays bounded

Passed: 9  Failed: 0
```
