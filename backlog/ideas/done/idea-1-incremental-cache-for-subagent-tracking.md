---
id: idea-1
title: Incremental cache for subagent tracking
created: 2026-07-01
promoted-to: task-3
---

## Problem

`server/lib/agents.ts` `readAgents` reads the **entire** transcript
(`fs.readFileSync`) and re-parses it from scratch every time it's called. Today
that's acceptable because it runs **on demand** (only for a selected session),
not in the 3s poll loop. But:

- It's O(file size) per call; transcripts grow without bound.
- If we ever want subagent info to be **always-live** (e.g. a per-row subagent
  count in the session list), we'd be re-walking whole files on the hot path.

## Rough shape

Transcripts are **append-only**: the file only grows, and a subagent that has
finished never un-finishes. So in principle we can cache settled results and only
scan new bytes.

The tempting-but-wrong version: *"checkpoint at the last finished job; never scan
below it."* This breaks because **completions do not arrive in launch order**,
specifically for background/async agents:

```
line 10   launch A  (background)         ← running
line 12   launch B  (sync)
line 15   result for B                   ← B done  ← "last finished job"
...
line 500  <task-notification> for A      ← A done, far downstream
```

If we froze the file at line 15 (last finished job), we'd permanently miss A's
completion at line 500 and report A as `running` forever. A launch stays open
until its result/notification appears, which can land anywhere after a *later*
job has already completed.

**Correct checkpoint: the oldest still-running launch.** Everything strictly
before the byte offset of the **oldest unresolved (running)** launch is fully
settled and cacheable. From that offset to EOF must still be scanned, because a
pending completion could be anywhere in there. If there are zero open launches,
the checkpoint is EOF. This is a low-water mark.

Proposed design — incremental offset-following, per-transcript state kept in
memory (keyed by file path):

```
offset        bytes consumed so far
openLaunches  map: tool_use_id | agentId -> launch info (not yet resolved)
settled       finished AgentJob[] already computed (never re-parsed)
partial       trailing partial line buffered from last read
```

Each poll (or on-demand call): `fstat`; if unchanged, return cache; if
truncated/rotated, reset and re-read from 0; otherwise seek to `offset`, read
`[offset, size)`, prepend `partial`, parse complete lines (new launch → add to
`openLaunches`; matching `tool_result` or `<task-notification>` → resolve into
`settled`), buffer the trailing partial line, advance `offset` to the last
newline. Cost per call becomes O(new bytes), not O(file size).

Caveats: a partial trailing line must be buffered and prepended next read (the
current *tail* code deliberately drops partial lines — fine for a snapshot,
wrong for incremental); `size < offset` means truncation/rotation → reset (`/clear`
creates a new UUID file, not a mutation of an existing one); in-memory state is
lost on server restart → one full read rebuilds it; `readAgents` stays as the
whole-file fallback / cold-start / test oracle.

## Open questions

The real tradeoff to decide before building: `readAgents` runs on demand today
precisely to keep the 3s poll cheap. "Collect as we go while polling" means
moving subagent parsing **into** the poll loop for **every** session,
continuously, even ones nobody is viewing — worth it *if* we want subagent info
always-live in the list; *not* worth it if subagent detail stays a drill-in-only
view, since a few-MB `readFileSync` on selection is not a demonstrated
bottleneck and premature optimization adds stateful complexity (offset/inode/
partial-line handling) to what is currently a pure function.

**Resolved during grooming (2026-08-24):** scope narrowed to the detail
endpoint only — see `promoted-to: task-3`. The 3s list poll stays on the
whole-file `readAgents` path; the incremental cache activates only for a
session the UI has actually selected.
