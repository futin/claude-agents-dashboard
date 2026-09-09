---
id: idea-24
title: "Management: list MCP servers alongside plugins and skills"
created: 2026-09-08
tags: management, config, mcp
---

## Problem

MCP servers are a third config category next to plugins and skills, and Management shows
none of them. `server/lib/management.ts` reads exactly three families of source:
`~/.claude/plugins/installed_plugins.json` (plugins), `~/.claude/skills/` plus each
plugin's `skills/` dir (skills), and `settings.json` hooks / rules / memory. The string
`mcpServers` appears nowhere in the scanner — the only hit in the repo is in
`server/lib/archived.ts`, unrelated.

Concretely: the user went looking for CodeGraph as a global plugin, found nothing, and
had no way to tell from the UI that it is an MCP server rather than a missing plugin.
CodeGraph does appear in Management, but only sideways — a Hooks row for
`codegraph-gate.sh` (a UserPromptSubmit hook symlinked to
`~/claude-global/hooks-local/`) and a `mcp__codegraph__*` entry in the permissions view.
Neither says "there is an MCP server called codegraph".

## Rough shape

An MCP Servers card in Management, populated the same way the existing cards are —
read-only disk scan, per scope. Sources to merge, each carrying its own scope badge:

- user scope: root `mcpServers` in `~/.claude.json` (today: `codegraph`, `{ type:
  "stdio", command: "codegraph", args: ["serve", "--mcp"] }`)
- project scope: `projects[<abs path>].mcpServers` in the same file
- repo scope: `.mcp.json` at the repo root, if present

Per row, the fields worth showing are name, scope, transport (`stdio` / `http` / `sse`),
and the command plus args (or URL for the remote transports). Follows the existing
`ConfigItem` pattern in `management.ts`, so it needs a `shared/types.ts` field first,
then the server producer, then the client card — the ordering the repo's CLAUDE.md
already mandates for a new API field.

## Open questions

- Does anything else in the dashboard need MCP awareness, or is Management the only
  consumer? (Sessions already surfaces `mcp__*` tool names in activity, without knowing
  which server they came from — a name→server mapping might be reusable.)
- Env vars in an MCP entry can hold secrets (`env: { API_KEY: ... }`). Show keys only,
  never values? Or omit `env` entirely from the API payload?
- `~/.claude.json` is large and rewritten constantly by the CLI. Cheap enough to read on
  every Management poll, or does it want the same caching treatment as
  `server/lib/agents-cache.ts`?
- Is a disabled/enabled state discoverable from disk at all, or is that only known to a
  live session?
