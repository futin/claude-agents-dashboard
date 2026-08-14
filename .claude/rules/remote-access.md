# Remote access (phone from anywhere, via Tailscale)

The dashboard is reachable from outside the home LAN through a **Tailscale tailnet** — a
private WireGuard network between your own devices. This was chosen over ngrok / Cloudflare
Tunnel deliberately: the app never touches the public internet, so **no login page, no auth
gate, and zero app-code changes** were needed. The server already binds all interfaces
(`server/index.ts` `server.listen(config.port)`) and Vite has `server.host: true`, so both
ports are tailnet-reachable as-is.

- **The model: device identity *is* the auth.** Only devices signed into your Tailscale
  account can connect — nothing is exposed publicly, there is no URL to guess, and traffic is
  end-to-end encrypted. That is *stronger* than the app's LAN-trust posture, so the existing
  security model carries over unchanged: reads stay open, and `ANSWER_TOKEN` (gating the
  three write POSTs) may stay empty. Set `ANSWER_TOKEN` only if you **share the tailnet**
  with other people — inside the tailnet it means exactly what it meant on a shared LAN.
- **Why not ngrok/Cloudflare:** a public tunnel URL would expose every read endpoint —
  full transcripts, chat history, and `/api/management/file` (config file bodies) — to anyone
  with the link, which would have required building an app-level auth gate (breaking the
  zero-code story) or trusting edge config. ngrok free also interposes an interstitial page;
  a stable Cloudflare hostname needs an owned domain. The tailnet sidesteps all of it.

## One-time setup

1. Install Tailscale on the Mac (menu-bar app, `brew install --cask tailscale` or
   tailscale.com/download) and on the phone (App Store / Play Store).
2. Sign both into the **same account** (free personal plan covers 3 users / 100 devices).
3. MagicDNS is on by default; find the Mac's stable hostname with `tailscale status` or in
   the admin console — it looks like `<mac-name>.<tailnet>.ts.net`.

## URLs

| Mode | URL |
|---|---|
| prod (`pnpm start`) | `http://<mac>.<tailnet>.ts.net:4173` |
| dev (`pnpm dev`) | `http://<mac>.<tailnet>.ts.net:5173` (Vite proxies `/api` locally, so dev works over the tailnet too — unlike a single-port tunnel) |
| HTTPS (optional) | `https://<mac>.<tailnet>.ts.net` via `pnpm tunnel` (below) |

## Optional HTTPS (`pnpm tunnel`)

`pnpm tunnel` runs `tailscale serve --bg 4173`: Tailscale fronts the prod server on port 443
with a real TLS certificate, so the phone bookmark is just `https://<mac>.<tailnet>.ts.net`
— no port, no cert warnings. Requires **HTTPS certificates enabled once** in the tailnet
admin console (DNS page). `--bg` persists across reboots; `tailscale serve reset` stops it.
Purely optional — the plain `:4173` URL works with no serve step at all.

## Phone usage

- Keep the Tailscale VPN toggle **on** — it's set-and-forget with negligible battery cost,
  and works over cellular and foreign wifi alike.
- Bookmark the stable hostname; it never changes when the LAN IP does.
- The remote-answer flow (the pulsing `answer` pill → option buttons in the drawer — see
  `remote-answer.md`) works from anywhere; the hook still talks to `127.0.0.1` on the host
  and is untouched by any of this.

## Gotchas

- **The Mac must be awake.** Tailscale doesn't wake a sleeping machine; disable sleep (or
  use `caffeinate`) if you rely on away-from-home access.
- **Docker runs are unaffected** — Tailscale runs on the host and forwards to the published
  localhost ports, same as a LAN client.
