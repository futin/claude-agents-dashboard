# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. Shows, for the top N
most-recently-active sessions, what each one is doing right now — project, git branch,
context usage, and current tool activity — refreshing every few seconds.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. No daemon, no hooks,
no dependencies.

![one row per session: status dot, project + branch, context bar, current activity](docs/screenshot.png)

## Run

```bash
node server.js
# or
npm start
```

Opens `http://localhost:4173` (auto-launches your browser). Keep the tab open on a second
monitor while you run sessions in parallel.

Requires Node.js >= 18.

## Configuration

Copy `.env.example` to `.env` and edit. Everything is optional (defaults shown). Real
environment variables override `.env`, which overrides the defaults.

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4173` | Port to serve on |
| `MAX_SESSIONS` | `5` | How many sessions to show, most-recent first |
| `ACTIVE_WINDOW_MIN` | `5` | A session is **working** if its transcript changed within this many minutes; else **idle** |
| `LOOKBACK_HOURS` | `24` | Only consider sessions modified within this many hours |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | _(auto)_ | Force the context-window size (tokens) for the `%` bar |

## What each row shows

- **Status dot** — green pulsing = working, grey = idle.
- **Project + branch** — real path from the transcript's `cwd`, plus `gitBranch`.
- **Context bar + %** — current context tokens vs. the model's window (turns orange/red > 70%).
- **Activity line** — the session's most recent tool call (e.g. `Edit server.js`,
  `Task Explore: map the codebase`), so you can see what it's doing at a glance.
- **Relative time** — how long since the transcript last changed.

## How "active" is detected

Claude Code does not write an explicit "this session is live" flag to disk, so **active is a
heuristic**: a session counts as *working* when its transcript file was modified within
`ACTIVE_WINDOW_MIN`. As a sanity cross-check the header also shows the number of running
`claude` processes (from `ps`). Context size is read from the latest usage record in each
transcript (input + cache-read + cache-creation tokens).

## Tests

```bash
node test/run-all.js
```

## Layout

```
server.js          HTTP server + inline dashboard page; GET /api/sessions returns JSON
lib/config.js      zero-dep .env loader
lib/transcript.js  tail-reads a transcript: tokens, model, context window, last activity
lib/scan.js        enumerates + ranks sessions across ~/.claude/projects
test/              node-assert tests with tmpdir JSONL fixtures
```

## Not included (yet)

- Cumulative token totals / estimated USD cost per session.
- Global & per-project hooks / settings / skills view.
