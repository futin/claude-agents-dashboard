# Quick pull and push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template (user rule, `~/.claude/CLAUDE.md`):** this plan specifies behaviour, signatures, exact values and exact test
> *cases* — never literal code. Write the bodies and the test scaffolding yourself; where you disagree with a signature here, say so in the commit body and
> keep the names other tasks rely on. Any size figure below is a soft target, never a reason to drop a rule.

**Goal:** Pull and Push items on the Git Sync key's new split menu run plain fast-forward git on the server, with no Claude session; Sync with Claude stays.

**Architecture:** A new writer module `server/lib/git-quick.ts` behind `POST /api/git-quick` resolves the pin, re-checks preconditions, takes a per-common-dir
lock (`server/lib/git-locks.ts`, shared with fetch-all), runs git with git-fetch's never-prompt overlay, and answers a typed `GitQuickResponse`. The reader
gains one field, `trunkCheckedOutElsewhere`. The client computes menu state and result text as pure functions (`client/src/lib/gitQuick.ts`), a hook
(`useGitQuick`) owns the POST and the result line, and `GitSyncButton` renders the split + a portalled menu.

**Tech Stack:** Node + TypeScript via tsx (server, zero new deps), React + Vite (client), node-assert tests in `test/` over tmpdir git fixtures.

**Spec:** `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md` (read it whole first — the copy table and §Precedence are normative).

## Global Constraints

- No new runtime deps in `server/`. Git is launched array-form, never through a shell.
- `shared/types.ts` first, then server, then client. Cross-boundary imports are `import type`.
- Server imports use the `.js` suffix.
- `styles.css`: no literal colors or shadows below the theme-token block; new classes use tokens only; existing `.git-*` class names unchanged; never restyle a
  `.uk-*` class.
- No `title` attributes anywhere in the new UI.
- Never `--force`, `reset`, `rebase`, a merge commit, `-u`, or a push to the trunk. Pull is `--ff-only` / non-`+` refspecs only.
- Git hooks run on Pull and Push (no `core.hooksPath=/dev/null`). Per-call timeout `QUICK_TIMEOUT_MS = 60_000`.
- Env overlay for every network git call: `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=''`, `SSH_ASKPASS=''`, and `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` unless
  the user set `core.sshCommand`, `GIT_SSH_COMMAND` or `GIT_SSH` — reuse git-fetch's, never copy it.
- Copy: exact strings from the spec's copy table; plural is `1 commit` / `N commits`. Every result string starts `<repo name>: `.
- New authored prose and comments wrap at 160 columns. Comments say *why*, matching the surrounding density.
- Each new test module is registered in `test/run-all.ts`. Run one module with
  `pnpm exec tsx -e "(async () => { await import('./test/tmp-root.ts'); const m = await import('./test/<name>.test.ts'); process.exit(await m.run() > 0 ? 1 : 0); })()"`
  (written `ONE <name>` below). CI runs the full `pnpm test`; locally run only touched modules.

## Review Focus

1. **Dirty tree + fast-forward that touches a modified file** — git refuses; the user must see git's first stderr line, and nothing moved. (Task 3 test.)
2. **Linked-worktree pin whose main checkout is on the trunk** — the common case for `.claude/worktrees/*`: Pull's trunk part disabled up front; a stale
   client's click finds the trunk checked out on re-read and no move is attempted; a git refusal of the move is reported, not worked around. (Task 1 +
   Task 3 tests.)
3. **Two clicks on two worktrees of one repo** — the second is refused `busy` (409), never two gits racing on one common dir. (Task 2 + Task 4 tests.)
4. **Fetch all pressed while a quick op holds a lock** — fetch-all waits, then runs; no `lock` FetchError recorded; a quick op pressed while fetch-all waits
   gets 409. (Task 2 test.)
5. **A branch tracking another remote, or tracking `origin/<trunk>`** — Push disabled `No upstream — use Sync`; the server refuses too if asked. (Task 3 +
   Task 5 tests.)

---

### Task 1: Shared types and the reader's `trunkCheckedOutElsewhere`

**Files:**
- Modify: `shared/types.ts` (the `ok` variant of `RepoGitStats` ~1690-1730; new types after `GitStatsResponse` ~1752)
- Modify: `server/lib/git-stats.ts` (local trunk lookup ~303, ok object ~372-386)
- Modify: `test/git-stats.test.ts`, and every test/fixture that builds an `ok` `RepoGitStats` literal (typecheck finds them)

**Interfaces:**
- Produces, in `shared/types.ts`:
  - `RepoGitStats` ok variant gains `trunkCheckedOutElsewhere: boolean` — JSDoc: true when the local trunk ref is checked out in a worktree other than
    this pin's `toplevel`; false when there is no local trunk or it is not checked out anywhere else.
  - `export type GitQuickOp = 'pull' | 'push';`
  - `export interface GitQuickRequest { dirName: string; op: GitQuickOp }`
  - `export type GitQuickPartKind = 'ff' | 'move' | 'push';` — `ff`: fast-forward of the checked-out branch (trunk or not); `move`: the local trunk moved
    without a checkout; `push`: the current branch pushed.
  - `export type GitQuickPart = { kind: GitQuickPartKind; branch: string; target: string } & ({ ok: true; commits: number } | { ok: false; timedOut: boolean; detail: string })`
    — `target` is the ref moved from/to, e.g. `origin/main`, `origin/feat/x`; `detail` is git's first non-empty stderr line (trimmed, `error: ` /
    `fatal: ` prefix stripped), or `''`.
  - `export type GitQuickRefusal = 'not-ok' | 'no-origin' | 'detached' | 'in-progress' | 'fetch-running' | 'busy' | 'nothing' | 'fetch-failed';`
  - `export interface GitQuickResponse { op: GitQuickOp; repo: string; parts: GitQuickPart[]; refusal: GitQuickRefusal | null; detail: string | null; timedOut: boolean }`
    — `repo` is the pin's display name; exactly one of `parts.length > 0` / `refusal !== null` holds; `detail` and `timedOut` describe a `fetch-failed`.

- [ ] **Step 1: Write failing reader tests** in `test/git-stats.test.ts`, over `GitFixture` (clone of a bare origin):
  - `trunkCheckedOutElsewhere: main checkout on main, pin on a linked worktree → true` (add a worktree on `feat/x` with `git worktree add`, read that toplevel).
  - `trunkCheckedOutElsewhere: the pin itself on main → false`.
  - `trunkCheckedOutElsewhere: main checkout on feat/x, linked worktree pin on feat/y, main checked out nowhere → false`.
  - `trunkCheckedOutElsewhere: no local trunk (only origin/main) → false`.
- [ ] **Step 2:** `ONE git-stats` → the four fail (field missing / typecheck error).
- [ ] **Step 3: Implement.** Add the types. In `readRepo`, derive the field from `localTrunk.worktreePath` (already read via `%(worktreepath)`), compared
  after `realpathOr` with the pin's `toplevel` the same way `branches[].worktreePath` is. Fix every `ok` literal `pnpm typecheck` flags (tests, visual mock
  data) with `trunkCheckedOutElsewhere: false`.
- [ ] **Step 4:** `ONE git-stats` passes; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(git): reader reports where the trunk is checked out` (stage the touched files by name).

### Task 2: The repo lock and fetch-all's side of it

**Files:**
- Create: `server/lib/git-locks.ts`
- Modify: `server/lib/git-fetch.ts` (`tickGitFetch` ~188, `fetchAll` ~221-226, `resetGitFetch` ~148; export the env overlay ~33-41 and the user-ssh check
  inside `fetchGroup` ~291-296)
- Test: `test/git-fetch.test.ts`

**Interfaces:**
- Produces, `server/lib/git-locks.ts` (no imports from git-fetch or git-quick — it is the leaf both depend on):
  - `tryLockRepo(commonDir: string): (() => void) | null` — null when that common dir is already held; the returned release is idempotent.
  - `heldRepoLocks(): Promise<void>[]` — one promise per held lock, each resolving on that lock's release.
  - `anyRepoLockHeld(): boolean`
  - `resetRepoLocks(): void` — tests only; drops every lock and resolves its waiters.
- Produces, `server/lib/git-fetch.ts`:
  - `fetchInFlight(): boolean` — `inFlight !== null` (covers the wait-for-locks phase, not just `runningSinceMs`).
  - `promptlessEnv(cwd: string, run: FetchRunner): Promise<Record<string, string> | null>` — the overlay `fetchGroup` uses today (FETCH_ENV, plus
    `SSH_BATCH` unless the user chose their ssh); null when `git config --get core.sshCommand` exits other than 0/1. `fetchGroup` calls it instead of its
    inline copy (behaviour unchanged).

- [ ] **Step 1: Write failing tests** in `test/git-fetch.test.ts` (runner spy via `overrideFetchRunner`, clock via `overrideFetchClock`; `resetRepoLocks` in
  the module's reset):
  - `fetchAll awaits a held repo lock before running`: `tryLockRepo('/x')` held → `fetchAll(cfg)`; after `setImmediate` the spy has seen no `fetch` and
    `getFetchClock().runningSinceMs === null`, but `fetchInFlight() === true`; release → await the promise → the spy saw the fetch; the repo's
    `lastFetchFor` error is `null`, never `'lock'`.
  - `a second fetchAll while waiting joins the first` (same promise object, D6 still holds).
  - `tickGitFetch skips while a repo lock is held`: due time passed, lock held → tick → `fetchInFlight() === false`; release → tick → fetch runs.
  - `resetGitFetch with a lock held and fetchAll waiting resolves` (drops the lock, the waiting fetch-all settles, the reset returns).
  - `tryLockRepo: second lock on the same commonDir is null; another commonDir is free; release frees it; double release is harmless`.
- [ ] **Step 2:** `ONE git-fetch` → new cases fail.
- [ ] **Step 3: Implement** git-locks.ts and the git-fetch changes. Ordering in `fetchAll` (spec §Shared preconditions): the join check stays first;
  `inFlight` is assigned synchronously to a promise that first awaits `Promise.all(heldRepoLocks())`, then `runFetch`. `tickGitFetch` adds
  `!anyRepoLockHeld()` to its start condition. `resetGitFetch` calls `resetRepoLocks()` **before** it awaits `inFlight` — otherwise a test that ends with
  a lock held and fetch-all waiting on it hangs the reset.
- [ ] **Step 4:** `ONE git-fetch` and `ONE api-git-fetch` pass.
- [ ] **Step 5: Commit** `feat(git): per-repo lock that fetch-all waits for`.

### Task 3: `server/lib/git-quick.ts` — Pull and Push

**Files:**
- Create: `server/lib/git-quick.ts`
- Create: `test/git-quick.test.ts` (register in `test/run-all.ts`)
- Maybe modify: `server/lib/git-stats.ts` to export `trunkOf` if you reuse it (read-only; your call per spec §Left to the builder)

**Interfaces:**
- Consumes: Task 1 types; Task 2 `tryLockRepo`, `fetchInFlight`, `promptlessEnv`, `makeFetchRunner`.
- Produces:
  - `export const QUICK_TIMEOUT_MS = 60_000;`
  - `overrideQuickRunner(run: FetchRunner | null): void` — git-quick's own test seam, mirroring `overrideFetchRunner`; null restores the default,
    `makeFetchRunner({ timeoutMs: QUICK_TIMEOUT_MS })`. Never fetch-all's runner (its timeout is 30s). Task 3 and Task 4 tests both spy through it.
  - `runQuickOp(pin: { name: string; toplevel: string }, op: GitQuickOp): Promise<GitQuickResponse>` — runs every git call through the module's runner. Never
    throws for a git failure; it answers with a refusal or a failed part.

Behaviour, in order (each step re-reads; nothing comes from the client but `op`):
1. Read `rev-parse --show-toplevel --git-common-dir` (resolve the common dir to an absolute realpath); a failure → `not-ok`. No `origin` remote → `no-origin`.
2. Synchronously, with no `await` between them: `fetchInFlight()` → `fetch-running`; `tryLockRepo(commonDir)` null → `busy`. Release the lock in a
   `finally` covering everything after.
3. In-progress: for each of `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `rev-parse --git-path <name>` (relative
   to the toplevel) and `fs.existsSync` → `in-progress`.
4. Current branch `symbolic-ref -q --short HEAD`; none → `detached`. Trunk: same rule as the reader (`origin/HEAD`, else `main`, else `master`).
5. **Pull:** `fetch origin` with `promptlessEnv` (non-zero → `fetch-failed`, `detail` = first stderr line, `timedOut` from the runner). Then, in this order:
   - *ff part* — on the trunk: target `origin/<trunk>`; on another branch: its upstream (`rev-parse --abbrev-ref @{u}`) only when it starts `origin/` and
     is not `origin/<trunk>`. When `rev-list --left-right --count` says behind > 0 and ahead == 0: `merge --ff-only <target>`; commits = behind measured
     before (or `rev-list --count old..new` after — your call). A non-zero exit is a failed part.
   - *move part* — only when not on the trunk, a local trunk exists, `for-each-ref --format=%(worktreepath) refs/heads/<trunk>` is empty, and trunk vs
     `origin/<trunk>` is behind > 0, ahead == 0: `fetch origin <trunk>:<trunk>` (non-`+` refspec, so git itself refuses a non-ff or a checked-out branch),
     with `promptlessEnv`. A trunk checked out elsewhere at re-read time gets no move part (the menu never offered it); a checkout that lands
     between the re-read and the fetch is git's refusal, reported as a failed part, never worked around.
   - No part applies → `nothing`.
6. **Push:** branch must not be the trunk and its upstream must start `origin/` and not be `origin/<trunk>`, else `nothing`. Counts ahead > 0, behind == 0,
   else `nothing`. `push origin refs/heads/<branch>:refs/heads/<upstream minus origin/>` with `promptlessEnv` — never `-u`, `--force`, `--no-verify`.
   One `push` part, target = the upstream short name (`origin/feature/x`), commits = ahead; a non-zero exit is a failed part.
7. Hooks: do not pass `core.hooksPath`. Env = `promptlessEnv` for network calls, `{ LC_ALL: 'C' }` for local ones.

- [ ] **Step 1: Write failing tests** in `test/git-quick.test.ts`, over `GitFixture` (bare origin + clone + a second clone that pushes the "remote" commits):
  - `pull on trunk behind 1 → one ff part {branch:'main', target:'origin/main', ok:true, commits:1}; HEAD equals origin/main`.
  - `pull on feat/x tracking origin/feat/x behind 3, trunk behind 5 and checked out nowhere → [ff fix 3, move main 5]`, both refs moved, worktree still on
    feat/x.
  - `pull with a dirty file the fast-forward would overwrite → ff part ok:false, detail non-empty, HEAD unchanged, the modification still on disk`.
  - `pull with a dirty unrelated file → ff ok:true` (decided with the user).
  - `pull, trunk diverged (ahead 1, behind 1), on trunk → refusal 'nothing'; local main unchanged`.
  - `pull from a linked worktree on feat/y (no upstream) while the main checkout is on main and main is behind 2 → refusal 'nothing'; local main unchanged;
    the spy saw no `fetch origin main:main``.
  - `pull fetches first`: a commit pushed to origin after the clone's last fetch is pulled (the count is the real one).
  - `pull while MERGE_HEAD exists → 'in-progress'` (create a conflicting merge with `allowFail`).
  - `pull on detached HEAD → 'detached'`.
  - `push feat/x ahead 2 → push part commits:2, target 'origin/feat/x'; origin's feat/x equals local`.
  - `push feat/x tracking origin/feature/x ahead 1 → target 'origin/feature/x'; origin's feature/x moved, no origin/feat/x created`.
  - `push rejected as non-fast-forward (origin moved, local fetch stale so the client thought ahead-only) → ok:false, detail non-empty, origin unchanged`.
    Arrange so the *re-read* counts still say ahead-only (do not fetch before push) and the remote rejects.
  - `push on a branch tracking upstream/feat/x (another remote) → 'nothing'; nothing sent` (spy saw no `push`).
  - `push on a branch tracking origin/main → 'nothing'`.
  - `push on the trunk ahead 1 → 'nothing'` (never pushes the trunk).
  - `push runs the pre-push hook`: a `pre-push` hook that `exit 1` → failed part; origin unchanged.
  - `second op on the same common dir while the first holds the lock → 'busy'` (hold via `tryLockRepo` on the clone's common dir).
  - `op while fetch-all is in flight → 'fetch-running'` (start `fetchAll` while a lock on another dir is held so it stays in flight).
  - `runner timeout → failed part with timedOut:true` (spy runner answering `{code: -1, timedOut: true}` for `merge`).
- [ ] **Step 2:** `ONE git-quick` → fails (module missing).
- [ ] **Step 3: Implement** `runQuickOp` per the behaviour list.
- [ ] **Step 4:** `ONE git-quick` passes; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(git): fast-forward pull and push without a session`.

### Task 4: `POST /api/git-quick`

**Files:**
- Modify: `server/api.ts` (beside `serveGitFetch` ~1740)
- Modify: `server/index.ts` (route comment rows ~13-14, handler beside `/api/git-fetch` ~266)
- Create: `test/api-git-quick.test.ts` (register in `test/run-all.ts`; model on `test/api-git-fetch.test.ts`: `withServer`, `plantProject`, `setPinned`)

**Interfaces:**
- Consumes: `runQuickOp`, `GitQuickRequest`, `GitQuickResponse`.
- Produces: `serveGitQuick(config: Config, req: IncomingMessage, res: ServerResponse): Promise<void>`.

Behaviour: `refuseWrite` first (exactly as `serveGitFetch`). Body JSON `{dirName, op}`; a missing/unknown `op` or non-string `dirName` → 400
`{error:'bad request'}`. `dirName` must match a pinned project whose git read is `ok` — resolve it through the same pin list `/api/git-stats` reads, never a
client path; not pinned → 404 `{error:'not a pinned project'}`. Then `runQuickOp`; answer 409 when `refusal` is `fetch-running` or `busy`, else 200, body
the `GitQuickResponse`. A thrown error → 500 `{error:'git quick failed'}` and a `console.error` line like serveGitFetch's. Non-POST → `methodNotAllowed`.

- [ ] **Step 1: Write failing tests:**
  - `LAN peer without the token → 403 and the runner spy saw nothing` (ENV with `ANSWER_TOKEN=secret`, header `LAN`).
  - `LAN peer with Bearer secret → 200, a ff part` (trunk behind 1).
  - `GET → 405`.
  - `op 'merge' → 400; dirName not pinned → 404`.
  - `busy → 409 with refusal 'busy'` (hold `tryLockRepo` on the clone's common dir).
  - `two pins on one repo (main checkout + linked worktree): the first POST's runner spy blocks on its `fetch` until the second POST has answered → the
    second is 409 busy; release → the first is 200`.
- [ ] **Step 2:** `ONE api-git-quick` fails.
- [ ] **Step 3: Implement** the handler, route and comment row (`POST /api/git-quick → serveGitQuick`, in the existing rows' format).
- [ ] **Step 4:** `ONE api-git-quick` passes.
- [ ] **Step 5: Commit** `feat(api): POST /api/git-quick`.

### Task 5: Client logic — menu state, result text, note expiry

**Files:**
- Create: `client/src/lib/gitQuick.ts`
- Create: `test/git-quick-client.test.ts` (register in `test/run-all.ts`)

**Interfaces:**
- Consumes: `OkRepo` (client's narrowed ok repo type, as `gitSync.ts` uses), `GitQuickResponse`, `WriteAccess`, `READ_ONLY_TEXT`, `gitTracked` (move it to a
  lib module if importing a component file into a lib is not the house pattern — your call, keep the export name).
- Produces:
  - `interface QuickItem { enabled: boolean; sub: string }`
  - `interface QuickCtx { writeAccess: WriteAccess | undefined; tokenRequired: boolean | undefined; tokenStored: boolean; syncAvailable: boolean; syncState: 'idle' | 'running' | 'busy'; quickRunning: boolean }`
    — `syncState` from `phaseFor(repo)`: null / ended / failed → `idle`; running → `running`; launching / unseen, or this repo mid-`sync.start` → `busy`.
  - `quickMenu(repo: OkRepo, ctx: QuickCtx): { pull: QuickItem; push: QuickItem; sync: QuickItem }`
  - `quickResultLine(res: GitQuickResponse): { text: string; tone: 'ok' | 'warn' }`
  - `quickFailureLine(repoName: string, kind: 'refused' | 'failed'): { text: string; tone: 'warn' }` — 403 / network; reuse the existing refusal copy in
    `client/src/lib/writeRefusal.ts` / `gitClock.ts` for the wording.
  - `QUICK_NOTE_TTL_MS = 30_000`; `quickNoteExpired(noteAtMs: number, pollAtMs: number): boolean` — true when `pollAtMs - noteAtMs > QUICK_NOTE_TTL_MS`.

Rules (spec §Copy table and §Precedence): write access (`writeAccess === 'none'` → `READ_ONLY_TEXT`; `tokenRequired && !tokenStored` → `Needs the Answer
token`) → sync not idle (`Sync is running`) → detached (`Detached HEAD`) → per-op. Pull parts from stats: ff-trunk (on trunk, `trunkVsOrigin` behind>0 ahead 0),
ff-current (not trunk, upstream `origin/*` ≠ `origin/<trunk>`, counts behind>0 ahead 0), move (not trunk, `trunkVsOrigin` behind>0 ahead 0,
`!trunkCheckedOutElsewhere`). Pull and Push read `Sync is running` whenever `syncState !== 'idle'`. Sync
item (same effect as the left half): `!syncAvailable` → disabled `This host can't start sessions`; `syncState === 'busy'` or `quickRunning` → disabled,
sub `Commit, check, push, prune branches`; otherwise enabled with that sub (while running it opens the chat).

- [ ] **Step 1: Write failing tests** (`ok(...)` helper builds an `OkRepo` with sane defaults: on `main`, trunk `main`, origin, `trunkVsOrigin {0,0}`,
  `currentVsUpstream null`, `trunkCheckedOutElsewhere false`; ctx default open/`syncAvailable` true/not busy):
  - pull sub-lines: on trunk behind 1 → enabled `Fast-forward main by 1 commit`; on `fix/x` upstream `origin/fix/x` behind 3, trunk {0,0} → `Fast-forward
    fix/x by 3 commits`; on `fix/x` no upstream, trunk behind 5 → `Move main forward 5 commits`; both → `fix/x by 3 · main by 5`.
  - pull blocked: on `fix/x` trunk behind 5 + `trunkCheckedOutElsewhere` + no upstream → disabled `main is checked out in another worktree`; same but upstream
    `origin/fix/x` with counts null → `Upstream gone — use Sync`; upstream diverged {1,1} → `fix/x has diverged — use Sync`; on trunk diverged → `main has
    diverged — use Sync`; on trunk {0,0} → `Nothing to pull`; on trunk ahead 2 behind 0 → `Nothing to pull`; `fix/x` diverged but trunk behind 5 and free →
    enabled `Move main forward 5 commits`.
  - push: `feat/x` upstream `origin/feat/x` ahead 2 → enabled `2 commits to origin/feat/x`; ahead 1 → `1 commit to origin/feat/x`; on trunk ahead 1 →
    `main is PR-only — use Sync`; on trunk {0,0} → `Nothing to push`; no upstream → `No upstream — use Sync`; upstream `upstream/feat/x` → `No upstream — use
    Sync`; upstream `origin/main` → `No upstream — use Sync`; counts null → `Upstream gone — use Sync`; diverged → `feat/x has diverged — use Sync`; ahead 0 →
    `Nothing to push`.
  - precedence: `writeAccess 'none'` + pullable → both disabled with `READ_ONLY_TEXT`; token required, not stored → `Needs the Answer token`; `syncState 'running'` →
    `Sync is running`; detached (`branch null`) → `Detached HEAD` for both.
  - sync item: `syncAvailable false` → disabled `This host can't start sessions`, pull still enabled; available → enabled `Commit, check, push, prune
    branches`; `syncState 'running'` → sync enabled, pull and push disabled `Sync is running`; `syncState 'busy'` → sync disabled; `quickRunning` → sync
    disabled.
  - result lines, repo `guide-manager` unless named: one ff into main 1 → `claude-global: pulled 1 commit into main.` (ok); one move 5 → `guide-manager:
    moved main forward 5 commits.`; ff fix/x 3 + move 5 → `guide-manager: pulled 3 commits into fix/x, moved main forward 5.`; move 5 ok + ff fix/x failed
    `detail D` → `guide-manager: moved main forward 5 commits; fix/x refused — D. Use Sync.` (warn); ff fix/x 3 ok + move failed `D` → `guide-manager: pulled
    3 commits into fix/x; main refused — D. Use Sync.` (warn); both parts failed (`D1`, `D2`) → `guide-manager: git refused — D1. Use Sync.` (warn, first
    failed part's detail; the line stays one sentence); push 2 → `claude-agents-dashboard: pushed 2 commits to
    origin/feat/x.`; single failed part `D` → `claude-global: git refused — D. Use Sync.` (warn); failed part timedOut → `claude-global: git took over 60s
    and was stopped. Use Sync.`; refusal fetch-running → `claude-global: a fetch is running — try again in a moment.`; refusal fetch-failed timedOut → the
    timeout line; refusal `busy` → `claude-global: another pull or push is running on this repo — try again in a moment.`; `in-progress` →
    `claude-global: a merge, rebase or similar is in progress. Use Sync.`; `detached` → `claude-global: detached HEAD. Use Sync.`; `nothing` (op pull) →
    `claude-global: nothing to pull.`; (op push) → `claude-global: nothing to push.`; `fetch-failed` with detail D → `claude-global: fetch failed — D. Use
    Sync.`; `not-ok`/`no-origin` → `claude-global: can't read this repo. Use Sync.`. All refusals are `warn`; a response whose every part is ok is `ok`.
    (The busy / in-progress / detached / nothing / fetch-failed / not-ok strings are this plan's calls — the spec's table has no row for them.)
  - `quickNoteExpired(0, 30_000) === false`, `quickNoteExpired(0, 30_001) === true`.
- [ ] **Step 2:** `ONE git-quick-client` fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** passes; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** `feat(git): quick menu state and result copy`.

### Task 6: Split key, menu and result line

**Files:**
- Create: `client/src/hooks/useGitQuick.ts`
- Create: `client/src/components/management/GitQuickMenu.tsx`
- Modify: `client/src/components/management/GitParts.tsx` (`GitSyncButton` ~41, `GitKeys` ~127), `GitBranches.tsx` (~68), `GitInspector.tsx` (footer ~196
  keeps the plain key), `GitView.tsx` (hook + note + expiry), `gitLayoutProps.ts` (add `quick`), whichever layouts pass `sync` to `GitKeys`
- Modify: `client/src/styles.css` (new classes after the existing `.git-sync*` rules; tokens only)

**Interfaces:**
- Consumes: Task 5 functions, `GitQuickRequest`/`GitQuickResponse`, `authHeaders`, `useAnswerToken`.
- Produces:
  - `useGitQuick(tokenRequired: boolean | undefined, writeAccess: WriteAccess | undefined, onDone: () => void): GitQuickControl` with
    `interface GitQuickControl { run(repo: OkRepo, op: GitQuickOp): void; runningFor(repo: RepoGitStats): GitQuickOp | null; note: { text: string; tone: 'ok' | 'warn'; atMs: number } | null; clearNote(): void; tokenStored: boolean }`
    — one POST per repo at a time (keyed by `toplevel`), no-op on a read-only network / missing token like `useGitFetch.start`; sets `note` from
    `quickResultLine` (200/409 with a JSON body) or `quickFailureLine` (403 → refused, other → failed); calls `onDone` after every answer.
  - `GitLayoutProps.quick: GitQuickControl`.
  - `GitSyncButton` gains `quick?: GitQuickControl`. Absent → today's plain key, unchanged (Inspector footer passes none). Present → the split.

Behaviour (spec §The UI): split = existing key (same classes/label/behaviour; additionally disabled while `quick.runningFor(repo)` is non-null) + a caret
button (`.git-split-caret`, `aria-haspopup="menu"`, `aria-expanded`, label `More sync options for <repo>`). Rendered when `canSync(repo)` and `quick` given,
even if `!sync.available` (then the left half is disabled). While a quick op runs on the repo, the caret shows the spinning glyph in the `.on` look and does
not open. Menu (`GitQuickMenu`): portal into `document.body`, `position: fixed` under the caret (flip above when it would leave the viewport), `role="menu"`,
items `role="menuitem"` with `aria-disabled`, label + sub-line, a divider before Sync with Claude. Opens focused on the first enabled item; ArrowUp/Down move
between enabled items; Enter/Space runs; Escape closes and returns focus to the caret; outside `pointerdown`, scroll (capture) and resize close it. Every
click/keydown inside stops propagation so the row never toggles. Sync with Claude does what the left half does (`sync.start(repo)` or open the chat).
Result line: in `GitView`, `{quick.note && <div className={...}>}` beside the other notes — `warn` uses the existing `.git-sync-note`; `ok` uses a new
`.git-quick-note` in `--ink2`. Clear it when `sync.starting` becomes non-null and when a stats poll lands with `quickNoteExpired(note.atMs, data.generatedAt)`.

- [ ] **Step 1:** Implement the hook, menu, button and wiring; `pnpm typecheck` and `pnpm build` clean.
- [ ] **Step 2:** `ONE git-sync-client` and `ONE git-quick-client` still pass; `ONE ui-kit-guard` passes (no `.uk-*` restyle).
- [ ] **Step 3: Commit** `feat(git): split Sync key with Pull and Push`.

### Task 7: Docs, CLAUDE.md and the outbound pin

**Files:**
- Modify: `.claude/CLAUDE.md` ("Keep new deps out of `server/`" paragraph — one sentence after the git-fetch one: `lib/git-quick.ts` launches `git fetch`,
  `git merge --ff-only` and `git push`, which make their own network calls — a git launch, not a third kind)
- Modify: `test/outbound.test.ts` (~115: a twin assertion that the same paragraph names `lib/git-quick.ts`)
- Modify: `docs/subsystems/git-stats.md` (new section "Quick pull and push — the writer": route, gate, lock + fetch-all ordering, preconditions, hooks run,
  60s timeout, never-force rules; §"The reader stays read-only" stays true and mentions `trunkCheckedOutElsewhere`)
- Modify: `docs/overview.md` (file map lines for `server/lib/git-quick.ts`, `server/lib/git-locks.ts`, `client/src/lib/gitQuick.ts`,
  `client/src/hooks/useGitQuick.ts`, `client/src/components/management/GitQuickMenu.tsx`, in the existing style)

- [ ] **Step 1:** Write the outbound assertion; `ONE outbound` fails.
- [ ] **Step 2:** Edit CLAUDE.md and the docs; `ONE outbound` and `ONE docs-links` pass.
- [ ] **Step 3: Commit** `docs: quick pull and push writer, server-deps line`.

### Task 8: Verification (not a code task)

- [ ] `pnpm typecheck`, `pnpm build`; `ONE` for every touched module (git-stats, git-fetch, api-git-fetch, git-quick, api-git-quick, git-quick-client,
  git-sync-client, outbound, docs-links, ui-kit-guard). Do not run the full `pnpm test` (CI does).
- [ ] Browser: worktree API on 4273 + Vite on 5273 (record the pids; kill only those), Management › Git in Matrix and Inbox: the caret opens an unclipped
  menu inside `.git-mx-wrap`, keyboard works, disabled reasons show, a real Pull on a scratch fixture repo pinned for the check (never a user repo) shows
  the result line and refreshed pills. Phone width (375): menu stays on screen.
- [ ] `pnpm test:visual` if git views are in its screens; a changed baseline caused only by the new caret is re-baselined with `pnpm test:visual
  --update-snapshots` and the diff named in the PR.

## Clarifications from plan review 1 (binding; each names the task it amends)

- **Task 1:** compare the trunk's `%(worktreepath)` with the pin's `toplevel`, after `realpathOr` on both — not with `mainWorktree`, which `branches[]` uses.
- **Task 2:** in the "awaits a held lock" case, the spy ordering is the proof; drop the `'lock'` clause (an in-memory lock never makes git see a lock file).
- **Task 3:** `trunkOf` is already exported (`server/lib/git-stats.ts:102`) and takes a `GitRunner` `(cwd, args)`; reuse it through a small adapter over the
  quick runner. `promptlessEnv` returning null → refusal `fetch-failed`, `detail` `''` (Pull) or a failed `push` part with `detail` `''` (Push). The
  `pin.toplevel` parameter is the pin row's path; `runQuickOp` re-derives the real toplevel itself (step 1). Task 3's two-part case uses `feat/x` throughout.
  The overlay `promptlessEnv` returns also carries `GIT_OPTIONAL_LOCKS=0` (via `READ_ENV`) — that is fine; Global Constraints lists the prompt-related part.
- **Task 4:** a bad body answers through the house helper `sendBadBody` (`server/api.ts`, as `/api/codegraph/run` does) with the expected shape
  `{dirName: string, op: 'pull' | 'push'}`.
- **Task 5:** `quickFailureLine(repoName, kind)` takes `kind: 'read-only' | 'bad-token' | 'failed'` — map a 403 through `refusalKind`
  (`client/src/lib/writeRefusal.ts`) — with copy `<repo>: <READ_ONLY_TEXT>`, `<repo>: the server refused the Answer token.`, `<repo>: the request failed.`;
  one test case each. The note expires on the client's own clock: `quickNoteExpired(note.atMs, receivedAtMs)` where both are client `Date.now()` (the
  note's stamp, and the moment a stats poll answered) — never the server's `generatedAt`. Pull-reason precedence: "on a branch with an upstream" means an
  *eligible* one (`origin/*`, not `origin/<trunk>`); a branch whose upstream is on another remote or is `origin/<trunk>` shows the trunk part's reason —
  add one case: `fix/x` upstream `upstream/fix/x` behind 2, trunk {0,0} → `Nothing to pull`. The Sync item is also disabled while `sync.pending` (today's key
  disables on it, `GitParts.tsx:57`); `QuickCtx` grows `syncPending: boolean`.
- **Task 6:** after an item runs, focus returns to the caret too (not only on Escape). The caret's spin honours `prefers-reduced-motion` the way the Sync
  glyph's does (`client/src/styles.css`, beside `.git-sync.on`).
- **Task 7:** `docs/overview.md` also gains a `POST /api/git-quick` row in its API table, beside `POST /api/git-fetch`.
- **Task 8:** the browser check's scratch repo is pinned by planting one transcript under a **temporary `HOME`** for the worktree server (the server reads
  `~/.claude/projects` from `HOME`), the way `plantProject` does in `test/api-git-fetch.test.ts` — never in the user's real `~/.claude/projects`; delete the
  temp dir afterwards.
- **Re-check of review 1:** Task 3 adds `move refused by git → failed move part`: a spy runner fails `fetch origin main:main` (code 1, stderr
  `fatal: refusing to fetch into branch 'refs/heads/main'`) → one `move` part `ok:false` with that detail minus `fatal: `. Task 5: an empty `detail` drops
  the ` — D` clause — `claude-global: git refused. Use Sync.`, `claude-global: fetch failed. Use Sync.`, and `fix/x refused. Use Sync.` inside the mixed
  line — one case each.
