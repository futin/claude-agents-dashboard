---
id: bug-14
title: listRecentProjects hides a project whose newest transcript chdir'd into a worktree
created: 2026-09-02
tags: management, worktrees
updated: 2026-09-04T21:11:06Z
started: 2026-09-04T21:01:26Z
execute-elapsed: 580
---

## Symptom

A project with plenty of recent Claude sessions disappears from
`GET /api/management`'s `projects[]`, so every consumer concludes it has had no
session inside `LOOKBACK_HOURS`. Downstream, backlog-manager's board disables
that project's dispatch buttons with "the dashboard cannot see
/Users/…/backlog-manager — no Claude session there inside its LOOKBACK_HOURS",
which is false.

The failure is worst exactly when it looks most wrong: a *running* session is
what triggers it. It also self-heals as soon as any main-repo session becomes
the newest again, so it reads as intermittent.

## Repro

1. In repo R, start a session and chdir into a worktree under `R/.worktrees/X`
   (EnterWorktree, or a `cd` in a Bash call). The transcript stays in
   `~/.claude/projects/<encoded R>/` — only its records' `cwd` moves.
2. Leave it as the newest transcript in that dir.
3. `GET /api/management` → `/…/R` is absent from `projects[]`, while older
   transcripts in the same dir, all carrying `cwd = /…/R`, are inside the
   lookback window.

Observed on this machine 2026-09-02. Replaying the algorithm over
`~/.claude/projects` with `now` pinned either side of a main-repo session:

```
17:40 (newest transcript in the dir was a worktree-chdir'd session): visible = False
17:44 (a main-repo session became newest):                           visible = True
```

The dir's own transcripts at that moment:

```
09-02 17:36  f4f08da0….jsonl  cwd = /…/backlog-manager/.worktrees/runs-view-redesign
09-02 15:01  3238abda….jsonl  cwd = /…/backlog-manager
09-02 14:39  5261cd95….jsonl  cwd = /…/backlog-manager
```

## Affects

- `server/lib/management.ts:418-437` — `listRecentProjects`
- `server/lib/management.ts:430` — `if (!parsed || !parsed.cwd) continue;`
- `server/lib/management.ts:436` — `path: parsed.cwd`
- `server/lib/scan.ts:372` — the sibling that already does this right

## Cause

Two compounding choices in `listRecentProjects`:

1. **Only the newest transcript per project dir is read** (`newestPerDir`), so
   one unrepresentative file speaks for the whole directory. Older transcripts
   in the same dir, still inside the window and carrying the right cwd, are
   never opened.
2. **The project's `path` is taken from `parsed.cwd` alone** — the *newest
   record's* cwd. A session launched in the repo root and later chdir'd into a
   worktree writes into the root's project dir but reports the worktree as its
   cwd, so the one dir that would have produced `/…/R` publishes `/…/R/.worktrees/X`
   instead. The `byCwd` dedupe then can't recover `/…/R`: nothing else produces it.

`ParsedTranscript.originCwd` exists precisely for this and is not consulted here.
Its own doc comment states the rule ("entering a worktree chdir's the process so
the newest cwd is the accurate one … neither is reliable alone"), and
`scan.ts:372` follows it — `[parsed.originCwd, parsed.cwd]`, matching on either,
added for bug-7. `listRecentProjects` was never brought along.

## Fix

Credit both cwds in `listRecentProjects`, the way `scan.ts:372` already does: a
session launched in a repo and chdir'd into its worktree makes *both* paths
recently active, so publish an entry for each rather than only the newest
record's. `originCwd` may be null (fail-open by design), so fall back to `cwd`
alone when it is.

That alone fixes the reported case. Consider also relaxing "newest transcript per
dir" to "newest per distinct cwd within the dir" so one wandering session can
never speak for a directory's whole history — cheaper than it looks, since
`readTranscript`'s head/tail windows are bounded.

Add a test with two transcripts in one project dir: the newer chdir'd into
`<root>/.worktrees/X`, the older at `<root>`; assert both `<root>` and the
worktree appear in `projects[]`.

## Outcome

2026-09-04 — Fixed, then corrected after review. Two passes; the second replaced
the first pass's approach outright, so only the final shape is described here.

**What ships.** `listRecentProjects` publishes, per project dir, the cwd that dir
is *named* for: of the newest transcript's launch cwd (`originCwd`) and newest
cwd, the one whose `encodeProjectDir` spelling equals the dirName, falling back
to launch-then-newest when neither matches (`server/lib/management.ts`).
`encodeProjectDir` is new and exported: Claude Code's own dir naming, every
character outside `[A-Za-z0-9]` replaced by `-`.

**Why not the simpler rules.** Both single-key rules are wrong, and each is wrong
in a way only real data showed:

- *Newest cwd* is the reported bug: a session launched in the repo and chdir'd
  into a worktree publishes the worktree, and the repo — which no other dir can
  name — vanishes.
- *Launch cwd* (what the first pass fell back to) breaks the mirror case. Probed
  live: `~/.claude/projects/-Users-…-backlog-manager--worktrees-merge-mode`, the
  **worktree's own** dir, holds a transcript whose `originCwd` is the repo. So a
  drifted session writes into both dirs, both report the same two cwds, and
  keying off the launch cwd makes the worktree's dir publish the repo, lose that
  key to the repo's own newer dir, and drop the worktree off the rail entirely.
  That was a regression the fixtures could not have caught — `dirName` does not
  reliably encode the launch cwd, which is what the first pass assumed.

The dir name is the only thing that distinguishes the two, so it is what decides.
Verified empirically before relying on it: across every project dir on this
machine, one of the newest transcript's two cwds encodes to the dirName in
**75/75** cases, 0 misses.

**Review findings, both fixed.**

1. *Duplicate `dirName`.* The first pass emitted two `ProjectRef`s per drifted
   dir, which duplicates React keys in `ScopeMenu.tsx:22`, highlights both rows,
   and gives `SpawnPanel.tsx:112` two `<option>`s with the same value. Now one
   entry per dir, so the key is unique again; `shared/types.ts` says so
   explicitly rather than leaving it implied. No client change was needed — the
   components were correct against the contract the server had broken.
2. *Ordering-dependent `resolveProject`.* The first pass claimed insertion order
   plus a stable sort put the repo in front. That guarantee was conditional and
   the reviewer was right to reject it: when an older dir already occupies the
   drifted cwd's Map slot, the pair shares one mtime and the sort preserves the
   older slot. Reproduced below. The ordering argument is gone entirely — with
   one entry per dir there is nothing to tie-break.

**Correction to the previous `## Outcome`.** It asserted that insertion order
makes `resolveProject` return the launch repo. That was conditional, not
guaranteed, and it is not how the code works now. The whole section was
rewritten rather than amended.

**Reproducing finding 2 before fixing it.** Both `readdirSync` orders are now
pinned, because which half breaks depends on which dir is walked first. With the
worktree-owning dir sorting *before* the repo's, the reviewer's exact symptom:

```
  ✗ resolveProject: an older dir holding the worktree cwd (sorting before the repo's) keeps both dirs intact
    Expected values to be strictly equal:
    actual:   '/var/folders/…/cad-proj-DgqxiC/.worktrees/X'
    expected: '/var/folders/…/cad-proj-DgqxiC'
```

Sorting *after*, the same root cause surfaces as the worktree's own dir being
swallowed (`resolveProject` → `null`) instead.

**Red before green**, second pass:

```
  ✗ encodeProjectDir matches the ~/.claude/projects naming
  ✗ listRecentProjects: each dir publishes the cwd it is named for, not the one the session drifted from
management: 29 passed, 2 failed
```

**Mutation check** — every branch of the selection is load-bearing:

```
--- mutant A: newest cwd only (the original bug-14)
management: 26 passed, 5 failed
--- mutant B: drop the dir-name match, keep launch-cwd fallback
  ✗ listRecentProjects: each dir publishes the cwd it is named for, not the one the session drifted from
management: 30 passed, 1 failed
--- mutant C: drop the fail-open fallback
management: 23 passed, 8 failed
--- restored
management: 31 passed, 0 failed
```

**Full suite + typecheck:**

```
$ pnpm test > /tmp/bug14-test3.log 2>&1; echo "TEST_EXIT=$?"
TEST_EXIT=0
$ grep -E "^(ALL PASS|FAILED)" /tmp/bug14-test3.log
ALL PASS
$ grep -c "✗" /tmp/bug14-test3.log
0
$ grep "^management:" /tmp/bug14-test3.log
management: 31 passed, 0 failed
$ pnpm typecheck; echo "TYPECHECK_EXIT=$?"
> tsc --noEmit
TYPECHECK_EXIT=0
```

**Live, on the real transcripts.** The reported dir isolated by hardlinking
`~/.claude/projects/-Users-…-backlog-manager/*.jsonl` (mtimes intact) into a temp
root, so nothing else on disk could supply the repo path, with `now` pinned one
second past its newest drifted transcript:

```
drifted newest: 2026-09-04T21:28:19.554Z
  originCwd: /Users/…/backlog-manager
  cwd      : /Users/…/backlog-manager/.worktrees/watchdog
pre-fix  publishes: [ '/Users/…/backlog-manager/.worktrees/watchdog' ]
post-fix publishes: [ '/Users/…/backlog-manager' ]
repo visible  pre-fix: false  post-fix: true
```

And whole-machine, which is what caught the first pass's regression:

```
projects: 11  unique dirNames: 11
  /Users/…/backlog-manager                     ← was hidden before the fix
  /Users/…/backlog-manager/.worktrees/merge-mode  ← the first pass dropped this
  …/task-11, …/task-12, …/bug-14, …/task-15, and 5 others
```

Replaying the report's own 2026-09-02 17:40 timestamp does **not** reproduce the
bug any more, and that is not evidence of anything: those files kept growing, so
their mtimes moved past the pinned `now` and a different file now reads as the
dir's newest. mtime history is not replayable; the isolated probe is the faithful
version.

**Deliberately not done.**

- The plan's optional second half ("newest per distinct cwd within the dir").
  With the dir-name rule it buys almost nothing, and it costs a 256 KB tail read
  of every in-window transcript on every call — including every
  `/api/management/file` request, which goes through `collectServablePaths`.
- No decoder for `encodeProjectDir`. The encoding is lossy (many paths collapse
  to one dirName), so only the encode direction is sound; the code never decodes.
- No client change. `ScopeMenu` and `SpawnPanel` key correctly off `dirName`
  once the server stops duplicating it.

**Not verified, needs a human.** Nothing ran through a running server or the
Management UI — no `GET /api/management` response inspected, no rail or spawn
dropdown rendered. Downstream, backlog-manager's board was not re-checked against
a live dashboard. The `75/75` encoding measurement is from this machine only; a
path containing characters that collide differently under the encoding (two
sibling dirs differing only in punctuation) would fall through to the fallback
rather than the name match, which is fail-open but untested against a real
collision.
