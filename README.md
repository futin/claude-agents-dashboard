---
docs-sync:
  sources:
    - server/
    - client/
    - scripts/
    - package.json
  kind: readme
  verified: fa1fa5b9daeb162acccef66d0e4d9a210ede95da
---

# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. For the top N
most-recently-active sessions it shows what each one is doing right now — project, git
branch, model, context usage, and current tool activity — refreshing every 3 seconds by
default, retunable in the Settings tab.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. **Monitoring needs
no daemon, no hooks, and no config in Claude Code** — only the optional
[remote answers](docs/subsystems/remote-answer.md) feature installs a hook. Zero runtime
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

- **[Live session monitor](docs/subsystems/sessions.md)** — one row per session: status
  dot (working / question / incomplete / idle), project + branch, model, context bar,
  current tool activity, expandable subagent detail, filter + sort toolbar.
- **[Chat drawer](docs/subsystems/chat.md)** — read any session's conversation:
  live-tailed, pageable back through the whole transcript, with an all/text/you filter
  and markdown rendering.
- **[Remote answers](docs/subsystems/remote-answer.md)** — answer a session's
  `AskUserQuestion` from your phone; the pick is delivered into the live session. The
  one opt-in feature that needs a hook.
- **[Remote plan verdicts](docs/subsystems/remote-plan.md)** — send a proposed
  `ExitPlanMode` plan back for revision with feedback, from the same drawer. Reject-only:
  the CLI discards a hook `allow` for plans, so accepting stays a terminal action.
- **[Management tab](docs/subsystems/management.md)** — read-only browser for all Claude
  config on the machine: skills, agents, commands, rules, hooks, settings, plugins, per
  scope.
- **[Analytics tab](docs/subsystems/analytics.md)** — per-session post-mortem cards
  (tokens, priciest tools/subagents) paired with the lesson the `/kaizen` skill logged.
- **[Usage bars](docs/subsystems/usage-limits.md)** — the header's 5h / Week account
  rate-limit bars, same numbers as `/usage` in the CLI.
- **[Settings tab](docs/subsystems/settings.md)** — themes, density and text scale, refresh
  rate, the scan knobs, desktop alerts, and the remote-answer idle threshold — all editable
  in the app, no `.env` edit or rebuild.
- **[Phone access & origin badge](docs/subsystems/remote-access.md)** — reach the
  dashboard over LAN, Tailscale, or a tunnel; a toolbar pill shows which route you're on.

## Optional setup

- **Phone / away-from-home access** — nothing to configure in the app; see
  [remote access](docs/subsystems/remote-access.md) for LAN, Tailscale, and tunnel options.
- **Remote answers hook** — 4 steps, ~2 minutes:
  [setup](docs/workflows/remote-answer-setup.md).
- **Docker** — production and dev images, read-only `~/.claude` mount:
  [docker](docs/workflows/docker.md).
- **Configuration** — everything is optional, defaults work out of the box; the full
  `.env` reference is in [configuration](docs/workflows/configuration.md).

## Documentation

[`docs/overview.md`](docs/overview.md) is the entry point — domains, data flow, HTTP
surface, repo layout, and the map of every doc. Per-subsystem deep dives (mechanism +
invariants) live in [`docs/subsystems/`](docs/subsystems/); runnable procedures
(configuration, Docker, the remote-answers hook) in
[`docs/workflows/`](docs/workflows/).

## Not included (yet)

- Estimated USD cost per session. (Whole-session token totals live in the
  **Analytics** tab — run `/kaizen` on a session and it appears there.)
