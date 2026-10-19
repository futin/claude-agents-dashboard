# Tailnet write trust — design

Date: 2026-10-16. Status: draft, awaiting approval.

## Why

Every write route (`tokenOk(config, req)` in `server/api.ts`, 19 call sites on 2026-10-16) is gated by `ANSWER_TOKEN`, and the browser keeps the
token in `localStorage` (`usePersistedState('dashboard.answerToken')`). On iOS that storage is per context: a home-screen bookmark, and the Lookout hub's viewer
(a cross-site iframe with partitioned storage), never see a token saved in Safari, so their writes 403. The user wants their own devices to write with nothing
stored on them.

They already reach the dashboard over Tailscale: `pnpm tailnet` registers `tailscale serve` on 443 → Vite on `WEB_PORT` (5174) → API on `PORT` (4173),
confirmed live on 2026-10-16 (`tailscale serve status`, and `GET /api/health` through the `ts.net` URL reports `origin: "tailnet"`). A tailnet is private
WireGuard between devices signed into the user's account, so **the network path is the credential**: a request that provably arrived from a tailnet address can
write without a token.

Considered and dropped: mTLS (certificate install on every device), and Tailscale identity headers (`Tailscale-User-Login`). The headers need an allowlist to
configure, are absent for tagged devices, and in the dev chain Vite forwards them verbatim from any client, so a LAN device could forge one through `:5174`.

## Goals

- A write from this machine (loopback) or from a tailnet address passes with no token, from any OS, via `tailscale serve` or the tailnet IP directly.
- `ANSWER_TOKEN` stays, for anyone who wants it: a correct `Authorization: Bearer` passes from **any** address.
- Trusting the tailnet is a switch in Settings, **on by default**, live without a restart.
- The peer address is derived only from facts a remote client cannot write.

## Non-goals

- Per-user identity, allowlists, audit of *who* wrote. Network membership only.
- Changing the read side. Every GET stays open, exactly as today.
- Refactoring the 12 copies of the client token plumbing (2026-10-15 audit). They stay, since the token stays.
- The Lookout repo. It keeps working unchanged (see *Lookout* below); dropping its per-app token field is a later change there.

## Anti-goals

- Trusting `X-Forwarded-For` entries a client can author. `server/lib/origin.ts` already warns against exactly this.
- A LAN device (same Wi-Fi, not on Tailscale) gaining writes it does not have today when a token is set.

## The rule

A write request is allowed when **either**:

1. **Trusted network:** `resolvePeer(req.socket.remoteAddress, req.headers)` is `local`, or it is `tailnet` and the `trustTailnet` setting is on; **or**
2. **Token:** `ANSWER_TOKEN` is set and the request carries `Authorization: Bearer <ANSWER_TOKEN>`.

Otherwise 403. The existing `GET` routes, `hostAllowed` and `crossSiteWrite` are untouched and still run first.

| Peer | `trustTailnet` | token set? | valid bearer? | result |
|---|---|---|---|---|
| local | any | any | any | allow |
| tailnet | on | any | any | allow |
| tailnet | off | yes | yes | allow |
| tailnet | off | yes / no | no | 403 |
| lan / unknown | any | yes | yes | allow |
| lan / unknown | any | yes / no | no | 403 |

**Behaviour change, decided by the user:** today an empty `ANSWER_TOKEN` opens writes to every client, LAN included. After this change, with no token set, a
LAN-IP client is **read-only**. Reaching the dashboard as `http://192.168.x.x:5174` from a device without Tailscale is the only case affected; the same phone on
the same Wi-Fi using the `ts.net` URL is a tailnet peer and writes.

## Resolving the peer

`resolvePeer(remoteAddress, headers) → ConnectionOrigin`, pure, in `server/lib/origin.ts`:

1. Classify the socket address with `classifyAddress`. If it is not `local`, that is the answer: nothing a non-loopback client sends is consulted. A missing
   socket address is `unknown`.
2. The socket is loopback, so the connection came from a process on this machine, possibly a proxy. Read `X-Forwarded-For` (a string, or an array that is
   joined with `,`; today's `classifyOrigin` reads only `raw[0]`), split on `,`, trim each entry, and walk it **from the right**:
   - a `local` entry is another loopback hop (e.g. Vite recording `tailscale serve`'s connection): skip it and keep walking;
   - the first non-`local` entry is the answer, classified by `classifyAddress`. An entry that is not an address (`isIpish` false), including an empty or
     whitespace-only one, is `unknown`: fail closed, never skipped. *(Author's call.)*
3. No header, or every entry is loopback → `local`.

Why the right-most entry can be trusted and the left-most cannot: each proxy appends the address of the socket *it* accepted. Vite's proxy
(`http-proxy`, `xfwd: true`) appends `req.socket.remoteAddress` to whatever the client sent (verified in Vite 5.4.21's bundled `XHeaders`, which joins with a bare
`,`). So a LAN client sending `X-Forwarded-For: 100.64.0.1` through Vite arrives as `100.64.0.1,192.168.1.5`; the right-most entry is the one Vite wrote, and it says
`lan`. `tailscale serve` writes the tailnet peer's address the same way, whether it replaces or appends a client-sent header.

Chains, as the API sees them:

| Path | socket | XFF at the API | peer |
|---|---|---|---|
| hook / curl on this machine → API | 127.0.0.1 | — | local |
| desk browser → Vite → API | 127.0.0.1 | `127.0.0.1` | local |
| phone → serve → Vite → API (dev, the user's daily path) | 127.0.0.1 | `100.x.y.z,127.0.0.1` | tailnet |
| phone → serve → API (prod on 4173) | 127.0.0.1 | `100.x.y.z` | tailnet |
| tailnet device → `100.x:5174` directly | 127.0.0.1 | `100.x.y.z` | tailnet |
| LAN device → `192.168.x:5174` (any forged XFF) | 127.0.0.1 | `…,192.168.1.5` | lan |
| LAN device → `192.168.x:4173` | 192.168.1.5 | ignored | lan |

`classifyOrigin` (the toolbar badge) switches to `resolvePeer`, which reverses some existing `test/origin.test.ts` assertions: those are rewritten, not kept
(`'100.90.1.2, 10.0.0.1'` was tailnet by first-hop and is now `lan`; `'not-an-ip'` and `''` were `local` and are now `unknown`). That way the badge and the gate can never disagree. Its "honour only from loopback" comment and the
module header's ⚠️ are rewritten to say the gate now uses this function and why the right-to-left walk is the safe one. The header's
"nothing in the app makes an access decision from it" sentence goes.

### Residual risks (accepted, documented in remote-access.md)

- **A loopback proxy that does not set `X-Forwarded-For`** makes all its clients look `local`. Vite, `tailscale serve`, ngrok and cloudflared all set it. A new
  front-end proxy must too; remote-access.md says so where it covers public tunnels.
- **Any local process** can write, and can claim any peer by sending its own XFF. It can already read `~/.claude` and `.env`, so this adds nothing. An `ssh -L` forward (listed in remote-access.md) sets no XFF, so its
  clients are `local` too: whoever can ssh in already has the machine.
- **CSRF is now the only barrier for trusted peers.** A page in the desk or phone browser that tries a write meets `crossSiteWrite` alone, even with a token
  set, where today the token was a second layer. `crossSiteWrite` therefore stays, unchanged, and its tests stay.
- **Tailnet trust is coarse:** tagged devices and users of other tailnets this machine is shared with have tailnet addresses and are trusted. The Settings hint
  says so; turning the switch off and using the token is the answer for a shared node.
- **Containerised runs** (`docker-compose.yml` and `docker-compose.dev.yml`, which both publish ports and forward the `NTFY_*` keys bare) see every client, the desk browser, the host's `tailscale serve` and the hooks alike, arrive from the bridge
  gateway, which classifies `lan`. Docker Desktop's published ports deliver LAN traffic from that same gateway, so trusting it would trust the LAN. *Builder's
  call, by the author:* a container run therefore needs `ANSWER_TOKEN` to write. Compose forwards `ANSWER_TOKEN` from the host `.env` the way it already
  forwards the ntfy topics, and remote-access.md's "Docker runs are unaffected" bullet is rewritten to say a token is required there. This is also why the
  hooks keep their token plumbing.

## The switch

- `ServerSettings.trustTailnet: boolean` in `shared/types.ts`, default `true` (`DEFAULT_TRUST_TAILNET` in `server/lib/settings.ts`), parsed like
  `recordUsageHistory`, persisted in the same settings file, written through the existing `POST /api/settings`.
- That POST is itself a write, gated by the rule above. A tailnet device that turns the switch off loses its own write access on the next request; that is
  expected, and the Mac (always `local`) can turn it back on.
- Settings › the existing Connection area gets a row "Trust tailnet devices" with the toggle. Its hint says that tagged devices and users this machine is
  shared with count as tailnet, and that Lookout reaches the dashboard over the tailnet and needs its token when this is off.
- Under it, a status line for **this** browser, from `GET /api/health`'s `origin` and `writeAccess`, built as
  `This device reaches the dashboard <how><switch note> — <access>.`:
  - `<how>`: `from this machine` (local), `via tailnet`, `via LAN`, `from an unrecognised address` (unknown).
  - `<switch note>`: `, and tailnet trust is off` when origin is tailnet and the switch is off; empty otherwise.
  - `<access>`: `writes need no token` (open), `writes need the answer token` (token), `read-only: no answer token is set` (none).
  - Before health answers, or on an older server without `writeAccess`, no status line renders.
  Placement within the existing Settings components is the builder's call.

## `GET /api/health`

- `serveHealth`'s `req` parameter becomes required (its one caller, `server/index.ts`, passes it).
- `HealthResponse` in `shared/types.ts` gains `writeAccess?: WriteAccess` (`'open' | 'token' | 'none'`) first, per the repo's API-field order. Optional,
  because the client must treat an older server (or health not yet answered) as today: `undefined` means "behave as before this change", e.g.
  `test/git-stats-client.test.ts`'s `tokenRequired: undefined → enabled` case keeps its result.
- New field `writeAccess`, computed for the calling request: `open` when rule 1 passes, `token` when it does not but a token is set,
  `none` otherwise. It reads `trustTailnet` through `getSettings()` on each request (the in-process cache is updated by `setSettings`), which is what makes
  the switch live without a restart. It does not inspect the caller's `Authorization` header, so it never confirms a guessed token.
- `tokenRequired` keeps its name and becomes `writeAccess === 'token'` ("this caller would need the token"). `remote-decision-hook.sh` already warns on
  `tokenRequired && !tokenFile`, which is exactly right under the new meaning (a hook on loopback is `open`, so it no longer warns just because a token is set).

## Client

- Token input, `dashboard.answerToken` storage and the Bearer headers stay as they are.
- The token field's hint says it is needed only when the status line says so.
- The write hooks set `needsToken` on `res.status === 403` alone (e.g. `client/src/hooks/useSpawn.ts`), and none of them reads health. They learn the
  difference from the **403 body**, not from health: one small shared client helper reads a refused response's `error` and returns `'token'` for
  `bad token` (and for any unreadable body, which is today's behaviour) or `'read-only'` for `read-only from this network`. On `'read-only'` a hook does not
  set `needsToken`; it surfaces the sentence `Read-only from this network: open the dashboard through Tailscale, or set ANSWER_TOKEN.` through that hook's
  existing error or failure path. The plan enumerates every hook and panel that sets or renders `needsToken`. *(Author's call: this adds one helper call per
  hook and is not the refactor the non-goal rules out.)*
- The git "Fetch all" key branches on `tokenRequired` (`client/src/lib/gitClock.ts`, `hooks/useGitFetch.ts`, `management/GitParts.tsx`, `GitClockChip.tsx`, `GitView.tsx`, `hooks/useGitSync.ts` (carries it off health),
  `test/git-stats-client.test.ts`). It moves to `writeAccess`, and renders disabled with the read-only reason when that is `none`, instead of failing with a 403.
  *(Author's call.)*
- `OriginBadge`'s `public` tooltip text ("set ANSWER_TOKEN …") is revisited so it stays true.

## Server error text

Two 403 bodies, matching the two refused `writeAccess` states, so existing client and test matches keep working:

- `{ error: 'bad token' }`: unchanged literal, when a token is set and the request is neither trusted nor carrying it (`writeAccess` would be `token`).
- `{ error: 'read-only from this network' }`: when no token is set and the peer is not trusted (`writeAccess` would be `none`).

`logRejectedWrite` keeps its one-line, rate-limited shape and gains the peer class and the refusal kind:
`[dashboard] rejected write: POST /api/remote-answer from lan (bad or missing token)` or `… from lan (read-only, no token set)`. The `^…$` assertion in
`test/api-reject-log.test.ts` changes to the new format, and the test that the line carries no part of the token stays.

## Hooks and installer

Unchanged in behaviour. They reach the API on `CLAUDE_DASHBOARD_URL` (default `http://127.0.0.1:4173`, `scripts/ask-remote-hook.sh`) and are `local`. A
user who points that variable at a non-loopback address moves the hooks off the `local` row, and they then need the token like any other peer. Their optional
`~/.claude/hooks/dashboard-token` Bearer still works and is still what a containerised run needs. `scripts/env-value.ts` is not touched beyond comment text that
claims the token is required.

`scripts/install-hooks.sh` prints `TODO no ANSWER_TOKEN in .env — set one, then: …` when `.env` has no token and no token file exists. Under the new rule a
loopback hook needs no token, so that line is rewritten as an informational `ok`-style line saying no token file is needed unless the dashboard runs in a
container or behind a non-loopback `CLAUDE_DASHBOARD_URL`. `test/install-hooks-token.test.ts`'s assertions on the old TODO text change with it.

## Lookout

The hub does **not** reach the dashboard on loopback. Both its server-side calls (`server/src/http/app-client.ts`, given a URL built by
`registry.service.ts` `baseUrl()` as `http://<machine host>:<port>`) and its viewer, which reverse-proxies the iframe through
`server/src/viewer/viewer-server.ts` (http-proxy-3, no `xfwd`, Origin rewritten), address the dashboard by the machine's tailnet host and a plain port, not
the HTTPS-443 serve listener. The connection therefore lands on Vite or the API from the machine's own tailnet address, which classifies `tailnet` whether it
is the socket (API port) or the entry Vite appends (`WEB_PORT`).

So Lookout keeps working with no change **while `trustTailnet` is on** (the default), and also with it off as long as its configured bearer matches
`ANSWER_TOKEN`. With the switch off and no matching bearer, the hub's tiles and the viewer's writes get 403. The Settings hint for the switch mentions this, and
the PR description says: Lookout needs no change to ship this. Its per-app token field becomes optional, and it is still the way to keep Lookout writing on a
dashboard that has tailnet trust off.

## Docs

Rewrite the trust-model paragraphs in `docs/subsystems/remote-access.md` (top section, CSRF bullet, badge section), and update every doc and comment that says
`ANSWER_TOKEN` gates writes or that an empty token leaves writes open: `README.md`, `.env.example`, `scripts/tailnet.ts` header, `request-guard.ts` header,
`docs/subsystems/settings.md`, `spawn.md`, `remote-answer.md`, `dictation.md`, `push-notify.md`, `permission-notify.md`, `docs/workflows/configuration.md`,
`remote-answer-setup.md`, `hooks-setup.md`, `.github/pull_request_template.md`. The list is not exhaustive: `git grep -n -e ANSWER_TOKEN -e tokenRequired -e 'dashboard token'` is the checklist, client copy
included. Provenance stamps follow the repo's
`docs-sync` convention.

## Tests

Pure peer resolution (`test/` alongside the existing origin tests), every row of the chain table, plus: IPv4-mapped IPv6 entries, array-valued header, empty and
whitespace entries, a non-address entry → `unknown`, a forged loopback entry left of a LAN entry → `lan`, a non-loopback socket with a forged tailnet XFF → `lan`.

The gate, through the real handler on at least one write route and `POST /api/settings`. `test/api-harness.ts` serves on `127.0.0.1`, so every harness
request has a loopback socket; a test plays a remote peer the way a local proxy would deliver one, by sending `X-Forwarded-For` (`192.168.1.5` for lan,
`100.101.102.103` for tailnet). The non-loopback-socket case cannot be produced by the harness and is covered by the pure `resolvePeer` tests above.

- local, no token set / token set without bearer → allowed
- tailnet + switch on, no bearer → allowed
- tailnet + switch off, no bearer → 403 `bad token` with a token set, 403 `read-only from this network` without one; with valid bearer → allowed
- lan, token set, valid bearer → allowed; wrong or missing bearer → 403
- lan, no token set → 403 (the behaviour change)
- non-loopback socket carrying a forged tailnet `X-Forwarded-For` → 403, as a direct call of the gate helper with a stubbed `req.socket.remoteAddress`
  (the harness cannot open a non-loopback socket)
- `GET /api/health` `writeAccess` and `tokenRequired` for each of those callers

**Every existing "token set, no bearer → 403 `bad token`" test** (`api-answer-endpoints`, `api-git-fetch`, `api-open-folder`, `api-pins`, `api-reject-log`,
`api-remote-toggle`, `api-wait-endpoints`, `spawn-endpoint`, `transcribe`, …) reaches the server from loopback with no XFF, so under the new rule it would be
allowed and fail. Each one adds a LAN `X-Forwarded-For` so it keeps testing what it was written to test. The 403 body stays `bad token` there. A new test
covers the `read-only from this network` body.

## Left to the builder

Module placement of the gate helper (a `writeAllowed(config, settings, req)` next to `tokenOk` is the obvious shape), and the exact Settings copy and layout.
