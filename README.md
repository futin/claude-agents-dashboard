# Claude Agents Dashboard

A live, always-open monitor for **parallel Claude Code sessions**. For the top N
most-recently-active sessions it shows what each one is doing right now — project, git
branch, model, context usage, and current tool activity — refreshing every 3 seconds by
default, retunable in the Settings tab.

Reads everything straight from `~/.claude/projects/*/*.jsonl` on disk. **Monitoring needs
no daemon, no hooks, and no config in Claude Code** — hooks are installed only by the
opt-in features that need one ([remote answers](docs/subsystems/remote-answer.md),
[remote plan verdicts](docs/subsystems/remote-plan.md), the
[`allow?` tab](docs/subsystems/permission-notify.md), and the `Stop` hook behind both the
finished-turn [push](docs/subsystems/push-notify.md) and
[remote messages](docs/subsystems/remote-message.md)). Zero runtime dependencies on the backend (Node
built-ins only), and exactly one outbound call — the ntfy push.

## Quick start

Requires **Node.js >= 18** and **pnpm**.

```bash
pnpm install
pnpm dev
```

Open **`http://localhost:5174`** — the API server and the Vite dev server run together,
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
  current tool activity, expandable subagent detail, filter + sort toolbar, and a
  full-height tab down the row's right edge that opens the chat — and names the hold
  (`answer` / `plan?` / `reply?` / `allow?`) when a session is waiting on you.
- **[Chat drawer](docs/subsystems/chat.md)** — read any session's conversation:
  live-tailed, pageable back through the whole transcript, with an all/text/you filter
  and markdown rendering.
- **[Remote answers](docs/subsystems/remote-answer.md)** — answer a session's
  `AskUserQuestion` from your phone; the pick is delivered into the live session. The first
  of the app's four write paths, and the reason the hook install exists.
- **[Remote plan verdicts](docs/subsystems/remote-plan.md)** — send a proposed
  `ExitPlanMode` plan back for revision with feedback, from the same drawer. Reject-only:
  the CLI discards a hook `allow` for plans, so accepting stays a terminal action.
- **[Remote messages](docs/subsystems/remote-message.md)** — when a turn finishes while
  you're away, the `Stop` hook holds it open for a short window and you type a follow-up
  into the drawer; the model reads it as your next instruction and carries on. No reply and
  the session just stops, as it always did. Sessions the dashboard spawned itself are the
  exception to *away*: they have no terminal to type into, so their window opens — and
  survives the idle sweep — whether you're at the desk or not.
- **[Dictation](docs/subsystems/dictation.md)** — a mic in that same composer: speak the
  follow-up instead of thumb-typing it on a phone. Recorded in the browser, transcoded and
  transcribed **on this machine** by a local whisper.cpp — no audio leaves the box, keeping
  the ntfy push the only outbound call. The transcript lands in the textarea as editable
  text; **send** stays a deliberate tap. Off until you install the engine, and needs HTTPS
  (`pnpm tunnel`) to record at all from a phone.
- **[New session](docs/subsystems/spawn.md)** — the toolbar's **+ New** button starts a
  brand-new session from the dashboard: pick a recent project, write or dictate the prompt,
  tap launch. The server spawns a detached, headless `claude -p` in that project's
  directory and the row shows up a poll later, ordinary from then on. The fourth write
  path, and the first one the dashboard *initiates* rather than answers. A session started
  this way is also not a dead end once its turn is over: its chat drawer offers a **resume**
  composer that relaunches the same session id, so the same transcript continues and the
  same row wakes up. Off by default
  (empty `CLAUDE_BIN`); how much a launch can do unattended is bounded by the
  `SPAWN_MAX_PERMISSION` ceiling on the host, never by the browser.
- **[Management tab](docs/subsystems/management.md)** — read-only browser for all Claude
  config on the machine: skills, agents, commands, rules, hooks, settings, plugins, per
  scope. A skill that ships more than `SKILL.md` opens its whole directory in a file rail
  beside the viewer.
- **[Analytics tab](docs/subsystems/analytics.md)** — per-session post-mortem cards
  (tokens, priciest tools/subagents) paired with the lesson the `/kaizen` skill logged.
- **[Guides tab](docs/subsystems/guides.md)** — browse the tutor decks and study guides
  published under `docs/published-guides/`, each opened inside the dashboard itself. That is
  what makes them readable on a phone over the tailnet, with no trip through GitHub Pages.
- **[Usage bars](docs/subsystems/usage-limits.md)** — the header's 5h / Week account
  rate-limit bars, same numbers as `/usage` in the CLI.
- **[Push notifications](docs/subsystems/push-notify.md)** — the server publishes to an
  [ntfy](https://ntfy.sh) topic when a session needs you (question, plan, permission
  dialog, finished turn); tapping the push opens that session's chat. Off by default, and
  the only channel that reaches you with the browser closed — which is why the old
  in-browser alert layer was deleted rather than kept: WebKit has no `Notification` API in
  a tab, so it could never fire on an iPhone.
- **[Settings tab](docs/subsystems/settings.md)** — themes, density and text scale, refresh
  rate, the scan knobs, the push-notification policy, and the remote-answer idle threshold
  and answer window — all editable in the app, no `.env` edit or rebuild.
- **[Phone access & origin badge](docs/subsystems/remote-access.md)** — reach the
  dashboard over LAN, Tailscale, or a tunnel; a toolbar pill shows which route you're on.

## Optional setup

- **All five hooks, one command** — `pnpm hooks:install` symlinks them into `~/.claude` and
  merges the six settings entries, idempotently, with `--dry-run` and `--uninstall`:
  [setup](docs/workflows/hooks-setup.md). Everything below that mentions a hook is what it
  automates; you still choose the token, the topic, and whether remote answering is on.
- **Phone / away-from-home access** — nothing to configure in the app; see
  [remote access](docs/subsystems/remote-access.md) for LAN, Tailscale, and tunnel options.
- **Remote answers hook** — 4 steps, ~2 minutes:
  [setup](docs/workflows/remote-answer-setup.md).
- **Push notifications to your phone** — 6 steps, ~5 minutes: pick a secret ntfy topic,
  subscribe the phone, set two `.env` values, enable it in Settings:
  [setup](docs/workflows/push-notify-setup.md).
- **Dictation (local whisper)** — 5 steps, ~5 minutes and ~150MB of disk: `brew install
  whisper-cpp` (plus `ffmpeg`), a model file, one `.env` line, and `pnpm tunnel` for phone
  use: [setup](docs/workflows/dictation-setup.md). Read the [security
  posture](docs/subsystems/dictation.md#security-posture) first if other devices can reach
  the dashboard — the endpoint spawns processes and is gated only by `ANSWER_TOKEN`, which
  defaults to empty.
- **New sessions (spawn)** — 1 step, ~1 minute: point `CLAUDE_BIN` at your `claude` binary
  (`which claude`), and set `SPAWN_MAX_PERMISSION` below its `auto` default if that's more
  than you want an unattended launch to have. Read the [security
  posture](docs/subsystems/spawn.md#security-posture) first — this is the widest write
  surface in the app; it's gated by the same `ANSWER_TOKEN` that defaults to empty, and by
  the remote-answer toggle, so flipping that pill off stops launching too.
- **Docker** — production and dev images, read-only `~/.claude` mount:
  [docker](docs/workflows/docker.md).
- **Configuration** — everything is optional, defaults work out of the box; the full
  `.env` reference is in [configuration](docs/workflows/configuration.md).

## Documentation

[`docs/overview.md`](docs/overview.md) is the entry point — domains, data flow, HTTP
surface, repo layout, and the map of every doc. Per-subsystem deep dives (mechanism +
invariants) live in [`docs/subsystems/`](docs/subsystems/); runnable procedures
(configuration, Docker, the remote-answers hook, push-notification and dictation setup) in
[`docs/workflows/`](docs/workflows/).

## Not included (yet)

- Estimated USD cost per session. (Whole-session token totals live in the
  **Analytics** tab — run `/kaizen` on a session and it appears there.)

<!-- docs-sync:
  sources:
    - server/
    - client/
    - scripts/
    - package.json
  kind: readme
  verified: fa9fdbc0d1f74c5ba2d43f90ecb63806e5b39b14
-->
