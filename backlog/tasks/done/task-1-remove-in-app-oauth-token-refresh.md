---
id: task-1
title: Remove in-app OAuth token refresh
created: 2026-07-06
---

## Goal

Remove the in-app "Sync" token-recovery feature: too much machinery for a
cosmetic header feature, and it fundamentally could not work in the project's
own Docker setup.

## Plan

The header usage bars (5h / Week) fetch account rate-limit utilization live
from Anthropic (`server/lib/usage.ts`, unchanged — stays present). Remove the
token-recovery layer built on top of it:

- `server/lib/token-refresh.ts` — spawned one headless `claude -p "ok" --model
  haiku` turn in `~/.claude/dashboard-refresh/`; the CLI renewed its own creds.
  Single-flight, 60s timeout, env stripped of API-key/proxy vars so the turn
  used the OAuth path.
- `POST /api/usage/refresh` (`serveUsageRefresh` in `server/api.ts`, route in
  `server/index.ts`).
- `UsageRefreshResponse` type (`shared/types.ts`); `forceUsageRefresh()`
  TTL-bypass (`usage.ts`).
- FE: the **Sync** button in `client/src/components/Header.tsx` (+
  `.u-sync`/`.u-err` CSS) shown when `usageStatus === 'token-expired'`; on
  click it POSTed the refresh endpoint.
- `scan.ts` filtered the refresh turn's transcript out of the session list
  (cwd match on `refreshCwd()`); test in `scan.test.ts`. Remove both with the
  feature.

Reasons, for the record: **CLI-spawn coupling** — refresh spawned the `claude`
binary, and resolving that binary is environment-specific (a GUI-launched
server has a thin `PATH` missing `~/.local/bin`, so `execFile('claude')`
throws `ENOENT`; a `resolveClaudeBin()` probe papered over it but added
surface area). **Docker: impossible, not just broken** — the container has no
`claude` binary and mounts `~/.claude` read-only; in Docker the token comes
from a one-time `CLAUDE_CREDENTIALS_JSON` snapshot captured at `dev:docker`
startup, so a refresh could never spawn the CLI and couldn't persist renewed
creds even if it could. The bars are cosmetic — not worth a CLI-spawn +
per-OS binary resolution + Docker special-casing to keep them alive on token
expiry.

Post-removal behavior: `usageStatus === 'token-expired'` → header shows a
plain "token expired" hint, no bars, no action button. Recovery is passive —
the `claude` CLI renews its own token the next time it runs (host use), and
the next 3s poll flips `usageStatus` back to `ok`. In Docker the snapshot goes
stale after the token's few-hour TTL → restart the container to re-capture
(`pnpm dev:docker`); only needed to get the bars back, nothing else depends on
it.

Historical design of the *original* feature, for context if this is ever
revisited: `docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md`.

## Test cases

- `scan.test.ts`: the refresh-turn-filtering case is removed along with
  `refreshCwd()`.
- Manual: force `usageStatus === 'token-expired'` and confirm the header shows
  the plain hint with no Sync button, and that the bars return on their own
  once the CLI re-authenticates and the next poll lands.

## Done when

`server/lib/token-refresh.ts`, `POST /api/usage/refresh`,
`UsageRefreshResponse`, `forceUsageRefresh()`, the Header Sync button/CSS, and
the `scan.ts` refresh-turn filtering are all deleted; `server/lib/usage.ts`
and the 5h/Week bars themselves are unaffected.

## If a future feature needs the dashboard to make its own Anthropic API call

The lesson: **don't read the host's native secret store, and don't shell out
to the CLI.** Both are platform-specific (macOS Keychain / Windows Credential
Manager / Linux libsecret-or-file) and neither works from inside the
container. A platform-independent design — **self-contained container, the
container owns its own creds:**

1. Install `claude` in the image (`npm i -g @anthropic-ai/claude-code`; reuses
   the container's Node, lighter than the ~230 MB native binary).
2. Give the container a **writable** creds location it owns — a named Docker
   volume, *not* the read-only host bind. Never touches host creds.
3. One-time `docker compose exec <svc> claude` OAuth login writes creds to
   that volume as a plain Linux file. Same flow regardless of host OS.
4. The container then self-refreshes: any in-container `claude` invocation
   renews the file-based creds. No keychain bridge, no host coupling, no
   manual restart.

One wrinkle to design: transcripts must stay host-mounted read-only
(`~/.claude/projects` — the app's whole point), but the writable creds file
also lives under `~/.claude`. Point the container's creds at a separate dir
via `CLAUDE_CONFIG_DIR` and teach `usage.ts` to honor it, so the read-only
transcript mount and the writable creds volume don't collide.

Rejected alternative: keep the host-handoff but make seeding portable — fails,
because on macOS/Windows creds live in a keychain with no file to read
without a per-OS export command. Only Linux hosts (file-based creds) work
with zero config today.

## Outcome

Shipped and removed (2026-07-06, prior to this backlog existing). Verified at
the time by confirming the deleted files/routes/types were gone and the
header fell back to the plain "token expired" hint with bars returning
passively — see the removal record this task was migrated from,
`docs/plans/2026-07-06-usage-token-refresh-removal.md` (kept in git history).
Migrated into this backlog on 2026-08-24 as a closed record, not re-verified
at migration time.
