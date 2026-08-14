# Remote access (reaching the dashboard)

Both servers already bind all interfaces — `server/index.ts` `server.listen(config.port)` and
Vite's `server.host: true` — so **every route below works with zero app-code changes**. Pick
whichever suits the moment; none of them is required, and nothing in the app depends on any
of them being present.

| Route | URL | Notes |
|---|---|---|
| **localhost** | `http://localhost:5173` (dev) / `:4173` (prod) | the default; nothing to set up |
| **LAN** | `http://<lan-ip>:5173` / `:4173` | the `Network:` URL Vite prints. Free, but the IP moves when the network does |
| **Tailscale** | `http://<host>.<tailnet>.ts.net:4173` (prod) / `:5173` (dev) | recommended for away-from-home — stable hostname, private, no auth gate needed. Dev needs `allowedHosts` (below) |
| **any other tunnel** | ngrok / Cloudflare / `ssh -L` … | works too, but read the warning below first |

## Why Tailscale is the recommended away-from-home option

A tailnet is a private WireGuard network between your own devices, so the dashboard never
touches the public internet. **Device identity is the auth** — only devices signed into your
Tailscale account can connect, there is no URL to guess, and traffic is end-to-end
encrypted. That is *stronger* than the app's LAN-trust posture, so the existing security
model carries over unchanged: reads stay open, and `ANSWER_TOKEN` (gating the three write
POSTs) may stay empty. Set `ANSWER_TOKEN` only if you **share the tailnet** with other
people — inside a tailnet it means exactly what it meant on a shared LAN.

The trade-off: every connecting device needs the Tailscale app, so you can't hand the URL to
someone who isn't on your tailnet.

> ⚠️ **If you pick a public tunnel instead** (ngrok, Cloudflare, …), understand what it
> exposes: *every* read endpoint is open — full transcripts, chat history, and
> `/api/management/file` (config file bodies) — to anyone with the link. Set `ANSWER_TOKEN`
> at minimum, and put auth at the edge (ngrok Basic Auth / Cloudflare Access), or add an
> app-level gate. The origin badge reads **`public`** on such a connection, which is the
> reminder. ngrok's free tier also interposes an interstitial page, and a stable Cloudflare
> hostname needs an owned domain.

## Which route am I on? (the origin badge)

The toolbar shows a small pill — `local`, `LAN`, `tailnet`, or `public` — saying how *your
browser* reached the dashboard. `public` is tinted orange, since it's the one worth noticing.

- **Display-only.** `server/lib/origin.ts` (pure, zero-dep, unit-tested in `test/origin.test.ts`)
  classifies `req.socket.remoteAddress`; the value rides on `GET /api/health` as
  `HealthResponse.origin` and renders via `components/OriginBadge.tsx`. **Nothing gates on
  it** — there is no policy to lock yourself out of.
- **⚠️ Classification order is load-bearing:** Tailscale's IPv6 range `fd7a:115c:a1e0::/48`
  sits *inside* the generic ULA space `fc00::/7`, so the tailnet check must run before the LAN
  check or every tailnet client reads `lan`. IPv4 tailnet is the CGNAT range `100.64.0.0/10`.
- **⚠️ `X-Forwarded-For` is honoured only from a loopback socket.** `pnpm tunnel`
  (`tailscale serve`) proxies on the host, so the socket is `127.0.0.1` and the peer's real
  tailnet address survives only in that header — without the fallback every tunnel user would
  read `local`. Spoofing is a non-issue by construction: only something already on the machine
  can send it, and it drives a badge with no policy attached.
- **⚠️ The dev proxy needs `xfwd: true`** (`vite.config.ts`). Vite reaches the API over
  loopback, so without it every `pnpm dev` client — including a phone on the LAN — classifies
  as `local`.
- No Tailscale installed ⇒ the tailnet branches never match and the badge reads `local` or
  `LAN`. Unreadable address ⇒ `unknown`; absent field (older server) ⇒ no badge at all.

## Tailscale setup (one-time, optional)

1. Install Tailscale on the host (menu-bar app, `brew install --cask tailscale` or
   tailscale.com/download) and on the phone (App Store / Play Store).
2. Sign both into the **same account** (free personal plan covers 3 users / 100 devices).
3. MagicDNS is on by default; find the host's stable hostname with `tailscale status` or in
   the admin console — it looks like `<host-name>.<tailnet>.ts.net`.

Dev works over the tailnet too (`:5173` — Vite proxies `/api` locally), unlike a single-port
public tunnel. **This is the mode to use while iterating**: prod (`:4173`) static-serves the
built `client/dist`, so every change needs a `pnpm build` *and* a `pnpm start` restart, while
dev hot-reloads and needs neither.

> ⚠️ **`allowedHosts: ['.ts.net']` in `vite.config.ts` is what makes dev-over-tailnet work.**
> Vite ≥5.4.12 rejects any `Host` header that isn't localhost or a bare IP (a DNS-rebinding
> guard), so a MagicDNS name 403s with *"Blocked request. This host is not allowed."* — LAN
> access never hit this because a LAN URL is an IP. The leading dot allows subdomains and
> scopes the exemption to tailnet hostnames instead of disabling the check (`allowedHosts:
> true`). Delete that line and phone-over-tailnet dev breaks with a 403, not a hang.

### Optional HTTPS (`pnpm tunnel`)

`pnpm tunnel` runs `tailscale serve --bg 4173`: Tailscale fronts the prod server on port 443
with a real TLS certificate, so the phone bookmark is just `https://<host>.<tailnet>.ts.net`
— no port, no cert warnings. Requires **HTTPS certificates enabled once** in the tailnet
admin console (DNS page). `--bg` persists across reboots; `tailscale serve reset` stops it.
Purely optional — the plain `:4173` URL works with no serve step at all.

### Phone usage

- Keep the Tailscale VPN toggle **on** — set-and-forget, negligible battery, works over
  cellular and foreign wifi alike.
- Bookmark the stable hostname; it never changes when the LAN IP does.
- The remote-answer flow (the pulsing `answer` pill → option buttons in the drawer — see
  `remote-answer.md`) works from anywhere; the hook still talks to `127.0.0.1` on the host
  and is untouched by any of this.

## Gotchas

- **`pnpm tunnel` fronts prod (4173), not Vite.** So a tunnel session shows the *built*
  client and the server process you started — neither picks up a code change until
  `pnpm build` + a `pnpm start` restart. A stale pair is the usual reason the origin badge is
  missing entirely through the tunnel while dev shows it fine (`client/dist` is gitignored, so
  pulling never refreshes it). Point Tailscale at `:5173` while developing instead.
- **The host must be awake.** Tailscale doesn't wake a sleeping machine; disable sleep (or
  use `caffeinate`) if you rely on away-from-home access.
- **Docker runs are unaffected** — Tailscale runs on the host and forwards to the published
  localhost ports, same as a LAN client. The badge sees the container's view of the peer
  address, so containerized dev may read `lan` where a host run reads `local`.
