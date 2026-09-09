# Remote access — reaching the dashboard, and the origin badge

Both servers already bind all interfaces — `server/index.ts` `server.listen(config.port)`
and Vite's `server.host: true` — so **every route below works with zero app-code
changes**. Pick whichever suits the moment; none of them is required, and nothing in the
app depends on any of them being present.

| Route | URL | Notes |
|---|---|---|
| **localhost** | `http://localhost:5174` (dev) / `:4173` (prod) | the default; nothing to set up |
| **LAN** | `http://<lan-ip>:5174` / `:4173` | the `Network:` URL Vite prints. Free, but the IP moves when the network does |
| **Tailscale** | `http://<host>.<tailnet>.ts.net:4173` (prod) / `:5174` (dev) | recommended for away-from-home — stable hostname, private, no auth gate needed. Dev needs `allowedHosts` (below) |
| **any other tunnel** | ngrok / Cloudflare / `ssh -L` … | works too, but read the warning below first |

## Why Tailscale is the recommended away-from-home option

A tailnet is a private WireGuard network between your own devices, so the dashboard never
touches the public internet. **Device identity is the auth** — only devices signed into
your Tailscale account can connect, there is no URL to guess, and traffic is end-to-end
encrypted. That is *stronger* than the app's LAN-trust posture, so the existing security
model carries over unchanged: reads stay open, and `ANSWER_TOKEN` (gating **every** write
endpoint — `grep -c 'tokenOk(config, req)' server/api.ts` for the current count — including
[spawn](spawn.md), which starts a brand-new `claude` process on this machine rather than
answering a session that already asked something, plus [dictation](dictation.md) and the
[push](push-notify.md) endpoints the hooks POST to) may stay empty. Set `ANSWER_TOKEN` only if you **share the
tailnet** with other people — inside a tailnet it means exactly what it meant on a shared
LAN.

The trade-off: every connecting device needs the Tailscale app, so you can't hand the URL
to someone who isn't on your tailnet.

> ⚠️ **If you pick a public tunnel instead** (ngrok, Cloudflare, …), understand what it
> exposes: *every* read endpoint is open — full transcripts, chat history,
> and `/api/management/file` (config file bodies) — to anyone with the link. And if you have
> set `CLAUDE_BIN`, so is [spawn](spawn.md): with `ANSWER_TOKEN` empty, anyone with the
> link can start a real Claude Code session on this machine. Set
> `ANSWER_TOKEN` at minimum, and put auth at the edge (ngrok Basic Auth / Cloudflare
> Access), or add an app-level gate. The origin badge reads **`public`** on such a
> connection, which is the reminder. ngrok's free tier also interposes an interstitial
> page, and a stable Cloudflare hostname needs an owned domain.

## Which route am I on? (the origin badge)

The status plate shows a small pill — `local`, `LAN`, `tailnet`, or `public` — saying how
*your browser* reached the dashboard. `public` is tinted orange, since it's the one worth
noticing.

- **Display-only.** `server/lib/origin.ts` (pure, zero-dep, unit-tested in
  `test/origin.test.ts`) classifies `req.socket.remoteAddress`; the value rides on
  `GET /api/health` as `HealthResponse.origin` and renders via
  `components/OriginBadge.tsx`. **Nothing gates on it** — there is no policy to lock
  yourself out of.
- No Tailscale installed ⇒ the tailnet branches never match and the badge reads `local`
  or `LAN`. Unreadable address ⇒ `unknown`; absent field (older server) ⇒ no badge at
  all.

## Tailscale setup (one-time, optional)

1. Install Tailscale on the host (menu-bar app, `brew install --cask tailscale` or
   [tailscale.com/download](https://tailscale.com/download)) and on the phone (App
   Store / Play Store).
2. Sign both into the **same account** (free personal plan covers 3 users / 100 devices).
3. MagicDNS is on by default; find the host's stable hostname with `tailscale status` or
   in the admin console — it looks like `<host-name>.<tailnet>.ts.net`.

Dev works over the tailnet too (`:5174` — Vite proxies `/api` locally), unlike a
single-port public tunnel. **This is the mode to use while iterating**: prod (`:4173`)
static-serves the built `client/dist`, so every change needs a `pnpm build` *and* a
`pnpm start` restart, while dev hot-reloads and needs neither.

> ⚠️ **`allowedHosts` in `vite.config.ts` is what makes dev-over-tailnet work.** Vite
> ≥5.4.12 rejects any `Host` header that isn't localhost or a bare IP (a DNS-rebinding
> guard), so a MagicDNS name 403s with *"Blocked request. This host is not allowed."* —
> LAN access never hit this because a LAN URL is an IP. The leading dot on `.ts.net`
> allows subdomains and scopes the exemption to tailnet hostnames instead of disabling
> the check (`allowedHosts: true`). Delete that entry and phone-over-tailnet dev breaks
> with a 403, not a hang.
>
> **A suffix rule is not enough on its own.** `tailscale serve --http` advertises this
> node under *two* names — the fully-qualified `<host>.<tailnet>.ts.net`, which `.ts.net`
> matches, and the bare single-label short name `http://<host>:<port>`, which has no dot
> and so matches nothing. The short name is the first URL `tailscale serve` prints, so it
> is the one that gets bookmarked, and it 403s on a socket that is otherwise healthy —
> which reads as a broken proxy target and sends you auditing the serve registration
> instead of the Host header. `magicDnsShortName()` in `vite.config.ts` therefore asks
> `tailscale status --json` for `Self.DNSName` and allows its first label too. It is
> best-effort: no Tailscale, no MagicDNS, a logged-out node or a hung CLI all add nothing
> and leave dev as it was. It cannot use `os.hostname()` — a node's tailnet name is set in
> the admin console and routinely differs from the machine's own hostname.
>
> **The proxy target stays `127.0.0.1`, not `localhost`.** A literal address needs no
> resolver and cannot land on `::1` while the dev server holds only the IPv4 wildcard.
> `test/tailnet.test.ts` asserts the emitted command against `http://127.0.0.1:<port>`.

### Publishing to the tailnet (`pnpm tailnet`)

`scripts/tailnet.ts` registers a `tailscale serve` from this node's tailnet address to the
local port the dashboard actually holds. All three script names run it; `tunnel` is the
older one, kept because the tooltip on the disabled mic button names it, and
`tailnet:local` is `tailnet` with `--http` already applied.

```bash
pnpm tailnet                # HTTPS on 443 → WEB_PORT
pnpm tailnet -- --http      # plain HTTP, tailnet port == WEB_PORT
pnpm tailnet:local          # the same --http shape, no `--` needed
pnpm tailnet status
pnpm tailnet down           # and `pnpm tailnet:local down`
pnpm tailnet -- --dry-run   # print the tailscale command, run nothing
```

`parseArgs` accepts `[up|down|status] [--http|--https] [--dry-run]` in any order, so every
subcommand composes with the `:local` entry point: `pnpm tailnet:local status`,
`pnpm tailnet:local down`, `pnpm tailnet:local --dry-run`.

**HTTPS on 443 is the default.** Tailscale fronts the local port with a real TLS
certificate, so the phone bookmark is just `https://<host>.<tailnet>.ts.net` — no port, no
cert warnings. Requires **HTTPS certificates enabled once** in the tailnet admin console
(DNS page); the script prints that as one of its remedies if the serve is refused. `--bg`
persists across reboots; `pnpm tailnet down` (or `tailscale serve reset`, which also clears
every other project's) stops it.

**`--http` is the escape hatch**, and it mirrors the number: the tailnet listener and the
loopback target carry the same port. Reach for it when HTTPS cannot serve — a tailnet that
never enabled certificates, or another project on this node already holding 443. It is not
a weaker perimeter (the hop is WireGuard-encrypted end to end, and the HTTP exists only
between tailscaled and a loopback socket) but it *is* not a secure context, so dictation
renders disabled on it. The script says so after registering.

**`WEB_PORT` is the only target, and there is no `prod` option.** The tailnet route exists
to be iterated against, and `WEB_PORT` is the Vite UI, which hot-reloads. Prod (`PORT`)
static-serves the built `client/dist`, so nothing you change appears there until
`pnpm build` plus a `pnpm start` restart — `client/dist` is gitignored, so pulling never
refreshes it either, which used to be the usual reason the origin badge went missing
through the tunnel while dev showed it fine. Offering a second target would also put a
second number back into a script whose entire point is that there is only ever one. To
front prod, type the `tailscale serve` yourself and own the copy of the port that creates.

Optional for browsing — the plain port URL works with no serve step at all — but no longer
optional for one feature: [dictation](dictation.md)'s `getUserMedia` call refuses to run
outside a secure context, so a plain-http tailnet URL or LAN IP can never record. This step
went from "nicer bookmark" to "the only way a phone dictates" without any change of its own.

**Never Funnel.** Every read endpoint here is open — full transcripts, chat history,
`/api/management/file` config bodies — and with `CLAUDE_BIN` set, [spawn](spawn.md) starts
a real Claude Code session on this machine. The tailnet *is* the perimeter;
`tailscale funnel` is the one command that removes it. `test/tailnet.test.ts` asserts the
word never appears in the script.

#### Why a script and not the one-liner it replaced

`pnpm tunnel` used to be literally `tailscale serve --bg 5174`. A serve registration stores
a **copy** of the port inside tailscaled — outside this repo, outside git, surviving
reboots — while the port the dashboard holds comes out of `.env` through `loadConfig`. This
machine's `.env` already sits on a non-default `WEB_PORT`, so the two had drifted, and the
symptom is a bare 502 from Tailscale on the phone, which reads as a Tailscale fault rather
than a stale mapping. This section used to carry a "keep them in sync" warning as the only
defence.

Now the number lives in exactly one place — `.env`, read by the same `loadConfig` the server
and `vite.config.ts` read — and the script asks for it. `test/tailnet.test.ts` asserts
against the script's own source text that no dashboard port literal appears in it at all;
443 is allowed, as the named `HTTPS_LISTEN_PORT`, because it is a Tailscale listener number
and not a dashboard port.

Ported from backlog-manager's `scripts/tailnet.mjs`, which exists for the same reason one
variable over. Two things differ deliberately: that repo has its own `.env` reader because
its port is read by docker compose, where this one reuses `loadConfig`; and it serves plain
HTTP only, because it has no dictation to keep in a secure context.

#### HTTPS slots are per node, not per account

Each *node* gets its own MagicDNS name and its own certificate — `<host>.<tailnet>.ts.net`.
The limit worth knowing is per node: `tailscale serve --https` accepts only **443, 8443 and
10000**, and paths can subdivide one of them (`--set-path=/x`). So this machine has three
HTTPS slots in total, shared across every project on it. `tailscale serve status` lists
what is registered.

### Phone usage

- Keep the Tailscale VPN toggle **on** — set-and-forget, negligible battery, works over
  cellular and foreign wifi alike.
- Bookmark the stable hostname; it never changes when the LAN IP does.
- The remote-answer flow (the pulsing `answer` tab → option buttons in the drawer — see
  [remote-answer](remote-answer.md)) works from anywhere; the hook still talks to
  `127.0.0.1` on the host and is untouched by any of this.
- [Dictation](dictation.md)'s mic needs the HTTPS route above specifically — over a plain
  tailnet port or a LAN IP it renders disabled and says why, rather than failing silently.

## Invariants

- **⚠️ Classification order is load-bearing:** Tailscale's IPv6 range
  `fd7a:115c:a1e0::/48` sits *inside* the generic ULA space `fc00::/7`, so the tailnet
  check must run before the LAN check or every tailnet client reads `lan`. IPv4 tailnet
  is the CGNAT range `100.64.0.0/10`.
- **⚠️ `X-Forwarded-For` is honoured only from a loopback socket.** `pnpm tailnet`
  (`tailscale serve`) proxies on the host, so the socket is `127.0.0.1` and the peer's
  real tailnet address survives only in that header — without the fallback every tunnel
  user would read `local`. Spoofing is a non-issue by construction: only something
  already on the machine can send it, and it drives a badge with no policy attached.
  **⚠️ That holds only while nothing gates on it.** A peer behind a
  loopback-terminating proxy writes the left-most forwarded entry itself, so as a
  guard `classifyOrigin` returns whichever verdict the caller asks for — refusing an
  honest proxied client and admitting one that prepends `127.0.0.1`. Any future gate
  must read `classifyAddress` (socket only), never `classifyOrigin`
  (`server/lib/origin.ts`).
- **⚠️ The dev proxy needs `xfwd: true`** (`vite.config.ts`). Vite reaches the API over
  loopback, so without it every `pnpm dev` client — including a phone on the LAN —
  classifies as `local`.

## Gotchas

- **`pnpm tailnet` no longer needs its port kept in sync** — it reads `WEB_PORT` from
  `.env` through `loadConfig`, and fronts nothing else. Registering against a port nothing
  is listening on is allowed and warned about, not refused — the registration persists,
  and the phone sees a 502 until `pnpm dev` starts. If you edited `WEB_PORT` without
  restarting `pnpm dev`, that is exactly the state you are in: config is read once, at
  startup.
- **The host must be awake.** Tailscale doesn't wake a sleeping machine; disable sleep
  (or use `caffeinate`) if you rely on away-from-home access.
- **Docker runs are unaffected** — Tailscale runs on the host and forwards to the
  published localhost ports, same as a LAN client. The badge sees the container's view of
  the peer address, so containerized dev may read `lan` where a host run reads `local`.

<!-- docs-sync:
  sources:
    - server/lib/origin.ts
    - client/src/components/OriginBadge.tsx
    - vite.config.ts
    - server/api.ts
    - package.json
    - scripts/tailnet.ts
  kind: subsystem
  verified: f436519f31ef4120521792db7658e2bc5431f0e9
-->
