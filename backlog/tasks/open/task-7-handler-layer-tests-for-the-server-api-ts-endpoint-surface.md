---
id: task-7
title: Handler-layer tests for the server/api.ts endpoint surface
created: 2026-08-27
tags: tests, server
---

## Goal

Close the one systemic coverage gap an audit verified across six independent findings: the
`server/api.ts` handlers have no tests. Their underlying `lib/*` functions are well covered,
but the handler layer above them — auth gating, body parsing, id validation, status-code
mapping, `res.on('close')` wiring — is exercised by nothing, so a break there passes CI.

Two handler groups already have the pattern to copy: `serveSpawn` / `serveSpawnStop` are
driven over a real socket in `test/spawn-endpoint.test.ts`.

## Plan

Extend the existing socket harness from `test/spawn-endpoint.test.ts` to the uncovered
handlers, one new test file per group so failures stay legible:

1. **Read endpoints** — `serveSessions` (api.ts:110), `serveSessionDetail` (:169),
   `serveSessionChat` (:209). Cover paging params and the not-found path.
2. **Hold-and-wait endpoints** — `serveQuestionWait` (:639), `servePlanWait` (:712),
   `serveMessageWait` (:787). Cover the token/enabled gate, `sessionExists`, and
   client-disconnect cleanup via `res.on('close')`.
3. **Answer endpoints** — `serveSessionAnswer` (:688), `serveSessionPlanAnswer` (:758),
   `serveSessionMessageAnswer` (:835). Cover the status-code switch for
   `ok` / `not-found` / `mismatch` / default.
4. **Kill switch** — `serveRemoteAnswerToggle` (:613). Cover 403, 409, and the `released`
   count. The doc comment calls this the app's only runtime kill switch.
5. **Analytics / management** — `serveAnalytics` (:1140), `serveManagementIndex` (:1080),
   `serveManagementProject` (:1100).

Each test drives a real request through `server/index.ts`'s router rather than importing the
handler, so the route table is covered too — the audit found the router itself is untested.

## Test cases

- `/api/sessions` with no params → 200, body is an array.
- `/api/sessions/<unknown-id>` → 404, not a 500.
- `/api/sessions/<id>/chat?before=<cursor>` → paging honored; malformed cursor → 400.
- `/api/questions/wait` with `REMOTE_ANSWER=false` → 403 without registering a waiter.
- `/api/questions/wait` with a bad session id (fails `ID_RE`) → 400.
- `/api/questions/wait`, then client aborts → the waiter is removed, not leaked.
- `/api/sessions/<id>/answer` for an unregistered question → the `not-found` status code.
- `/api/sessions/<id>/answer` with a mismatched id → the `mismatch` status code, distinct
  from `not-found`.
- `/api/sessions/<id>/answer` with a non-JSON body → 400 from `readJsonBody`, not a throw.
- `/api/remote-answer` toggle off with waiters held → 409 (or the intended code) and
  `released` equals the number actually dismissed.
- `/api/remote-answer` without a valid token → 403.
- `/api/analytics` → 200 and well-formed JSON.
- `/api/management/<project>` for an unknown project → 404.

## Done when

`pnpm test` covers all thirteen handlers above through the real router, the count printed by
`test/run-all.ts` reflects the new cases, and each new test has been shown to fail with its
handler's guard removed — a test that stays green with the guard deleted proves nothing.
