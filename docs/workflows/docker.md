---
docs-sync:
  sources:
    - Dockerfile
    - docker-compose.yml
    - docker-compose.dev.yml
    - scripts/host-credentials.sh
    - scripts/lan-ip.sh
    - server/lib/config.ts
  kind: workflow
  verified: 8326b88586603f5ad72061c686d3d33bd8f50f67
---

# Running in Docker

The repo ships one multi-stage `Dockerfile` (`deps` → `dev` / `build` → `runtime`,
node:20-alpine) and two compose files. In both, the container gets a **read-only** mount
of your host `~/.claude` — the transcripts it scans.

```bash
# production image — serves built client + API on http://localhost:4173
CLAUDE_CREDENTIALS_JSON=$(scripts/host-credentials.sh) docker compose up --build

# dev image — Vite hot-reload on http://localhost:5174, source bind-mounted
pnpm dev:docker
```

`pnpm dev:docker` expands to `docker compose -f docker-compose.dev.yml up --build` with
`HOST_LAN_IP` and `CLAUDE_CREDENTIALS_JSON` pre-filled from the two helper scripts.

## What the helper scripts bridge

Two things a container can't reach on its own:

- **Usage bars need the OAuth token**, which lives in the host macOS Keychain — a Linux
  container has no `security` binary. `scripts/host-credentials.sh` reads it on the host
  and passes the blob in as `CLAUDE_CREDENTIALS_JSON`. Omit it and the bars fail open
  (everything else still works, falling back to the mounted
  `~/.claude/.credentials.json` if present).
- **Phone access:** Vite inside a container only sees its own bridge IP, not the host's
  LAN IP, so its printed `Network:` URL is useless. `scripts/lan-ip.sh` passes
  `HOST_LAN_IP` in and the dev server prints a `Phone (LAN):` line with the address a
  phone should actually open. Tailscale access is unaffected — it runs on the host and
  forwards to the published ports.

## Container-specific behavior

- The **process-liveness gate is auto-disabled** (`server/lib/config.ts`
  `isDockerContainer()` detects `/.dockerenv`): the container only sees its own process
  namespace, so `lsof` could never find the host's `claude` processes and would force
  every session to idle. Override either way with `SKIP_PROC_SCAN`. See
  [session status](../subsystems/sessions.md#the-status-machine-the-left-dot).
- The dev compose bind-mounts the source but keeps the container's own Linux
  `node_modules` (an anonymous volume shadows the host's).
- `~/.claude` is mounted read-only, which is also why the remote-answer toggle persists
  to a repo-root file instead of anywhere under `~/.claude`.
- **Dictation is unavailable in these images.** `config.ts` reads `WHISPER_MODEL`,
  `WHISPER_BIN` and `FFMPEG_BIN`, but neither compose file passes them and the
  `node:20-alpine` stages install neither `whisper-cli` nor `ffmpeg` — so `probeTranscribe`
  fails, `/api/health` reports `transcribe: false`, and the mic never renders (which is the
  designed no-engine behavior, not a broken state). Running the server on the host is the
  supported way to use it; see [dictation-setup](dictation-setup.md).
- **Spawning a session is unavailable in these images too.** `config.ts` reads `CLAUDE_BIN`,
  but neither compose file passes it and no stage installs the `claude` CLI — so `probeSpawn`
  fails, `/api/health` reports `spawnAvailable: false`, and the toolbar's `+ New` button never
  renders. Same designed no-binary behavior as dictation above, and the same fix: run the
  server on the host. See [spawn](../subsystems/spawn.md).
- **Push notifications need their three variables passed in explicitly.** `.env` is in
  `.dockerignore` and the runtime stage copies only `server/`, `shared/` and the built
  client, so `loadConfig()` finds no file in the production image. Both compose files
  therefore list `NTFY_TOPIC`, `NTFY_SERVER` and `DASHBOARD_PUBLIC_URL` bare under
  `environment:`, which Compose resolves from your shell **or** the project's `.env` on the
  host — the values reach the container even though the file does not. Bare rather than
  `VAR=${VAR}` because Compose drops an unset variable in that form, while the `=` form
  injects an empty string that `config.ts` counts as set. ⚠️ `DASHBOARD_PUBLIC_URL` has no
  default, and a `localhost` value would resolve inside the container's own network
  namespace — so the tailnet hostname is the only useful one here. See
  [push-notify-setup](push-notify-setup.md#docker).
