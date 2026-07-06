# Removal of in-app OAuth token refresh ("Sync")

**Date:** 2026-07-06
**Status:** removed (feature deleted, this doc kept for the future)

## What was removed

The header usage bars (5h / Week) fetch account rate-limit utilization live from Anthropic
(`server/lib/usage.ts`, unchanged — **still present**). Layered on top of that was a **token
recovery** feature that let the user re-auth an expired OAuth token from the dashboard UI:

- `server/lib/token-refresh.ts` — spawned one headless `claude -p "ok" --model haiku` turn in
  `~/.claude/dashboard-refresh/`; the CLI renewed its own creds. Single-flight, 60s timeout,
  env stripped of API-key/proxy vars so the turn used the OAuth path.
- `POST /api/usage/refresh` (`serveUsageRefresh` in `server/api.ts`, route in `server/index.ts`).
- `UsageRefreshResponse` type (`shared/types.ts`); `forceUsageRefresh()` TTL-bypass (`usage.ts`).
- FE: a **Sync** button in `client/src/components/Header.tsx` (+ `.u-sync`/`.u-err` CSS) shown
  when `usageStatus === 'token-expired'`; on click it POSTed the refresh endpoint.
- `scan.ts` filtered the refresh turn's transcript out of the session list (cwd match on
  `refreshCwd()`); test in `scan.test.ts`. Both removed with the feature.

Historical design of the *original* feature: `docs/superpowers/specs/2026-07-01-usage-token-refresh-design.md`.

## Why removed

Too much machinery for a cosmetic header feature, and it fundamentally could not work in the
project's own Docker setup:

- **CLI-spawn coupling.** Refresh spawned the `claude` binary. Resolving that binary is
  environment-specific: a GUI-launched server (IDE run-config, `.app`) has a thin `PATH`
  missing `~/.local/bin`, so `execFile('claude')` threw `ENOENT`. A `resolveClaudeBin()` probe
  (CLAUDE_CLI_PATH → known install dirs → bare name) papered over it but added surface area.
- **Docker: impossible, not just broken.** The dashboard runs in a Linux container that (a) has
  no `claude` binary installed and (b) mounts `~/.claude` **read-only**. So a refresh could
  never spawn the CLI, and even if it could, the CLI couldn't persist renewed creds. In Docker
  the container's token comes from `CLAUDE_CREDENTIALS_JSON`, a **one-time snapshot** captured
  at `dev:docker` startup (`scripts/host-credentials.sh`, macOS-Keychain-specific).
- The bars are cosmetic. Losing them on token expiry is not worth a CLI-spawn + per-OS binary
  resolution + Docker special-casing.

## Current behavior (post-removal)

- `usageStatus === 'token-expired'` → header shows a plain "token expired" hint, no bars, no
  action button.
- Recovery is passive: the `claude` CLI renews its own token the next time it runs (host use),
  and the next 3s poll flips `usageStatus` back to `ok`; the bars return on their own.
- In Docker the snapshot goes stale after the token's few-hour TTL → restart the container to
  re-capture (`pnpm dev:docker`). Only needed if you want the bars back; nothing else depends
  on it.

## If a future feature needs the dashboard to make its own Anthropic API call

The lesson: **don't read the host's native secret store, and don't shell out to the CLI.** Both
are platform-specific (macOS Keychain / Windows Credential Manager / Linux libsecret-or-file)
and neither works from inside the container. A platform-independent design:

**Self-contained container — the container owns its own creds.**

1. Install `claude` in the image (`npm i -g @anthropic-ai/claude-code`; reuses the container's
   Node, lighter than the ~230 MB native binary).
2. Give the container a **writable** creds location it owns — a named Docker volume, *not* the
   read-only host bind. Never touches host creds.
3. One-time `docker compose exec <svc> claude` OAuth login writes creds to that volume as a
   plain Linux file. Same flow regardless of host OS.
4. The container then self-refreshes: any in-container `claude` invocation renews the file-based
   creds. No keychain bridge, no host coupling, no manual restart.

**One wrinkle to design:** transcripts must stay host-mounted read-only (`~/.claude/projects` —
the app's whole point), but the writable creds file also lives under `~/.claude`. Point the
container's creds at a separate dir via `CLAUDE_CONFIG_DIR` and teach `usage.ts` to honor it, so
the read-only transcript mount and the writable creds volume don't collide.

Rejected alternative: keep the host-handoff but make seeding portable — fails, because on
macOS/Windows creds live in a keychain with no file to read without a per-OS export command.
Only Linux hosts (file-based creds) work with zero config today.
