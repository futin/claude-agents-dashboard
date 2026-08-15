---
docs-sync:
  sources:
    - server/
    - client/
    - scripts/
    - package.json
  kind: readme
---

# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. For the top N
most-recently-active sessions it shows what each one is doing right now — project, git
branch, model, context usage, and current tool activity — refreshing every 3 seconds.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. **Monitoring needs
no daemon, no hooks, and no config in Claude Code** — only the optional
[remote answers](docs/features/remote-answers.md) feature installs a hook. Zero runtime
dependencies on the backend (Node built-ins only).

![dashboard: header with 5h/week usage bars, filter + sort toolbar, and one row per session showing status dot, project + branch, model, context bar, activity, and expandable subagent detail](docs/screenshot.png)

## Quick start

Requires **Node.js >= 18** and **pnpm**.

```bash
pnpm install
pnpm dev
```

Open **`http://localhost:5173`** — the API server and the Vite dev server run together,
with hot reload.

For a production run:

```bash
pnpm build   # bundles client/ → client/dist
pnpm start   # serves the built app + API on http://localhost:4173
```

Tests and types:

```bash
pnpm test        # node-assert tests over the domain logic
pnpm typecheck   # tsc --noEmit
```

That's the whole basic setup. Everything below is optional.

## Features

- **[Live session monitor](docs/features/sessions.md)** — one row per session: status
  dot (working / question / incomplete / idle), project + branch, model, context bar,
  current tool activity, expandable subagent detail, filter + sort toolbar.
- **[Chat drawer](docs/features/chat-drawer.md)** — read any session's conversation:
  live-tailed, pageable back through the whole transcript, with an all/text/you filter
  and markdown rendering.
- **[Remote answers](docs/features/remote-answers.md)** — answer a session's
  `AskUserQuestion` from your phone; the pick is delivered into the live session. The
  one opt-in feature that needs a hook.
- **[Management tab](docs/features/management.md)** — read-only browser for all Claude
  config on the machine: skills, agents, commands, rules, hooks, settings, plugins, per
  scope.
- **[Analytics tab](docs/features/analytics.md)** — per-session post-mortem cards
  (tokens, priciest tools/subagents) paired with the lesson the `/kaizen` skill logged.
- **[Usage bars](docs/features/usage-bars.md)** — the header's 5h / Week account
  rate-limit bars, same numbers as `/usage` in the CLI.
- **[Phone access & origin badge](docs/features/remote-access.md)** — reach the
  dashboard over LAN, Tailscale, or a tunnel; a toolbar pill shows which route you're on.

## Optional setup

- **Phone / away-from-home access** — nothing to configure in the app; see
  [remote access](docs/features/remote-access.md) for LAN, Tailscale, and tunnel options.
- **Remote answers hook** — 4 steps, ~2 minutes:
  [setup](docs/features/remote-answers.md#setup).
- **Docker** — production and dev images, read-only `~/.claude` mount:
  [docker](docs/workflows/docker.md).
- **Configuration** — everything is optional, defaults work out of the box; the full
  `.env` reference is in [configuration](docs/workflows/configuration.md).

## Documentation

- [`docs/architecture/`](docs/architecture/) — how the thing is built:
  [overview](docs/overview.md) (domains, data flow, HTTP surface, layout),
  [configuration](docs/workflows/configuration.md),
  [docker](docs/workflows/docker.md).
- [`docs/features/`](docs/features/) — what each part does and how to use it (linked
  above).
- [`.claude/rules/`](.claude/rules/) — contributor deep dives: per-domain invariants and
  gotchas, read before changing that area.

## Not included (yet)

- Estimated USD cost per session. (Whole-session token totals live in the
  **Analytics** tab — run `/kaizen` on a session and it appears there.)
