# Where a session lives, and where you can continue it

Written after the remote-control spawn work (2026-08-17), because the boundaries
between the surfaces are easy to guess wrong — several were guessed wrong, tested,
and corrected the same day. Every claim below was verified live on this machine
(CLI 2.1.233, desktop app 1.30096.5) unless marked *untested*.

## The five kinds of session

| # | Kind | Runs on | Local skills / memory / files | Account-registered |
|---|------|---------|-------------------------------|--------------------|
| A | Desktop-app (Harness) session | this Mac | ✅ | ❌ (local registry only) |
| B | Terminal `claude` | this Mac | ✅ | only with `--remote-control` |
| C | Dashboard spawn, plain headless `-p` | this Mac | ✅ | ❌ |
| D | Dashboard spawn with **remote control** (the default) | this Mac | ✅ | ✅ while alive |
| E | Cloud session (created from the phone app / claude.ai) | Anthropic sandbox | ❌ | ✅ |

E is the only one that does **not** get this Mac's global skills, memory, hooks, or
filesystem — that is the trade the phone app's native "new chat" makes, and the
reason D exists at all.

## What each surface can see and do

| Surface | Sees | Can continue a conversation | Long-text comfort |
|---|---|---|---|
| Desktop app sidebar | A + E — it merges the account's **cloud** sessions into the list (verified: a phone-created cloud session appears; its id is absent from the app's local registry, so this is a rendered merge, not an import). **Not D** — a live, phone-visible RC session shows nowhere in the app | A full UI; E as a cloud thread | ✅ |
| Phone Claude app | D (while alive), E | D and E, full chat UI | ✅ |
| claude.ai web | E; D *untested* | E | ✅ |
| This dashboard | A, B, C, D (anything with a transcript on disk) | any of them via the turn-end reply window (away-only), 8 replies per stretch | ⚠️ composer, not a thread UI |
| Terminal `claude --resume <id>` | any local transcript (A–D) | full TUI with complete history | ✅ |
| Another local session (`ListAgents`/`SendMessage`) | any *live* local session, incl. one held in its reply window | enqueue a message; the reply comes back cross-session | n/a (agent-to-agent) |

## The two boundaries that will not move from this repo

- **Nothing external can add a row to the desktop app's local sidebar.** Its registry
  is private and its management surface (`ccd_session_mgmt`) has list/get/send but no
  create/import. A spawned session — RC or not — will never appear there.
- **The desktop app does not show remote-control sessions anywhere** (tested with one
  running and visible on the phone) — even though it *does* merge cloud sessions into
  its sidebar. The exclusion is specifically RC. Until the app grows that view,
  "continue in the desktop app UI" for a spawned session means `claude --resume`.

## So what is remote control *for*?

One thing, and it is the thing cloud sessions can't do: **the phone app's full chat
UI attached to a session that runs on this Mac** — local skills, memory, hooks,
repo checkout, the lot. Away from the desk, that is strictly better than both
alternatives: the dashboard composer (works, but it's a text box, not a thread) and
a phone-app cloud session (nice thread, wrong brain).

Lifetime caveat: C and D exit when their turn ends unless the away-hold keeps them
open (`Stop` hook + `idleSecs`; see [remote-message](remote-message.md)). At the
desk they die in seconds by design — you'd continue them in a terminal instead. A
session that has exited shows nowhere live; its transcript remains resumable and
visible to the dashboard.

## Continuity recipes

- **Start on the phone → keep talking on the phone:** dashboard spawn (RC default
  on) → open it in the phone Claude app. Or stay in the dashboard reply window.
- **Start on the phone → continue in the desktop app UI:** create a **cloud** session
  in the phone app instead of spawning — it appears in the desktop sidebar (verified)
  and continues there as a cloud thread. Cost: the cloud brain — no Mac skills,
  memory, or files.
- **Start on the phone → continue at the Mac with the Mac brain:**
  `claude --teleport <session-id>` — **verified**: the same cloud thread continues in
  a local terminal TUI, with this machine's filesystem (it read uncommitted local
  files) and global hooks (a SessionStart hook demonstrably fired). This is the
  strongest phone→Mac chain: the session is visible on every account surface while
  cloud, then lands locally with full powers when you sit down.
  **Teleport is a move, not a mirror** (verified twice): the thread leaves the cloud,
  so it disappears from the app sidebar and the phone list, and from then on it is an
  ordinary terminal session — a transcript under `~/.claude/projects` that the
  dashboard monitors and `--resume` reopens. You hold a session on exactly one side
  at a time.
- **Start on the phone → continue at the Mac:** `claude --resume <session-id>` in a
  terminal — full history, everything local. (The id is in the dashboard row / chat
  drawer URL.)
- **Start at the Mac (Harness) → continue on the phone:** the dashboard already
  monitors every local session; use the reply window. A-sessions are not
  RC-registered, so the phone *app* cannot attach to them.
- **Start in the desktop app → continue in the desktop app:** its own sidebar,
  as always.
