# Remote access — reaching the dashboard, and the origin badge

Both servers already bind all interfaces — `server/index.ts` `server.listen(config.port)`
and Vite's `server.host: true` — so **every route below works with zero app-code
changes**. Pick whichever suits the moment; none of them is required, and nothing in the
app depends on any of them being present.

| Route | URL | Notes |
|---|---|---|
| **localhost** | `http://localhost:5174` (dev) / `:4173` (prod) | the default; nothing to set up |
| **LAN** | `http://<lan-ip>:5174` / `:4173` | the `Network:` URL Vite prints. Free, but the IP moves when the network does, and writes need `ANSWER_TOKEN` (read-only without one) |
| **Tailscale** | `http://<host>.<tailnet>.ts.net:4173` (prod) / `:5174` (dev) | recommended for away-from-home — stable hostname, private, no auth gate needed. Dev needs `allowedHosts` (below) |
| **any other tunnel** | ngrok / Cloudflare / `ssh -L` … | works too, but read the warning below first |

## Why Tailscale is the recommended away-from-home option

A tailnet is a private WireGuard network between your own devices, so the dashboard never
touches the public internet. **Device identity is the auth** — only devices signed into
your Tailscale account can connect, there is no URL to guess, and traffic is end-to-end
encrypted. That is *stronger* than a shared LAN, which is why the write gate trusts it.

## Who may write

Reads stay open. Every write route — `grep -c 'refuseWrite(config, req, res)' server/api.ts` for the current count, including [spawn](spawn.md), which starts a
brand-new `claude` process on this machine, [dictation](dictation.md), the [push](push-notify.md) endpoints the hooks POST to, and `POST /api/open-folder`,
which can only open a folder that is already a listed pin — runs one gate, `refuseWrite` in `server/api.ts`. A write is allowed when **either**:

1. **Trusted network:** the peer (`resolvePeer`, below) is `local`, or it is `tailnet` and **Settings › Shared › Trust tailnet devices** (`trustTailnet`,
   default on, live without a restart) is on; **or**
2. **Token:** `ANSWER_TOKEN` is set and the request carries `Authorization: Bearer <ANSWER_TOKEN>` — from any address.

| Peer | `trustTailnet` | token set? | valid bearer? | result |
|---|---|---|---|---|
| local | any | any | any | allow |
| tailnet | on | any | any | allow |
| tailnet | off | yes | yes | allow |
| tailnet | off | yes / no | no | 403 |
| lan / unknown | any | yes | yes | allow |
| lan / unknown | any | yes / no | no | 403 |

The 403 body says which kind of refusal it is: `bad token` when a token is set (sending the right one would help), `read-only from this network` when none is
(nothing the caller sends can). So with no token set, a device reaching the dashboard by its LAN IP (`http://192.168.x.x:5174`) without Tailscale is
**read-only**; the same phone on the same Wi-Fi using the `ts.net` URL is a tailnet peer and writes. `GET /api/health` reports the calling peer's
`writeAccess` (`open` / `token` / `none`), and `tokenRequired` is `writeAccess === 'token'`; Settings › Local › Connection renders it as one line about this
browser.

The switch is itself a write (`POST /api/settings`): a tailnet device that turns it off loses its own write access from the next request, and this machine,
always `local`, can turn it back on. Turn it off and use the token if you **share the tailnet**: tagged devices and users of other tailnets this machine is
shared with have tailnet addresses, and are trusted while it is on.

**Two kinds of write.** Every route behind the write gate is one of these, and the docs use the two terms in exactly this sense (`test/write-paths.test.ts`
pins the split against `server/api.ts`):

- **Session write path** — the remote-answer switch (`REMOTE_ANSWER`, or the runtime pill) is checked *before* the gate, and off means 404. There are **four**,
  counted by feature: [answer](remote-answer.md), [plan](remote-plan.md), [message](remote-message.md) and [spawn](spawn.md) (start and both stops).
  `POST /api/transcribe` ([dictation](dictation.md)) rides the switch too but acts on no session, so it is not a fifth path: its only consumers are the reply and
  spawn composers.
- **Gate-only write** — the write gate and nothing else: `POST /api/settings`, `POST /api/remote-answer`, the three [push](push-notify.md) routes
  (`permissions/notify`, `notify/event`, `notify/test`), `POST /api/pins`, `POST /api/pins/order`, `POST /api/open-folder`, `POST /api/git-fetch`,
  `POST /api/git-quick` and `POST /api/codegraph/run`.

Gate-only is the intended posture for that second set, not an oversight. The switch is a runtime kill switch for *acting on sessions remotely*, not an auth
boundary — the gate above is the boundary. `POST /api/settings` and `POST /api/remote-answer` cannot sit behind it, or turning the switch off would lock out
turning it back on. The push routes must keep working with remote answering off, because push notification is independent of it. Pins, pin order, open folder,
git fetch, quick pull and push, and codegraph runs touch no session.

**Resolving the peer.** `resolvePeer(remoteAddress, headers)` (`server/lib/origin.ts`) classifies the socket address. A non-loopback socket is the answer
outright: nothing such a client sends is consulted. A loopback socket means a process on this machine, possibly a proxy, so `X-Forwarded-For` is walked **from
the right**: loopback entries (another local hop) are skipped, the first other entry is the peer, and an entry that is not an address is `unknown` (fail
closed). No header, or only loopback entries, is `local`. The right-most entry is the trustworthy one because each proxy *appends* the address of the socket
it accepted (Vite's `xfwd`), so whatever a client forged sits to its left.

| Path | socket | XFF at the API | peer |
|---|---|---|---|
| hook / curl on this machine → API | 127.0.0.1 | — | local |
| desk browser → Vite → API | 127.0.0.1 | `127.0.0.1` | local |
| phone → serve → Vite → API (dev) | 127.0.0.1 | `100.x.y.z,127.0.0.1` | tailnet |
| phone → serve → API (prod on 4173) | 127.0.0.1 | `100.x.y.z` | tailnet |
| tailnet device → `100.x:5174` directly | 127.0.0.1 | `100.x.y.z` | tailnet |
| LAN device → `192.168.x:5174` (any forged XFF) | 127.0.0.1 | `…,192.168.1.5` | lan |
| LAN device → `192.168.x:4173` | 192.168.1.5 | ignored | lan |

**Residual risks, accepted:**

- **A loopback proxy that does not set `X-Forwarded-For`** makes all its clients look `local`. Vite, `tailscale serve`, ngrok and cloudflared all set it; any
  new front proxy must too.
- **Any local process** can write, and can claim any peer by sending its own `X-Forwarded-For`. It can already read `~/.claude` and `.env`, so this adds
  nothing. An `ssh -L` forward sets no header, so its clients are `local` too: whoever can ssh in already has the machine.
- **CSRF is the only barrier for trusted peers.** A page in the desk or phone browser that tries a write meets `crossSiteWrite` alone, even with a token set.
  That guard stays, unchanged (below).
- **Tailnet trust is coarse** — tagged devices and shared-in users count, as above.
- **Containerised runs** see every client — the desk browser, the host's `tailscale serve` and the hooks alike — arrive from the bridge gateway, which
  classifies `lan`. Docker Desktop's published ports deliver LAN traffic from that same gateway, so trusting it would trust the LAN; a container run needs
  `ANSWER_TOKEN` to write, and both compose files forward it.
- **Lookout** reaches the dashboard by this machine's tailnet host on a plain port, so it is a tailnet peer: it writes while the switch is on, or with the
  switch off when its configured bearer matches `ANSWER_TOKEN`.

The trade-off: every connecting device needs the Tailscale app, so you can't hand the URL
to someone who isn't on your tailnet.

> ⚠️ **If you pick a public tunnel instead** (ngrok, Cloudflare, …), understand what it
> exposes: *every* read endpoint is open — full transcripts, chat history,
> `/api/git-stats` (pinned repos' paths and branch names), and `/api/configs/file`
> (config file bodies) — to anyone with the link. And if you have
> set `CLAUDE_BIN`, so is [spawn](spawn.md) for anyone holding the token. A tunnel client
> terminates on loopback, so the write gate trusts it only through `X-Forwarded-For`: the
> tunnel must set that header (ngrok and cloudflared do), or every client of it reads
> `local` and writes. Set `ANSWER_TOKEN` at minimum, and put auth at the edge (ngrok Basic Auth / Cloudflare
> Access), or add an app-level gate. The origin badge reads **`public`** on such a
> connection, which is the reminder. ngrok's free tier also interposes an interstitial
> page, and a stable Cloudflare hostname needs an owned domain.
>
> A public tunnel's hostname also has to go in **`ALLOWED_HOSTS`** (e.g. `ALLOWED_HOSTS=.ngrok.app`), or every request through it is a 403 from the
> Host guard below — in prod and dev alike, since the same list feeds Vite's `allowedHosts`.

## Browser-side guards

Two refusals run in the request listener (`server/index.ts`) before any route, both from `server/lib/request-guard.ts`. Neither is about other machines —
the LAN/tailnet trust model above is unchanged — they stop a web page in *your own* browser from using the dashboard as a back door.

- **Host allowlist (DNS rebinding).** A page on `evil.example` can re-point its own name at `127.0.0.1` and then read every open GET route as
  same-origin; the browser still sends `Host: evil.example`. Allowed without config: a missing `Host`, IP literals, single-label names (`localhost`, a
  tailnet short name, a LAN hostname), and `*.localhost`, `*.local`, `*.ts.net`. Anything else is a 403 naming `ALLOWED_HOSTS` — comma-separated exact
  names, `.suffix` rules (which also match the apex) or `*` to switch the check off. This is the prod twin of the Vite guard described below.
- **Cross-site writes (CSRF).** A trusted peer writes with no token and `readJsonBody` ignores Content-Type, so a `no-cors` `text/plain` POST from any
  site open in that browser would reach the write routes without a preflight. Any non-GET/HEAD/OPTIONS request is refused when `Sec-Fetch-Site` is present and
  is not `same-origin` or `none`, or — when it is absent — when `Origin` is present and its host differs from `Host` (`Origin: null` included). A request
  carrying neither header is not a browser and passes, which is how the hooks and `curl` keep working. Another port on localhost counts as cross-site.

The listener also turns a target `new URL` cannot parse (`GET //`, `//%zz`) into a 400 instead of an uncaught throw that took the process down.

## Which route am I on? (the origin badge)

The Board card in the Sessions aside shows a small pill — `local`, `LAN`, `tailnet`, or `public` — saying how
*your browser* reached the dashboard. `public` is tinted orange, since it's the one worth
noticing.

- **The same verdict the write gate uses.** `server/lib/origin.ts` (pure, zero-dep, unit-tested in
  `test/origin.test.ts`) resolves the peer with `resolvePeer` (above); the value rides on
  `GET /api/health` as `HealthResponse.origin` and renders via
  `components/OriginBadge.tsx`. Badge and gate share one function, so they can never disagree.
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
> the check (`allowedHosts: true`); `ALLOWED_HOSTS` entries are appended, and `*` there does mean `true`. Delete that entry and phone-over-tailnet dev breaks
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
`/api/git-stats` repo paths and branch names, `/api/configs/file` config bodies — and
with `CLAUDE_BIN` set, [spawn](spawn.md) starts
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
- The remote-answer flow (the pulsing `Answer` tab → option buttons in the drawer — see
  [remote-answer](remote-answer.md)) works from anywhere; the hook still talks to
  `127.0.0.1` on the host and is untouched by any of this.
- [Dictation](dictation.md)'s mic needs the HTTPS route above specifically — over a plain
  tailnet port or a LAN IP it renders disabled and says why, rather than failing silently.

## Invariants

- **⚠️ Classification order is load-bearing:** Tailscale's IPv6 range
  `fd7a:115c:a1e0::/48` sits *inside* the generic ULA space `fc00::/7`, so the tailnet
  check must run before the LAN check or every tailnet client reads `lan`. IPv4 tailnet
  is the CGNAT range `100.64.0.0/10`.
- **⚠️ `X-Forwarded-For` is honoured only from a loopback socket, and read from the right.** `pnpm tailnet`
  (`tailscale serve`) proxies on the host, so the socket is `127.0.0.1` and the peer's
  real tailnet address survives only in that header — without it every tunnel user would
  read `local`. The write gate decides on it, so the walk order is load-bearing: the
  left-most entry is whatever the client sent, the right-most non-loopback entry is the one
  the nearest proxy appended. Reading the left one would let a LAN client behind Vite claim
  `100.x` and write; never switch back to first-hop parsing.
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
- **Docker runs need `ANSWER_TOKEN` to write** — Tailscale runs on the host and forwards to the
  published ports, and inside the container every client, the desk browser and the hooks
  included, arrives from the bridge gateway and classifies `lan`. Set the token in the host
  `.env` (both compose files forward it), in the browser, and in `~/.claude/hooks/dashboard-token`.

<!-- docs-sync:
  sources:
    - server/lib/origin.ts
    - server/lib/request-guard.ts
    - client/src/components/OriginBadge.tsx
    - vite.config.ts
    - server/api.ts
    - package.json
    - scripts/tailnet.ts
  kind: subsystem
  verified: 142439e51a92c5c5faebaf0c867bc5a36fef7c57
-->
