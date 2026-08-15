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
---

# Running in Docker

The repo ships one multi-stage `Dockerfile` (`deps` → `dev` / `build` → `runtime`,
node:20-alpine) and two compose files. In both, the container gets a **read-only** mount
of your host `~/.claude` — the transcripts it scans.

```bash
# production image — serves built client + API on http://localhost:4173
CLAUDE_CREDENTIALS_JSON=$(scripts/host-credentials.sh) docker compose up --build

# dev image — Vite hot-reload on http://localhost:5173, source bind-mounted
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
