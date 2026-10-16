# Plan review 1 — tailnet write trust

Date: 2026-10-16. Reviewer: a fresh subagent (Fable 5.1), given only the plan, the spec, the repo and the checklist.

Plan: `docs/superpowers/plans/2026-10-16-tailnet-write-trust.md`. Spec: `docs/superpowers/specs/2026-10-16-tailnet-write-trust-design.md`.

## Verdict: APPROVE WITH FIXES

The plan is faithful to the spec on every value I could check (403 bodies, log line, status-line copy, rule-table truth table, the Task 1 XFF rows), its
interfaces chain correctly across tasks, the 19 `tokenOk` sites it counts are the 19 in `server/api.ts`, and every Create path is absent while every
Modify path exists. Five Important gaps need a sentence each before an implementer builds from it; none is a wrong value or a contradiction of the spec.

## Checklist results

1. **Coverage.** Every spec section maps to a task except: the PR-description sentence in spec §Lookout (spec:187, "the PR description says: Lookout needs
   no change to ship this") has no task; `docs/subsystems/settings.md` (spec:194) is not named by Task 6 and the Task 6 grep cannot reach it. Every spec
   §Tests bullet (spec:201-220) has a Task 1 or Task 3 case.
2. **Values.** All exact strings match the spec: `bad token`, `read-only from this network`, `READ_ONLY_TEXT`, the `logRejectedWrite` line (spec:163 vs
   plan:162-163), the status-line sentences (spec:120-125 vs plan:215-220), the row name `Trust tailnet devices` (spec:118 vs plan:225). The `OriginBadge`
   tooltip edit (plan:229-230) targets the literal that exists at `client/src/components/OriginBadge.tsx:20`.
3. **Reality.** Verified by grep: 19 `if (!tokenOk(` sites in `server/api.ts` (400-1760); `serveHealth(config, res, req?)` at `server/api.ts:523` with its
   one caller `server/index.ts:233` already passing `req`; `SavingKey` at `client/src/hooks/useServerSettings.ts:7`; `fetchKeyState` at
   `client/src/lib/gitClock.ts:133`; `Segmented` imported at `SettingsView.tsx:3`; `NTFY_TOPIC` forwarded bare in both compose files (`docker-compose.yml:25`,
   `docker-compose.dev.yml:17`); installer branch at `scripts/install-hooks.sh:353-355`; test regex at `test/install-hooks-token.test.ts:220`; reject-log
   regex at `test/api-reject-log.test.ts:62`; all three Create files absent; all nine "modify tests" present. `test/api-harness.ts:133` listens on `127.0.0.1`
   and `RequestOptions.headers` (`:70`) carries `X-Forwarded-For`.
4. **Interfaces.** `resolvePeer` (T1) → T3; `DEFAULT_TRUST_TAILNET`/`getSettings().trustTailnet` (T2) → T3; `WriteAccess`, `HealthResponse.writeAccess`
   (T3) → T5; `READ_ONLY_TEXT` (T4) → T5. Spellings agree.
5. **Order.** No forward dependency. T4 precedes T5, which consumes `READ_ONLY_TEXT`.
6. **Tests.** Each task's step 2 names the failure expected before implementation. Review Focus 1, 2, 3, 5 each have a pinned case (plan:68-69, 151-152,
   106, 71/74). Review Focus 4 is pinned on `refusalKind` only (plan:189-190), never on a hook's body read — acceptable, noted as Minor.
7. **Conventions.** No function bodies or scaffolding anywhere; soft size budget stated; 160-column wrap held.

## Important

- **[I] plan:160** — Step 2 rewrites only the "token set, no/wrong bearer → 403" cases, but `test/api-remote-toggle.test.ts:67-71` asserts
  `GET /api/health` `tokenRequired: true` with a token set, from loopback with no XFF. Under the new rule (plan:133, spec:137) that caller is `open`, so
  `tokenRequired` is `false` and the case fails; `api-remote-toggle` is in the Files list but nothing says what to do with this case, and plan:160 says to
  leave non-403 cases alone. → Add to Step 2: that health case gains `X-Forwarded-For: 192.168.1.5` (it keeps testing "a caller that needs the token"),
  and its sibling at `:77-81` (no token → `false`) passes unchanged.
- **[I] plan:174-176** — The Task 4 enumeration (which spec:148 says must be complete) misses `client/src/hooks/useGitSync.ts:82`, which renders
  `useSpawn().needsToken` as `SYNC_NEEDS_TOKEN`. With `useSpawn` gaining `readOnly`, a read-only refusal of a Sync launch sets neither `needsToken` nor
  `error` (`useSpawn.ts:49-51` returns null without `setError`), so `useGitSync` shows no note at all. → Add `useGitSync` to the list with the contract
  "on `readOnly`, `setNote(READ_ONLY_TEXT)`".
- **[I] plan:225** — "under the Shared band, beside `recordUsageHistory`" places the switch in the **Usage forecast** group (`SettingsView.tsx:409-412`,
  sub "Feeds the weekly projection on the Usage page"), which is the only group that row lives in. Spec:118 asks for "the existing Connection area", and
  spec:126 leaves placement to the builder, but the plan's phrasing points at the wrong group. → Name the group: either a new Shared `SettingsGroup`
  (e.g. "Write access", sub "Who may change things without a token") or the Remote answers group (`:306`), and keep the status line under Local ›
  Connection (`:699`) as written.
- **[I] plan:237-241** — Task 6 does not name `docs/subsystems/settings.md`, which spec:194 lists, and the grep at plan:240 cannot reach it: that doc
  enumerates every Shared key (`settings.md:60-80`, "`recordUsageHistory` … is the fourth", `gitFetchSecs` next) and contains no `ANSWER_TOKEN`,
  `tokenRequired` or `dashboard token` hit. `trustTailnet` would ship undocumented there. → Add `docs/subsystems/settings.md` (a `trustTailnet` paragraph in
  that enumeration) to Task 6's Files, and `client/src/hooks/useServerSettings.ts:28-31`'s JSDoc list to Task 2.
- **[I] plan:256-263** — Spec:187 requires the PR description to say "Lookout needs no change to ship this" and that its per-app token field becomes
  optional. No task writes the PR body. → Add a line to Task 7 (or a Task 8 "PR") naming the PR template sections and that sentence.

## Minor

- plan:9 — "one `refuseWrite` … also feeds `GET /api/health`": health reads `writeAccessFor`, not `refuseWrite` (plan:133 says so). Wording.
- plan:30 — `run-one.mts` lives in a session-specific scratchpad (`/private/tmp/claude-501/…/5efd6455…/scratchpad`); a subagent in another session will
  not have it. Give the one-liner inline (`tsx -e 'import "./test/tmp-root.ts"; …'`) or commit a `scripts/` runner.
- plan:34 — Trailer says `Claude Opus 5.5`; the implementing session's own attribution reminder decides the model name. Say "the trailer your attribution
  reminder gives".
- plan:119-120 — `server/index.ts:151` is a comment naming `tokenOk`; Step 5's grep (plan:167) forces it to change, so list `server/index.ts` as an
  unconditional Modify. Same for `test/api-reject-log.test.ts:46` (banner text) and `docs/overview.md:123` (it does describe the gate, so drop the "if").
- plan:138-141 — Say the env body copies the `SHOW_USAGE=false\nSKIP_PROC_SCAN=true` prefix (`test/api-reject-log.test.ts:28`); and the cross-module cache
  fact is true (`test/api-harness.ts:105-110` `resetStores` does not call `resetSettings`), but the repo's existing pattern is for the module to call
  `resetSettings()` itself (`api-pins`, `api-git-fetch`, `api-open-folder` …), which is simpler than a try/finally re-enable in every case.
- plan:156-157 — The stub `res` must implement `writeHead(code, headers)` and `end(body)` (`server/api.ts:1581-1583`); name both so the implementer
  does not reach for a `ServerResponse` mock library.
- plan:211 — `fetchKeyState` "gains" `writeAccess`; spec:151 says the key "moves to `writeAccess`". The plan's choice keeps the existing cases intact
  and is self-consistent; say explicitly that `tokenRequired` stays in the input on purpose.
- plan:209 — No test row for `trustTailnet: undefined` (server settings not yet loaded); `(tailnet, token, undefined)` should carry no switch note.
- plan:228 — "Only needed when the line above says so" has no referent before health answers or on an older server (spec:125). Consider "…when the
  status line above says so (or the server runs with `ANSWER_TOKEN` set)".
- plan:43 — Review Focus 4 is pinned on the pure helper; no case drives a hook with a non-JSON 403. Fine for this repo's test style, noted.
- plan:140 — The plan's own convention says Fable/Opus "say so rather than transcribing"; the comment at `test/api-remote-toggle.test.ts:63-66`
  ("`/api/health` is the only endpoint the hooks can reach without a token") becomes false and should be reworded in Step 2.

## Not verified

- The Vite `xfwd` join character (spec:75) and `tailscale serve`'s header shape — out of scope for a document review; Review Focus 1 pins both forms.
- Task 7's LAN-IP path through Vite: `hostAllowed` (`server/lib/request-guard.ts:47`) accepts IP-literal hosts and `crossSiteWrite` (`:66-71`) passes a
  request with no `Origin`/`Sec-Fetch-Site`, so a `curl` through `:5273` should reach the gate as the plan expects, but I did not run it.
