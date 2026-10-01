# Dashboard plugin (git-sync + kaizen) — design

Ship the two skills the dashboard depends on, `git-sync` and `kaizen`, as a Claude Code plugin that lives in this repo, so anyone who installs the dashboard gets
them with one `/plugin install`, and so there is one copy of each instead of three.

This is **Phase P** of a four-phase line agreed on 2026-10-01:

| Phase | What                                                                                                   | Status                                               |
| ----- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **P** | This spec: the dashboard becomes a plugin marketplace carrying `git-sync` + `kaizen`                     | this document                                        |
| 1     | **Git Stats** — read-only git state per pinned project (branch, on trunk, ahead/behind, unmerged branches) | next brainstorm; reuses P's git-sync engine          |
| 0     | Nav reshuffle — Management → **Claude Configs**; a new **Management** holds Pinned Projects + Git Stats   | after 1, when Git Stats needs its home               |
| 2     | **Sync button** — per pinned project, spawns a headless `/git-sync` there; its decision round is answered remotely | after 0; needs P installed                   |
| —     | Multi-machine hub (tokens, backlog/orchestration, git across Mac + Linux)                               | parked: futin/claude-agents-dashboard#164            |
| —     | Ship the six hooks in the plugin, retire `pnpm hooks:install`                                           | parked: futin/claude-agents-dashboard#165            |

*Phase 1 row:* Superseded: see [2026-10-01-git-stats-design.md](2026-10-01-git-stats-design.md) §1.

## Problem

Two skills the dashboard consumes live outside it:

- **`kaizen`** writes `~/.claude/session-analytics-log.md`, which the Analytics tab parses. To let collaborators populate that tab, the repo vendors a copy at
  `.claude/skills/kaizen/`, whose SKILL.md admits edits "don't take effect for the user until they're copied" to the global copy. They were not: as of
  2026-10-01 the two `kaizen.mjs` files have diverged **both ways** — the repo copy (543 lines) carries ~200 lines the global one lacks (the ctx trend,
  never-compacted flag, tool-result sizing), the global copy (429 lines) carries ~90 the repo lacks (the `compactions` block and its
  `test/compactions.test.mjs`). A vendored skill also only loads in sessions started in this repo.
- **`git-sync`** lives only in `~/claude-global` (the user's private machine-sync repo, symlinked into `~/.claude`). The Phase 2 Sync button spawns
  `/git-sync` inside *another* project's checkout, so for anyone but this user the button would point at a skill they don't have — and a project-scoped
  vendored copy would not load there either.

A user-scope plugin install is the one mechanism that reaches every project on the machine, and it is how the sibling projects already ship
(`backlog-manager`, `guide-manager`).

## Decisions

1. **Scope is `git-sync` + `kaizen` only.** The hooks stay on `pnpm hooks:install` (#165). Generic global skills (`doc-review`, `docs-sync`, `audit`,
   `preload-audit`) are not dashboard features and stay in claude-global.
2. **The plugin is a subfolder, `plugin/`, not the repo root.** The siblings use `source: "./"`, and backlog-manager shows the cost: its repo-root `.mcp.json`
   ships inside the install and registers a `playwright` MCP server in every project on the machine. The dashboard root has none of the auto-discovered paths
   today (`.mcp.json`, `hooks/`, `agents/`, `commands/`, `output-styles/` — checked 2026-10-01), but a subfolder makes that a property of the layout rather
   than of nobody ever adding one.
3. **One copy of each skill, in this repo.** `.claude/skills/kaizen/` is deleted; claude-global's `skills/git-sync/` and `skills/kaizen/` are deleted.
4. **Skill names do not change.** `/git-sync` and `/kaizen` keep their triggers; the namespaced forms are `claude-agents-dashboard:git-sync` /
   `claude-agents-dashboard:kaizen`.

## §1 Layout

```
.claude-plugin/marketplace.json        marketplace "claude-agents-dashboard-marketplace", one plugin, source "./plugin"
plugin/
  .claude-plugin/plugin.json           name "claude-agents-dashboard", version 0.1.0, one-line description
  skills/
    git-sync/                          SKILL.md, references/design.md, tools/git-sync.mjs, test/ (15 *.test.mjs + world.mjs)
    kaizen/                            SKILL.md, kaizen.mjs, test/
```

- `git-sync/` moves over unchanged except for paths (§3). Its history stays in claude-global; the commit that adds it names the claude-global sha it was
  copied from.
- The engine already guards its CLI entry (`isDirectRun()` at the foot of `git-sync.mjs`), so Phase 1's server can `import` it without running it. P does not
  change that file beyond paths and the comment above `isDirectRun()`, which describes the old `~/.claude/skills` symlink route.
  Superseded: see [2026-10-01-git-stats-design.md](2026-10-01-git-stats-design.md) §1.
- `plugin/` is never compiled and holds no TypeScript; the server's zero-runtime-dep rule is untouched (P adds no server code at all).

## §2 Kaizen merge

The merged `kaizen` is a superset of both copies; neither copy's features may be lost.

- **Base:** the repo copy (`.claude/skills/kaizen/`) — it is the one under test here (`test/analyze.test.ts`, `test/kaizen-trend.test.ts`) and it carries the
  log-format features the Analytics tab reads (`--trend`, the `(<ctx> ctx)` figure).
- **Port from the global copy:** the `compactions` block (one row per main-chain `compact_boundary`, a replayed boundary counted once, the unbounded-window
  counterfactual), skipping `isCompactSummary` records in the correction heuristic, and `test/compactions.test.mjs`. Port whatever else the global-only diff
  turns out to contain; the implementer diffs both directions and lists every hunk as kept-from-repo, ported-from-global, or deliberately dropped (with why).
- **SKILL.md:** drop the "vendored copy … edits don't take effect" note. Keep the log-path + line-grammar contract, still naming
  `docs/subsystems/analytics.md` and `server/lib/sessionAnalyticsLog.ts` as the other side of it. Any section the global SKILL.md has that the repo one
  lacks is merged the same way as the code.
- **The `PROVENANCE` header** in the global `kaizen.mjs` says the `compactions` block is "not yet in" `server/lib/analyze.ts`. That stays true after P —
  porting compactions into the server is not this phase — so the header keeps saying so, with the path updated.

## §3 Paths inside the skills

- Every `node ~/.claude/skills/git-sync/tools/git-sync.mjs …` in git-sync's SKILL.md (9 occurrences, 2026-10-01) becomes
  `node "${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs" …` — the braced form, quoted, exactly as backlog-manager's skills write it. Claude Code
  substitutes it into the skill text at load time, so the session sees an absolute path. The bare `$CLAUDE_PLUGIN_ROOT` in a Bash call is empty (recorded
  in this repo's memory), which is why the substituted form is required.
- kaizen's `node "$CLAUDE_SKILL_DIR/kaizen.mjs" …` calls, and the paragraph telling the session to "substitute the real absolute path", become
  `node "${CLAUDE_PLUGIN_ROOT}/skills/kaizen/kaizen.mjs" …` — one convention for both skills, the one the sibling plugins already prove works.
- git-sync's `test/skill.test.mjs` asserts things about SKILL.md's engine calls; if any assertion encodes the old path it is updated to the new one, never
  deleted.

## §4 Tests

- The three `kaizen.mjs` path resolutions in `test/analyze.test.ts` and the one in `test/kaizen-trend.test.ts` point at `plugin/skills/kaizen/kaizen.mjs`.
- `pnpm test` also runs **kaizen's** own `node --test` suite (`plugin/skills/kaizen/test/*.test.mjs`, 5 tests, ~0.1 s) — the one coupled to Analytics. The
  case counts of both runners appear in the output.
- **git-sync's** suite gets its own script, `pnpm test:skills`, and is not part of `pnpm test`: it is 193 tests that took 3 min 45 s on 2026-10-01 (real git
  processes per case), which would make every `pnpm test` — orchestrator verifications included — four minutes slower for a skill this repo rarely edits.
  `.claude/CLAUDE.md` requires `pnpm test:skills` green for any change under `plugin/skills/git-sync/`. (Amended 2026-10-01 after the baseline was measured;
  the first draft put both suites in `pnpm test`.)
- `pnpm typecheck` stays green (no new TS; the repointed tests are TS).

## §5 Docs and rules that change

| Where                                         | Change                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `README.md`                                   | New "Install the skills" section, shaped like backlog-manager's: `/plugin marketplace add`, `/plugin install`, what it gives, and that skill edits need `/plugin marketplace update` + reinstall before a session sees them |
| `.claude/CLAUDE.md`                           | Orientation lists `plugin/` as a fourth domain; the "keep the vendored `/kaizen` skill in lockstep" rule becomes "`plugin/skills/kaizen/` is the only copy; its log format is a contract with Analytics" |
| `docs/overview.md`                            | Map / file map gains `plugin/`                                                                           |
| `docs/subsystems/analytics.md`                | "vendored at `.claude/skills/kaizen/`" wording (lines 7, 87, 211) and the docs-sync `sources:` entry (`.claude/skills/kaizen/`) move to `plugin/skills/kaizen/` |
| claude-global `skills/`                       | `git-sync/` and `kaizen/` deleted                                                                        |
| claude-global `bootstrap.sh`                  | the "confirm the four global skills list — audit, docs-sync, find-skills, kaizen" step drops kaizen and says it now comes from the dashboard plugin |

`docs/learning-notes/` and `docs/superpowers/` are records of a moment and are not rewritten.

## §6 Cut-over

Two repos and two machines (macOS, WSL2), in this order on each machine:

1. Merge P in this repo.
2. Install the plugin: `/plugin marketplace add <this repo — GitHub slug, or a local path on the author's machines>`, then
   `/plugin install claude-agents-dashboard@claude-agents-dashboard-marketplace`.
3. Commit the claude-global deletions once (either machine); the other machine gets them with `~/claude-global/sync.sh pull`.

Between steps 2 and 3 both copies are installed and the bare `/kaizen` / `/git-sync` may be ambiguous; the namespaced names still resolve. Doing step 3 before
step 2 leaves a window with no git-sync at all, which is worse, so the order is fixed.

## Verification

Provable in the repo: `pnpm test` (both runners' counts), `pnpm test:skills` (193 git-sync cases, the 2026-10-01 baseline), `pnpm typecheck`, a grep showing no `.claude/skills/kaizen` or `~/.claude/skills/git-sync` path
left outside `docs/learning-notes/` and `docs/superpowers/`, and the §2 hunk list showing nothing from either kaizen copy was lost.

**Needs a human** (not provable by the implementing session):

- `/plugin install` on the Mac, then a fresh session where `/git-sync` and `/kaizen` both list, the loaded git-sync text shows an absolute path where
  `${CLAUDE_PLUGIN_ROOT}` was, and `/kaizen` produces a log line the Analytics tab parses.
- The same on the WSL2 box after `sync.sh pull`.
- One real `/git-sync` run from the installed plugin in some repo other than this one.

## Out of scope

- Hooks in the plugin (#165).
- Porting kaizen's `compactions` block into `server/lib/analyze.ts`.
- Anything Phase 1 needs from the engine beyond it being reachable at `plugin/skills/git-sync/tools/git-sync.mjs` — an import-friendly API, if Phase 1 wants
  one, is designed there.
- Publishing to any marketplace other than this repo's own.
