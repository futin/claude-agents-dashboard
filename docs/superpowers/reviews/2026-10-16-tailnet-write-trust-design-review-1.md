# Review 1 — Tailnet write trust design

Document: `docs/superpowers/specs/2026-10-16-tailnet-write-trust-design.md` (196 lines, at b623bf7).
Reviewer: Fable 5.1, 2026-10-16. Read-only; the document was not edited.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. The core design verifies: the rule table, the right-to-left `X-Forwarded-For` walk, the chain table and
Vite's `XHeaders` behaviour all check out against the code. Nine Important findings, all small and local: two false facts (hook URL variable, the Lookout
path), one internal contradiction (the harness test list), and six places where the implementer would have to guess (client plumbing of `writeAccess`,
the `undefined` case, status-line copy, the reject-log line, the dev compose file, the installer's TODO copy).

## Verified true (no finding)

| Doc line | Claim | Evidence |
|---|---|---|
| 7 | `tokenOk(config, req)`, 19 call sites | `grep -c "tokenOk(" server/api.ts` = 20, one is the definition at `server/api.ts:500` |
| 7-8 | token in `localStorage` via `usePersistedState('dashboard.answerToken')` | `client/src/hooks/usePersistedState.ts:13`; 12 call sites listed in `audits/2026-10-15-audit.md:37` |
| 12 | `pnpm tailnet` → 443 → `WEB_PORT` 5174 → `PORT` 4173 | `scripts/tailnet.ts:102,115`; `vite.config.ts` proxy `/api` → `http://localhost:${port}`, `xfwd: true` |
| 31 | 12 copies of the token plumbing (2026-10-15 audit) | `audits/2026-10-15-audit.md:37` |
| 36 | `origin.ts` warns against gating on XFF | `server/lib/origin.ts:10-16` |
| 46 | `hostAllowed` / `crossSiteWrite` run before routing | `server/index.ts:199-202` |
| 74-76 | Vite 5.4.21 `XHeaders` appends `req.socket.remoteAddress` with a bare `,` | `node_modules/vite/package.json` 5.4.21; `dist/node/chunks/dep-BK3b2jBa.js:61169-61184` |
| 91-92 | the three `origin.test.ts` assertions that flip | `test/origin.test.ts:126` (`'100.90.1.2, 10.0.0.1'` → tailnet), `:130` (`'not-an-ip'` → local), `:131` (`''` → local). Recomputed under the new walk: `lan`, `unknown`, `unknown` |
| 105 | compose forwards the ntfy topics bare | `docker-compose.yml` `NTFY_TOPIC`, `NTFY_SERVER` |
| 106 | "Docker runs are unaffected" bullet | `docs/subsystems/remote-access.md:242` |
| 111 | `recordUsageHistory` parse shape | `server/lib/settings.ts:184-187, 287-290` |
| 115 | existing Settings › Connection group | `client/src/components/settings/SettingsView.tsx:699` |
| 121 | `serveHealth` `req?` optional, one caller | `server/api.ts:523`; `server/index.ts:233` |
| 124 | `remote-decision-hook.sh` warns on `tokenRequired && !tokenFile` | `scripts/remote-decision-hook.sh:91-92` |
| 136 | `OriginBadge` `public` tooltip says "set ANSWER_TOKEN" | `client/src/components/OriginBadge.tsx:17-20` |
| 142 | `{ error: 'bad token' }` literal | every `tokenOk` site in `server/api.ts` |
| 156 | Lookout viewer: http-proxy-3, no `xfwd`, Origin rewritten | `lookout/server/src/viewer/viewer-server.ts:15,155,357`; `rewrites.ts:124` |
| 161 | Lookout per-app token field | `lookout/server/src/registry/registry.service.ts:59-60,145-147` |
| 177 | harness listens on `127.0.0.1` | `test/api-harness.ts:133` |
| 189-190 | the named tests set a token and expect 403 with no bearer | all nine exist; `api-reject-log` and `transcribe` assert status 403 only, not the body |
| — | every write check funnels through `tokenOk` (no second gate in hub code) | `grep -rn "answerToken\|headers.authorization" server` hits only `api.ts:500-506,531` |

Not verifiable from code, taken on the author's word: line 13 (`tailscale serve` sets XFF and health reports `tailnet` live), line 98 (ngrok /
cloudflared set XFF), line 104 (Docker Desktop delivers published-port traffic from the bridge gateway).

## Important

### I1. Line 149 — `DASHBOARD_LOCAL_URL` does not exist
The hooks read `CLAUDE_DASHBOARD_URL`, default `http://127.0.0.1:4173` (`scripts/ask-remote-hook.sh:33`, `remote-decision-hook.sh:59`,
`permission-notify-hook.sh:51`, `plan-remote-hook.sh:37`, `stop-notify-hook.sh:44`; `install-hooks.sh:399` prints the name). → Use the real name, and note
that a user who points it at a non-loopback URL (the container, or the ts.net name) moves the hooks off the `local` row.

### I2. Lines 155-157 — Lookout does not arrive "through `tailscale serve`"
`registry.baseUrl` is `originOf(host, port)` = `http://<host>:<port>` (`lookout/server/src/registry/registry.service.ts:21,129-136`): plain HTTP with an
explicit port, which is never the HTTPS-443 serve listener `pnpm tailnet` registers by default. With the default shape the hub and the viewer hit Vite (`:5174`,
`host: true`) or the prod API (`:4173`) on the tailnet IP / MagicDNS name directly. The conclusion still holds — Vite appends the hub's tailnet address via
`xfwd`, and the prod API sees a tailnet socket — but the mechanism as written is false, and the `-- --http` shape is the only one where serve is in the path.
Also, `server/src/http/app-client.ts` does not call `registry.baseUrl()`; its callers do (`poller.service.ts:228`, `prober.service.ts:268`,
`actions.service.ts:65`, `widgets.controller.ts:75,100`). → Rewrite the paragraph: "reaches `http://<host>:<port>` directly; via Vite that is XFF
`100.x`, via the prod port a tailnet socket; both classify `tailnet`".

### I3. Line 186 contradicts line 179
Line 179: "The non-loopback-socket case cannot be produced by the harness and is covered by the pure `resolvePeer` tests." Line 186 then lists "non-loopback
socket carrying a forged tailnet `X-Forwarded-For` → 403" under "The gate, through the real handler". → Drop the bullet from the gate list, or say it is a
direct call of the gate helper with a stubbed `req.socket`.

### I4. Line 145 — the reject-log line format and its pinned test
`logRejectedWrite` prints `[dashboard] rejected write: <METHOD /path> (bad or missing token)` (`server/api.ts:493`), and `test/api-reject-log.test.ts:62`
asserts that exact line with `^…$` anchors. "Logs the resolved peer class next to the existing key" changes the line and breaks the assertion; the parenthetical
is also wrong for a `read-only from this network` refusal, where no token exists to be bad. → Give the new line format (one per refused `writeAccess`
state, or one with the peer class), and list `api-reject-log.test.ts:62` as an assertion that changes, not just a test that gains an XFF header.

### I5. Lines 115-117 — status-line copy covers two of the five states
Three strings are given: tailnet/open, LAN/token, LAN/none. Missing: `local` (the desk browser, the most common caller), `unknown` (the `public` badge
case, where the token is the only way), and tailnet with the switch off (`token` or `none`). "Builder's call" covers wording, not which cases exist. →
State the copy as a function of `writeAccess` (and optionally origin) with all cases, or give the full table.

### I6. Lines 131-134 — `writeAccess` undefined is not defined
`HealthResponse` fields are optional for an older server / before health answers (`shared/types.ts:1046-1062`), and `test/git-stats-client.test.ts:348`
pins `tokenRequired: undefined → key enabled`. Moving the key to `writeAccess` needs the same rule stated, and the field declared optional on
`HealthResponse` in `shared/types.ts` (CLAUDE.md: "Adding an API field: `shared/types.ts` first" — the spec places `trustTailnet` there but not
`writeAccess`). → Add: `writeAccess?: 'open' | 'token' | 'none'` on `HealthResponse`; `undefined` behaves as today (`tokenRequired` undefined).

### I7. Lines 131-132 — how `writeAccess` reaches the prompt sites is unspecified
The eleven hooks set `needsToken` on `res.status === 403` alone (`client/src/hooks/useSpawn.ts:49-52`, `useStopSession.ts`, `usePendingMessage.ts`,
`usePendingPlan.ts`, `usePendingQuestion.ts`, …); none reads health. The non-goal at line 31 forbids refactoring them, so the only ways to know
`writeAccess` there are new plumbing (a context, or health in each hook) or the 403 body, which line 140 introduces for exactly this purpose but line 131
does not use. → Say which: "a 403 whose body is `read-only from this network` sets a `readOnly` flag instead of `needsToken`" keeps the non-goal intact.

### I8. Lines 103-107 — `docker-compose.dev.yml` is omitted
It publishes 5174 and 4173 and forwards `NTFY_TOPIC` / `NTFY_SERVER` the same bare way (`docker-compose.dev.yml:6-18`), with no `ANSWER_TOKEN`. Under the
new rule a dev-container run (Vite inside the container, desk browser arriving from the bridge gateway → `lan`) is read-only for every client and has no
way to receive a token. → Name both compose files, or state the dev one is out of scope and why.

### I9. Line 150 — the installer's user-facing TODO contradicts line 125
`scripts/install-hooks.sh:354-355` prints `TODO     no ANSWER_TOKEN in .env — set one, then: …` and `test/install-hooks-token.test.ts:220` asserts it.
That is output copy, not a comment, and under the new rule a loopback hook needs no token — line 125 says the hook "no longer warns just because a token is
set", while the installer still tells the user to create one. → Decide: rewrite the TODO to "optional — only a containerised dashboard needs it" (and
update the assertion), or state why the installer keeps recommending a token.

## Minor

- Line 43 says `resolvePeer(req)`; line 63 says `resolvePeer(remoteAddress, headers)`. Pick one signature (the pure one at 63 matches `classifyOrigin`).
- Line 92: "…are now `unknown`).  so the badge and the gate can never disagree." — the clause after the parenthesis lost its subject when the parenthetical
  was inserted. Reorder.
- Line 68: "an array that is joined" — say with `,`. (Node already joins duplicate headers with `, `; `classifyOrigin` today reads `raw[0]` only,
  `server/lib/origin.ts:148`.)
- Line 140: "so existing client and test matches keep working" — no client code matches the `bad token` body; the only match is the label text in
  `test/git-stats-client.test.ts:341`. The sentence is about tests.
- Lines 167-169: the enumerated doc list omits `docs/subsystems/remote-message.md`, `remote-plan.md`, `docs/workflows/dictation-setup.md`,
  `shared/types.ts:1051-1061` (`tokenRequired` JSDoc: "True when `ANSWER_TOKEN` is set"), `server/lib/config.ts:254`, and client copy
  (`RemoteAnswerToggle.tsx`, `SettingsView.tsx`, `Expanded.tsx:55`). The `git grep` sentence covers them; the list reads as exhaustive and is not.
- Line 133: the `tokenRequired` consumer list omits `client/src/components/management/GitClockChip.tsx:35-77`, `GitView.tsx:41,77` and
  `hooks/useGitSync.ts:18` (where the field is carried off health).
- Line 183: "tailnet + switch off, no bearer → 403" — which body depends on whether a token is set; say which case the test uses (or test both).
- Line 98: `ssh -L` is listed as a tunnel in `remote-access.md:13` and sets no XFF, so its clients are `local`. Covered by the "any local process" bullet
  (line 100), but worth naming since the doc lists it.
- Residual risks: once loopback is trusted, `crossSiteWrite` becomes the *only* barrier between a page in the desk browser and a write, even when a token
  is set (today the token is a second layer). One sentence in the risks section would record that this was weighed.
- Line 122: `writeAccess` is computed from the `trustTailnet` setting read on each request — say so, since "live without a restart" (line 24) depends on
  `getSettings()` not caching the file (`server/lib/settings.ts:237-238` caches in-process; `setSettings` updates it, so the API process sees its own writes).
