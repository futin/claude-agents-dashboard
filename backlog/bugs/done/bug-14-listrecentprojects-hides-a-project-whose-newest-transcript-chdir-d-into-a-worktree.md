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

2026-09-04 — Fixed. `listRecentProjects` now credits both of the newest
transcript's cwds (`server/lib/management.ts:427-450`), the way `scan.ts:372`'s
liveness gate already did, so a session launched in a repo and chdir'd into its
worktree publishes the repo *and* the worktree instead of only the worktree. The
launch cwd is inserted first, which — Map insertion order plus a stable sort —
is what `resolveProject` returns for that dirName, so `/api/management/project`
and a spawn's cwd stay on the repo rather than following the drift.

The plan's optional second half ("newest per distinct cwd within the dir") was
deliberately **not** done. It only buys the residual case where `originCwd` is
null *and* the newest cwd drifted, and it costs a 256 KB tail read of every
in-window transcript on every call — including every `/api/management/file`
request, which goes through `collectServablePaths`. The null-`originCwd`
fail-open is instead pinned by a test so it can't silently become a crash or a
phantom entry.

Tests: `test/management.test.ts` — the drift case, the `resolveProject`
tiebreak, and the fail-open complement. Fixture `makeProjectsRoot` grew an
optional `originCwd`. Docs: `docs/subsystems/management.md`,
`docs/subsystems/spawn.md`.

**Red → green.** Before the fix:

```
  ✗ listRecentProjects: a worktree-chdir'd newest transcript still publishes its launch repo
    launch repo missing: ["/var/folders/q9/.../cad-proj-YftWO5/.worktrees/X"]
  ✗ resolveProject: a drifted dir resolves to its launch repo, not the worktree
  ✓ listRecentProjects: an unresolvable launch cwd falls open to the newest cwd alone
management: 24 passed, 2 failed
```

**Mutation check** — dropping `parsed.cwd` from the pair (`originCwd` only) fails
both directions, so neither test is decorative:

```
--- mutant: originCwd only
  ✗ listRecentProjects: a worktree-chdir'd newest transcript still publishes its launch repo
  ✗ listRecentProjects: an unresolvable launch cwd falls open to the newest cwd alone
management: 24 passed, 2 failed
--- restored
management: 26 passed, 0 failed
```

**Full suite + typecheck:**

```
$ pnpm test > /tmp/bug14-test.log 2>&1; echo "EXIT=$?"
EXIT=0
$ grep -E "^(ALL PASS|FAILED)" /tmp/bug14-test.log
ALL PASS
$ grep -c "✗" /tmp/bug14-test.log
0
$ pnpm typecheck; echo "TYPECHECK_EXIT=$?"
> tsc --noEmit
TYPECHECK_EXIT=0
```

**Reproduced on the real transcripts, not just fixtures.** The reported dir was
isolated by hardlinking `~/.claude/projects/-Users-…-backlog-manager/*.jsonl`
(mtimes intact) into a temp root — so nothing else on disk could supply the repo
path — with `now` pinned one second after its newest drifted transcript, which
is the state the report describes:

```
drifted newest: 2026-09-04T21:02:23.895Z
  originCwd: /Users/andrejajevtic/Documents/custom-projects/backlog-manager
  cwd      : /Users/andrejajevtic/Documents/custom-projects/backlog-manager/.worktrees/merge-mode
isolated transcripts at or before now: 85
pre-fix  publishes: [ '/Users/…/backlog-manager/.worktrees/merge-mode' ]
post-fix publishes: [ '/Users/…/backlog-manager',
                      '/Users/…/backlog-manager/.worktrees/merge-mode' ]
repo visible  pre-fix: false  post-fix: true
```

Replaying the report's own 2026-09-02 17:40 timestamp does **not** reproduce it
any more, and that is not evidence of anything: those transcript files kept
growing after that moment, so their mtimes have moved past the pinned `now` and
a different file now reads as the dir's newest. mtime-based history is not
replayable; the isolated probe above is the faithful version.

Not verified, needs a human: nothing was exercised through a running server or
the Management UI — no `GET /api/management` response was inspected, and the
duplicate-`dirName` pair has not been seen rendered in the side rail (two rows,
repo and worktree, both opening the repo's scope). Downstream, backlog-manager's
board was not re-checked against a live dashboard.
