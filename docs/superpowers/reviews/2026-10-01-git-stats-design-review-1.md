# Review 1 — `2026-10-01-git-stats-design.md`

Reviewer: Fable 5.1, 2026-10-01. Read-only. Checked against the repo at `9ca06bd` and the mockup `2026-10-01-git-stats-mockups.html`. Every git claim was
run against this machine's git (2.50.1, Apple Git-155) in a scratch repo.

## Verdict: REVISE

One Critical: the spec's `%(worktreepath)` claim is false on the git this runs on, so the D10 badge would land on the wrong branches and a §7 test fails as
written. Seven Important findings are ambiguities an implementer would have to guess at, one false "never hides" claim about the merged proof, and one
missed existing-code touch point (`OWNED_KEYS`).

## Verified true (no finding)

- `listPinRows` returns `path: null` for a dead pin — `server/lib/management.ts:727`.
- `test/plugin-manifest.test.ts` pins `plugin/` to `.claude-plugin` + `skills` (L54); the server never imports it.
- `test/outbound.test.ts` scans only `http/https/http2/net/tls/dgram` + `fetch(` (L21, L56); `node:child_process` in a new `git-stats.ts` does not trip it. D4
  holds.
- git-sync's `trunkOf` is exactly D7 — `plugin/skills/git-sync/tools/git-sync.mjs:179-191`, remote ref before local at L188. `survey` measures ahead against
  `origin/<name>` (L987-1032) and calls `gh` (L1092). M2 = `cherrySigns` (L646, L733-735); M3 writes a `commit-tree` probe (L741). §1 is accurate.
- `Section`/`SECTIONS` in `client/src/lib/sections.ts:11-20`, rail order Sessions, Usage, Management, Analytics, Settings; landing picker derives from
  `SECTIONS` at `client/src/lib/settings.ts:183`.
- Routes `/api/management`, `/project`, `/file` at `server/index.ts:174-180`; handlers `server/api.ts:1531-1567`; `/api/pins` at `server/index.ts:202`.
- localStorage keys `management.collapsed/type/scope` at `ItemList.tsx:46`, `ManagementView.tsx:32`, `useManagementScope.tsx:47`; `dashboard.section`
  at `App.tsx:35`.
- `SettingsTab = SettingsScope | 'pinned'` and `SETTINGS_TABS` at `client/src/lib/settings.ts:49,226`; `pickOne` falls back to `DEFAULT_SETTINGS.settingsTab
  = 'local'` (L140, L252). `SUBNAV` at `client/src/components/SideRail.tsx:72`.
- `LAYOUTS`, `WIDE_ONLY_LAYOUTS`, `drawableLayout` at `client/src/lib/filterSort.ts:73,103,118`.
- `PinnedProjectsGroup` at `client/src/components/settings/PinnedProjectsGroup.tsx:16`; "stay in Management" sub-line at `SettingsView.tsx:177`.
- `.wide-mgmt` is applied at `App.tsx:63` and referenced in `styles.css:1172,1331`.
- Both test files named in §4 exist and hit the old paths (`test/api-management-analytics.test.ts:41`).
- `docs/subsystems/management.md`, `settings.md`, `view-persistence.md`, `remote-access.md` (L34, L144 name `/api/management/file`), `scripts/tailnet.ts:60`,
  `.claude/DESIGN.md` §8.5 (L319) all exist as described. `.claude/CLAUDE.md` Orientation names the five-tab rail.
- `62c22a8` is the `feat/dashboard-plugin` merge; #166 and #164 are open with the titles the spec implies.
- `GIT_OPTIONAL_LOCKS=0` does stop `git status` taking `index.lock`.

## Critical

### C1 — `%(worktreepath)` is not empty for the main worktree (L73; also L66, L200)

Spec L73: "It is empty for the main worktree's own branch, so only *linked* worktrees get the D10 badge." The man page says so (`git help for-each-ref`,
"if it is checked out in any linked worktree"), but on this machine's git 2.50.1 it is false:

```
$ git for-each-ref --format='%(refname:short) [%(worktreepath)]' refs/heads     # this repo, no linked worktrees
main [/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard]
```

A fresh `git init` repo prints the same. Built as written, any non-trunk branch checked out in the main worktree gets the worktree badge, and the §7 L200
case "the main worktree's branch has `null`" fails. The doc text is stale, not the behaviour.

Fix: define `worktreePath` as `null` when `%(worktreepath)` equals the repo's own toplevel (compare after `realpath`, since `--show-toplevel` is
resolved), or read `git worktree list --porcelain` and skip its first entry. Say which in §2.

## Important

### I1 — Triage rules contradict each other and the mockup (L170-175, L101, L215)

L172 "In flight: clean and even with origin, but with ≥ 1 unmerged branch." L173 "Quiet: … A repo with no remote, or no trunk, but otherwise clean also
lands here." L101: with no trunk, *every* branch is listed as unmerged, so a no-trunk repo always has ≥ 1 unmerged branch and the two rules collide. The
mockup's `ixray` (no remote, clean, one unmerged branch `experiment/sampler 0 | 4`) sits under Quiet; by L172 it is In flight. §7 L215 tests the Quiet
reading. An implementer picks one and either the test or the rule is wrong.

Fix: state precedence explicitly. Either "`trunkVsOrigin === null` (no remote, no `origin/<trunk>`, or no trunk) → Quiet when uncommitted = 0, regardless
of branches, because nothing can be measured", or move such repos to In flight and change the mockup and L215.

### I2 — "counting entries" of `status --porcelain -z` miscounts (L65, L190)

Verified in a scratch repo with one staged rename and an untracked directory of two files:

```
$ git status --porcelain -z | tr '\0' '\n'
R  b
a
?? d/
```

Three NUL-terminated tokens, two entries: a `R`/`C` entry carries a second path. Splitting on NUL overcounts every rename. And the default untracked mode
collapses `d/` to one entry, so §7 L190's "one modified + one untracked file → uncommitted 2" holds only when the untracked file is not in a new
directory.

Fix: say the count is of status entries after parsing `XY`, skipping the extra path for `R`/`C`; and either pass `-uall` or state that an untracked
directory counts once. Pin the §7 fixture (file at the root) so the test says what it tests.

### I3 — The `git cherry` proof can hide a branch; "never hiding one" is false (L80-82, L197)

Two cases the rule "prints only `-` lines" gets wrong:

- `git cherry` prints nothing when the branch is ahead only by merge commits (cherry skips merges; verified `git cherry HEAD HEAD` → 0 lines). "Only `-`
  lines" is vacuously true of empty output, so a branch whose own content lives in a merge commit is hidden.
- Cherry skips merge commits even when they carry content (the "merge main, fix the build" pattern). All non-merge commits may be `-` while the merge
  commit's fix is unmerged — hidden again.

git-sync guards both: M2 requires `signs.length > 0` and `rev-list --merges ref..tip` empty (`git-sync.mjs:733-735`, comment L699-701). The spec claims to
borrow M2 (L43) but drops the guard, and L81 then asserts the proof "always errs toward showing a branch, never hiding one."

Fix: require ≥ 1 cherry line and an empty `rev-list --merges <base>..<branch>`; otherwise unmerged. Add the two cases to §7.

### I4 — The `RepoGitStats` shape is only implied, and the detached-HEAD field is contradictory (L64, L89-99, L191)

L64: detached HEAD → "report the short sha *instead*" (one field holding either). L95: "current branch (or detached sha)". L191: "current branch `null`,
detached sha = …" (two fields). Field names appear only incidentally in §7 (`isTrunk`, `hasOrigin`, `worktreePath`); the rest (uncommitted count, trunk
vs origin pair, fetched age, the branch record, the counts) are unnamed. "`shared/types.ts` first" (L89) is the repo rule, but the spec gives the
implementer nothing to write there.

Fix: list the union's fields and types in §2 (names + nullability per state), and settle detached HEAD on one shape — `branch: string | null` plus
`detachedSha: string | null` matches L191.

### I5 — `OWNED_KEYS` is not in the rename and does not gain the new key (L119, L149)

`client/src/hooks/useSettings.tsx:24-28` lists `management.scope`, `management.type`, `management.collapsed` as the keys Settings → Reset clears. §4 renames
the keys to `configs.*` and §6 adds `management.gitLayout`, but neither section touches this list. Built as written, Reset stops clearing Claude Configs
state and never clears the Git layout choice.

Fix: add to §4: `OWNED_KEYS` gains `configs.collapsed/type/scope`; to §6: it gains `management.gitLayout`. Decide whether the old `management.*` names stay
in the list so Reset still sweeps the leftovers D13 leaves behind (cheap, and the only migration-free way to ever drop them).

### I6 — User-facing copy is incomplete (L140-163, L180, L98 vs L160)

The spec says copy must be exact, but several states have none:

- Trunk vs origin: "main = origin", "main 2 behind origin", "no remote" (L157). Missing: ahead *and* behind; ahead only; `hasOrigin: true` but no
  `origin/<trunk>` (never fetched); trunk `null` ("no trunk" is in §2 quotes only).
- Fetched age `null`: "never fetched" appears only in the §2 table (L68), not in §6.
- The no-pins empty state (L141): "says to pin a project and links to the Pinned sub-view" — no sentence.
- "couldn't update" (L180) — where it sits and whether "updated Ns ago" stays.
- "+N more" (L160) when total > 50 (L98-99): the payload holds 50 of 60, so is N 45 (what can expand) or 55 (what exists)? The mockup's `+3 more` /
  `+5 more` for the same repo (8 branches, 5 shown, then 3 shown on the phone) already shows the number is "what can expand".

Fix: one copy table in §6 keyed by state, including the `> 50` case ("+45 more · 10 not shown" or a decision to raise the cap).

### I7 — Mockup differences are not called out (L19, L140, L161, L169, L171-175)

L19 says every layout "is drawn there". The mockup diverges from the spec in these places and none is noted:

| Spec                                                                | Mockup                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| L140 one band sub-line for all layouts                              | Triage band reads "2 of 6 pinned repos need attention."                                 |
| L171-174 four groups: Needs you / In flight / Quiet / Can't read    | Only a "Quiet" header; the busy repos and the errors have no group label                |
| L161 "N merged branches hidden"                                     | Cards: "7 merged branches hidden — cleanup candidates for Sync"; Triage: "7 merged hidden" |
| L169 columns On / Uncommitted / Trunk vs origin / Branches / Fetched | A leading "Repo" column; Branches reads "8 · 0 merged"; Trunk vs origin reads "— even"  |
| L155-158 shared facts                                               | Cards also carry a "3 branches" / "no other branches" / "1 branch" chip                 |
| L159 worktree badge                                                 | Phone strip abbreviates to "wt"                                                         |
| L163 "Folder is gone — …", "Not a git repository."                  | Triage lowercases both ("folder is gone", "not a git repository")                       |

Fix: either align the spec (the "N branches" chip and the Table's "— even" are decisions, not drift) or add a "differs from the mockup on purpose" list.

## Minor

- L116 rename list omits `useManagementIndex` (`client/src/hooks/useManagement.ts`), imported by `client/src/components/SpawnPanel.tsx:6`; the sweep test
  (L124) only catches the route string, not the hook name.
- L51 a `PinRow` with `listed: false` and a non-null `path` (its cwd is a linked worktree — `shared/types.ts:1506`) reaches git under this rule, while
  "every list hides it". Say that Git Stats shows it (it is a real checkout) or treats it as `missing`.
- L67 / D7: `origin/HEAD` can point at a branch with neither `refs/remotes/origin/<x>` nor `refs/heads/<x>` (stale symref after a remote default-branch
  change). git-sync returns the name anyway (`git-sync.mjs:185`). Say whether that is trunk `null` or a named trunk with no base.
- L63-64 an unborn HEAD (fresh `git init`, no commits): `symbolic-ref -q HEAD` succeeds, `for-each-ref` is empty, the trunk rule finds no ref. State what
  `ok` carries.
- L203 "no git call made" for a deleted folder needs an `fs.stat` before `rev-parse`; §2 only says a non-zero exit → `not-git`, and `execFile` with a missing
  `cwd` rejects with ENOENT, not an exit code. Add the stat to §2's table.
- L180 first fetch fails with no last-good data: the body is unspecified.
- L224 renaming `docs/subsystems/management.md` → `configs.md` must update every inbound link (`docs/overview.md:90,313`, DESIGN.md, settings.md…);
  `test/docs-links.test.ts` will fail otherwise. Worth one line in §8.
- L128 `SubKey` at `client/src/components/SideRail.tsx:70-72` is `'usageTab' | 'settingsTab'`; `managementTab` means widening that union and the `SUBNAV`
  comment ("Management's tree is … not a fixed list"), which becomes true of Claude Configs instead.
- The mockup's amber/cyan/green chips must become `[data-theme]` tokens in `styles.css` (CLAUDE.md "Never hardcode a color"); the spec never says so.
- L7 / L17: the plugin spec's phase table (`2026-10-01-dashboard-plugin-design.md:11-12`) and its L58 "Phase 1's server can `import` it" still state the old
  plan. The spec supersedes them but does not say the older record is left as-is on purpose.
- L84 a pin to a linked worktree reads that worktree's own `FETCH_HEAD` (per-worktree in git), so "fetched" differs from the main checkout's. Fine, but
  undocumented.
