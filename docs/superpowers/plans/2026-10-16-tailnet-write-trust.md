# Tailnet Write Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** writes pass without a token from this machine and (switchable, on by default) from the tailnet; `ANSWER_TOKEN` stays as an any-address pass; a
LAN-IP client with no token set becomes read-only.

**Architecture:** a pure right-to-left `X-Forwarded-For` walk in `server/lib/origin.ts` resolves the peer; a pure `writeAccessFor` turns peer + switch +
token-set into `open | token | none`; one `refuseWrite` in `server/api.ts` replaces the 19 `tokenOk` sites and also feeds `GET /api/health`. The client learns
"read-only" from the 403 body and from health.

**Tech Stack:** Node + TypeScript via `tsx` (server, zero deps), Vite + React (client), node-assert tests (`test/run-all.ts`).

**Spec:** `docs/superpowers/specs/2026-10-16-tailnet-write-trust-design.md`. Read it before any task; it holds the rule table, the chain table and the
residual risks this plan does not repeat.

> **Plan convention (overrides writing-plans' "code blocks required"):** this plan gives signatures, exact values, exact copy and exact test cases, never
> function bodies or test scaffolding. Write the code yourself; if the plan looks wrong against the code, say so rather than transcribing it. Size targets
> are soft.

## Global Constraints

- Server stays zero-dep; no new import outside Node built-ins and `lookout-widgets` (`test/server-deps.test.ts`). Server imports use the `.js` suffix.
- API fields: `shared/types.ts` first, then the server producer, then the client consumer. Cross-boundary imports are `import type`.
- No hardcoded colours or shadows in `client/src/styles.css`; keep existing class names.
- Authored text wraps at 160 columns; commit bodies at 72. Comments say why, not what.
- Exact strings, used verbatim wherever named below:
  - server 403 bodies: `{ error: 'bad token' }` (unchanged) and `{ error: 'read-only from this network' }`.
  - client sentence `READ_ONLY_TEXT`: `Read-only from this network: open the dashboard through Tailscale, or set ANSWER_TOKEN.`
- Running one test module: `pnpm exec tsx /private/tmp/claude-501/-Users-andrejajevtic-Documents-custom-projects-claude-agents-dashboard/5efd6455-5d75-440c-9be6-d7a56586d81e/scratchpad/run-one.mts test/<name>.test.ts`
  (imports `test/tmp-root.ts` first, then calls the module's `run()`; non-zero exit on failure). A new test module is also registered in
  `test/run-all.ts`, following the existing import + call pattern.
- Never run the whole `pnpm test` just before pushing (CI gates it). Do run `pnpm typecheck` once per task.
- Commit per task, on branch `feat/tailnet-write-trust`, with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.

## Review Focus

1. **Proxy that appends with `, ` vs `,`**: `tailscale serve` (Go) may join with `, `; Vite joins with a bare `,`. Both must parse identically. Pinned in
   Task 1 (`'100.101.102.103, 127.0.0.1'` and `'100.101.102.103,127.0.0.1'` → tailnet).
2. **A switch-off from a tailnet device locks it out mid-session**: the very `POST /api/settings` that turns `trustTailnet` off must itself succeed (it was
   allowed when it arrived), and the next write must 403. Pinned in Task 3.
3. **Old settings file without `trustTailnet`** must read as `true`, not `false`. Pinned in Task 2.
4. **A 403 with an unreadable body** (proxy error page, empty body) must keep today's behaviour, the token prompt. Pinned in Task 4.
5. **IPv6 tailnet peer** (`fd7a:115c:a1e0::…`) and IPv4-mapped LAN entries (`::ffff:192.168.1.5`) inside XFF classify like their plain forms. Pinned in
   Task 1.

---

### Task 1: Peer resolution

**Files:**
- Modify: `server/lib/origin.ts` (add `resolvePeer`; `classifyOrigin` delegates to it; rewrite the module header and `classifyOrigin` JSDoc per spec §Resolving
  the peer)
- Test: `test/origin.test.ts`

**Interfaces:**
- Produces: `export function resolvePeer(remoteAddress: string | undefined, headers?: IncomingHttpHeaders): ConnectionOrigin`. `classifyOrigin` keeps its
  signature and returns `resolvePeer(...)`.

- [ ] **Step 1: Rewrite and extend the tests.** Replace the existing first-hop assertions (`'100.90.1.2, 10.0.0.1'` → tailnet; `'not-an-ip'` and `''` →
  local) with the new expectations, and add a `resolvePeer` table. Each row is (socket, XFF) → expected:

  | socket | X-Forwarded-For | expected |
  |---|---|---|
  | `127.0.0.1` | none | local |
  | `::1` | none | local |
  | `::ffff:127.0.0.1` | `127.0.0.1` | local |
  | `127.0.0.1` | `100.101.102.103,127.0.0.1` | tailnet |
  | `127.0.0.1` | `100.101.102.103, 127.0.0.1` | tailnet |
  | `127.0.0.1` | `100.101.102.103` | tailnet |
  | `127.0.0.1` | `fd7a:115c:a1e0::5` | tailnet |
  | `127.0.0.1` | `100.64.0.1,192.168.1.5` | lan (forged tailnet left of the real LAN hop) |
  | `127.0.0.1` | `127.0.0.1,192.168.1.5` | lan (forged loopback left of LAN) |
  | `127.0.0.1` | `::ffff:192.168.1.5` | lan |
  | `127.0.0.1` | `100.90.1.2, 10.0.0.1` | lan |
  | `127.0.0.1` | `not-an-ip` | unknown |
  | `127.0.0.1` | `''` (empty string) | unknown |
  | `127.0.0.1` | `100.101.102.103, ,127.0.0.1` | unknown (empty entry reached before the tailnet one) |
  | `127.0.0.1` | `  ` (whitespace only) | unknown |
  | `127.0.0.1` | array `['100.101.102.103', '127.0.0.1']` | tailnet (joined with `,`) |
  | `127.0.0.1` | `8.8.8.8` | unknown |
  | `192.168.1.5` | `100.101.102.103` | lan (non-loopback socket ignores XFF) |
  | `100.101.102.103` | `127.0.0.1` | tailnet |
  | `undefined` | `100.101.102.103` | unknown |

  Also assert `classifyOrigin` returns the same value as `resolvePeer` for three rows of that table.
- [ ] **Step 2:** run `test/origin.test.ts`; expect failures on the new rows (`resolvePeer` is not exported).
- [ ] **Step 3:** implement `resolvePeer` per spec §Resolving the peer, steps 1-3. Note that an absent header and an empty-string header differ: absent →
  `local`, present-but-empty → `unknown`.
- [ ] **Step 4:** run `test/origin.test.ts` and `pnpm typecheck`; expect all pass.
- [ ] **Step 5:** commit `feat(api): resolve the request peer right-to-left through loopback proxies`.

### Task 2: The `trustTailnet` setting

**Files:**
- Modify: `shared/types.ts` (`ServerSettings.trustTailnet: boolean`, JSDoc pointing at the spec), `server/lib/settings.ts` (`Stored`, defaults, read,
  `setSettings` validator), `client/src/hooks/useServerSettings.ts` (`SavingKey` gains `'trustTailnet'`)
- Test: `test/settings.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_TRUST_TAILNET = true` in `server/lib/settings.ts`; `getSettings().trustTailnet: boolean`; `setSettings({ trustTailnet })`
  accepts only a boolean.

- [ ] **Step 1: Tests**, following the file's existing `recordUsageHistory` cases:
  - a fresh home (no settings file) → `trustTailnet === true`
  - a settings file written before this change (has the other keys, no `trustTailnet`) → `true`
  - `setSettings({ trustTailnet: false })` → returns `trustTailnet: false`, and a fresh `getSettings` reads `false` from disk
  - `setSettings({ trustTailnet: 'no' })` → `null`, stored value unchanged
  - a stored non-boolean (`"trustTailnet": 1`) → reads as `true`
- [ ] **Step 2:** run `test/settings.test.ts`; expect the new cases to fail.
- [ ] **Step 3:** implement, mirroring `recordUsageHistory` at every site it appears in `settings.ts`.
- [ ] **Step 4:** run `test/settings.test.ts`, `test/client-settings.test.ts`, `pnpm typecheck`; expect pass.
- [ ] **Step 5:** commit `feat(settings): add the trustTailnet switch, on by default`.

### Task 3: The server gate and health

**Files:**
- Modify: `shared/types.ts` (`export type WriteAccess = 'open' | 'token' | 'none'`; `HealthResponse.writeAccess?: WriteAccess`; rewrite the `tokenRequired`
  JSDoc to the new meaning), `server/api.ts` (replace `tokenOk` and its 19 call sites; `logRejectedWrite`; `serveHealth`), `server/index.ts` only if
  `serveHealth`'s signature change needs it
- Create: `test/api-write-trust.test.ts` (register in `test/run-all.ts`)
- Modify tests: `api-answer-endpoints`, `api-git-fetch`, `api-open-folder`, `api-pins`, `api-reject-log`, `api-remote-toggle`, `api-wait-endpoints`,
  `spawn-endpoint`, `transcribe` (`.test.ts` each)

**Interfaces:**
- Consumes: `resolvePeer` (Task 1), `getSettings().trustTailnet` (Task 2).
- Produces, in `server/api.ts`:
  - `export function writeAccessFor(peer: ConnectionOrigin, trustTailnet: boolean, tokenSet: boolean): WriteAccess`: pure. `open` for local, or tailnet with
    the switch on; else `token` if a token is set; else `none`.
  - `export function refuseWrite(config: Config, req: IncomingMessage, res: ServerResponse): boolean`: true when it has sent the 403 (caller returns).
    Passes when `writeAccessFor(...)` is `open`, or when a token is set and `Authorization` equals `Bearer <token>` exactly (today's comparison).
    Otherwise sends `bad token` if a token is set, `read-only from this network` if not, and logs.
  - `serveHealth(config, res, req)`: `req` required. Adds `writeAccess`; `tokenRequired` becomes `writeAccess === 'token'`.
- Every `if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });` becomes `if (refuseWrite(config, req, res)) return;`, in the same
  position relative to the surrounding checks (the ordering comments around `serveTranscribe` and `serveSpawn` stay true; reword "token" to "write gate"
  where they name it).

- [ ] **Step 1: New tests in `test/api-write-trust.test.ts`**, via `withServer` (loopback socket). "lan" means header `X-Forwarded-For: 192.168.1.5`,
  "tailnet" means `X-Forwarded-For: 100.101.102.103`. Use `POST /api/remote-answer` with `{ "enabled": true }` as the write probe unless a case names
  another route; `TOKEN` is any fixed string set as `ANSWER_TOKEN` in the env body. The harness runs the server in this process, so the settings cache
  in `server/lib/settings.ts` is shared across test modules: every case that turns `trustTailnet` off turns it back on before it ends, even on failure.
  - local, no token set → 200
  - local, token set, no bearer → 200
  - tailnet, switch on (default), no token set → 200
  - tailnet, switch off (via `POST /api/settings {"trustTailnet": false}` from local first), token set, no bearer → 403 `bad token`
  - tailnet, switch off, no token set → 403 `read-only from this network`
  - tailnet, switch off, token set, `Bearer TOKEN` → 200
  - lan, token set, `Bearer TOKEN` → 200; `Bearer wrong` → 403 `bad token`; no bearer → 403 `bad token`
  - lan, no token set → 403 `read-only from this network` (the behaviour change)
  - `POST /api/settings` from lan, no token set → 403 `read-only from this network`, and `GET /api/settings` shows the value unchanged
  - Review Focus 2: from tailnet with no token set, `POST /api/settings {"trustTailnet": false}` → 200; the next tailnet write → 403
    `read-only from this network`; then from local `{"trustTailnet": true}` → 200 and the tailnet write → 200
  - `GET /api/health` `{ writeAccess, tokenRequired, origin }` for: local+token set → `open, false, local`; tailnet+switch on → `open, false, tailnet`;
    tailnet+switch off+token → `token, true, tailnet`; lan+token → `token, true, lan`; lan+no token → `none, false, lan`; lan+token+valid bearer still
    reports `token, true` (health never checks the bearer)
  - direct call, no server: `refuseWrite` with a stub `req` (`socket.remoteAddress: '192.168.1.5'`, `headers: { 'x-forwarded-for': '100.101.102.103' }`, a
    method and url) and a stub `res` that records status and body, config with no token → returns true, status 403, body `read-only from this network`
  - `writeAccessFor` truth table: the 6 rows of the spec's rule table, minus the bearer column, give `open/open/token/none/token/none` for
    (local,any,any) (tailnet,on,any) (tailnet,off,yes) (tailnet,off,no) (lan,any,yes) (lan,any,no); `unknown` behaves as lan.
- [ ] **Step 2: Update the existing token tests.** Each "token set, no/wrong bearer → 403" case adds `X-Forwarded-For: 192.168.1.5` so it still tests a
  refusal; its asserted body stays `bad token`. Cases that send the right bearer keep passing either way; leave them. `test/api-reject-log.test.ts`'s line
  assertion becomes `^\[dashboard] rejected write: POST \/api\/remote-answer from lan \(bad or missing token\)$`, plus one new case with no token set
  expecting `… from lan (read-only, no token set)`; the "line carries no part of the token" case stays.
- [ ] **Step 3:** run `test/api-write-trust.test.ts` and the nine modified modules; expect the new module to fail (no `writeAccessFor` export) and the
  refusal cases to fail where they already have the LAN header.
- [ ] **Step 4:** implement. Remove `tokenOk`. `logRejectedWrite(req)` gains the peer class and the refusal kind; keep its rate limit and key.
- [ ] **Step 5:** run the same modules plus `test/origin.test.ts` and `pnpm typecheck`; expect pass. Grep: `git grep -n tokenOk -- server` prints nothing.
- [ ] **Step 6:** commit `feat(api): trust loopback and tailnet peers on write routes; keep ANSWER_TOKEN as a pass`.

### Task 4: Client refusal handling

**Files:**
- Create: `client/src/lib/writeRefusal.ts`
- Modify: the write hooks `usePendingQuestion`, `usePendingPlan`, `usePendingMessage`, `useSpawn`, `useStopSession`, `useRemoteAnswer`, `useServerSettings`,
  `useOpenFolder`, `usePins`, `useDictation` (all under `client/src/hooks/`), and the panels that render their `needsToken` (`QuestionPanel`, `PlanPanel`,
  `MessagePanel`, `ResumePanel`, `SpawnPanel`, `RemoteAnswerToggle`, `sessions/Expanded`, `settings/SettingsView`)
- Test: `test/write-refusal.test.ts` (register in `test/run-all.ts`)

**Interfaces:**
- Produces, in `client/src/lib/writeRefusal.ts`:
  - `export const READ_ONLY_TEXT` (exact copy in Global Constraints)
  - `export function refusalKind(status: number, body: unknown): 'token' | 'read-only' | null`: `null` unless `status === 403`; `'read-only'` only when
    `body` is an object whose `error` is exactly `read-only from this network`; every other 403 → `'token'`.
- Hook contract: on a 403, read the JSON body once (tolerating a non-JSON body as `undefined`) and call `refusalKind`. `'token'` → exactly today's
  behaviour. `'read-only'` → never set `needsToken`; surface `READ_ONLY_TEXT` through the hook's existing error or failure text (`usePins` returns it in
  place of `TOKEN_TEXT`; `useDictation` in place of its `token needed …` string; `useOpenFolder` in place of its `bad token` branch). A hook with no error
  text today gains `readOnly: boolean` next to `needsToken`, and its panel renders `READ_ONLY_TEXT` where it would render the token prompt.

- [ ] **Step 1: Tests for `refusalKind`:** `(403, {error:'read-only from this network'})` → read-only; `(403, {error:'bad token'})` → token; `(403,
  undefined)` → token; `(403, 'read-only from this network')` (a bare string) → token; `(403, {error:'Read-only from this network'})` → token (exact match);
  `(404, {error:'read-only from this network'})` → null; `(200, {})` → null.
- [ ] **Step 2:** run it; expect failure (module missing).
- [ ] **Step 3:** implement the helper, then wire each hook and panel listed above per the hook contract. Keep each hook's token storage and Bearer header
  untouched.
- [ ] **Step 4:** run `test/write-refusal.test.ts`, `test/client-settings.test.ts`, `pnpm typecheck`, `pnpm build`; expect pass. `git grep -n "setNeedsToken(true)" -- client/src`
  shows every remaining site sits behind a `'token'` outcome.
- [ ] **Step 5:** commit `feat(client): tell a read-only network apart from a missing token`.

### Task 5: Settings switch, status line, git fetch key, badge copy

**Files:**
- Create: `client/src/lib/writeStatus.ts`
- Modify: `client/src/components/settings/SettingsView.tsx`, `client/src/lib/gitClock.ts`, `client/src/hooks/useGitFetch.ts`,
  `client/src/hooks/useGitSync.ts`, `client/src/components/management/GitView.tsx`, `GitClockChip.tsx`, `GitParts.tsx`, `client/src/components/OriginBadge.tsx`
- Test: `test/write-status.test.ts` (register), `test/git-stats-client.test.ts`

**Interfaces:**
- Consumes: `HealthResponse.origin`, `.writeAccess` (Task 3), `ServerSettings.trustTailnet` (Task 2), `READ_ONLY_TEXT` (Task 4).
- Produces: `export function writeStatusLine(origin: ConnectionOrigin | undefined, writeAccess: WriteAccess | undefined, trustTailnet: boolean | undefined):
  string | null`, built exactly as spec §The switch describes; `null` when `origin` or `writeAccess` is undefined.
- `fetchKeyState`'s input gains `writeAccess: WriteAccess | undefined`; `useGitSync` carries `writeAccess` off health next to `tokenRequired`, and
  `useGitFetch` / `GitClockChip` / `GitParts` pass it on.

- [ ] **Step 1: Tests.**
  - `writeStatusLine`: `(local, open, true)` → `This device reaches the dashboard from this machine — writes need no token.`; `(tailnet, open, true)` → `This
    device reaches the dashboard via tailnet — writes need no token.`; `(tailnet, token, false)` → `This device reaches the dashboard via tailnet, and tailnet
    trust is off — writes need the answer token.`; `(tailnet, none, false)` → `… via tailnet, and tailnet trust is off — read-only: no answer token is set.`;
    `(lan, token, true)` → `This device reaches the dashboard via LAN — writes need the answer token.`; `(lan, none, true)` → `… via LAN — read-only: no
    answer token is set.`; `(unknown, token, true)` → `… from an unrecognised address — writes need the answer token.`; `(lan, undefined, true)` → null;
    `(undefined, open, true)` → null. (Write the `…` rows out in full in the test.)
  - `fetchKeyState`: `writeAccess: 'none'` → `{ disabled: true, label: 'now', sub: READ_ONLY_TEXT, subTone: 'amber' }`, and it outranks a `'refused'`
    failure; every existing case passes unchanged with `writeAccess: undefined` added to the helper's defaults (including the `tokenRequired: undefined →
    enabled` row).
- [ ] **Step 2:** run both modules; expect failures.
- [ ] **Step 3:** implement. In `SettingsView`: under the Shared band, beside `recordUsageHistory`, a row named `Trust tailnet devices`, `Segmented` on/off
  saving `{ trustTailnet }`, hint: `Writes from any device on your tailnet need no token, tagged devices and users this machine is shared with included.
  Lookout reaches the dashboard over the tailnet, so with this off it needs its token.` Under Local › Connection, above the Answer token row, render
  `writeStatusLine(remote.state?.origin, remote.state?.writeAccess, server.state?.trustTailnet)` when non-null. The Answer token hint becomes `Only needed
  when the line above says so. Stored in this browser and sent with every write.` `OriginBadge`'s `public` tooltip: replace `set ANSWER_TOKEN and consider
  auth at the edge` with `writes need ANSWER_TOKEN here; consider auth at the edge too`.
- [ ] **Step 4:** run both modules, `pnpm typecheck`, `pnpm build`; expect pass.
- [ ] **Step 5:** commit `feat(settings): show this device's write access and the tailnet switch`.

### Task 6: Installer, compose, docs

**Files:**
- Modify: `scripts/install-hooks.sh` (the `TODO no ANSWER_TOKEN in .env` branch), `test/install-hooks-token.test.ts`, `docker-compose.yml`,
  `docker-compose.dev.yml`, `.env.example`, `README.md`, `scripts/tailnet.ts` (header), `server/lib/request-guard.ts` (header), `server/lib/config.ts`
  (`answerToken` JSDoc), `scripts/remote-decision-hook.sh` (comment only), `docs/subsystems/remote-access.md`, and every other hit of
  `git grep -n -e ANSWER_TOKEN -e tokenRequired -e 'dashboard token'` whose sentence is no longer true, plus `.github/pull_request_template.md`
  and `docs/overview.md` if it describes the gate

- [ ] **Step 1: Installer test.** In `test/install-hooks-token.test.ts`, the "genuinely no token anywhere" case now expects the line
  `ok       no token file needed — hooks reach the dashboard on loopback (set ANSWER_TOKEN only for a container or a non-loopback CLAUDE_DASHBOARD_URL)`
  and asserts the old `TODO {5}no ANSWER_TOKEN` text is absent. The `could not read ANSWER_TOKEN` TODO cases are unchanged (a read failure is still
  worth a TODO).
- [ ] **Step 2:** run it; expect the changed case to fail.
- [ ] **Step 3:** change the installer branch to print that line (no follow-up printf hint). Compose: forward `ANSWER_TOKEN` in both files the same bare way
  they forward `NTFY_TOPIC`, with a comment saying a container needs it to write (spec §Residual risks). Docs: rewrite per spec §Docs; remote-access.md
  gets the trust rule, the chain table, every residual-risk bullet, the Docker bullet rewrite, and the note that any new front proxy must set
  `X-Forwarded-For`. Update docs-sync provenance stamps the way the repo's other edited docs do.
- [ ] **Step 4:** run `test/install-hooks-token.test.ts`, `test/env-value.test.ts`, `pnpm typecheck`; expect pass. `git grep -n "leaves them open\|empty
  (default) leaves" -- . ':!docs/superpowers' ':!audits' ':!backlog'` prints nothing stale.
- [ ] **Step 5:** commit `docs: describe tailnet write trust; installer and compose follow it`.

### Task 7: Live check (no commit unless a fix is needed)

- [ ] With the worktree's `pnpm dev` on non-default ports (`PORT=4273 WEB_PORT=5273`, started via Bash with its pid recorded; kill only that pid):
  `curl -s localhost:4273/api/health | jq '{writeAccess,origin}'` → `open, local`; the same with `-H 'X-Forwarded-For: 192.168.1.5'` → `none` or `token`
  per the worktree `.env`. A `POST /api/remote-answer` through `http://<LAN IP>:5273` from this machine → `lan` refusal (Vite appends the LAN address).
  Record the outputs for the PR's Verification section. The real phone path through `tailscale serve` cannot be exercised from a worktree without
  re-registering serve, which belongs to the user's running dashboard: list it as unverified.
