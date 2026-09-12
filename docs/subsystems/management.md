# Management — read-only config browser

A **Management** section (top-level `SideRail` in `App.tsx`, persisted as
`dashboard.section`) shows all Claude config on the machine. Read-only v1 — nothing is
ever written.

**The scope is a rail destination, not a pane** (`.claude/DESIGN.md` §8.5): Global
(`~/.claude`) and every recently-active project sit in the sidebar as Management's
sub-nav, the same tree Usage and Settings draw, and only while the section is open. The
page keeps the persisted state (`management.scope`) and still resolves a stale value to
`global` during render — only the control moved. The **band** names it as
`Management · <scope>` with the scope's path in a *neutral* `.set-scope` pill (the green
fill means "every device" on Settings and would lie here), the ↻ on the same line, and
the one-line subtitle the full width beneath.

What is left is three levels, so the page is **three columns**:

- **Column 1 — type:** one row per kind (Skills, Agents, Commands, Rules, Hooks, Memory,
  Settings, Plugins) with its count as a pill. Only kinds with at least one entry appear,
  and the counts are the *filter's* counts. Which type is showing is persisted
  (`management.type`) and resolved during render, so a filter that empties the picked type
  falls back to the first type still standing rather than drawing an empty card.
- **Column 2 — item, as a Settings card (§8.2):** the type is the category title, the
  subtitle counts what the filter left, then the filter box, then one row per item — name
  over its description, source badge on the right, a hairline between. Every item is tagged
  `user`, `project`, or `plugin:<name>`; installed plugins are fully expanded, so
  plugin-provided skills/hooks/agents/rules show up too. The filter matches an item's name
  and description, and for a skill its **file names** too, so searching a reference doc
  finds the skill that ships it. **Source sub-groups survive as collapsible labelled rows**
  between the items — flattening them away would lose the one split that tells a user's
  skill from a plugin's. Their padding is symmetric on purpose: plugin groups start
  collapsed, so in practice you get a run of headers, and a header that hugs the group
  below it then floats under the rule above.
- **Column 3 — file, drawn only when something is selected:** the item's metadata and file
  content (SKILL.md, hook script, settings.json, …). A **skill that ships more than
  SKILL.md** gets a file rail beside the viewer — the whole skill directory (references,
  scripts, agents, docs), any file of which opens in place. Single-file skills keep the
  plain path + viewer. Clicking the open item again closes the column.

Columns 1 and 2 are **fixed** (190px / 420px): a column that is wide until you pick
something and narrow after jumps out from under the row you just clicked. Below 1330px the
file column drops to a full-width row under the other two; below 700px everything is one
column. Every column sizes to its content and the page body is the only scroller — no pane
is pinned to the viewport, so a long file is read by scrolling the page. The scope has no
control in the band at any width: it is a nav destination, so it is the tree under
Management — on the desktop rail, and in the phone menu, which draws every tree open.

Two things the three-pane version had are **gone on purpose**: the type-group collapse
control (the type is a column now, not a collapsible header) and the
`select an item to inspect it` empty state (a third of the page spent saying nothing).

## Mechanism

- **Endpoints:** `GET /api/management` (ManagementIndex: global ScopeConfig + recent
  ProjectRefs), `GET /api/management/project?dir=<dirName>` (one project's ScopeConfig),
  `GET /api/management/file?path=<abs>` (FileContent). Handlers in `api.ts`, scanner in
  `lib/management.ts`, frontmatter metadata via `shared/frontmatter.ts`.
- **Scopes:** global = `~/.claude/{skills,agents,commands,rules,hooks,CLAUDE.md,settings*}`
  **plus every installed plugin's subtree** (`plugins/installed_plugins.json` →
  installPath → skills/agents/commands/rules/hooks.json), items tagged `plugin:<name>`.
  Project = `<cwd>/.claude/*` + root CLAUDE.md, items tagged `project`. Recent projects
  come from transcript cwds (same lookback as sessions), deduped by cwd, newest-first.
  Each dir publishes the cwd **it is named for**: of the newest transcript's launch and
  newest cwds, the one whose `encodeProjectDir` spelling equals the dirName. A session that
  chdir'd into a worktree drifts away from the dir it is filed under *and* writes into the
  worktree's dir too, so both dirs hold a transcript reporting the repo as launch cwd and the
  worktree as newest — neither cwd is right for both. Naming settles it: the repo's dir
  yields the repo (the newest cwd hid it, and no other dir can name it — bug-14) and the
  worktree's own dir still yields the worktree. Falls back to launch-then-newest when the
  name matches neither. One entry per dir, never two: `dirName` is the rail's React key, the
  spawn `<option>` value and `resolveProject`'s argument, so it has to stay unique.
  Sessions the desktop app archived are skipped — `api.ts` passes `archivedIds` into
  `listRecentProjects`, so a project whose only recent session was deleted in the app stops
  reading as recently active (see [sessions](sessions.md) §Archived-session filter). The
  servable-path set (`collectServablePaths`) is deliberately *not* narrowed that way: a file
  already listed in an open panel must keep serving.
- **Skill directories:** `readSkillsDir` walks each skill dir at scan time and sets
  `ConfigItem.files` (`{rel, size}[]`, SKILL.md first then rel-sorted) — only when there
  is more than SKILL.md, so a single-file skill's payload is byte-identical to before. No
  file bodies are read during the scan; the rail fetches one on click through the same
  `/api/management/file`. Caps: depth 4 rel-segments, 200 files per skill.
- **No polling:** config changes over days. Index fetched on entering the section / manual
  ↻; project scopes + file bodies fetched lazily on click and cached in ref-held Maps.
  Switching to Management unmounts SessionsView → the 3s poll stops.
- **Client:** ManagementView is a `React.lazy` default export (own chunk; sessions bundle
  unchanged). Entry normalization is pure (`lib/managementEntries.ts`, unit-tested).
  Stale persisted scope / type / dead selection resolve during render — no effects.
- **⚠️ One index fetch, two consumers.** The rail's scope tree needs `projects[]` from
  `GET /api/management`, which the lazy chunk used to own. `hooks/useManagementScope.tsx`
  hoists the scope state *and* that one fetch into a context above both `SideRail` and
  `main` (`App.tsx`), so the index is fetched exactly once and the rail and the page can
  never disagree about the scope. Only `hooks/useManagement.ts` — three fetch hooks, no
  components — moves into the main bundle with it; the management chunk itself stays lazy.
  The provider's `active` prop (`section === 'management'`) is what keeps a Sessions
  visitor from triggering a config scan, and the rail renders no rows at all while the
  section is closed.

## Invariants

- **⚠️ File-endpoint security (the one thing not to lose):** the endpoint serves ONLY
  paths present in `collectServablePaths()` — the exact set the scanner itself
  enumerated. **Never replace this with prefix/subtree checks**: `~/.claude` also holds
  `.credentials.json`/`history.jsonl`/`session-data/`, and project roots hold `.env` —
  exact set membership is what keeps those unservable. `dirName` is resolved against the
  enumerated recent-project list, never joined into a path (same philosophy as
  `serveSessionDetail`). Content capped at 256 KB (`truncated` flag). `~/.claude.json`
  (huge, private) is never read.
- **⚠️ The skill-dir walk feeds that set, so it enumerates only what it can see itself:**
  **symlinks and dotfiles/dot-dirs are skipped**. A symlink inside a skill dir pointing at
  `~/.claude/.credentials.json` or a project `.env` would otherwise turn into a servable
  member — the one way this feature could breach the invariant above. `readdir`'s
  `withFileTypes` dirents never report a symlink as a file, so the explicit
  `isSymbolicLink()` guard is belt-and-braces; a refactor to plain `readdir` + `stat`
  would silently follow links, which is exactly what the regression test pins.

<!-- docs-sync:
  sources:
    - server/lib/management.ts
    - shared/frontmatter.ts
    - server/api.ts
    - client/src/components/management/
    - client/src/hooks/useManagement.ts
    - client/src/hooks/useManagementScope.tsx
    - client/src/lib/managementEntries.ts
  kind: subsystem
  verified: f436519f31ef4120521792db7658e2bc5431f0e9
-->
