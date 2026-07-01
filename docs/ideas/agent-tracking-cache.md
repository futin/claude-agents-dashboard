# Idea: incremental cache for subagent tracking

**Status:** proposal / not implemented.
**Context:** see `docs/learning/session-and-agent-tracking.md` for how subagent
tracking works today.

## Problem

`server/lib/agents.ts` `readAgents` reads the **entire** transcript
(`fs.readFileSync`) and re-parses it from scratch every time it's called. Today
that's acceptable because it runs **on demand** (only for a selected session),
not in the 3s poll loop. But:

- It's O(file size) per call; transcripts grow without bound.
- If we ever want subagent info to be **always-live** (e.g. a per-row subagent
  count in the session list), we'd be re-walking whole files on the hot path.

## The core insight (and the trap)

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

### Correct checkpoint: the oldest still-running launch

Everything strictly before the byte offset of the **oldest unresolved (running)
launch** is fully settled and cacheable. From that offset to EOF must still be
scanned, because a pending completion could be anywhere in there. If there are
zero open launches, the checkpoint is EOF. This is a low-water mark.

## Proposed design: incremental offset-following

Because the file is append-only, don't re-read it — remember where you stopped and
read only the appended bytes.

Per-transcript state, held in memory (keyed by file path):

```
offset        bytes consumed so far
openLaunches  map: tool_use_id | agentId -> launch info (not yet resolved)
settled       finished AgentJob[] already computed (never re-parsed)
partial       trailing partial line buffered from last read
```

Each poll (or on-demand call):

1. `fstat` the file. If `size === offset`, nothing new → return the cache.
2. If `size < offset` → file truncated/rotated → reset state, re-read from 0.
3. Seek to `offset`, read `[offset, size)`, prepend `partial`.
4. Parse complete lines:
   - new launch → add to `openLaunches` as `running`
   - `tool_result` matching an open `tool_use_id` → resolve (sync completion), or
     detect the async launch ack and record its `agentId`
   - `<task-notification>` matching an open `agentId` → resolve (async completion)
   - resolved launches move from `openLaunches` to `settled`
5. Buffer any trailing partial line; advance `offset` to the last newline.

Result: cost per call is **O(new bytes)**, not O(file size). The "don't re-scan
settled jobs" caching falls out for free, and `openLaunches` keeps the long-range
launch→notification pairing alive across calls — which is exactly what the
full-file walk buys today.

## Caveats to handle

- **Partial trailing line.** Reading `[offset, size)` can end mid-JSON; buffer the
  fragment and prepend next read. (The current *tail* code deliberately drops
  partial lines — fine for a snapshot, wrong for incremental.)
- **Truncation / rotation.** `size < offset` → reset and re-read from 0. `/clear`
  creates a *new* UUID file (a new key), so it's not a mutation of an existing
  one.
- **Cold start / server restart.** In-memory state is lost on restart → one full
  read to rebuild (or persist the checkpoint to disk if we care).
- **Keep `readAgents` as the fallback.** The incremental path is an optimization
  layered on top; the pure whole-file `readAgents` stays as the cold-start /
  fallback / test oracle.

## The real tradeoff (decide before building)

`readAgents` runs on demand today precisely to keep the 3s poll cheap.
"Collect as we go while polling" means moving subagent parsing **into** the poll
loop for **every** session, continuously, even ones nobody is viewing — a small
recurring cost on the hot path in exchange for instant on-select detail and
live per-row counts.

- Worth it **if** we want subagent info always-live in the list.
- **Not** worth it if subagent detail stays a drill-in-only view — a few-MB
  `readFileSync` on selection is not a demonstrated bottleneck, and premature
  optimization adds stateful complexity (offset/inode/partial-line handling) to
  what is currently a pure function.

Recommended: only activate the incremental cache for sessions the UI actually
subscribes to, so the always-on cost scales with what's being watched, not with
the total number of transcripts on disk.
