---
name: git-sync
description: >
  Does the repo's git chores in one pass, safely across two machines that share a remote: commits whatever work is lying around behind a
  secret/junk scan, syncs the trunk with origin, runs the repo's checks, pushes the trunk when they are green, and prunes branches proven merged
  (squash and rebase merges included), stale branches, leftover worktrees and stashes. Use on /git-sync, "sync the repo", "clean up the repo", "tidy branches",
  "do the git chores", or "prune merged branches". Every deletion, push of a branch and stash change is asked first, in one decision round,
  and re-proven right before it runs; anything the user did not choose is kept.
trigger: /git-sync
---

# git-sync

One run inside one repo ends with the trunk checked out, synced, verified and pushed when allowed, and every branch, stash and worktree either kept or
removed because the user chose it. The engine `tools/git-sync.mjs` does every git operation, one subcommand per phase, and prints one JSON envelope
per call; this procedure runs those calls in order and owns only three judgement steps: the commit message, the decision round, and relaying the report.
`references/design.md` is the spec and records every ruling the engine was built to.

Every call below may take `--cwd <dir>` to point at the repo; without it the engine uses the current directory. Each call prints
`{ "ok": true, "cmd": …, …payload }` or `{ "ok": false, "cmd": …, "stop": …, "detail": … }`, and mirrors it into `<stateDir>` as `<cmd>.json`.
Exit code 0 is `ok: true` and 2 is a stop. Exit code 1 prints nothing on stdout and means one of two things, told apart by stderr:

- stderr starts with `Usage:`: your own call was malformed (an unknown subcommand, a misplaced `--answers` or `--plan`). Fix the call and run it
  again, once. It is not a stop.
- anything else, usually a stack trace: an engine failure. Stop the flow there, never re-run or work around it, run `report`, and relay the report
  together with the first line of stderr. An engine failure can only follow a successful preflight, so the repo and its state dir are this run's.
  After a failure in `apply` the report may be incomplete: `<stateDir>/deleted.log` is the durable record of every deletion, one tab-separated
  `<time> <host> <branch> <local|remote> <sha>` line each, kept across runs. Name it to the user alongside the report.

**The state dir.** `<stateDir>` below always means preflight's `stateDir`, the absolute path in preflight's payload. Take it from there and never
build it yourself: it sits under the git common dir, which is not always `<root>/.git`. Preflight clears it at the start of every run, keeping only
`deleted.log` and `last-report.md`.

## Procedure

0. **Preflight.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" preflight`. It refuses a linked worktree, an operation in progress
   (rebase, merge, cherry-pick, revert, bisect), a detached HEAD, a repo without `origin`, and one whose trunk it cannot tell. Note `root`,
   `stateDir`, `trunk`, `startBranch`, `downgraded` and `warnings`. A `downgraded` repo (not GitHub, or `git-sync.push=false`) never pushes the
   trunk and never touches a remote branch; say so in one line before going on.

1. **Commit.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" stage-scan`. It runs `git add -A` and scans what is staged; a secret- or
   junk-shaped hit restores the index exactly and stops with `secret-or-junk-staged`, whose `detail.hits` name each path and reason (never the secret).
   With `clean: true` there is nothing to commit; go to phase 2. Otherwise write one conventional-commit message (`type(scope): subject`, a short body
   only when the subject cannot carry the why) from its `staged` list and `stat` alone — never read the diff — ending with the session's attribution
   trailer, to `commit-msg.txt` in `<stateDir>`, and commit on the current branch with `git -C <root> commit -F <stateDir>/commit-msg.txt`, both
   paths spelled out in full. If that commit fails (a hook, signing), stop and report it as the stop; never retry with `--no-verify` or any other flag.

2. **Sync the trunk.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" sync`. It fetches `--all --prune`, checks out the trunk and rebases
   it onto the fetched `origin/<trunk>`; `pulled` counts the commits that arrived and `switchedFrom` names the branch it left. A conflict is aborted in
   full and stops with `rebase-conflict`, `detail.files` listing the paths.

3. **Survey.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" survey`. Read-only. It classifies every branch into `protected`, `merged`,
   `gone-unproven`, `abandoned` or `active`, lists stashes and worktrees, and hands back the decision round ready to ask: `rounds` (a list of calls,
   each a list of at most 4 questions) and `followups.merged`. When `remoteKind` is `github` and `gh` is `absent`, open-PR protection was off for this
   run — a branch with an open PR can be offered as merged — so say that in one line right before the decision round, not only at the end.

4. **Decision round.** Ask every call in `survey.rounds`, in order, back to back, with nothing else in between. Pass each call to AskUserQuestion as
   given: each question's `header`, `question`, `multiSelect` and `options` (labels and descriptions) unchanged, and its `id` kept aside to map the
   answer back. Ask `followups.merged` only when the user chose `Let me pick` on the `merged` question, right after the call that held it. Without
   AskUserQuestion, follow the hard rule instead: ask in prose and skip `plan` and `apply`. Then write `answers.json` in `<stateDir>` from the chosen
   labels — branch labels are exact branch names, copied character for character:

   | Question id | Chosen label(s) | answers.json |
   | --- | --- | --- |
   | `merged` | `Delete all` / `Keep all` / `Let me pick` | `"merged": "all"` / `"merged": "none"` / from the follow-up, below |
   | `merged-pick:<n>` (follow-up) | ticked branch names, across every chunk | `"merged": [names]`; `Keep all` adds nothing, so only it ticked is `[]` |
   | `asked:<n>` | ticked branch names, across every chunk | `"asked": [names]`; `Keep all` adds nothing |
   | `push:<n>` | ticked branch names, across every chunk | `"push": [names]`; `Push none` adds nothing |
   | `stash:<sha>` | `Branch + push` / `Branch, local` / `Drop` / `Keep stash` | `"stashes": { "<sha>": "branch-push" / "branch-local" / "drop" / "keep" }` |
   | `worktree:<path>` | `Keep` / `Remove` | `"worktrees": { "<path>": "keep" / "remove" }` |

   `<sha>` and `<path>` are the rest of the id after the first `:`. A question left unanswered, or answered with free text that is not one of its
   labels, is left out of answers.json: a missing answer means keep. When `rounds` is empty there is nothing to ask; write `{}`. Then run
   `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" plan --answers <stateDir>/answers.json`, `<stateDir>` spelled out as the absolute path
   from preflight's payload. It validates every name against what was
   offered and writes `plan.json`; never write or edit `plan.json` yourself.

5. **Verify.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" verify`. It installs dependencies when needed, runs every discovered check
   even after one fails, and reports `status`: `green`, `red` or `unverified` (no checks found). On `red`, read only the last 40 lines of each failing
   check's `log` (a check with a non-zero `exit` or `timedOut`, and `install` when its `exit` is non-zero) and quote the cause in one or two lines.
   Never fix checks inside this skill, never re-run them, and carry on: red blocks the trunk push, not the rest.

6. **Push the trunk.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" push-trunk`. Not pushing is `ok: true` with a `reason`
   (`not-allowed`, `no-verify`, `stale-verify`, `red`, `rejected`, `nothing-to-push`). `rejected` covers every failed push: quote its `detail`.
   Suggest re-running /git-sync only when `detail` reads as a non-fast-forward (`fetch first`, `non-fast-forward`), which means the other machine
   pushed first; for anything else (auth, a protected branch, a missing `origin/<trunk>`) say what `detail` names instead. Never retry it here.

7. **Apply.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" apply`. It prunes stale worktree metadata, then carries out `plan.json` in a
   fixed order, re-proving each action against the live repo first. Each result is `done`, `skipped` or `failed` with a reason; one refusal never
   stops the rest. Retry nothing it skipped.

8. **Report.** `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" report`. Relay its `markdown` as-is: it already words every reason code and
   prints a recovery line for every deleted branch, so never re-derive a reason, a count or a bucket in prose. Keep its `## Warnings` visible — above
   all `gh absent: open-PR protection was off` — and add at most one line of your own: the next step for a stop, a red check or a rejected push.

## Stops

A stop is `ok: false`. Stop the flow at that phase, run `report` (it opens with `Stopped at <cmd>: <stop>`), relay it, and tell the user what to do.
Two stops are the exception: relay their envelope directly and never run `report` for them.

- `not-a-repo`: there is no repo and no state dir for `report` to read, so it would stop the same way.
- `linked-worktree`: the refusal writes nothing to the state dir it shares with the main tree, so `report` would show that tree's own run, or nothing.


| Stop | Phase | What the user does |
| --- | --- | --- |
| `not-a-repo` | any | Relay the envelope; do not run `report`. Run from inside a git repo. |
| `linked-worktree` | preflight, apply | Relay the envelope; do not run `report`. Run from the repo's main tree, not a linked worktree. |
| `in-progress-operation` | preflight | Finish or abort the rebase, merge, cherry-pick, revert or bisect named in `detail.marker`. |
| `detached-head` | preflight | Check out a branch. |
| `no-origin` | preflight and later | Add an `origin` remote; this skill works only against `origin`. |
| `no-trunk` | preflight and later | Set `origin/HEAD` (`git remote set-head origin -a`) or create `main`/`master`. |
| `secret-or-junk-staged` | stage-scan | Remove, ignore or commit by hand each hit in `detail.hits`; the index is as it was. |
| `scan-failed` | stage-scan | The scan itself failed; the index was restored. Report `detail.message`. |
| `dirty-tree` | sync | Something is still uncommitted after phase 1; commit or stash it by hand. |
| `fetch-failed` | sync | Fix network or auth for `origin`; classifying against a stale origin is unsafe. |
| `no-upstream` | sync | Set the trunk's upstream to `origin/<trunk>`. |
| `rebase-conflict` | sync | The rebase was aborted and the tree is clean; resolve `detail.files` by hand. |
| `no-survey` | plan | Survey did not complete this run; start again. |
| `bad-answers` | plan | answers.json named something the survey did not offer, or has the wrong shape; rebuild it from the table above and re-run `plan`. |
| `no-plan` | apply | Plan did not complete this run; start again. |
| `bad-plan` | apply | plan.json is malformed; start again. |
| `bad-state` | any | A state file in the state dir is unreadable (`detail.file` names it); start again. |

`bad-answers` is the one stop that is your own error rather than the repo's: correct answers.json from the labels the user actually chose — never
add a choice they did not make — and run `plan` again, once. Correcting your own mapping is not working around a stop.

## Hard rules

- Never work around a stop.
- The only git command you run yourself is git commit -F, in phase 1.
- Without AskUserQuestion, ask in prose, run verify and push-trunk, and skip plan and apply.
- Never kill a process by pattern.
- **Destructive operations happen only in `apply`, and only for what the user chose.** Deleting a branch, removing a worktree, dropping a stash and
  pushing a branch all go through the plan built from the user's answers; nothing is removed on inference.
- **Ask the survey's questions, not your own.** Never add, merge, reword or reorder questions or options: `buildPlan` accepts only what `rounds`
  offered, and the counts in the `merged` question are exactly what `Delete all` does.
