# Dashboard plugin (git-sync + kaizen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, exact values and exact test *cases* — never literal implementation or test code.
> Write the code yourself from the requirements; if a requirement here looks wrong against the code in front of you, say so instead of transcribing it. The
> line-count budget is soft.

**Goal:** Ship `git-sync` and `kaizen` as a Claude Code plugin from this repo's `plugin/` folder, with one copy of each skill instead of three.

**Architecture:** The repo root becomes a plugin marketplace whose single plugin lives in `plugin/`. git-sync is copied in from claude-global; kaizen is the
merge of the vendored repo copy and the global copy. No server or client code changes; `pnpm test` gains kaizen's node suite, git-sync's slow suite gets
`pnpm test:skills`.

**Tech Stack:** Claude Code plugin manifests (JSON), plain-JS `.mjs` skills with `node --test`, the repo's tsx + node-assert runner.

**Spec:** `docs/superpowers/specs/2026-10-01-dashboard-plugin-design.md`

## Global Constraints

- Marketplace name `claude-agents-dashboard-marketplace`; plugin name `claude-agents-dashboard`; plugin version `0.1.0`; marketplace source `./plugin`.
- Skill names and triggers unchanged: `git-sync` (`/git-sync`), `kaizen` (`/kaizen`).
- Every engine call in a SKILL.md uses the quoted, braced form `node "${CLAUDE_PLUGIN_ROOT}/skills/<skill>/<path>" …`. Never a bare `$CLAUDE_PLUGIN_ROOT`,
  never `$CLAUDE_SKILL_DIR`, never `~/.claude/skills/…`.
- No server or client code changes. `server/` keeps zero runtime deps. Skill files stay plain JS — no TypeScript under `plugin/`.
- `docs/overview.md` **§Map is off-limits**: it holds unresolved conflict markers owned by a separate task. Edit only §Repo layout in that file.
- `docs/learning-notes/` and `docs/superpowers/` (other than this plan and its spec) are records of a moment — not rewritten.
- Do not bump any docs-sync `verified:` stamp; only edit `sources:` paths. Re-baselining is `/docs-sync`'s job.
- New prose wraps at 160 columns; commit bodies at 72. A figure measured off this machine carries its date beside it.
- Work on branch `feat/dashboard-plugin` in a worktree; never switch the shared checkout's branch.

## Review Focus

1. **git-sync's T14.2 regex vs the quoted path.** `skill.test.mjs` T14.2 matches `git-sync\.mjs\s+<word>`; the new form puts `"` between `.mjs` and the
   space, so it would find zero engine calls. Expected: the test accepts the quoted form and still fails when a subcommand goes uncalled. Pinned in Task 1.
2. **An unexpanded plugin root at runtime.** If a SKILL.md uses a form Claude Code does not substitute, the session runs `node "/skills/…"` and fails. Not
   testable in-repo; a test pins the one allowed form in both SKILL.md files (Tasks 1, 2), and Task 3's human checklist proves the expansion live.
3. **The kaizen merge silently losing a feature.** Expected: everything either copy did, the merged copy does. Pinned in Task 2 by cross-running each old
   copy against the other copy's tests (both must fail) and the merged copy against all of them (all pass).
4. **A manifest that parses but doesn't install** — plugin name mismatch, wrong source path, missing `skills/`. Expected: caught in `pnpm test`, not on a
   user's machine. Pinned in Task 1 by a manifest test.
5. **Something plugin-shaped landing in `plugin/` by accident** (an `.mcp.json`, a `hooks/`), which would load in every project on every machine. Expected:
   a deliberate test edit is required to add one. Pinned in Task 1 by the same manifest test.

---

### Task 1: Plugin scaffold + git-sync

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`
- Create: `plugin/skills/git-sync/**` — copied from claude-global `skills/git-sync/` at `079032c` (its last commit there, 2026-09-29)
- Modify: `plugin/skills/git-sync/SKILL.md` (9 engine paths), `plugin/skills/git-sync/tools/git-sync.mjs` (the comment above `isDirectRun()` only),
  `plugin/skills/git-sync/test/skill.test.mjs` (T14.2 + one new case)
- Create: `test/plugin-manifest.test.ts`; Modify: `test/run-all.ts` (register it)
- Modify: `package.json` (`test:skills`), `README.md`, `.claude/CLAUDE.md`, `docs/overview.md` §Repo layout

**Interfaces:**
- Produces: the plugin root `plugin/` with `plugin/skills/` that Task 2 adds kaizen to; `pnpm test:skills`; `test/plugin-manifest.test.ts`, which Task 2
  extends with kaizen's directory.

- [ ] **Step 1: Copy the skill.** Copy only tracked files — `git -C ~/claude-global archive 079032c skills/git-sync` extracted with the leading `skills/`
  stripped into `plugin/skills/`. Expected tree: `SKILL.md`, `references/design.md`, `tools/git-sync.mjs`, `test/` (15 `*.test.mjs` + `world.mjs`).
- [ ] **Step 2: Baseline from the new location.** `node --test plugin/skills/git-sync/test/*.test.mjs` before any edit. Expected: 193 pass, 0 fail
  (2026-10-01 baseline in the old location, ~3m45s). Anything else: stop and report — the copy is wrong, not the tests.
- [ ] **Step 3: Write the failing tests.** In `skill.test.mjs`:
  - **T14.2 widened:** engine calls are recognised whether or not a closing `"` follows `git-sync.mjs`. Cases the test must hold: the current SKILL.md
    (after Step 4) names every subcommand; a SKILL.md text with one subcommand's call removed still fails (verify by hand once, mutation-style, then revert).
  - **New T14.x "engine calls go through the plugin root":** every occurrence of `git-sync.mjs` in SKILL.md is preceded by exactly
    `"${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/`; SKILL.md contains no `~/.claude/skills/`, no bare `$CLAUDE_PLUGIN_ROOT` (i.e. without the brace), and
    no `$CLAUDE_SKILL_DIR`.
  Run the suite — expected: the new case FAILS (SKILL.md still has the old paths), T14.2 still passes.
- [ ] **Step 4: Repoint SKILL.md.** All 9 `node ~/.claude/skills/git-sync/tools/git-sync.mjs <sub>` become the Global Constraints form. Reword the comment
  above `isDirectRun()` so it no longer claims SKILL.md reaches the CLI through the `~/.claude/skills` symlink (the realpath guard itself is unchanged —
  it still matters for any symlinked install). Run the full git-sync suite — expected: 194 pass (193 + the new case), 0 fail.
- [ ] **Step 5: Manifests.** `marketplace.json`: name, `owner.name` `andrejajevtic`, one `plugins[]` entry (name, `source: "./plugin"`, one-line
  description). `plugin.json`: name, version, description. Shape matches `../backlog-manager/.claude-plugin/` exactly apart from these values.
- [ ] **Step 6: Manifest test (`test/plugin-manifest.test.ts`, registered in `run-all.ts`).** Cases:
  - both manifests parse as JSON;
  - the marketplace has exactly one plugin, its `name` equals `plugin.json`'s `name`, its `source` is `./plugin`, and that directory holds
    `.claude-plugin/plugin.json`;
  - `plugin.json` `version` is a semver string;
  - `plugin/` contains exactly `.claude-plugin` and `skills` — nothing else (guards Review Focus 5);
  - `plugin/skills/` contains exactly the skill dirs this plan ships (Task 1: `git-sync`; Task 2 adds `kaizen`), each with a `SKILL.md` whose frontmatter
    `name` equals its directory name — parse it with `shared/frontmatter.ts`, the repo's own parser.
  Mutation-prove once by hand: renaming the plugin in `plugin.json` fails case 2; dropping an empty `plugin/hooks/` dir in fails case 4. Revert both.
- [ ] **Step 7: Scripts.** `package.json` gains `test:skills` running `node --test plugin/skills/git-sync/test/*.test.mjs`. `pnpm test` unchanged in this task.
- [ ] **Step 8: Docs.** `README.md` — an "Install the skills" section shaped like `../backlog-manager/README.md` §Install the skills: the two `/plugin`
  commands, what they give (`/git-sync`, `/kaizen`), that the Sync button (future) and Analytics depend on them, and that a skill edit takes effect only after
  `/plugin marketplace update` + reinstall. `.claude/CLAUDE.md` — Orientation names `plugin/` as a fourth domain (the installable skills, plain JS, never
  imported at runtime by server/client yet); Commands lists `pnpm test:skills` (~4 min) and says any change under `plugin/skills/git-sync/` needs it green.
  `docs/overview.md` §Repo layout — a `plugin/` block in the same style as `server/`. Then `pnpm test` — expected: ALL PASS, `runDocsLinks` included.
- [ ] **Step 9: Verify + commit.** `pnpm test`, `pnpm typecheck`, `pnpm test:skills` — record each command's final lines. Commit (`feat(plugin): ship git-sync
  from a plugin in plugin/`); the body names claude-global `079032c` as the source.

### Task 2: Kaizen merge

**Files:**
- Create: `plugin/skills/kaizen/SKILL.md`, `plugin/skills/kaizen/kaizen.mjs`, `plugin/skills/kaizen/test/compactions.test.mjs`
- Delete: `.claude/skills/kaizen/` (the `.claude/skills/` dir goes too if empty)
- Modify: `test/analyze.test.ts` (3 `kaizen.mjs` paths, ~lines 442/527/577), `test/kaizen-trend.test.ts` (1 path, line 9), `test/plugin-manifest.test.ts`
  (expected skill set gains `kaizen`), `package.json` (`test`), `.claude/CLAUDE.md` (the kaizen lockstep rule), `docs/subsystems/analytics.md`

**Interfaces:**
- Consumes: `plugin/skills/` and `test/plugin-manifest.test.ts` from Task 1.
- Produces: `plugin/skills/kaizen/kaizen.mjs` exporting at least `analyzeSession(filePath, id)` (what `compactions.test.mjs` imports) and keeping every CLI
  flag either copy had (`--latest`, `--trend`, `<session-id>`, `<path>`).

- [ ] **Step 1: Inventory both directions.** Sources: repo `.claude/skills/kaizen/` (543-line `kaizen.mjs`) and claude-global `skills/kaizen/` at `9227948`
  (429 lines, plus `test/compactions.test.mjs`). Diff `kaizen.mjs` and `SKILL.md` both ways and write a hunk ledger: each hunk group labelled
  *kept-from-repo*, *ported-from-global*, or *dropped* (with the reason). Known so far (2026-10-01): repo-only — ctx trend (`--trend`), never-compacted flag,
  tool-result sizing in `byTool`; global-only — the `compactions` block, skipping `isCompactSummary` records in the correction heuristic, a `PROVENANCE` header.
- [ ] **Step 2: Cross-run the old copies (the failing tests).** Copy `compactions.test.mjs` into `plugin/skills/kaizen/test/` and point it at a copy of the
  *repo* `kaizen.mjs` placed there — expected: FAIL (no compactions). Point the repo's `test/kaizen-trend.test.ts` at the *global* `kaizen.mjs` — expected: FAIL.
  Both failures prove the tests distinguish the copies; if either passes, that test does not cover its feature — report it before merging.
- [ ] **Step 3: Merge.** Start from the repo copy; port every *ported-from-global* hunk. `SKILL.md`: drop the "vendored copy … edits don't take effect" note,
  keep the log-path + line-grammar contract naming `docs/subsystems/analytics.md` and `server/lib/sessionAnalyticsLog.ts`, move every `kaizen.mjs` call to
  the Global Constraints form and delete the "substitute the real absolute path" instruction. The `PROVENANCE` header keeps saying `compactions` is not yet
  in `server/lib/analyze.ts` (still true). Reword the CLI-guard comment that mentions the `~/.claude/skills` symlink.
- [ ] **Step 4: Repoint and wire.** The four repo test paths → `plugin/skills/kaizen/kaizen.mjs`. `pnpm test` becomes the repo runner followed by
  `node --test plugin/skills/kaizen/test/*.test.mjs`; the second runs even when the first fails (no bare `&&` short-circuit), the script exits non-zero if
  either failed, and both counts show. Manifest test expects `git-sync` + `kaizen`.
  Add a case (in `compactions.test.mjs`'s neighbour, a new `plugin/skills/kaizen/test/skill.test.mjs`): SKILL.md frontmatter `name` is `kaizen`; every
  `kaizen.mjs` occurrence in SKILL.md is preceded by `"${CLAUDE_PLUGIN_ROOT}/skills/kaizen/`; no `$CLAUDE_SKILL_DIR`, no `~/.claude/skills/kaizen`.
- [ ] **Step 5: Run.** `pnpm test` — expected: ALL PASS from the repo runner and 5 + the new skill-test cases passing from node. Re-run Step 2's cross-checks
  against the *merged* copy — expected: both pass.
- [ ] **Step 6: Docs + rule.** `analytics.md`: the vendored wording at lines 7, 87, 211 says the skill ships in the dashboard plugin at
  `plugin/skills/kaizen/`; the docs-sync `sources:` entry `.claude/skills/kaizen/` becomes `plugin/skills/kaizen/` (stamp untouched). `.claude/CLAUDE.md`:
  the lockstep rule becomes "`plugin/skills/kaizen/` is the only copy; its log path and line grammar are a contract with Analytics
  (`docs/subsystems/analytics.md`) — never change one side only".
- [ ] **Step 7: Verify + commit.** `pnpm test`, `pnpm typecheck`; grep the repo for `.claude/skills/kaizen` and `~/.claude/skills/git-sync` outside
  `docs/learning-notes/`, `docs/superpowers/` — expected: no hits. Commit (`feat(plugin): merge kaizen into the dashboard plugin`) with the hunk ledger
  summarised in the body.

### Task 3: Cut-over (controller + human — not a subagent task)

Touches the user's Claude Code config and a second repo, so every step is confirmed with the user first.

- [ ] **Step 1:** Whole-branch review, then merge `feat/dashboard-plugin` to main (merge commit, per repo convention). PR body states the *Unproven* rows below.
- [ ] **Step 2 (human):** install on the Mac — `/plugin marketplace add` (GitHub slug or this checkout's path) and
  `/plugin install claude-agents-dashboard@claude-agents-dashboard-marketplace`. In a fresh session: `/git-sync` and `/kaizen` both list; the loaded git-sync
  text shows an absolute path where `${CLAUDE_PLUGIN_ROOT}` was; `/kaizen` writes a log line the Analytics tab shows.
- [ ] **Step 3 (after the user confirms Step 2):** in `~/claude-global`, delete `skills/git-sync/` and `skills/kaizen/`, and change `bootstrap.sh`'s "confirm
  the four global skills list — audit, docs-sync, find-skills, kaizen" step so kaizen is no longer listed and the step says kaizen + git-sync come from the
  dashboard plugin. Commit there; push with `~/claude-global/sync.sh push` only on the user's yes.
- [ ] **Step 4 (human):** on the WSL2 box — `sync.sh pull`, install the plugin, repeat Step 2's checks, and run one real `/git-sync` in a repo other than
  this one.

**Unproven until a human does it:** plugin install on either machine, `${CLAUDE_PLUGIN_ROOT}` expansion in a live session, Analytics parsing a kaizen line
written by the plugin copy, a real `/git-sync` run from the plugin.
