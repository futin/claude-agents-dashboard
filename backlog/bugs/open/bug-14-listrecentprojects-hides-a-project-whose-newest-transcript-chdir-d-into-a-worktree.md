---
id: bug-14
title: listRecentProjects hides a project whose newest transcript chdir'd into a worktree
created: 2026-09-02
tags: management, worktrees
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
