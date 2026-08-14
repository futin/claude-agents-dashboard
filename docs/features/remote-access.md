---
docs-sync:
  sources:
    - server/lib/origin.ts
    - client/src/components/OriginBadge.tsx
    - vite.config.ts
    - package.json
---

# Phone access & the origin badge

Both servers bind all interfaces, so **every route below works with no app config**.
None is required — pick what suits you.

| Route | URL | Notes |
|---|---|---|
| **localhost** | `http://localhost:5173` (dev) / `:4173` (prod) | the default |
| **LAN** | the `Network:` URL Vite prints, or `http://<lan-ip>:4173` for prod | free, but the IP moves when the network does |
| **Tailscale** | `http://<host>.<tailnet>.ts.net:5173` (dev) / `:4173` (prod) | recommended away-from-home: stable hostname, private, no auth gate needed |
| **any other tunnel** | ngrok / Cloudflare / `ssh -L` | works, but read the warning below |

## Tailscale (recommended)

A private WireGuard network between your own devices — nothing public, device identity is
the auth, no URL to guess. Install [Tailscale](https://tailscale.com/download) on the
host and your phone, sign both into the same account (free personal plan), and the
dashboard gets a **stable** MagicDNS hostname that survives LAN IP changes and works over
cellular. Find it with `tailscale status`.

Use the **dev** port while changing code: prod static-serves the built `client/dist`, so
it needs `pnpm build` + a restart to show a change, while dev hot-reloads.
Dev-over-tailnet relies on `allowedHosts: ['.ts.net']` in `vite.config.ts` — Vite ≥5.4.12
otherwise 403s any non-IP hostname (DNS-rebinding guard).

Gotcha: the host must be awake — Tailscale doesn't wake a sleeping machine.

### Optional HTTPS: `pnpm tunnel`

`pnpm tunnel` runs `tailscale serve --bg 5174`: Tailscale fronts that local port on 443
with a real TLS certificate, so the phone bookmark needs no port and shows no cert
warnings. Requires HTTPS certificates enabled once in the tailnet admin console;
`tailscale serve reset` stops it.

> ⚠️ The port in that script is fixed while the port it should front depends on your
> `.env` — prod `PORT` (default 4173) or, while developing, your Vite `WEB_PORT`. It
> currently points at `5174`, a dev `WEB_PORT` override, so adjust it (or your `.env`) to
> match what you actually run. Whatever it fronts is what the HTTPS hostname serves.

## Public tunnels — know what you expose

A public URL exposes *every* read endpoint — full transcripts, chat history, and
`/api/management/file` (config file bodies) — to anyone with the link. Set
`ANSWER_TOKEN` at minimum and put auth at the edge (ngrok Basic Auth / Cloudflare
Access). The origin badge reads **`public`** on such a connection; that's the reminder.

## Which route am I on? (the origin badge)

The toolbar shows a small pill — `local` / `LAN` / `tailnet` / `public` — saying how *your
browser* reached the dashboard. `public` is tinted orange. **Display-only**: nothing
gates on it, so there is no policy to lock yourself out of. Classification internals
(the tailnet-before-ULA ordering, the loopback-only `X-Forwarded-For` rule):
[.claude/rules/remote-access.md](../../.claude/rules/remote-access.md).

The [remote answers](remote-answers.md) flow works from any of these routes — the hook
always talks to `127.0.0.1` on the host and is untouched by how your browser connects.
