# Review 2 — `2026-10-01-git-stats-design.md`

Reviewed at `d6dd41b` (the document after review 1 was addressed). Read-only: nothing in the repo was edited or staged. Git claims were checked in
throwaway repos under `/private/tmp/claude-501/gitprobe*` on git 2.50.1 (Apple Git-155), removed afterwards.

## Verdict: REVISE

No Critical. Eight Important findings; four of them (I2–I5) need a design decision in §2, not a one-line fix, which is why this is REVISE rather than
APPROVE WITH FIXES. Review 1's C1 (worktreepath on the main worktree) is fixed and verified; its I1–I7 are addressed.

## Verified true (no finding)

| Spec line | Claim | Where it was checked |
| --- | --- | --- |
| L41, D7 | `trunkOf`: `origin/HEAD`, else `main`, else `master`, remote-tracking ref before local | `plugin/skills/git-sync/tools/git-sync.mjs:179-190` |
| L53, L98-99 | M2 = cherry ≥ 1 line, all `-`, and `rev-list --merges` empty | `git-sync.mjs:732-735`; `cherrySigns` at `:646-649` (merge commits skipped, comment `:644-645`) |
| L54 | M3 writes a probe object with `commit-tree` | `git-sync.mjs:739-743` |
| L52-53 | `survey` measures ahead against `origin/<branch>` and calls `gh` | `git-sync.mjs:1027-1034`, `:762-767` |
| L46, D4 | `test/outbound.test.ts` is unaffected by a `child_process` import | `test/outbound.test.ts:21` — `NET_MODULES` is http/https/http2/net/tls/dgram only |
| L61, D3 | `listPinRows` returns rows in pin order with `path: string \| null` | `server/lib/management.ts:713-731`; `shared/types.ts:1498-1509` |
| L143 | `/api/pins` is routed in `server/index.ts`, handlers in `server/api.ts` | `server/index.ts:202`; `server/api.ts:1613-1645` |
| L150 | Rail order and the landing picker derive from `SECTIONS` | `client/src/lib/sections.ts:11-20` and its header comment |
| L153 | `useManagementIndex` is imported by `SpawnPanel`; `ManagementSubNav` is the rail's scope tree | `client/src/components/SpawnPanel.tsx:6`; `client/src/components/SideRail.tsx:85` |
| L156-159 | Current keys are `management.collapsed` / `.type` / `.scope`; `OWNED_KEYS` is what Reset clears and already holds them | `ItemList.tsx:46`, `ManagementView.tsx:32`, `useManagementScope.tsx:47`; `useSettings.tsx:24-28`, loop at `:54` |
| L162 | `.wide-mgmt` exists; the current tab's wrap is `wrap wide wide-mgmt` | `client/src/App.tsx:63`; `styles.css` (4 hits) |
| L163 | Both named test files exist | `test/api-management-analytics.test.ts`, `test/management.test.ts` |
| L168-173 | `SubKey`/`SUBNAV` hold `usageTab`/`settingsTab`; `SettingsTab` includes `'pinned'`; the validator's fallback is `local` | `SideRail.tsx:70-74`; `client/src/lib/settings.ts:49, 140, 226, 252` |
| L170-171 | Settings' Pinned band reads "Settings · Pinned" / "Projects that stay in Management and the launch sheet…" | `client/src/components/settings/SettingsView.tsx:176-177` |
| L185 | `LAYOUTS`, `WIDE_ONLY_LAYOUTS`, `drawableLayout` exist as described | `client/src/lib/filterSort.ts:73, 103, 118-119` |
| L203 | `--amber`, `--mustard`, `--cyan`, `--green` exist in every theme block | `client/src/styles.css:20-23, 50, 62, 73, 101` |
| L295-303 | `docs/subsystems/management.md`, `settings.md`, `view-persistence.md`, `remote-access.md` exist; `/api/management/file` is named in `remote-access.md:34` and `scripts/tailnet.ts:60`; DESIGN.md §8.5 at `:319`; CLAUDE.md's rail line | all read |
| L17 | The plugin spec's Phase 1 row says "reuses P's git-sync engine" | `docs/superpowers/specs/2026-10-01-dashboard-plugin-design.md:11` |
| L89 | `%(worktreepath)` is set for the main worktree too | probe: `refs/heads/main /…/work` printed from the main worktree |
| L84-85 | `status --porcelain=v1 -z` emits two NUL fields for a rename and one `?? dir/` for an untracked dir | probe: `R  c\0b\0?? d/\0` |
| L75, L87 | `symbolic-ref -q --short HEAD` prints the name on an unborn HEAD (exit 0) and exits 1 when detached | probe |
| L97 | `rev-list --left-right --count base...branch` prints base-only (behind) then branch-only (ahead) | probe: `2\t1` |
| L264 | A single cherry-picked commit shows as `-` in `git cherry` | probe |
| L63 | `GIT_OPTIONAL_LOCKS=0` leaves no `index.lock` behind `git status` | probe |

## Critical

None.

## Important

### I1 — `test/plugin-manifest.test.ts` does not pin "the server never imports plugin/" (L51)

The test's five cases (`test/plugin-manifest.test.ts:33-58`) pin the manifests and what directories/skills live under `plugin/`. None of them reads
`server/` or asserts anything about imports. The rule itself is real — `.claude/CLAUDE.md` Orientation says `plugin/` is "never imported by server or
client at runtime" — but the sentence credits a test that does not exist, and an implementer told "the test already covers it" will not write one.
Note also that the plugin spec (`2026-10-01-dashboard-plugin-design.md:58, 140`) still says Phase 1's server "can `import`" the engine; D6 reverses
that without saying so.

→ Cite CLAUDE.md's rule instead of the test; if the rule is to be pinned, add it to the §7 sweep (no `plugin/` specifier under `server/`). Mark the
plugin spec's L58/L140 superseded in §8.

### I2 — `PinRow.listed` is never mentioned; a pin can reach git with a path that is a linked worktree (L61, L113, L115)

`PinRow` (`shared/types.ts:1498-1509`) carries `listed: boolean`, false for "a dead pin: its cwd is gone **or is now a linked worktree**". The
listing filter (`server/lib/management.ts:730-736`) drops linked worktrees on purpose, so a pin with `listed: false` and a non-null, existing path
is exactly a pin whose cwd is a linked worktree. The spec's only dead-pin rule is `path: null` (L61, L115); such a pin passes `fs.stat` and
`rev-parse` and is reported `ok` — with the inverted badge and the wrong FETCH_HEAD described in I3 and I4.

→ State what Git Stats does with `listed: false`: either skip it as `missing` (matching every other list), or poll it and define the worktree and
fetch semantics for it (I3, I4).

### I3 — For a linked-worktree pin the badge rule inverts (L89-91, L269)

Probe, pin = linked worktree `wt` with `feat` checked out, main worktree `work` with `main`:

```
rev-parse --show-toplevel --absolute-git-dir   → /…/wt   /…/work/.git/worktrees/wt
for-each-ref %(worktreepath)                   → refs/heads/feat /…/wt     refs/heads/main /…/work
```

Under L90 ("`worktreePath` is that path when it differs from the repo toplevel"), `feat` gets `null` and `main` — checked out in the **main**
worktree — gets the badge. L91's "only branches checked out in a linked worktree get the badge" is false for this pin, and §7's case at L269
(a main-worktree pin) cannot catch it.

→ Compare `%(worktreepath)` against the main worktree, not the pin's toplevel: `rev-parse --path-format=absolute --git-common-dir` (its parent) or
the first entry of `worktree list --porcelain`. Add the linked-worktree-pin case to §7.

### I4 — `FETCH_HEAD` is per-worktree, so "fetched" is wrong whenever a fetch ran in another worktree (L79, L130, L279)

Probe: `git fetch` run inside the linked worktree wrote `work/.git/worktrees/wt/FETCH_HEAD`; `work/.git/FETCH_HEAD` did not exist. `origin/*` refs
are shared, so the remote data *is* fresh, but `<git-dir>/FETCH_HEAD` — the main worktree's for a normal pin, `worktrees/<n>/` for a worktree
pin — reports "never fetched" or a stale age. On this machine orchestrator sessions run in linked worktrees, so this is the common case, not a
corner.

→ Read the newest mtime over `<common-dir>/FETCH_HEAD` and `<common-dir>/worktrees/*/FETCH_HEAD`, or keep the single file and say in the copy and
in `docs/subsystems/git-stats.md` that only fetches from the main worktree count. Add a §7 case either way.

### I5 — A trunk that exists only as `origin/<trunk>` turns the whole repo into `error` (L129, L213-216, L106)

D7 resolves the trunk from the remote-tracking ref first, so `origin/HEAD → origin/develop` with no local `develop` yields `trunk: 'develop'`
(probe #9: `show-ref refs/heads/develop` exits 1). L129 lists `trunkVsOrigin: null` for "no origin, no trunk, or no `origin/<trunk>`" — not for
"no local `<trunk>`". The trunk's own row (L106) then runs `rev-list … refs/heads/develop`, which fails, and L66 maps an unexpected exit to
`error`: a repo in a D7-sanctioned state reads "Couldn't read: …". The copy table has no row for it either.

→ Add "no local `<trunk>`" → `trunkVsOrigin: null`, base stays `origin/<trunk>` for the branches, and a copy row (e.g. "`<trunk>` not checked out
here"). Add the §7 case.

### I6 — Process fan-out is unbounded (L65, L97-99, L131-132)

"Repos are read in parallel" is the only concurrency rule. Per repo the first poll runs 2–3 calls per unmerged branch (`rev-list`, `cherry`,
`rev-list --merges`) for **every** unmerged branch — the 50 cap is on the payload, and `unmergedTotal`/`mergedCount` need all of them. Whether the
per-branch calls run in parallel is unstated; a `Promise.all` over branches across six pins is hundreds of simultaneous `git` processes, and a
spawn failure (`EAGAIN`) lands as a per-repo `error` by L66.

→ State that calls within one repo run sequentially (repos in parallel), or give a concurrency cap, and add a §7 case for a repo with many
branches.

### I7 — §7's two cherry cases do not isolate the rules they claim, and one fixture cannot be built (L100-101, L266, L267)

- L267 "Branch ahead only by an empty merge of `main` into itself": on a branch at `main`'s tip, `git merge --no-ff main` answers "Already up to
  date" and creates nothing (probe). Built as a catch-up merge instead, `rev-list --merges` is non-empty, so the no-merges rule rejects it too.
- The ≥ 1 rule (L100) is unreachable under the spec's own ordering: ahead = 0 is handled first, and when ahead > 0 with no merge in range cherry
  prints one line per commit — even an `--allow-empty` commit prints `+` (probe). So no fixture exists where the ≥ 1 rule is the deciding one.
- L266 "merge of another **unmerged** branch": cherry prints `+` for that branch's commit (probe #4, `viamerge`), so the all-`-` check rejects
  before the no-merges rule does. A build with the no-merges rule deleted stays green.

→ L266: make the other branch's commit already on `main` (cherry-pick it there), then merge `main` into the branch — cherry prints `- X`, merges
= 1, and only the no-merges rule rejects. L267: drop the case, or keep the ≥ 1 check as belt-and-braces and say so instead of claiming a test
isolates it.

### I8 — Mockup differences in the Table and phone layouts are not called out, and their copy is unspecified (L20-29, L229, L233-234)

The mockup's Table (B) cells read `— even`, `2 behind`, `— no remote`, `4` / `—` (uncommitted), `6h` / `—` (fetched); its phone card (A) reads
"main 2 behind" and "fetched 6h". The copy table gives "`main` = origin", "`main` 2 behind origin", "clean", "fetched 6h ago". L229 fixes only the
Branches column. Neither the phone forms nor the Table cells are in the known-differences list, and nothing says whether the Table uses the copy
table verbatim (which makes the Uncommitted column read "clean"). Two smaller omissions on the same page: the `●` marker on the current branch
in the branch list (mockup A/B/C, `feat/tracker ●`) and Triage's "3 unmerged branches" chip.

→ Either add rows for the Table cells and phone short forms to the copy table, or add them to the known-differences list as "not built, the copy
table is used verbatim". Say whether the current-branch marker is drawn.

## Minor

- **M1 (L164)** — the sweep for `'/api/management` (leading single quote) misses the two template-literal fetches (`client/src/hooks/useManagement.ts:54, 90`
  use backticks). Sweep for `/api/management` without the quote; the comments that mention the path (`App.tsx:68`, `SideRail.tsx:80`) are the only
  false positives and go with the rename anyway.
- **M2 (L180)** — the sub-line nests straight double quotes inside the quoted copy; mark the inner `"fetched"` as literal so it is not read as a typo.
- **M3 (L189)** — the per-view layout keys today are `dashboard.layout` and `dashboard.analyticsLayout` (`useSettings.tsx:25-26`); `management.gitLayout`
  breaks the pattern. Taste only.
- **M4 (L222 vs L225)** — "Unpin it under Pinned." does not say Pinned is a link; L225 does. Say so once for both.
- **M5 (L74)** — a pin to a bare repo: `rev-parse --show-toplevel` exits 128 (probe #10), so it reads "Not a git repository." Acceptable, but worth a
  word in `git-stats.md`.
- **M6 (L104 vs D10)** — a branch cut at the base's tip with no commits yet is hidden *with* its worktree badge — exactly a fresh orchestrator
  worktree. Intended by L104, but D10 reads as unconditional; add a clause.
- **M7 (L170)** — `PinnedProjectsGroup` lives in `client/src/components/settings/`; the spec does not say whether the file moves with the view.
- **M8 (L87, L216)** — an unborn HEAD on `main` shows the branch chip `main` beside "no main branch". Harmless; note it.
- **M9 (L143)** — `remote-access.md` carries a prose warning (`:34`), not an exposure list; "lists it" → "names it".
- **M10 (L25)** — Triage's "3 unmerged branches" row chip (mockup C) is not one of the chips L25 names; see I8.
- **M11 (L62)** — the runner env is additive to `process.env`; say whether `GIT_DIR` / `GIT_WORK_TREE` are stripped, since an inherited `GIT_DIR` would
  point every call at one repo.

## Task-quality verdict

The document is well-structured and nearly every code claim held up; the gaps are concentrated in one place — linked worktrees and the trunk edge
in §2 — plus test fixtures that would pass without the rule they are meant to prove.
