---
id: bug-21
title: Management project rail lists git worktrees as projects
created: 2026-09-08
tags: management, worktrees, ui
updated: 2026-09-23T08:17:49Z
started: 2026-09-23T08:10:31Z
execute-elapsed: 438
execute-tokens: 36782
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

`listRecentProjects` (`server/lib/management.ts:422`) derives its rows from `~/.claude/projects/*` transcript dirs, and a session that chdir's into a
worktree writes a transcript into that worktree's own encoded dir. That dir is then indistinguishable, to this function, from a real project: it has a newest
transcript inside the window and a cwd that `encodeProjectDir` matches, which is the entire membership test. Nothing consults the filesystem at the row's
`path` at all — neither "is this a linked worktree?" nor "does this path still exist?".

The second question turns out to be the bigger one. Probed live on 2026-09-22 (this machine, `lookbackHours: 336`): 9 rows, of which 1 is a checked-out
linked worktree (`backlog-manager/.worktrees/task-47`, `.git` is a file) and 4 are paths that no longer exist on disk — three pruned worktrees
(`guide-manager/.worktrees/5`, `backlog-manager/.worktrees/task-48`, `claude-agents-dashboard/.worktrees/bug-22`) and one deleted repo
(`custom-projects/claude-global`). An orchestrator run merges and prunes its worktrees, so after a run almost every worktree row is a dead path: a
worktree-only detection rule would have removed 1 of the 4 throwaway rows seen here.

## Fix

Filter the rows `listRecentProjects` returns by what is on disk at each row's `path`. Hide dropped rows outright — no folding under the parent repo and no
"N worktrees" badge: the Sessions tab already shows a run's worktree sessions live, and Management lists *config*, which a worktree only duplicates from the
branch it was cut from. Pure `fs` reads, no `git` subprocess, no new dependency — the scanner stays disk-only.

**The rule.** Drop a row when either holds; keep it otherwise:

1. `path` is not an existing directory (pruned worktree, deleted or moved repo). Any `stat` error counts as "not there".
2. `path/.git` is a regular **file** whose `gitdir:` line points at a directory inside a `worktrees/` segment of a git dir
   (`gitdir: /r/.git/worktrees/task-47`) — i.e. a linked worktree, wherever it sits (`.worktrees/`, `.claude/worktrees/`, or a sibling from
   `git worktree add ../foo`). A `.git` file pointing elsewhere is a submodule (`gitdir: ../.git/modules/sub`) and is kept. A `.git` file that cannot be read
   or has no `gitdir:` line is kept — fail open, the same stance as the naming fallback above it.

A `.git` directory, or no `.git` at all (e.g. `~/.claude/dashboard-refresh`, which is a real non-git project dir), is kept.

**Where.** Apply the filter to the final deduped set, after the `byCwd` loop and before the sort, so the bug-14 naming rule (`management.ts:443-457`) is
untouched: it still decides *which* cwd a dir publishes, and only then is that cwd asked whether it belongs on the rail. Keep it a small named, exported
predicate (e.g. `isListedProjectPath(path): boolean`) so tests can hit it directly; the name is the implementer's call.

**Knock-on effects — all accepted, none needs extra code:**

- `resolveProject` shares the list, so a worktree's or dead path's `dirName` stops resolving: `POST /api/spawn` answers `400 unknown project` for it (correct
  — spawning into a pruned path fails anyway, and into a live worktree is not what the dropdown is for), and `GET /api/management/project` answers 404. The
  client already copes: `useManagementScope.tsx:53` treats a persisted `management.scope` that is no longer in `projects` as unknown and falls back to
  `'global'`. Resume (`api.ts:1388`) builds its ref from the transcript, not from `resolveProject`, so resuming a worktree session is unaffected.
- `collectServablePaths` shares the list too, so a worktree's own `.claude/` files stop being servable. Unlike the archived-session filter (which
  `docs/subsystems/management.md` deliberately keeps out of the servable set so an open panel keeps serving), nothing can hold such a file open: the rail
  never lists the worktree once this lands, and a dead path has no files. Keep the filter unconditional inside `listRecentProjects`, not an option.
- Cost: one `statSync` per row plus one small `readFileSync` for rows whose `.git` is a file — a few dozen syscalls per call at most.

**Tests** (`test/management.test.ts` unless noted; fixtures are real tmpdirs):

- Linked worktree: repo tmpdir with a `.git` dir, plus `<repo>/.worktrees/X` containing a `.git` *file* `gitdir: <repo>/.git/worktrees/X`; the worktree has
  its own project dir with a transcript. `listRecentProjects` paths equal `[repo]`; `resolveProject(<worktree dirName>)` is `null`.
- Worktree outside the repo: same, but the worktree is a separate `makeProject()` tmpdir whose `.git` file points into `<repo>/.git/worktrees/Y`. Dropped.
- Pruned path: a transcript whose cwd is a path that does not exist. Dropped; the repo row alongside it is kept.
- Submodule: `.git` file `gitdir: ../.git/modules/sub`. Kept.
- `.git` file with no `gitdir:` line (e.g. empty). Kept.
- Plain dir with no `.git`. Kept.
- The existing bug-14 tests (`management.test.ts:250-310`) build worktree cwds with `path.join(repo, '.worktrees', 'X')` that never exist on disk, so rule 1
  would drop them. They pin the *naming* rule, not worktree listing: `mkdirSync` those paths (no `.git` file) so they keep asserting exactly what they assert
  today, and reword the comment at `:288-292` that calls losing the worktree row a breakage — for a real linked worktree it is now the intended behaviour.
- `test/archived.test.ts:210-230` uses literal `/tmp/one`, `/tmp/two` cwds that need not exist; switch them to real tmpdirs so the archived-filter tests keep
  testing the archived filter. `test/api-management-analytics.test.ts:57` uses `h.home`, which exists — unaffected.
- Mutation proof: with the filter call removed, the linked-worktree, outside-the-repo and pruned-path cases must fail. Say so in the outcome.

**Docs.** Update the *Scopes* bullet in `docs/subsystems/management.md` (the "Recent projects come from transcript cwds…" sentence) to state the filter and
why worktrees are hidden rather than folded, and trim the `management.ts:443-455` comment's claim that the worktree's own dir "still yields the worktree" to
note that the row is then dropped by the filter.

In the browser (playwright MCP tools): with the dev server running, open http://localhost:5174, switch the side rail to Management, and read the project rail
and the spawn dialog's project `<select>`. Expected: no row or option whose path contains `/.worktrees/` or `/.claude/worktrees/` (the executing session's
own worktree has a transcript dir and is the live case to check), no row for a path that does not exist on disk, and `claude-agents-dashboard` itself still
listed.

## Outcome

2026-09-23 — `listRecentProjects` now filters its deduped rows through a new exported predicate `isListedProjectPath(dir)` (`server/lib/management.ts`),
applied after the `byCwd` loop and before the sort, so the bug-14 naming rule is untouched. It drops a path that is not an existing directory, and a linked
worktree (`.git` is a file whose `gitdir:` resolves to a dir whose parent is named `worktrees`); it keeps `.git` dirs, no `.git`, submodule `.git` files and
`.git` files with no readable `gitdir:` line. Pure `fs`, unconditional, so `resolveProject` and `collectServablePaths` shrink with it as the plan accepted.

Tests: four new cases in `test/management.test.ts` (linked worktree inside the repo, which also asserts `resolveProject(<worktree dirName>) === null`; worktree
outside the repo; pruned path beside a live repo; one predicate case covering submodule / empty `.git` file / `.git` dir / plain dir / a regular file). The
bug-14 tests that assert a fake worktree is listed now `mkdirSync` it (plain dir, no `.git` file) and their comment is reworded; `test/archived.test.ts`
recent-project tests use real tmpdirs instead of `/tmp/one`, `/tmp/two`.

Verification (`pnpm build` first — the fresh worktree had no `client/dist`, which made the unrelated `api-usage-rates` "near-miss path" SPA-fallback test fail
before the build; it passes after):

```
$ pnpm test   # exit 0
management: 35 passed, 0 failed
managementEntries: 11 passed, 0 failed
ALL PASS
$ pnpm typecheck
> tsc --noEmit        # exit 0
```

Live probe against this machine's `~/.claude/projects` (`listRecentProjects({ lookbackHours: 336 })`): 20 rows, `claude-agents-dashboard` listed, this
session's own worktree (`.worktrees/bug-21`) not listed (`isListedProjectPath` → false), no row matching `/.worktrees/` or `/.claude/worktrees/`, no row whose
path is missing on disk.

Not verified: the playwright browser check in the plan (Management rail + spawn `<select>` at :5174). The server on 5174 belongs to the user's main checkout
and serves main's code, not this branch; starting a second dev server from this worktree was skipped. The live probe above exercises the same function the
rail and the spawn options are built from. Needs a human look after merge.

Contract sweep: 3 sites updated (docs/subsystems/management.md Scopes bullet, server/lib/management.ts bug-14 comment + listRecentProjects JSDoc, test/management.test.ts multi-dir comment)
Red proof: 3 tests went red with the change reverted (filter call removed from `listRecentProjects`: linked-worktree, outside-the-repo and pruned-path cases; the `isListedProjectPath` predicate case was red before the function existed)
