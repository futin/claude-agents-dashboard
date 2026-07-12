# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. For the top N
most-recently-active sessions it shows what each one is doing right now — project, git
branch, model, context usage, and current tool activity — refreshing every 3 seconds.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. **No daemon, no hooks,
no config in Claude Code required.** Zero runtime dependencies on the backend (Node built-ins
only).

![dashboard: header with 5h/week usage bars, filter + sort toolbar, and one row per session showing status dot, project + branch, model, context bar, activity, and expandable subagent detail](docs/screenshot.png)

A **monolith split into three domains**: a Node backend (`server/`), a Vite + React +
TypeScript frontend (`client/`), and the shared API contract (`shared/`). One repo, one
deploy; the only thing crossing the FE/BE boundary is the typed JSON payloads defined in
`shared/types.ts`.

## Management section

Next to the live sessions monitor, a **Management** tab gives a read-only, three-pane
overview of all Claude configuration on the machine:

- **Left — scope menu:** Global (`~/.claude`) plus every recently-active project.
- **Middle — item list:** skills, agents, commands, rules, hooks, memory (CLAUDE.md),
  settings, and installed plugins for the selected scope, grouped by type and filterable.
  Every item is tagged with its source: `user`, `project`, or `plugin:<name>` — installed
  plugins are fully expanded, so plugin-provided skills/hooks/agents/rules show up too.
- **Right — detail pane:** the selected item's metadata and file content (SKILL.md, hook
  script, settings.json, …).

Read-only by design; nothing is ever written. The file endpoint only serves paths the
scanner itself enumerated (exact set membership, no prefix checks), so secrets that live
under the same roots — `~/.claude/.credentials.json`, `history.jsonl`, project `.env` —
are unservable by construction. Contents are capped at 256 KB per file.

## How to start

Requires **Node.js >= 18** and **pnpm**.

### Develop (hot-reload)

```bash
pnpm install
pnpm dev
```

Runs the API server and the Vite dev server together. Open **`http://localhost:5173`**.
Vite hot-reloads the UI and proxies `/api` to the backend.

### Run (production)

```bash
pnpm build   # bundles client/ → client/dist
pnpm start   # serves the built app + API on http://localhost:4173
```

`pnpm start` (`NODE_ENV=production`) static-serves the built client and auto-opens your
browser. Keep the tab open on a second monitor while you run sessions in parallel.

### Run in Docker

The dashboard ships with a Dockerfile and two compose files. The container gets a
**read-only** mount of your host `~/.claude` (the transcripts it scans).

```bash
# production image — serves built client + API on http://localhost:4173
CLAUDE_CREDENTIALS_JSON=$(scripts/host-credentials.sh) docker compose up --build

# dev image — Vite hot-reload on http://localhost:5173, source bind-mounted
pnpm dev:docker
```

Two things a container can't reach on its own, handled by the `scripts/`:

- **Usage bars** need the OAuth token, which lives in the host macOS Keychain — a Linux
  container has no `security` binary to read it. `scripts/host-credentials.sh` reads it on
  the host and passes the blob in as `CLAUDE_CREDENTIALS_JSON`. Omit it and the bars just
  fail open (everything else still works).
- **Phone access:** Vite inside a container only sees its own bridge IP, not the host's LAN
  IP. `pnpm dev:docker` runs `scripts/lan-ip.sh` to pass `HOST_LAN_IP` in, so the dev server
  prints the address a phone on the same wifi should actually open.

The **process-liveness gate is auto-disabled in a container** (it can't see the host's
`claude` processes) — see [Session status](#session-status-the-left-dot) below.

### Tests / typecheck

```bash
pnpm test        # node-assert tests over the backend domain logic
pnpm typecheck   # tsc --noEmit
```

## Features

### Per-session rows

Each session is one row, sorted most-recent-first by default. A row shows:

- **Status dot** — one of four states (see [Session status](#session-status-the-left-dot) below).
- **Project + git branch** — real path from the transcript's `cwd`, plus its `gitBranch`.
- **Model + CLI version** — the model the session is running and the Claude Code version.
- **Context bar + %** — current context tokens vs. the model's window (1M for Sonnet / Opus /
  Fable, 200k for Haiku and unknowns; override with `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). Turns
  orange/red as it fills.
- **Activity line** — the session's most recent tool call (e.g. `Edit server.ts`,
  `Task Explore: map the codebase`), so you can see what it's doing at a glance.
- **Relative time** — how long since the last conversational message.

### Session status (the left dot)

Four states, computed from the transcript's newest message record. `question` overrides
everything; otherwise it's a 2×2 of **recency** × **turn finished**:

|                            | recent (< `ACTIVE_WINDOW_MIN`) | stale             |
|----------------------------|--------------------------------|-------------------|
| **pending** (no end_turn)  | 🟢 **working**                 | 🟡 **incomplete** |
| **finished** (end_turn)    | 🟡 **incomplete**              | ⚪ **idle**        |

- 🔵 **question** — the newest assistant action is an unanswered `AskUserQuestion`. Beats all
  other states. (`ExitPlanMode` is not treated as a question.)
- 🟢 **working** (pulsing) — recent *and* the turn is unfinished = machine actively churning.
  **Only this state** counts toward the header's active total.
- 🟡 **incomplete** — either recent + finished (your turn to reply) or stale + unfinished
  (stalled mid-task).
- ⚪ **idle** — stale and the last turn finished cleanly.

Recency is based on the last **conversational message** timestamp — *not* file mtime, so
merely selecting a session in Claude Code (which appends metadata records) doesn't flip an
idle session to working.

**Process-liveness gate:** an interrupted session can look "recent + pending" on disk
forever. To catch this, the scanner shells out to `lsof` for the set of directories with a
live `claude` CLI process; a session whose directory has no live process is forced to
**idle**. Fail-open — if `lsof` is unavailable the gate is skipped. It is also
**auto-disabled inside a Docker container** (detected via `/.dockerenv`), since the container
can only see its own process namespace and would otherwise force every session to idle;
override either way with `SKIP_PROC_SCAN`.

**Empty-session filter:** a freshly `/clear`ed session holds no user/assistant message yet
and would show as a phantom "pending" row. Such transcripts are dropped until a real message
appears.

### Expandable subagent detail

Click a row to expand it. The dashboard fetches `GET /api/sessions/:id` and lists the
**subagents** that session launched via the `Task` tool — each with its type
(e.g. `Explore`), description, running/done status, and duration.

### Filter + sort toolbar

A control bar above the list filters and sorts the sessions client-side:

- **Project** — show all, or just one project.
- **Status** — all, or one of working / question / incomplete / idle.
- **Activity window** — restrict to sessions active within a time window.
- **Sort by** — recency, tokens, name, or status, with an ascending/descending toggle.

### Account usage bars (header)

The header shows two mini progress bars — **5h** and **Week** — the same account rate-limit
utilization Claude Code's `/usage` reports. Unlike everything else, these are **not on
disk**: they're fetched live from Anthropic's OAuth usage endpoint using your local
credentials (macOS keychain, falling back to `~/.claude/.credentials.json`).

- Cached and refreshed at most ~once/minute in the background, so the 3s poll never blocks on
  the network.
- Fail-open: no token / expired / network error → the bars are simply omitted.
- Disable entirely with `SHOW_USAGE=false`.

> ⚠️ On macOS the first keychain read triggers a GUI prompt — approve once with
> **"Always Allow"**.

## Configuration

Copy `.env.example` to `.env` and edit. Everything is optional (defaults shown). Real
environment variables override `.env`, which overrides the defaults.

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4173` | Port to serve on (production) |
| `MAX_SESSIONS` | `10` | How many sessions to show, most-recent first |
| `ACTIVE_WINDOW_MIN` | `5` | A recent session is one whose last message is within this many minutes |
| `LOOKBACK_HOURS` | `24` | Only consider sessions modified within this many hours |
| `SHOW_USAGE` | `true` | Show the header usage bars (fetches from Anthropic + reads keychain). Set `false` to disable |
| `SKIP_PROC_SCAN` | _(auto)_ | Skip the `lsof` process-liveness gate. Defaults to `true` inside a Docker container, `false` otherwise |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | _(auto)_ | Force the context-window size (tokens) for the `%` bar |
| `CLAUDE_CREDENTIALS_JSON` | _(unset)_ | OAuth creds blob for the usage bars when the host Keychain isn't reachable (Docker). See [Run in Docker](#run-in-docker) |

## Layout

```
shared/types.ts          the GET /api/sessions contract — imported by both sides

server/                  backend (Node + TypeScript, run via tsx — no compile step)
  index.ts               HTTP entry: routes /api/sessions(/:id), serves client/dist in prod
  api.ts                 the /api/sessions handler (scan + usage + error fallback)
  lib/config.ts          zero-dep .env loader
  lib/transcript.ts      tail-reads a transcript: tokens, model, context window, activity
  lib/scan.ts            enumerates + ranks sessions; process-liveness gate
  lib/usage.ts           fetches account 5h/weekly limits from Anthropic

client/                  frontend (Vite + React + TypeScript)
  index.html
  src/main.tsx / App.tsx
  src/components/         Header, Toolbar, SessionList, SessionRow, SessionDetail
  src/hooks/useSessions.ts   polls /api/sessions every 3s
  src/lib/filterSort.ts  client-side filter + sort logic
  src/lib/format.ts      token / relative-time formatters
  src/styles.css

vite.config.ts           dev proxy /api → backend (reuses the backend config loader)
test/                    node-assert tests with tmpdir JSONL fixtures

Dockerfile               multi-stage build (deps / dev / build / runtime)
docker-compose.yml       production container; read-only mount of host ~/.claude
docker-compose.dev.yml   dev container (Vite hot-reload, source bind-mounted)
scripts/host-credentials.sh   reads host Keychain creds → CLAUDE_CREDENTIALS_JSON
scripts/lan-ip.sh        host LAN IP, passed in so the dev container can print it
```

## Not included (yet)

- Cumulative token totals / estimated USD cost per session.
- Global & per-project hooks / settings / skills view.
