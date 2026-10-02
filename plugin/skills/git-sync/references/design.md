# git-sync — design

Status: design approved in conversation on 2026-09-24 (approach A of three, all three sections); this file is the written spec the implementation plan
argues from. It lives beside the skill, as `preload-audit/references/design.md` does, because it describes the skill and travels with it.

## 1. Problem

Two machines — the mac (company subscription) and the WSL2 box (personal) — push to the same remotes. Every couple of days a repo gets a manual chore:
commit what is lying around, get back to the trunk, delete branches that are done, check the trunk is green, push. Done by hand, the chore skips the parts
that bite in a two-machine setup: the other box may have pushed the trunk since, a remote branch missing locally may be the other box's live work, a branch
that was never pushed and a stash are both invisible to the other box, `git branch --merged` does not see squash or rebase merges so finished branches
linger forever, and worktrees left by `backlog-orchestrate` pin branches that cannot be deleted while they exist.

## 2. Goals and non-goals

Goals:

- One command, `/git-sync`, run inside one repo, that ends with: the trunk checked out, synced with origin, verified, and pushed when allowed; every
  branch that is not provably merged still present unless the user chose to drop it; nothing lost silently.
- The user is interrupted once — a single decision round asked through AskUserQuestion, answerable from a phone — and everything after it runs unattended.
- Every destructive action is proven safe twice: when the survey classifies it, and again immediately before it runs.
- Works identically on both machines: paths from `os.homedir()` where needed, run state kept in `.git/`, nothing machine-specific committed.
- Zero dependencies, Node ≥ 20, `node --test`, same shape as `preload-audit` and `docs-sync`.

Non-goals (each weighed and set aside):

- Sweeping several repos in one run. Scope is the current repo; a sweep can later be a loop over the same script.
- Syncing `~/claude-global`. `sync.sh push|pull` stays the tool for that; run inside `claude-global`, this skill treats it like any other repo.
- Fixing red checks, resolving rebase conflicts, or force-pushing anything. Each of those stops the run and is reported.
- GitLab MR state (`glab`), tags, submodules, `git gc`. Downgraded repos (§6) get local-only triage instead.

## 3. Home and layout

```
skills/git-sync/
  SKILL.md                  procedure: run the tool, own the judgement steps, ask the decision round, report
  tools/git-sync.mjs     deterministic engine, one subcommand per phase, JSON on stdout
  test/*.test.mjs           node:test suite, one file per area, sharing the test/world.mjs fixture
  references/design.md      this file
```

Run state lives in `<git-common-dir>/git-sync/` of the target repo — never committed, never synced, per machine: `plan.json`, `verify.json`, check logs,
`deleted.log`, `last-report.md`.

## 4. Flow

| # | Phase | Owner | Behaviour |
| --- | --- | --- | --- |
| 0 | Preflight | script | Refuse (`ok:false`, `stop`) when a rebase, merge, cherry-pick or bisect is in progress, HEAD is detached, there is no `origin` remote, or the trunk cannot be determined. Record the start branch and start HEAD SHA. |
| 1 | Commit | script + model | Only when the tree is dirty. `stage-scan` stages everything and scans it (§8). A hit unstages and stops. Otherwise the model writes one conventional-commit message from the staged stat and commits on the current branch. |
| 2 | Sync trunk | script | `fetch --all --prune`; check out the trunk; rebase it onto the fetched `origin/<trunk>` (never `git pull`). A conflict runs `rebase --abort` and stops. A fetch failure stops — classifying against a stale origin is unsafe. |
| 3 | Survey | script | Read-only classification (§5) plus detected checks (§9) and the push rules (§6). |
| 4 | Decision round | model + script | Every question at once (§7), as `survey` pre-chunked them; `plan` turns the answers into `plan.json`. Skipped when nothing needs deciding. |
| 5 | Verify | script | Install when needed, run the checks, write `verify.json` keyed to the trunk HEAD SHA. |
| 6 | Push trunk | script | Only when verify is not red for this exact SHA, the trunk is ahead of origin, and push is allowed. |
| 7 | Apply | script | Execute `plan.json`, re-checking each action first (§10). |
| 8 | Report | script + model | `report` renders §12; the model relays it as-is. |

The decision round comes before verify on purpose: the user answers early and the long test run plus every change happen afterwards without them. Red checks
block phase 6 only; triage (phase 7) does not depend on the trunk being green. Destructive actions still come last, after the trunk is safe on the remote.

## 5. Branch classification

Local branches and `origin/*` branches are paired by name into one record per branch. The trunk is excluded; remotes other than `origin` are ignored.
`<ref>` below is `origin/<trunk>` after phase 2.

A branch is **merged** when any one proof holds:

| Proof | Catches | Rule |
| --- | --- | --- |
| M1 | merge, fast-forward | the tip is an ancestor of `<ref>` |
| M2 | rebase, cherry-pick | `git cherry <ref> <tip>` lists no `+` commit |
| M3 | squash merge | a synthetic commit carrying the tip's tree with the merge-base as its only parent is patch-equivalent to something in `<ref>` (the `git cherry` check again) |
| M4 | merged PR | GitHub only, when `gh` is installed and authenticated: a merged PR whose base is the trunk and whose head SHA equals the current tip. A tip that moved after the merge is not proof. |

A `[gone]` upstream is never proof on its own.

Buckets, first match wins:

| Bucket | Condition | Outcome |
| --- | --- | --- |
| `protected` | has an open PR (M4's lookup), is checked out in a locked worktree, or is the current HEAD | never offered for deletion |
| `merged` | any of M1–M4 | offered for deletion in one confirmation |
| `gone-unproven` | upstream is gone, no proof | asked, whatever its age, labelled "remote deleted, not provably merged" |
| `abandoned` | unmerged, and the newer of its local and remote tip committer dates is older than the stale threshold (default 30 days) | asked; the user picks which to delete |
| `active` | everything else | kept; if local-only or ahead of its upstream, offered for pushing |

Remote-only branches (on origin, absent locally) go through the same buckets. An `active` remote-only branch is presumed to be the other machine's work and
is never touched and never fetched into a local branch.

Stashes are listed by SHA with age, base branch and changed-file count. Worktrees are listed with branch, clean/dirty and locked state; `git worktree prune`
runs automatically at the start of `apply` (survey stays read-only) because it only clears metadata for worktrees whose directory is already gone.
A clean worktree on a `merged` branch is removed as part of that branch's deletion. A dirty worktree, or one on an unmerged branch, is asked about. A locked
worktree is never touched. A merged branch checked out in a dirty worktree leaves the merged set: it is deleted only if the user chooses to remove that
worktree, and kept otherwise.

## 6. Trunk, push and downgraded repos

- Trunk = the branch `origin/HEAD` points at; when that ref is unset, `main`, then `master`; neither → stop.
- Remote kind comes from the `origin` URL host: `github.com` → github, anything else (GitLab, self-hosted) → other.
- `pushAllowed` = remote kind is github and `git config git-sync.push` is not `false`.
- A repo with `pushAllowed` false is **downgraded**: it still gets commit, sync, verify and local triage, but the trunk is not pushed and **remote branches
  are entirely off-limits** — no remote deletion, no branch pushing, remote-only branches not even listed as candidates. Company remotes hold colleagues'
  branches; this skill must never act on them.
- Per-repo overrides are local git config, deliberately not a committed file, so a shared repo stays untouched: `git-sync.push`, `git-sync.checks`
  (a shell command replacing discovery), `git-sync.staleDays`. They are per machine and must be set on each box.

## 7. Decision round

Asked through AskUserQuestion in one sitting, before verify. The tool allows 4 questions per call and 4 options per question, so larger sets use multiSelect
questions spread over consecutive calls, still asked back to back before anything else runs.

| Question | Form |
| --- | --- |
| Delete the merged set | one question: delete all (N branches, M remote copies, K worktrees) / let me pick / keep all |
| Abandoned and gone-unproven | multiSelect of branch name, age, commits ahead, local/remote presence; ticked = delete |
| Unpushed survivors | multiSelect of local-only or ahead branches; ticked = push with upstream. Not asked in downgraded repos. |
| Each stash | branch it and push / branch it, keep local / drop / keep as stash (push option omitted when downgraded) |
| Each dirty or unmerged worktree | keep / remove, the option naming how many changed files would be lost |

Choosing to delete a branch whose worktree the user keeps is skipped at apply time by invariant 1 and reported as such. An unanswered question means
keep — no destructive or outward action happens without an answer. A session with no AskUserQuestion answers with `survey.unattended` instead (R37): the
merged set goes (`"merged": "all"`), and so does every offered worktree on a merged branch, dirty or not. Nothing else is answered, so abandoned,
gone-unproven and unpushed branches, stashes and unmerged or detached worktrees are kept and asked in prose after the report.

The `plan` subcommand turns the answers into `plan.json` (the model never writes it): a list of actions — `stash-branch`, `stash-drop`,
`remove-worktree`, `push-branch`, `delete-remote`, `delete-local` — each carrying the tip or stash SHA the survey saw (`expectTip`).

## 8. Stage and scan

`stage-scan` records the current index, runs `git add -A` and inspects the staged set. It stops, restoring the index to exactly what it was before the
scan, when it finds:

- secret-shaped paths: `.env*` (except `.env.example`/`.env.sample`), `*.pem`, `*.key`, `id_rsa*`/`id_ed25519*`;
- secret-shaped added lines: private-key headers, AWS access keys, GitHub tokens, Anthropic API keys;
- junk paths: anything under `node_modules/`, `.venv/`, `venv/`, `__pycache__/`, `.DS_Store`, or any file over 10 MB.

Output names each hit with its path and reason, never the secret itself. The model additionally reads the staged stat (names only, not the diff) before
writing the message. The commit follows the session's normal attribution rules.

## 9. Check discovery

`git-sync.checks` wins when set. Otherwise:

1. Node (`package.json`): package manager from the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lockb`). Run whichever exist, in this
   order: `typecheck` or `type-check`, `lint`, `test`. Root scripts only. Every check runs with `CI=1` so vitest and jest do not enter watch mode.
2. Else a `Makefile` with `lint` / `test` targets.
3. Else pytest when `pytest.ini` exists or `pyproject.toml` has a `[tool.pytest` section — via `uv run` when `uv.lock` exists, else `python -m pytest -q`.
4. Else no checks: verify records `unverified`, the report says so, and the trunk push is still allowed.

Install runs before the checks when `node_modules` is missing, or when the lockfile blob differs between the start HEAD and the synced trunk HEAD — the
start HEAD is what the installed tree most likely matches. It uses the frozen variant (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install
--frozen-lockfile`, `bun install --frozen-lockfile`). A failed install is red.
It runs only when the chosen checks came from `package.json`, never beside a `git-sync.checks` override or a Makefile or pytest source that won.
A check still running at the timeout, or one whose backgrounded grandchild keeps its output open past it, is a timeout: red, with its process group killed.

Each check has a 10-minute timeout. Full output goes to a log file; `verify.json` records per check the command, exit code, duration and log path, so the
model reads a log tail only when a check fails. A `.nvmrc` that does not match the active node version is a report warning, never a switch.

## 10. Safety invariants

1. Never delete a branch that is the trunk, the current HEAD, checked out in a worktree that is not being removed in the same action, or `protected`.
2. `delete-local` of a `merged` branch re-proves M1–M4 at apply time; of a user-picked branch, re-checks that the tip still equals `expectTip`. Either
   failing skips the action. A `remove-worktree` on the `merged` basis re-proves the worktree's HEAD the same way, on `origin/<trunk>`.
3. `delete-remote` uses a lease on the expected remote tip, so a branch the other machine has since pushed to is not deleted.
4. `push-branch` never forces; a non-fast-forward rejection is reported.
5. Stashes are addressed by SHA, never by `stash@{n}`, because indexes shift as others are dropped. `stash-branch` builds the branch in a temporary detached
   worktree at the stash's base, applies the stash there, commits, and drops the stash only after the branch commit exists; a conflict keeps the stash and
   skips.
6. `push-trunk` refuses unless `verify.json` exists for the current trunk HEAD SHA with a status of green or unverified.
7. Every deleted branch's name and tip SHA is appended to `deleted.log`, and the report prints one `git branch <name> <sha>` recovery line per deleted
   local branch and one `git push origin <sha>:refs/heads/<name>` per deleted remote branch.
8. The script waits only on processes it started for checks; it starts no servers and never kills by pattern.
9. Apply order: stash actions, worktree removals, branch pushes, remote deletions, local deletions. One failed action does not stop the rest.
10. Re-running the whole skill is always safe; a second run on a tidy repo changes nothing.

## 11. Errors

Every subcommand prints JSON with `ok`. `ok:false` carries `stop` (a machine-readable reason) and `detail`; the skill stops at that phase and reports — it
never works around a stop. Named stops: `in-progress-operation`, `detached-head`, `no-origin`, `no-trunk`, `secret-or-junk-staged`, `fetch-failed`,
`rebase-conflict`, `no-upstream`, plus `not-a-repo`, `linked-worktree`, `dirty-tree`, `scan-failed`, `no-survey`, `bad-answers`, `no-plan`, `bad-plan`
and `bad-state` (§15, §16). A rejected trunk push is reported with its `detail` and not retried; "re-run /git-sync" is suggested only when that
`detail` is a non-fast-forward (the other machine pushed in between), since auth, a protected trunk or a missing `origin/<trunk>` would fail again.
Exit code 1 is not a stop: with `Usage:` on stderr it is a malformed call, and anything else is an engine failure the skill stops on (R33).

## 12. Report

Printed in chat and written to `last-report.md`: committed (SHA, message, branch) · trunk (commits pulled, each check's status, pushed or why not) ·
deleted (branch, bucket, local/remote, recovery line) · kept (branch, bucket, reason) · pushed branches · stashes · worktrees · warnings (node version,
unverified, downgraded repo).

## 13. Testing

`node:test`. Each case builds its own world in a temp directory: a bare `origin`, clone A (this machine) and clone B (the other machine). `gh` is a PATH
stub returning canned JSON. Commit dates are fixed with `GIT_COMMITTER_DATE`. Cases:

- Merge proofs: fast-forward merge, true merge, rebase merge and squash merge each classify `merged`; squash followed by one more commit on the branch does
  not; a merged PR whose tip moved afterwards does not; an open PR classifies `protected`.
- Buckets: gone upstream without proof → `gone-unproven`; unmerged tip 31 days old → `abandoned`, 29 days → `active`; `git-sync.staleDays` overrides
  the threshold; a remote-only branch pushed from clone B is `active` and absent from any delete action.
- Worktrees: a locked worktree is never offered; a dirty worktree is asked about; a clean worktree on a merged branch is removed with it; `prune` clears a
  worktree whose directory was deleted.
- Stashes: `stash-branch` produces base + one commit with the stash's changes and drops the stash; a conflicting stash is kept; dropping one stash does not
  retarget an action aimed at another.
- Downgraded: an `origin` on a GitLab host yields no `delete-remote`, no `push-branch`, no trunk push; `git-sync.push=false` does the same on GitHub.
- Races: clone B pushes the trunk after A's sync → trunk push rejected and reported; clone B pushes to a branch after A's survey → `delete-remote` lease
  fails and is skipped; the local tip moves after survey → `delete-local` skipped.
- Stops: each preflight refusal; rebase conflict aborted with the tree left clean; fetch failure stops before survey.
- Stage-scan: `.env` staged, a private-key line, `node_modules/` staged, a 10 MB file — each stops and leaves the index as it was before the scan,
  including anything the user had staged by hand; `.env.example` passes.
- Checks: discovery per lockfile type, the order typecheck → lint → test, `CI=1` present in the child environment, the config override, install triggered by
  a lockfile change and skipped without one, `push-trunk` refused after a red verify and after a verify for a different SHA.
- Idempotence: a second full run on the result of the first yields an empty plan and no writes.

## 14. Decisions log

Settled in conversation on 2026-09-24, each against its alternatives:

- Scope: current repo only (not a configured list, not an auto-discovered sweep).
- Deletion: proven-merged in one confirm, abandoned by pick (not merged-only, not auto-dropping old branches).
- Red checks: stop the trunk push and report; triage still runs (not a bounded auto-fix, not a full debug hand-off).
- Non-GitHub or no-direct-push repos: detect and downgrade (not refuse, not push anyway).
- Unpushed survivors: list and ask per branch (not push all, not report only).
- Stashes: list and ask per stash (not report only, not always branch).
- Uncommitted work: auto-commit everything with one generated message, behind the stage-scan guard (not propose-and-confirm, not refuse when dirty).
- Worktrees: merged and clean go with their branch, the rest asked (not report only, not auto-commit inside them).
- `claude-global`: not bookended by `sync.sh`.
- Cadence: survey first, one decision round, then unattended (not step-by-step asks, not an editable plan file).
- Implementation: SKILL.md plus a deterministic `tools/git-sync.mjs` (not prose-only, not a bash script).
- Name: `git-sync`.

## 15. Refinements made while planning

Each was settled while the implementation plan was written; where one differs from the sections above, this one wins.

- `plan` and `report` are engine subcommands, so the model never hand-writes `plan.json` or the report; it writes only `answers.json` and the commit message.
- `survey` emits the decision round pre-chunked: `rounds` (calls of at most 4 questions, in the §7 order) and `followups.merged` (asked only on "let me pick").
- `git worktree prune` moved from survey to the start of `apply`, keeping survey strictly read-only.
- A record is merged only when every present tip — local and remote — is proven; a remote copy the other box moved on keeps the record unmerged.
- New stops: `not-a-repo`, `linked-worktree` (preflight and apply refuse a linked worktree), `dirty-tree` (sync), `bad-answers` (plan).
- Exit codes: 0 for `ok: true`, 1 for bad arguments (usage on stderr, nothing on stdout), 2 for a stop. Run state lives under `git-common-dir`, so a linked
  worktree and its main tree share one state dir.
- `push-trunk` not pushing is `ok: true` with a `reason`, never a stop.
- `verify` runs every check even after one fails, so the report shows all of them.
- `GIT_SYNC_CHECK_TIMEOUT_MS` overrides the 10-minute check timeout; it is a test-only hook, not a user setting.
- A downgraded survey omits remote-only records altogether.
- A deleted remote branch's recovery line is `git push origin <sha>:refs/heads/<name>`.
- `sync` rebases onto the fetched `origin/<trunk>` instead of running `git pull`, so the user's `pull.*` config cannot pick the strategy.
- `stage-scan` returns the staged `stat` along with the staged names, which is all the model reads to write the message.
- Merged deletions, remote as well as local, are re-proven in `apply` against `origin/<trunk>`; a downgraded survey proves against `origin/<trunk>` too,
  where a pushing one proves against the local trunk.

## 16. Implementation rulings

Rulings made while the tasks were implemented that change behaviour this spec describes. Numbers are the plan's own.

- R3 — `not-a-repo` is checked before any subcommand is dispatched, so a wrong cwd is reported as that whatever the subcommand.
- R11 — M2 and M3 also require a whitespace- and mode-exact containment gate (the net `merge-base..tip` diff reverse-applies to the ref's tree); M2 is
  refused when `ref..tip` holds a merge commit.
- R14 — a worktree's `dirty` count includes ignored paths outside a fixed junk list (`node_modules`, `.venv`, `dist`, `build`, `target`, caches …), so
  a worktree holding ignored work is not clean and not in the merged set.
- R15 — M4 counts a merged PR only when its base is the trunk; a PR merged into another branch is not proof the work reached the trunk.
- R16 — `apply` re-proves each tip it deletes on its own (local before `branch -D`, remote before `push --delete`) against `origin/<trunk>`, never
  trusting survey's `proof` label.
- R17 — a failed `gh` lookup on a GitHub remote makes a record unmergeable ("PR status unknown"); `gh` absent leaves M1–M3 standing, and the report warns
  that open-PR protection was off.
- R18 — a worktree mid-rebase or mid-bisect is never asked about and never acted on, like a locked one; its branch is `protected`.
- R19 — every question has 2–4 options; multiSelect chunks are balanced (never a 1-option chunk), and a single candidate gets a sentinel option (`Keep all`,
  or `Push none` for pushes) that names no branch.
- R20 — `apply` runs `git worktree prune` before any branch deletion.
- R21 — `push-trunk` with no `refs/remotes/origin/<trunk>` does not push: `ok: true`, `reason: 'rejected'`, with a `detail` naming the missing ref.
- R22 — `verify.json`'s `sha` is HEAD at verify time, and `push-trunk` compares it with `refs/heads/<trunk>`; a mismatch fails closed as
  `stale-verify`.
- R23 — `apply` skips `delete-remote` and `push-branch` aimed at the trunk as `protected`, as it already did `delete-local`.
- R24 — `apply` results carry an optional `detail` (git's stderr) and a null `reason` when `done`, and gain the reasons `in-progress` and
  `git-failed`. `apply` stops with `no-plan`, `bad-plan` or `linked-worktree`, and takes `--plan <file>` to run a plan other than `plan.json`.
  `lease-failed` also covers a remote branch that is already gone, so it is worded neutrally.
- R25 — a `done` stash-branch result names the new branch in `reason` and, when it was pushed, carries `push: 'done' | 'downgraded' | 'rejected'`.
  A parent-path ref blocking the name skips it as `name-conflict`, a `stash -a` holding ignored files as `stash-conflict`, and a filesystem failure
  around the temporary worktree as `io-failed`; the stash is kept in each case.
  A branch commit that fails for any reason but "nothing to commit" (no identity, a signing hook) is `failed` / `git-failed`, detail `stash kept: …`.
- R26 — a stash is dropped after `stash-branch` only when the new branch commit provably holds it exactly; otherwise the new branch is deleted, the stash
  kept, and the action skipped as `stash-conflict`.
- R28 — an unparseable state file is the stop `bad-state`; `report` alone treats it as missing and adds a warning instead.
- R29 — recovery lines POSIX single-quote any branch name holding characters outside `[A-Za-z0-9._/@+-]`, so they paste into a shell safely.
- R30 — `report`'s Deleted section reads the deleted tips from `apply.json`'s results, never by pairing against `deleted.log`.
- R31 — `preflight`'s payload carries `stateDir`, the state dir under the git common dir. SKILL.md reads it from there and never derives the path,
  which would be wrong for any `.git`-file layout and could land a message file inside the working tree.
- R32 — a `linked-worktree` refusal, from `preflight` or `apply`, writes nothing to the state dir, not even its own envelope: that dir is shared with
  the main tree, whose in-flight run it would otherwise overwrite.
- R33 — exit code 1 with `Usage:` on stderr is the caller's malformed invocation, to be fixed once; any other exit 1 is an engine failure (an
  unexpected git error rethrown by `main()`), and the skill stops, runs `report` and relays stderr.
- R34 — after `not-a-repo` or `linked-worktree` the skill relays the stop envelope directly and never runs `report`: the first leaves no state dir,
  and the second (R32) leaves this run nothing in it, so `report` would show nothing or the main tree's own run.
- R35 — `stage-scan` snapshots the index by copying the index file itself (`rev-parse --git-path index`, which honours `GIT_INDEX_FILE`) and restores
  it by renaming the copy back, never with `write-tree`/`read-tree`, so skip-worktree, assume-unchanged and intent-to-add entries survive a stop.
- R36 — `apply` writes `apply.json` on every exit once the plan is loaded. A failed `worktree prune` becomes a warning in the payload's new
  `warnings` list, which the report shows; an error inside one action that is not git's own is that action's `failed` result with reason `internal`;
  a `deleted.log` write that fails after a deletion keeps the `done` result and adds a warning; and an error outside every action writes the results
  so far as a `partial: true` apply.json before it is rethrown as an engine failure (R33). `<stateDir>/deleted.log` stays the durable record.
- R37 — with no AskUserQuestion the survey's `unattended` answers are applied, not skipped (2026-10-02, the user's call: cleaning up merged work is the
  point of the skill and needs no answer). They are built from `offered`, so `buildPlan` accepts them by construction, and they hold merged work only;
  a dirty worktree on a merged branch is removed and its changed or ignored files are lost.
