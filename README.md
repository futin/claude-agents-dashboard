# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. For the top N
most-recently-active sessions it shows what each one is doing right now — project, git
branch, model, context usage, and current tool activity — refreshing every 3 seconds.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. **Monitoring needs no
daemon, no hooks, and no config in Claude Code** — only the optional
[Remote answers](#remote-answers-optional) feature installs a hook. Zero runtime dependencies
on the backend (Node built-ins only).

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

The one deliberate exception to "read-only" is [Remote answers](#remote-answers-optional):
two `POST` endpoints hand an answer back to a session that asked a question. Even there
nothing is written to disk — the pending-question store lives in memory only.

## Analytics section

An **Analytics** tab shows a post-mortem card for each of the last few sessions you've run
the [`/kaizen`](https://docs.claude.com/en/docs/claude-code) skill on. `/kaizen` is the only
trigger: a session shows up here because `/kaizen` logged a line for it to
`~/.claude/session-analytics-log.md`. Nothing appears until you run it — and the dashboard itself never
writes anything (it just reads that log).

Each card pairs two things:

- **The numbers** — recomputed live from the transcript every time you open the tab: billable
  tokens (the real cost signal), total context tokens, subagent count + tokens, turn count,
  and tool-error/retry counts. Below that, the priciest tools (approx tokens) and the priciest
  subagents.
- **Research & suggestions** — the one-line lesson `/kaizen` wrote for that session. This is
  the qualitative part (what went well/badly, what to change) — the dashboard does no LLM calls
  and invents no advice; it surfaces exactly what `/kaizen` recorded.

Each card also carries a **status badge** — `actioned`, `promoted`, `dropped`, or `open` —
answering "did I ever act on this lesson?". `/kaizen` records that by appending a `status` line
to the same log once you've decided; a lesson with no such line is still open. And when no
`/kaizen review` sweep has happened in the last 7 days, the section bar shows a **review due**
chip: a nudge to sweep the accumulated lessons, promote the recurring ones, and prune rules that
stopped earning their keep.

**Workflow:** run `/kaizen` in a Claude Code session → it appends a lesson to
`~/.claude/session-analytics-log.md` → the session appears in the Analytics tab (hit ↻ to pull it in).
If a session's transcript has since been deleted, the card still shows the logged lesson,
just without the live numbers.

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

### Phone access (same wifi, or anywhere via Tailscale)

**Same wifi:** both servers bind all interfaces, so no tunnel is needed — open the
`Network:` URL Vite prints (e.g. `http://192.168.x.x:5173`), or `http://<lan-ip>:4173`
for prod.

**From anywhere** (cellular, other wifi — and immune to the LAN IP changing): install
[Tailscale](https://tailscale.com/download) on the host machine and your phone, sign both
into the same account (free personal plan), and the dashboard is reachable at a **stable**
MagicDNS hostname:

```
http://<mac-name>.<tailnet>.ts.net:4173   # prod   (pnpm start)
http://<mac-name>.<tailnet>.ts.net:5173   # dev    (pnpm dev — Vite proxies /api locally)
```

Find the hostname with `tailscale status`. Nothing is exposed to the public internet —
only devices signed into *your* tailnet can connect, which is why no extra login or auth
gate exists in the app. Optionally, `pnpm tunnel` (`tailscale serve --bg 4173`) fronts prod
over HTTPS at `https://<mac-name>.<tailnet>.ts.net` (no port, real certificate; enable
HTTPS certificates once in the tailnet admin console; `tailscale serve reset` stops it).
Gotcha: the host must be awake — Tailscale doesn't wake a sleeping machine. Details in
`.claude/rules/remote-access.md`.

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
  prints the address a phone on the same wifi should actually open. Tailscale access is
  unaffected — it runs on the host and forwards to the published port either way.

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

### Remote answers (optional)

When a session calls `AskUserQuestion`, the chat drawer can show its options as buttons —
tap one on your phone and the answer goes into the **live session**. This is the only part of
the dashboard that writes anything, and the only part that needs a hook.

#### Setup

Four steps, ~2 minutes. Needs `curl` and `jq` on the PATH — **without `jq` the hook exits
silently**, which looks exactly like "not installed", so check that first if nothing happens.

**1. Run the dashboard.** `pnpm dev` (or `pnpm build && pnpm start`). No `.env` needed —
remote answers are on by default. To answer from a phone, open the `Network:` URL Vite prints
(e.g. `http://192.168.x.x:5173`) on a device on the same wifi — or from anywhere via the
stable Tailscale hostname (see [Phone access](#phone-access-same-wifi-or-anywhere-via-tailscale)).

**2. Link the hook**, from the repo root. A symlink rather than a copy, so `git pull` keeps it
current:

```bash
mkdir -p ~/.claude/hooks && ln -s "$PWD/scripts/ask-remote-hook.sh" ~/.claude/hooks/ask-remote.sh
```

**3. Register it** in `~/.claude/settings.json`. Create the `AskUserQuestion` matcher if you
don't have one; keep any existing entry, since hooks under one matcher run in parallel (a
notification hook and this one coexist happily):

```json
{ "matcher": "AskUserQuestion", "hooks": [
  { "type": "command", "command": "bash \"$HOME/.claude/hooks/ask-remote.sh\"", "timeout": 630 }
]}
```

> ⚠️ That `timeout` **must** exceed the wait window (`CLAUDE_DASHBOARD_ANSWER_TIMEOUT`, default
> 600s), or the CLI kills the hook first and the window silently shrinks. Keep
> `timeout ≥ window + 30`.

**4. Verify the chain** without waiting for a real question:

```bash
curl -s localhost:4173/api/health
```

`{"ok":true,...,"remoteAnswer":true}` means the hook will engage — if `remoteAnswer` is false,
check the **phone answers** pill in the toolbar and `REMOTE_ANSWER` in your config. Then drive
the hook itself (`IDLE_SECS=0` forces the away branch, 20s window):

```bash
echo '{"session_id":"SID","tool_input":{"questions":[{"question":"Works?","header":"Test","options":[{"label":"Yes"},{"label":"No"}]}]}}' | CLAUDECODE=1 CLAUDE_DASHBOARD_IDLE_SECS=0 CLAUDE_DASHBOARD_ANSWER_TIMEOUT=20 bash ~/.claude/hooks/ask-remote.sh
```

Swap `SID` for a real id from `GET /api/sessions`. Open that session's chat drawer, tap an
option, and the command prints the `permissionDecision: "deny"` JSON that carries your answer
into a session. Silence after 20s means a gate stopped it.

> ⚠️ **macOS only, in practice.** Gate 3 (below) reads keyboard idle from `IOHIDSystem`.
> Elsewhere that read fails, which counts as "at the desk", so remote answering never engages.
> On Linux/WSL set `CLAUDE_DASHBOARD_IDLE_SECS=0` to skip the check — every question then waits
> for the dashboard until answered or timed out, and the panel's **answer in the terminal**
> button is your way back.

Steps 2 and 3 live in `~/.claude/`, outside this repo, so they're per-machine and can't be
shared through git. Only step 1 travels with a clone.

#### How it works

A `PreToolUse` hook fires on `AskUserQuestion` and offers the question to
the dashboard, holding the tool call while it waits. You answer in the drawer; the hook then
denies the tool call with a reason naming your choice, which the model reads and acts on
(there is no supported way for a hook to *fill in* an answer — deny-with-reason is the
mechanism). Everything else — dashboard down, nobody answers in time, you hit **answer in the
terminal** — falls through to the normal terminal dialog, so the feature can only ever add an
option, never take one away. If the dashboard isn't running, the probe gives up in under a
second, so a question costs no measurable extra latency.

**A question can't be both places at once.** The terminal dialog only renders once the hook
exits, so while the hook waits for your phone the dialog isn't there yet. Three gates decide
who gets the question, and the third is the one that matters day to day:

| Gate | Where | Question goes to |
|---|---|---|
| `REMOTE_ANSWER` | server config | `false` → terminal, always. Hard kill switch |
| **phone answers** toggle | dashboard toolbar | off → terminal, always. Off also releases anything already waiting |
| keyboard idle | the hook | **at your desk → terminal, instantly.** Away ≥ `CLAUDE_DASHBOARD_IDLE_SECS` (60s) → waits for your phone |

So with everything on, sitting at your keyboard behaves exactly as it did before the hook
existed — the dialog appears immediately, no delay, no hidden question. Remote answering only
engages once you've actually stepped away. Idle costs ~40ms to read, and an unreadable value
counts as at-the-desk: the dialog is never hidden on a guess.

> ⚠️ The gates are checked when the question is *asked*. Walk away 10 seconds after a question
> lands and it's already the terminal's — the phone won't offer it. The reverse is safe: the
> panel's **answer in the terminal** button hands a waiting question back within a second.

**Security.** These POSTs let anyone on your LAN steer a live session — including free text
("Other…") that reaches the model. On a shared network set `ANSWER_TOKEN` and put the same
value in `~/.claude/hooks/dashboard-token` (`chmod 600`); the browser asks for it once. Plain
HTTP with a static bearer token is a tripwire, not real auth. `REMOTE_ANSWER=false` turns the
whole feature off server-side. Over Tailscale the tailnet itself is the perimeter — device
identity beats any password, so `ANSWER_TOKEN` can stay empty unless you share the tailnet
with other people (see `.claude/rules/remote-access.md`).

**One file on disk.** The toggle is persisted to a gitignored `.remote-answer.json` in the repo
root, because `tsx watch` restarts the server on every edit and a switch you flipped before
walking away has to survive that. It's the only thing this app writes, and it fails open — an
unwritable path keeps the toggle working for the current run and the pill shows a `*`.

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
| `WEB_PORT` | `5173` | Port the Vite dev UI serves on (`pnpm dev` only; prod ignores it) |
| `MAX_SESSIONS` | `10` | How many sessions to show, most-recent first |
| `ACTIVE_WINDOW_MIN` | `5` | A recent session is one whose last message is within this many minutes |
| `LOOKBACK_HOURS` | `24` | Only consider sessions modified within this many hours |
| `SHOW_USAGE` | `true` | Show the header usage bars (fetches from Anthropic + reads keychain). Set `false` to disable |
| `SHOW_ANALYTICS` | `true` | Show the Analytics tab (last N `/kaizen`-logged sessions). Set `false` to disable |
| `ANALYTICS_KEEP` | `5` | How many logged sessions the Analytics tab shows, newest-first |
| `REMOTE_ANSWER` | `true` | Whether [remote answers](#remote-answers-optional) are available at all (the only write path). `false` → the toolbar pill reads "disabled" and questions always go to the terminal |
| `CLAUDE_DASHBOARD_IDLE_SECS` | `60` | Seconds of keyboard idle before you count as away (read by the hook). Below it, a question goes straight to the terminal dialog. `0` skips the check and always waits |
| `ANSWER_TOKEN` | _(empty)_ | Shared secret required by the two remote-answer POSTs. Empty = open, like every read endpoint. The hook reads the same value from `~/.claude/hooks/dashboard-token` |
| `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` | `600` | Seconds the hook waits for a remote answer (read by the hook, not the server). Keep the hook's `timeout` above it |
| `CLAUDE_DASHBOARD_URL` | `http://127.0.0.1:4173` | Where the hook looks for the dashboard |
| `SKIP_PROC_SCAN` | _(auto)_ | Skip the `lsof` process-liveness gate. Defaults to `true` inside a Docker container, `false` otherwise |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | _(auto)_ | Force the context-window size (tokens) for the `%` bar |
| `CLAUDE_CREDENTIALS_JSON` | _(unset)_ | OAuth creds blob for the usage bars when the host Keychain isn't reachable (Docker). See [Run in Docker](#run-in-docker) |

## Layout

```
shared/types.ts          the GET /api/sessions contract — imported by both sides

server/                  backend (Node + TypeScript, run via tsx — no compile step)
  index.ts               HTTP entry: routes /api/sessions(/:id) + /api/management + /api/analytics, serves client/dist in prod
  api.ts                 the /api/sessions + /api/management + /api/analytics handlers (scan + usage + error fallback)
  lib/config.ts          zero-dep .env loader
  lib/transcript.ts      tail-reads a transcript: tokens, model, context window, activity
  lib/scan.ts            enumerates + ranks sessions; process-liveness gate
  lib/usage.ts           fetches account 5h/weekly limits from Anthropic
  lib/analyze.ts         whole-session post-mortem → SessionAnalysis (also powers /kaizen)
  lib/sessionAnalyticsLog.ts       parses ~/.claude/session-analytics-log.md → per-session lessons,
                         lesson-status lines, review markers (append-only log)
  lib/analytics.ts       read-only reader: last N /kaizen-logged sessions, re-analyzed live
  lib/pending.ts         in-memory pending-question store behind remote answers
  lib/remoteState.ts     the remote-answer on/off switch (env gate + persisted UI toggle)

client/                  frontend (Vite + React + TypeScript)
  index.html
  src/main.tsx / App.tsx
  src/components/         Header, Toolbar, SessionList, SessionRow, SessionDetail
  src/components/analytics/AnalyticsView.tsx   the post-mortem card list (read-only)
  src/components/QuestionPanel.tsx             the answer-a-question action bar in the chat drawer
  src/components/RemoteAnswerToggle.tsx        toolbar pill for the remote-answer switch
  src/hooks/useSessions.ts   polls /api/sessions every 3s
  src/hooks/useAnalytics.ts  fetches /api/analytics on mount + manual refresh (no poll)
  src/hooks/usePendingQuestion.ts  polls /api/sessions/:id/question; posts the answer back
  src/hooks/useRemoteAnswer.ts     reads /api/health, flips POST /api/remote-answer
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
scripts/ask-remote-hook.sh    the PreToolUse[AskUserQuestion] hook; symlink into ~/.claude/hooks/

.claude/rules/           per-domain deep-dive docs (not auto-loaded; read when working in one)
  remote-access.md       phone access from anywhere via Tailscale — see Phone access above
```

## Not included (yet)

- Estimated USD cost per session. (Whole-session token totals now live in the
  **Analytics** tab — run `/kaizen` on a session and it appears there.)
