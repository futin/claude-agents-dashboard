---
id: bug-21
title: Management project rail lists git worktrees as projects
created: 2026-09-08
tags: management, worktrees, ui
---

## Symptom

The Management tab's project rail shows every git worktree that has been active in the
lookback window as its own project row, so one orchestrator run turns into dozens of rows
named `bug-10`, `bug-11`, `task-3`… all of them the same repo. The real project is pushed
down or off the visible rail, and each worktree row serves near-identical config (the
repo's own `.claude/` as it stood on that branch), which is not information anyone wants
listed N times.

The same `ProjectRef[]` also feeds the spawn `<option>`s (noted in the comment at
`server/lib/management.ts:452`), so the spawn project dropdown carries the same
throwaway worktree paths — several of which no longer exist on disk once the run has
merged and pruned them.

## Repro

1. Run `/backlog-orchestrate` on any repo that uses `.worktrees/<id>` (backlog-manager
   is the loudest example on this machine).
2. Within the lookback window (`lookbackHours`, default 24) open Management.
3. The rail lists one row per worktree. Today, with no worktrees checked out at all
   (`git worktree list` shows only the main checkout), `~/.claude/projects/` still holds
   the transcript dirs for ~30 of them:
   `-Users-andrejajevtic-Documents-custom-projects-backlog-manager--worktrees-bug-10`,
   `…-bug-11`, `…-bug-12`, and so on, plus
   `…-backlog-manager--claude-worktrees-agents-dispatch`.

## Affects

- `server/lib/management.ts:422` — `listRecentProjects`; one entry per project dir with a
  resolvable cwd, no notion of a worktree.
- `server/lib/management.ts:443-452` — the bug-14 comment that deliberately makes a
  worktree's own dir resolve to the worktree. That behaviour is correct for *resolution*
  and is what this fix must not break; the question is only whether such an entry belongs
  in the published list.
- `server/lib/management.ts:471` — `resolveProject`, which looks up by membership in that
  same list, so anything filtered out of the list also stops resolving.
- `server/lib/management.ts:481` — `collectServablePaths`, which reads a project scope per
  entry; a filter shrinks the served path set too (fewer scopes scanned per request — a
  side benefit, but it means a worktree's own config files stop being servable).

No worktree detection exists anywhere in `server/` today: the only `worktree` hits are the
four comment lines above plus `scan.ts:157`, `scan.ts:487` and `transcript.ts:78`, all
prose.

## Cause

`listRecentProjects` derives its rows from `~/.claude/projects/*` transcript dirs, and a
session that chdir's into a worktree writes a transcript into that worktree's own encoded
dir. That dir is then indistinguishable, to this function, from a real project: it has a
newest transcript inside the window and a cwd that `encodeProjectDir` matches, which is
the entire membership test. Nothing consults git, so "is this cwd a linked worktree of a
repo I already list?" is a question the code never asks.

## Fix

unknown — needs a groom decision on the detection rule and on what happens to a
worktree's `dirName` afterwards. Candidate detection rules, cheapest first:

- **path shape**: drop a cwd whose path contains a `.worktrees/` or `.claude-worktrees/`
  segment. Zero I/O, matches both conventions seen on this machine, but hardcodes other
  people's layout and misses `git worktree add ../foo`.
- **`.git` is a file, not a dir**: in a linked worktree `<cwd>/.git` is a file holding
  `gitdir: …`. One `stat`, no git invocation, works regardless of where the worktree sits.
- **`git rev-parse --git-common-dir` ≠ `--git-dir`**: authoritative, but spawns a process
  per candidate row and adds a git dependency to a scanner that is pure disk reads today.

Open questions for the groom, beyond the rule itself:

- Hide the worktree row outright, or fold it under its parent repo (a "3 worktrees" badge)
  so an orchestrator run is still visible somewhere?
- `resolveProject` gates `/api/management/project`; if worktree dirs stop being members,
  an open Management tab pointed at one starts 404ing. Acceptable, or does resolution need
  to keep working while only the *rail* filters?
- A worktree dir whose path no longer exists on disk (pruned after a merge) is arguably a
  separate, simpler bug — filter stale paths regardless of the worktree question?
