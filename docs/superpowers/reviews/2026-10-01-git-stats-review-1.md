# Plan review 1 — Management restructure + Git Stats

- Plan: `docs/superpowers/plans/2026-10-01-git-stats.md`
- Spec: `docs/superpowers/specs/2026-10-01-git-stats-design.md`
- Reviewer: fresh subagent (Fable 5.1), read-only. Scratch repos under `/private/tmp/claude-501/` were built to check the git facts below and removed.
- Date: 2026-10-01

## Verdict: APPROVE WITH FIXES

No Critical findings. Every spec section and every §7 test case maps to a task (one half-case excepted, I9); every path the plan names exists or does
not yet exist as it says; the interfaces chain in order. The Important findings are all document fixes: two false statements about the code/git, a
hidden test breakage in Task 1, two test designs that need a seam the plan never produces, one test weaker than the spec, and two spec requirements
with no step.

## What was verified against the code

- All 36 Modify/Move paths exist; all 15 Create paths are absent (checked by `ls`).
- `test/outbound.test.ts:22` scans only `http/https/http2/net/tls/dgram` + `fetch(`; `node:child_process` is not in the set, so `git-stats.ts` leaves it
  unchanged and green as the plan requires.
- `server/index.ts:351` falls an unknown `/api/*` path through to `serveStatic`; `clientDist` is `process.cwd()/client/dist` (`server/index.ts:45`), and the
  harness chdirs to a tmpdir, so in tests the reply is the 404 `text/plain` at `server/index.ts:120`. Plan Task 1 Step 1 ("content type is not JSON, no
  status") is correct.
- `/api/pins`' neighbours (`/api/analytics`, `/api/health`, `/api/account`) are method-agnostic (`server/index.ts:129`), matching Task 5.
- `listPinRows(config, dirNames, options)` (`server/lib/management.ts:713`), `getPinnedProjects()` (`server/lib/settings.ts:294`), `PinRow`
  (`shared/types.ts:1498`, fields `dirName/name/path/lastActiveMs/listed`) all exist as consumed.
- `formatAgo` clamps at `Math.max(0, …)` (`client/src/lib/format.ts:31`) and returns `2h`, so "fetched 2h ago" / "fetched 0s ago" follow.
- `filterSort.ts` has `LAYOUTS`, `isLayout`, `WIDE_ONLY_LAYOUTS`, `layoutsFor`, `drawableLayout` (lines 73–119); `useNarrow`, `usePersistedState` exist.
- `SettingsView.tsx:177` carries the Pinned sub-line; dropping "Management and" yields Task 2's string exactly.
- `SECTIONS`/`isSection` in `client/src/lib/sections.ts`; `SubKey`/`SUBNAV` at `SideRail.tsx:70-72`; `SETTINGS_TABS` at `settings.ts:226` (module-private).
- No file under `server/`, `client/src/`, `shared/` imports from `plugin/` today (the Task 1 sweep is a guard, as spec §7:310 intends).
- Git 2.50.1 scratch checks: unborn `git init -b main` → `symbolic-ref -q --short HEAD` prints `main`, exit 0, zero refs (Task 3 row holds); staged
  rename emits two NUL fields and an untracked dir one `?? d/` entry (counting rule holds); `%(worktreepath)` is set for the main worktree's branch;
  `rev-parse --show-toplevel --path-format=absolute --git-common-dir` from a linked worktree gives the worktree and the main `.git` (spec §2 holds);
  rebase conflict → HEAD detached, `UU a`, `REBASE_HEAD` present (Task 3 row holds). **Mid-merge → HEAD still `main`, exit 0** (see I2).
- `git -c alias.e='!env' e` prints the environment through git itself (see M3).

## Checklist

| # | Item | Result |
| - | ---- | ------ |
| 1 | Coverage | All §1–§9 and Verification sections map to a task. §7 rows all map; row 288's "branches compared against `origin/develop`" half has no case (I9). §8's `.docs-sync.yml` entry has no step (I8). |
| 2 | Values | Every copy string in Task 6 matches spec §6 exactly. Task 4's warm-poll assertion is weaker than §7:296 (I5). |
| 3 | Reality | Paths and names check out. Two stated facts are false: Review Focus 1's "mid-merge … detached" (I2) and, by omission, Task 1's claim of green at the end of the task (I1). |
| 4 | Interfaces | Every Consumes is Produced earlier with the same spelling. Two tests consume things nothing Produces: a runner seam reachable through HTTP (I3) and an inspectable memo (I4). |
| 5 | Order | No forward dependency. Task 5's doc section "triage rule (Task 6)" is written before Task 6 exists (M4). |
| 6 | Tests | Red-before-green holds for every table except the plugin-import guard (a guard, intended). Review Focus 1–5 each have a test. |
| 7 | Conventions | "Behaviour not code" and soft budget are followed throughout. |

## Important

**I1 — Task 1 breaks `test/client-settings.test.ts` and does not list it** (plan, Task 1 "Files" and Step 4 "All green"). `test/client-settings.test.ts:235-242`
spells the landing picker out literally: `['last', 'sessions', 'usage', 'management', 'analytics', 'settings']`, length 6, by design ("not derived from
SECTIONS"). Task 1 swaps `management` for `configs` in `SECTIONS`, so that case fails and the "green at the end of every task" constraint cannot hold.
Task 2 then grows the list to seven and only names the file for its *new* cases.
→ Add `test/client-settings.test.ts` to Task 1's Modify list with the expected literal `['last','sessions','usage','configs','analytics','settings']`,
and in Task 2 state the seven-entry literal (`…,'management','configs',…`) and the new length. Also note that `client-settings.test.ts:87`
(`settingsTab: 'pinned'` round-trips) flips to `'local'` in Task 2.

**I2 — Review Focus 1 states a false git fact** (plan, Review Focus 1: "mid-rebase or mid-merge … HEAD is detached … Expected: `branch: null`").
Verified on git 2.50.1: during a conflicted `git merge`, `symbolic-ref -q --short HEAD` prints the branch and exits 0; `MERGE_HEAD` exists but HEAD is
not detached. Only the rebase case is detached. Task 3's test row is rebase-only, so no test value is wrong, but a reviewer applying the Review Focus
as written would expect `branch: null` from a mid-merge repo.
→ Narrow Review Focus 1 to rebase, or add a Task 3 row "Mid-merge with a conflict → `ok`, `branch: 'main'`, `detachedSha: null`, uncommitted ≥ 1".

**I3 — Task 5's API tests inject a runner that nothing exposes** (plan, Task 5 Step 1 "Runner times out for A only", "Spawn fails with ENOENT").
The route is driven through `test/api-harness.ts`, which builds the server with `createRequestListener(cfg)` and offers no injection point; the
`run?` parameter on `readGitStats(config, run?)` is unreachable from an HTTP request. The implementer must invent a seam.
→ Produce one in Task 5: an exported override in `server/lib/git-stats.ts`, on the pattern of `overrideClaudeRoots` (`server/lib/management.ts:653`),
e.g. `overrideGitRunner(run | null)`, reset in each test's teardown. Say so in Task 5's Produces.

**I4 — Two tests read memo contents the plan keeps opaque** (plan, Task 4 row "Branch deleted between reads → memo holds no key for it"; Task 5 Step 1
"the memo holds no key under B's toplevel"). Task 3 produces `GitMemo` as "an opaque `Map`", Task 4 gives the key as a tuple with no string encoding,
and Task 5 says the memo is module-level without exporting it. A test cannot assert "no key for X" without the encoding and a handle.
→ Either state the key string form (e.g. `${toplevel}\0${branchSha}\0${baseSha}`) and export the memo (or a `memoKeys()` reader) for tests, or restate
both rows as spy assertions: after the deletion/unpin, the next read makes no `rev-list`/`cherry` call naming that branch's or that toplevel's refs.

**I5 — Task 4's warm-poll test is weaker than the spec** (plan, Task 4 row "Second read, no sha moved → spy sees no `rev-list --left-right` and no
`cherry`"). Spec §7:296 says "no `rev-list`/`cherry` calls", and §2:109-115 memoises the whole merged proof, including `rev-list --merges`. The plan's
assertion passes an implementation that re-runs `rev-list --merges` every poll.
→ Change the row to "no `rev-list` of any form and no `cherry`".

**I6 — Task 7 omits four §6 rendering requirements** (plan, Task 7 Step 1 bullet list). The step enumerates behaviours, so an omission reads as a
decision. Missing: the empty-state sentence renders "Pinned" as a link (spec:242); on a phone the divergence bar drops and the numbers stay (spec:250);
`trunk: null` branches show no bar and no numbers (spec:233); all four Triage groups get a header and Can't read sits at the bottom (spec:24, 254).
→ Add four bullets to Task 7 Step 1 and a live-probe check for the phone bar drop.

**I7 — The new Management tab's wrap class has no step** (plan, Task 2 Step 3). Spec §4:178: "The new Management tab gets the plain `wrap wide`."
`client/src/App.tsx:63-65` gives any section that is not `management`/`analytics`/broad the 820px `wrap`; after Task 1 renames the old branch to
`configs`, the new `management` falls to plain `wrap` unless Task 2 adds it. Task 2 lists `App.tsx` but says nothing about it.
→ Add to Task 2 Step 3: `App.tsx` maps `management` → `wrap wide` and `configs` → `wrap wide wide-mgmt`.

**I8 — `docs/.docs-sync.yml` is not in Task 1's doc moves** (plan, Task 1 "Docs"). `docs/.docs-sync.yml:14` is `- path: docs/subsystems/management.md`,
the doc's own manifest entry, not a `sources:` path. The plan's constraint "only edit `sources:` paths when a file moves" would leave it pointing at a
file that no longer exists, and the next `/docs-sync` reports the doc gone.
→ Add `docs/.docs-sync.yml` (the `path:` entry) to Task 1's Docs list.

**I9 — Spec §7:288's branch-comparison half has no case** (plan, Task 3 row "`origin/HEAD` → `origin/develop`, no local `develop`"). The spec row also
asserts "branches compared against `origin/develop`", and §2:107 adds "No call names `refs/heads/<trunk>`". Task 3 covers trunk/`trunkVsOrigin`/`onTrunk`;
Task 4 has no row with an origin-only trunk, so an implementation that falls back to `refs/heads/develop` (which does not exist) and reports `error`
or `null` numbers passes.
→ Add a Task 4 row: origin-only trunk `develop`, branch 2 ahead of `origin/develop` → listed with `ahead: 2, behind: 0`; spy never sees `refs/heads/develop`.

## Minor

- M1 — Task 1 Step 2 says the failing cases include "the 404", but Step 1 says "Do not assert a status". Say "the content-type case".
- M2 — Global Constraints hardcode the trailer `Co-Authored-By: Claude Opus 5.5`. The executing session's attribution reminder governs; say "the
  session's attribution trailer" instead.
- M3 — Task 3 row "`defaultGitRunner` env … (spy on the spawn)": `node:child_process` is an ESM namespace and cannot be monkey-patched from a test.
  Two workable routes: export the env constant and assert on it, or run `defaultGitRunner(cwd, ['-c', 'alias.e=!env', 'e'])` and grep its stdout
  (verified: git spawns the alias with the inherited env). Name one.
- M4 — Task 5 Step 5 writes "the triage rule (Task 6)" into `git-stats.md` before Task 6 exists. Move that bullet to Task 7's doc step.
- M5 — Task 5's tests need two pins resolving to two tmp repos. `test/api-harness.ts` `plant()` writes into one fixed project dir (`-fake-proj`), and
  `POST /api/pins` is token-guarded and only accepts dirs the server enumerated. Say the test plants its own project dirs under `h.home` with
  `cwd` = each repo and pins via `setPinned` (`server/lib/settings.ts:305`).
- M6 — Spec §2:93 "Ignored files are not counted" has no test in the spec or the plan. One `.gitignore`d file → uncommitted 0 would pin it.
- M7 — The ENOENT → `'git not found'` mapping first appears in Task 5's test, but it belongs to `readRepo` (Task 3/4). Add it to Task 3's Produces so the
  reader does not invent a different message.
- M8 — Task 1 Interfaces drop `'management'` from `Section` until Task 2 restores it. Harmless on one branch, but say so, since a stored
  `dashboard.section: 'management'` falls back to the default between the two commits.

## Not verified

- The plan's claims about the mockup HTML were not checked against the mockup; the spec's "Known differences" list was taken as authoritative.
- Whether `git cherry` with full refnames behaves identically to bare names on 2.50.1 was not re-run; the plan's refname rule is consistent with git's
  documented behaviour.
