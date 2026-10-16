# Tailnet write trust — final whole-branch review

Date: 2026-10-16. Branch `feat/tailnet-write-trust`, range `0b6ee61..63ac7e8` (10 commits, 77 files, +1628/−287).
Requirements: `docs/superpowers/specs/2026-10-16-tailnet-write-trust-design.md`, `docs/superpowers/plans/2026-10-16-tailnet-write-trust.md`, plus the
executor's six `Ruling:` lines in `.superpowers/sdd/2026-10-16-tailnet-write-trust/progress.md`. Read-only review; nothing on the checkout was touched.

Verified locally (output seen, not assumed): `pnpm typecheck` clean; `api-write-trust` 12/12, `origin` 16/16, `settings` 50/50, `write-refusal` 7/7,
`write-status` 7/7, `api-reject-log` 8/8, `api-remote-toggle` 11/11, `git-stats-client` 42/42, `install-hooks-token` 18/18. The full `pnpm test` was
not run here (CI is the gate per CLAUDE.md), nor `pnpm test:visual`, nor any live server.

## Declined to judge

- Timing-unsafe bearer comparison (`server/api.ts:519`, plain `===`): pre-existing in `tokenOk`, carried over unchanged; the plan says "today's
  comparison". Listed under Minor as a recommendation, not graded against this change.
- `process.env.ANSWER_TOKEN` beating the harness's env file (`server/lib/config.ts:305`), which would flip every api test's expectations in a shell that
  exports the variable: pre-existing property of the whole api test family, not introduced here.
- Lookout's viewer iframe and hub reaching the dashboard: the spec's §Lookout analysis was taken as given; nothing in this repo can test it.
- Tailscale Funnel: the repo already forbids it (`remote-access.md:216`, `test/tailnet.test.ts`), so whether a Funnel client's forwarded address would
  read `unknown` rather than `tailnet` was not pursued.
- The Settings switch was not clicked in a browser (Ruling, Task 7). The PR's unverified line is the right place for that; the save path is the same
  `POST /api/settings` the trust tests drive.
- Docs-sync `verified:` stamps left stale (Ruling, Task 6): the repo's convention is to restamp after the squash; outside this review.
- Two pre-existing >160-column lines in `shared/types.ts:1665,1669` are not in the diff.

## Strengths

- The gate reads only what a remote client cannot author. `resolvePeer` (`server/lib/origin.ts:140-156`) returns the socket verdict outright for any
  non-loopback socket and walks `X-Forwarded-For` right-to-left only when the socket is loopback, failing closed (`unknown`) on any non-address entry
  rather than skipping it. `refuseWrite` (`server/api.ts:517-527`) consults the bearer only when `writeAccessFor` already said `token`, so an empty
  `ANSWER_TOKEN` can never be matched by `Bearer ` and a trusted peer never has its header inspected.
- Every write route in the router (`server/index.ts:243-395`: settings, pins, pins/order, open-folder, git-fetch, the three waits, remote-answer,
  permissions/notify, notify/event, notify/test, transcribe, spawn, spawn/:id/stop, sessions/:id/{answer,plan-answer,stop,message-answer}) calls
  `refuseWrite` in the same position its `tokenOk` held; `git grep tokenOk -- server client shared scripts test` is empty. No GET route mutates:
  `serveDismiss` returns a static page, the hub declares no POST actions (`api.ts:567-573`), and `markGitWatched` on `GET /api/git-stats` is a timer
  hint, not state. `hostAllowed` and `crossSiteWrite` still run before routing (`index.ts:199-202`); `request-guard.ts` changed only in comments, and
  `test/request-guard.test.ts:109-113` drives a cross-site POST through the listener from loopback — now a trusted peer — so it proves the CSRF refusal
  does not depend on the token.
- `test/api-write-trust.test.ts` covers every row of the spec's rule table through the real handler, the switch-off-from-tailnet sequence (Review
  Focus 2), `POST /api/settings` refused from LAN leaving the value unchanged, health never confirming a guessed bearer, and the non-loopback socket with
  a forged tailnet header as a direct `refuseWrite` call. `test/origin.test.ts:140-162` pins bare-`,` and `, ` joins (Focus 1), array headers, empty and
  whitespace entries, IPv6 tailnet and IPv4-mapped LAN inside the header (Focus 5), a forged loopback entry left of a LAN one, and the
  badge/gate agreement. `test/settings.test.ts:327-364` pins the pre-switch file reading as on (Focus 3) and a stored non-boolean reading as on.
  `test/write-refusal.test.ts` pins an unreadable body as a token refusal (Focus 4) and an exact, case-sensitive match on the read-only body.
- The client never shows the token prompt for a read-only refusal: all ten hooks the plan lists call `refusalKind` on the 403 body and either set a
  `readOnly` flag (clearing `needsToken`) or return `READ_ONLY_TEXT` through their existing error path; the five panels that render `needsToken`
  either render `readOnly` beside it (Question/Plan/Message, RemoteAnswerToggle, SettingsView) or render `error`, which `useSpawn`/`useStopSession`
  now set to `READ_ONLY_TEXT` with `needsToken` false (ResumePanel, SpawnPanel, `sessions/Expanded.tsx:55-56`).
- The rejected-write log keeps its rate limit and key and adds only the peer class and refusal kind (`api.ts:485-495`); the "no part of the token"
  test stays. `tokenRequired` keeps its name with the per-caller meaning, so `remote-decision-hook.sh` needs no logic change and stops warning a
  loopback hook that has no token file.
- Docs: `remote-access.md` gains the rule table, the chain table and the residual-risk list verbatim from the spec; `.env.example`, `config.ts`,
  `request-guard.ts`, `scripts/tailnet.ts`, both compose files, `docker.md`, `hooks-setup.md`, `remote-answer-setup.md`, `settings.md`, `spawn.md`,
  `remote-answer.md` and `overview.md` all state the new model. No CSS was touched, so no theme literal could slip in.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

1. **`OriginBadge.tsx` still says nothing gates on the origin.**
   - File: `client/src/components/OriginBadge.tsx:25-26` — "Informational only — nothing in the app gates on it (see server/lib/origin.ts)".
   - Issue: the badge's value is now exactly the write gate's verdict (`classifyOrigin` delegates to `resolvePeer`, `origin.ts:159-164`), and the
     spec's §Docs says every comment that describes the old trust model is rewritten. This is the one comment left that tells a reader the opposite
     of the new security model, in the file a front-end change to the badge would start from.
   - Fix: rewrite to say the badge shows the same peer the gate trusts (`docs/subsystems/remote-access.md#who-may-write`), so a change here must keep
     agreeing with `server/api.ts` `refuseWrite`.

### Minor (Nice to Have)

1. **Stale "token guard" wording in router and handler comments.** `server/index.ts:246` ("Same read/write split and token guard as /api/settings"),
   `server/index.ts:264` ("token-guarded inside the handler"), `server/api.ts:1025` and `server/api.ts:1736` ("Token-guarded like …"). All sit
   beside a `refuseWrite` call, so nobody is misled about the mechanism, but the spec's grep checklist did not include "guard" and these slipped
   through. One-word edits to "write gate".
2. **`useGitFetch` is the one write hook that never reads its 403 body.** `client/src/hooks/useGitFetch.ts:41-43` maps any 403 to `failure: 'refused'`,
   whose copy is "fetch refused: bad token". `start()` is a no-op once health has reported `writeAccess: 'none'` (`:35`), and `fetchKeyState` lets
   `'none'` outrank the failure (`gitClock.ts:152`, tested), so the wrong copy can show only in the window between page load and the first health
   answer on a read-only network. The spec chose health over the body for this key, so this is within design; a `refusalKind` call in the `.then`
   would close the window at the cost of one body read.
3. **Dismiss paths in the three pending hooks set one flag without clearing the other.** `usePendingQuestion.ts:154-155`, `usePendingPlan.ts:147-148`,
   `usePendingMessage.ts:145-146`: a `'token'` outcome sets `needsToken` without clearing `readOnly`, and vice versa, so a panel could show both notes
   if the server's state changed between two dismisses. The submit paths clear both. Reaching it needs a server restart with a token added mid-session;
   cosmetic.
4. **`OriginBadge` `lan` tooltip** (`OriginBadge.tsx:9-11`) says only that the address moves; now that a LAN badge means read-only without a token, one
   clause ("writes need ANSWER_TOKEN") would make the badge match the Settings status line. Spec asked only for the `public` tooltip, which is done.
5. **Bearer comparison is not constant-time** (`server/api.ts:519`). Pre-existing, but the token is now the only pass for LAN and public callers, and
   `crypto.timingSafeEqual` over equal-length buffers is a Node built-in, so no new dependency. Low practical risk on a LAN/tunnel with per-request
   jitter; worth doing when next in the file.
6. **No test row for a mapped-loopback entry appended by Vite** (`100.x,::ffff:127.0.0.1`), the form a dual-stack Vite listener writes when `tailscale
   serve` connects over IPv4. `normalizeAddress` (`origin.ts:32-45`) unwraps it, and the socket-side row `['::ffff:127.0.0.1', '127.0.0.1', 'local']`
   covers the function, but a header-side row would pin the daily-path chain exactly as the API sees it.
7. **`SettingsView.sendTestPush`** (`SettingsView.tsx:156-167`) prints the server's `error` body verbatim, so a read-only caller sees "read-only from
   this network" rather than `READ_ONLY_TEXT`. Accurate, just not the shared sentence; the plan's hook list did not include this button.

## Plan alignment

- Tasks 1-6 are present and match their interfaces: `resolvePeer` + `classifyOrigin` alias (Task 1), `trustTailnet` mirrored at every
  `recordUsageHistory` site (Task 2), `writeAccessFor`/`refuseWrite`/`serveHealth(config, res, req)` (Task 3), `writeRefusal.ts` + the ten hooks and
  the panels (Task 4), `writeStatus.ts`, the Shared-band "Write access" group, the Connection status line, the `writeAccess`-aware fetch key and the
  `public` tooltip (Task 5), installer line, compose forwarding and docs (Task 6). Task 7 was a live check (ruling noted above); Task 8 is the PR.
- Deviation, justified: the spec's §The switch put the toggle in "the existing Connection area"; the plan moved it to a Shared-band group because the
  value is a server setting read by the gate, and the status line (per-browser) stays under Local › Connection. Right split; `.env.example` and
  `settings.md` name the Shared location consistently.
- Rulings: Task 2 (visual fixture) required by typecheck; Task 4 (`useSpawn` gets both `readOnly` and `error`) is what lets ResumePanel/SpawnPanel
  render the sentence without a change of their own; Task 5 (placement, `server.state` guard) matches the neighbouring rows; Task 6 (stamps,
  extra docs) and Task 7 (switch not clicked) are honest and flagged for the PR. All six stand.

## Recommendations

- Fix Important 1 and Minor 1 together: one `git grep -n -i -E "token guard|token-guarded|nothing in the app gates"` pass, five one-line edits.
- Add the `::ffff:127.0.0.1`-in-header row to `test/origin.test.ts` (Minor 6) — it is the user's daily chain and costs one table line.
- Carry the PR's "not verified" line exactly as the Task 7 ruling states it: the Settings switch was exercised through `POST /api/settings`, not clicked.

## Assessment

**Spec compliance:** compliant. Every rule-table row, both 403 bodies, the health fields, the switch default and its live read, the right-to-left
peer walk, the installer and compose changes and the docs are as specified; the one placement deviation is the plan's own and is an improvement.

**Ready to merge?** With fixes — the single Important item is a comment that contradicts the trust model; everything else is Minor.

**Task quality:** high. The gate is small, pure where it can be, and its tests exercise the real listener for every peer class the harness can
produce and the pure helper for the one it cannot. The client change is the minimal per-hook call the spec allowed rather than the refactor it ruled
out.
