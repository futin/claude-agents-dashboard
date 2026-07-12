# Management section (read-only config browser)

A **Management** tab (top-level `SectionTabs` in `App.tsx`, persisted as `dashboard.section`)
shows all Claude config on the machine in a three-pane layout: scope menu (Global +
recently-active projects) | filterable item list grouped by type | detail pane with the
selected item's file content. Read-only v1 — nothing is ever written.

- **Endpoints:** `GET /api/management` (ManagementIndex: global ScopeConfig + recent
  ProjectRefs), `GET /api/management/project?dir=<dirName>` (one project's ScopeConfig),
  `GET /api/management/file?path=<abs>` (FileContent). Handlers in `api.ts`, scanner in
  `lib/management.ts`, frontmatter metadata via `lib/frontmatter.ts`.
- **Scopes:** global = `~/.claude/{skills,agents,commands,rules,hooks,CLAUDE.md,settings*}`
  **plus every installed plugin's subtree** (`plugins/installed_plugins.json` →
  installPath → skills/agents/commands/rules/hooks.json), items tagged `plugin:<name>`.
  Project = `<cwd>/.claude/*` + root CLAUDE.md, items tagged `project`. Recent projects
  come from transcript cwds (same lookback as sessions), deduped by cwd, newest-first.
- **⚠️ File-endpoint security (the invariant to keep):** the endpoint serves ONLY paths
  present in `collectServablePaths()` — the exact set the scanner itself enumerated.
  **Never replace this with prefix/subtree checks**: `~/.claude` also holds
  `.credentials.json`/`history.jsonl`/`session-data/`, and project roots hold `.env`.
  `dirName` is resolved against the enumerated recent-project list, never joined into a
  path (same philosophy as `serveSessionDetail`). Content capped at 256 KB (`truncated`
  flag). `~/.claude.json` (huge, private) is never read.
- **No polling:** config changes over days. Index fetched on section mount / manual ↻;
  project scopes + file bodies fetched lazily on click and cached in ref-held Maps.
  Switching to Management unmounts SessionsView → the 3s poll stops.
- **Client:** ManagementView is a `React.lazy` default export (own chunk; sessions bundle
  unchanged). Entry normalization is pure (`lib/managementEntries.ts`, unit-tested).
  Stale persisted scope / dead selection resolve during render — no effects.
