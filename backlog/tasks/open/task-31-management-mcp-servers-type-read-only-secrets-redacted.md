---
id: task-31
title: Management: MCP servers type, read-only, secrets redacted
created: 2026-09-23
from: idea-24
---

## Goal

Management gains an **MCP servers** type next to Plugins, Skills and the rest, so a user looking for CodeGraph (or the backlog-manager plugin's Playwright)
sees "there is an MCP server called codegraph, user scope, stdio, `codegraph serve --mcp`" instead of finding nothing under Plugins. Read-only, like the rest
of the section. Secret-bearing values (`env`, `headers`) never leave the server.

## Decisions (idea-24's open questions, settled at groom time)

- **Sources, per scope.** Global scope = `user` (root `mcpServers` in `~/.claude.json`) plus `plugin:<name>` (each installed plugin's `.mcp.json` at its
  installPath, and/or an object-valued `mcpServers` in its `.claude-plugin/plugin.json`). Project scope = `local` (`projects[<abs project path>].mcpServers` in
  `~/.claude.json`) plus `project` (`<project root>/.mcp.json`). Badge names follow Claude Code's own scope vocabulary (`user` / `local` / `project`) so they
  match what `claude mcp list` prints. Live data on 2026-09-23: `codegraph` (user, stdio) and `playwright` (plugin:backlog-manager, stdio, `bash -c <script>`);
  no local or project entries on this machine.
- **`~/.claude.json` invariant changes, deliberately.** `docs/subsystems/management.md` says the file "is never read". New rule: the server reads it for the two
  `mcpServers` locations above and nothing else, and the path **never** enters `collectServablePaths` — no MCP declaring file does (not the repo `.mcp.json`, not
  a plugin's), because serving any of them whole would hand out the `env` values the payload redacts. The detail pane renders from the API payload instead.
- **Secrets: keys only.** `env` and `headers` become sorted key lists (`envKeys`, `headerKeys`); values are dropped server-side. `command`, `args` and `url` are
  sent verbatim — same exposure class as hook commands, which Management already shows, and the thing a user actually needs to see.
- **Cost.** The file is ~63 KB, and Management does not poll, so no agents-cache-style layer. But `collectServablePaths` fans out over every recent project on
  each file request, so parse `~/.claude.json` at most once per (path, mtimeMs, size) — a module-level memo keyed on `stat`, re-read when either changes.
- **Enabled state.** Only what disk says: a plugin's server is `disabled` when its plugin is disabled (`enabledPlugins`); a `local`/`project` server is
  `disabled` when its name is in that project entry's `disabledMcpServers` or `disabledMcpjsonServers`. `user` servers are never marked disabled (per-project
  toggles belong to a project view). Live connection status is session-only and out of scope.
- **Other consumers.** None. Sessions' `mcp__<server>__<tool>` names already carry the server name; no name→server mapping is built.
- **No dedupe.** The same name in several scopes shows once per scope, each with its badge. Precedence is Claude Code's business, not this read-only view's.

## Plan

Implementation plan — behaviour and cases, not literal code; disagree with it where the code says otherwise. Order follows the repo rule for a new API field:
`shared/types.ts`, then the server producer, then the client consumer.

1. **`shared/types.ts`.** Add `McpServerInfo`: `name`; `source: ItemSource` (`'user' | 'local' | 'project' | 'plugin:<name>'`); `transport` (declared
   `type`, else `'stdio'`); `command: string | null`; `args: string[]` (non-strings dropped); `url: string | null`; `envKeys: string[]`; `headerKeys: string[]`
   (both sorted); `declaredIn` (absolute path of the file that declared it — display only, never servable); `disabled: boolean`. Add
   `mcpServers: McpServerInfo[]` to `ScopeConfig`, with a JSDoc line saying env/header values are never included. Update the Management block comment's list of
   kinds.

2. **`server/lib/management.ts` — reading.**
   - `claudeJsonPath(homeDir?)` → `<homeDir || os.homedir()>/.claude.json` (sibling of `claudeHome`, **not** inside it).
   - A memoized reader of that file (stat → reuse the last parse when mtimeMs and size match). Missing, unreadable or malformed → treated as `{}`, never throws,
     never sets `error`.
   - A pure normaliser `normalizeMcpServers(raw, source, declaredIn, disabledNames)` → `McpServerInfo[]`: non-object input → `[]`; non-object entries skipped;
     result sorted by name. This is the one place redaction happens — keep it pure so the tests hit it directly.
   - Plugin MCP: in `readPlugin`, read `<installPath>/.mcp.json` (its `mcpServers` object) and the manifest's `mcpServers` when it is an object. A string-valued
     manifest `mcpServers` is a path — resolve it against installPath and read it only if the resolved path stays inside installPath; otherwise ignore. Tag
     `plugin:<name>`, `disabled = !enabled`. Add the rows to `PluginScan`. Do **not** count them in `PluginInfo.counts` unless you also add an `mcp` count and
     render it — leave counts untouched by default.
   - `readGlobalScope` → `mcpServers` = user rows (root `mcpServers`) then plugin rows. `readProjectScope` → local rows (`projects[projectPath].mcpServers`, with
     that entry's two disabled lists) then project rows (`<projectPath>/.mcp.json`, same disabled lists). The `projects` key is the exact project path string;
     no normalisation beyond what `projectPath` already is.
   - `collectServablePaths`: **no change**. Add a one-line comment there that MCP rows add nothing, and why.

3. **Client — `client/src/lib/managementEntries.ts`.** New entry variant `kind: 'mcp'` carrying the `McpServerInfo`. Group title `MCP servers`, placed
   immediately after Plugins in the global scope and first in the project scope (so it sits beside Plugins, where the user went looking). Key
   `mcp:<source>:<name>`. Label = name. Sublabel = `<transport> · <url or command>` (command alone, not args — a `bash -c` script arg is hundreds of chars). Badge
   = `disabled` when disabled, else the source. Subgroup = `itemSubgroup(source)` with the same user/project-first sort Skills uses (treat `local` as local too).
   `filePath: null`. Empty list → the group is dropped like every other empty kind.

4. **Client — detail.** New `components/management/McpDetail.tsx`, shaped like `HookDetail`: head row (name, transport, source badge), then labelled blocks for
   `command` + args (one `<pre>`, args one per line so a multi-line script stays readable) or `url`, `env` keys and `headers` keys (names only, with a short
   "values hidden" note), and `declared in` as a plain path — **not** a `FileBlock`, since the path is not servable and a FileBlock would draw a 403.
   `DetailPane` branches on `entry.kind === 'mcp'` the way it does for hooks. Reuse existing classes (`mdetail-*`, `msrc`, `mgmt-file mgmt-cmd`); if a new class is
   unavoidable it uses theme tokens only — no colour literals below the token block.

5. **Docs.** `docs/subsystems/management.md`: add MCP servers to the kind list and the Scopes bullet; rewrite the `~/.claude.json` sentence in the file-endpoint
   invariant to the new rule (read for `mcpServers` only, memoized, never servable, env/header values never in the payload). Leave the docs-sync stamp alone —
   `/docs-sync` re-baselines it. Check `docs/overview.md` §Map's management line still reads true.

## Test cases

Server (`test/management.test.ts`, tmpdir `homeDir` fixtures — `~/.claude.json` lives at `<homeDir>/.claude.json`):

- Root `mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } }` → global scope `mcpServers` has exactly one row:
  name `codegraph`, source `user`, transport `stdio`, command `codegraph`, args `['serve','--mcp']`, url `null`, envKeys `[]`, headerKeys `[]`, disabled `false`,
  declaredIn `<homeDir>/.claude.json`.
- Entry with no `type` and a `command` → transport `stdio`. Entry `{ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer SEKRIT-H' } }` →
  transport `http`, command `null`, url kept, headerKeys `['Authorization']`.
- **Redaction (mutation-prove it):** `env: { B_KEY: 'SEKRIT-B', A_KEY: 'SEKRIT-A' }` → envKeys `['A_KEY','B_KEY']`, and `JSON.stringify` of the whole scope
  contains none of `SEKRIT-A`, `SEKRIT-B`, `SEKRIT-H`. Temporarily pass `env` through in the normaliser and confirm this case goes red; record that in the
  execute notes.
- `~/.claude.json` missing → `mcpServers: []`, no `error`. Malformed JSON → same. `mcpServers` an array or a string → `[]`. One entry `null` beside a valid one
  → only the valid one.
- Project scope for `/tmp/x/proj`: `projects['/tmp/x/proj'].mcpServers.a` → one row, source `local`; a `.mcp.json` at the project root with server `b` → one
  row, source `project`, declaredIn that `.mcp.json`. A server under a *different* project key does not appear. `disabledMcpServers: ['a']` → `a` disabled;
  `disabledMcpjsonServers: ['b']` → `b` disabled.
- Global scope does **not** include `projects[*]` servers; project scope does **not** include root servers.
- Plugin fixture (installed_plugins.json + installPath with `.mcp.json` declaring `pw`) → global row `pw`, source `plugin:<name>`, declaredIn the plugin's
  `.mcp.json`; same plugin set disabled in `enabledPlugins` → row `disabled: true`. Manifest `mcpServers: '../../escape.json'` → ignored, no throw.
- **Servable set unchanged (mutation-prove it):** with all of the above on disk, `collectServablePaths` contains neither `<homeDir>/.claude.json`, nor the
  project `.mcp.json`, nor the plugin `.mcp.json`. Add a temporary `allowed.add` of any of them and confirm the case goes red.
- Memo: read scope, rewrite `~/.claude.json` with a different server (ensure the mtime or size differs), read again → the new server shows.

API (`test/api-management-analytics.test.ts`): `GET /api/management/file?path=<homeDir>/.claude.json` → 403 when that file exists and declares MCP servers.

Client (`test/management-entries.test.ts`):

- Global scope with one plugin and one user MCP server → group titles begin `['Plugins', 'MCP servers', 'Skills', …]`. Project scope with one MCP server →
  first title `MCP servers`. No MCP servers → no `MCP servers` group.
- Entry for `codegraph`: kind `mcp`, key `mcp:user:codegraph`, sublabel `stdio · codegraph`, badge `user`, filePath `null`. An http server's sublabel uses its
  url. A disabled server's badge is `disabled`.
- Subgroup order: `user` rows before `plugin:*` rows.

Browser:

- In the browser (playwright MCP tools): with the dev server this session started running (`pnpm dev`, note the port it prints), open the web port, click
  Management in the side rail, keep the Global scope, click the `MCP servers` type → a `codegraph` row with a `user` badge and `stdio · codegraph` under it is
  visible, and a `playwright` row under a `backlog-manager` sub-group. Click `codegraph` → the detail column shows `codegraph` / `serve` / `--mcp` and no
  `FileBlock` error or 403 text. Both rows depend on this machine's live config; if either is absent, say so rather than marking the check passed.

## Done when

- `pnpm test` and `pnpm typecheck` pass, output quoted, with the new cases above in the count.
- Both mutation proofs (redaction, servable set) were run and went red, and that is recorded.
- The browser check above passed, or the reason it could not run is stated.
- `docs/subsystems/management.md` states the new `~/.claude.json` rule and lists the MCP servers kind.
- No `server/` dependency added; no colour literal added to `styles.css`.
