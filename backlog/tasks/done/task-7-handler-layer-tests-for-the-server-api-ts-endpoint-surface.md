---
id: task-7
title: Handler-layer tests for the server/api.ts endpoint surface
created: 2026-08-27
tags: tests, server
started: 2026-08-28
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

## Outcome

**2026-08-28 — done.** All thirteen handlers are now covered through the real route
table, in five new test files (77 cases), plus a shared socket harness.

One production change was needed to make "through the real router" possible:
`server/index.ts`'s request listener was an anonymous closure over the module-level
`config`, so it could only ever be driven with the developer's own `.env`. It is now
`createRequestListener(config)`, and the production server is
`http.createServer(createRequestListener(config))`. Whitespace-blind, the diff is 16
added lines and 2 removed — signature plus doc comment; the route bodies are
re-indented but otherwise untouched.

Added:

- `test/api-harness.ts` — a live server on a throwaway `.env`, cwd and `$HOME`, with
  `req` (awaited), `open` (response left hanging, for the wait endpoints) and `until`
  (poll the store, never sleep a guessed interval).
- `test/api-read-endpoints.test.ts` (15) — scan knobs and their caps, `ID_RE`, the 404
  vs 500 distinction, cursor validation, contiguous `?before=` paging, `%ZZ`.
- `test/api-wait-endpoints.test.ts` (14) — the toggle/token/id/`sessionExists` gates
  asserted against the *store*, not just the status code; the hold staying held; the
  `res.on('close')` cleanup on all three; and a stale close not evicting a newer wait.
- `test/api-answer-endpoints.test.ts` (28) — the four-way switch run over all three
  answer routes from one table, with `not-found` (404) and `mismatch` (409) driven by
  the same request body so only the held state differs.
- `test/api-remote-toggle.test.ts` (9) — 403, 409, and `released === 3` proven by all
  three hooks' held responses completing as `dismissed`.
- `test/api-management-analytics.test.ts` (11) — enumerated-set resolution for `?dir=`
  and `?path=`, plus the analytics pass-through. Also covers `serveManagementFile`,
  which is not one of the thirteen but is the only route here that reads an arbitrary
  absolute path.

Two findings worth recording. `?before=` with an empty value is *not* refused —
`Number('') === 0`, so the guard reads it as offset 0. Harmless, and now pinned by a
test rather than left as an accident. And `serveSessionAnswer` gates on
`config.remoteAnswer` while the wait routes gate on `getState(config).remoteAnswer`;
that asymmetry is deliberate (it is what lets the toggle release held waits instead of
stranding them) and is now pinned too.

### Verification

`pnpm test` — 907 cases, all pass (`pnpm`/`tsc` invoked directly here; the repo's
corepack pin does not match this machine's pnpm 11):

```
$ ./node_modules/.bin/tsc --noEmit && echo "TYPECHECK OK"
TYPECHECK OK

$ ./node_modules/.bin/tsx test/run-all.ts
...
=== read endpoints (api.ts via the router) ===
  15/15 passed
=== wait endpoints (api.ts via the router) ===
  14/14 passed
=== answer endpoints (api.ts via the router) ===
  28/28 passed
=== remote-answer toggle (api.ts via the router) ===
  9/9 passed
=== management + analytics endpoints (api.ts via the router) ===
  11/11 passed
ALL PASS
```

**Mutation proof** — the "done when" clause that matters. 21 guards were deleted one at
a time (each restored immediately after) and the owning test file re-run. Every one of
the 21 turned its test file red:

```
CAUGHT   read: serveSessionDetail loses its 404 for an unknown id
CAUGHT   read: serveSessionChat loses its cursor validation
CAUGHT   read: scanOverrides loses the SCAN_CAPS clamp
CAUGHT   read: serveSessionDetail loses its ID_RE check
CAUGHT   router: the chat route stops beating the detail route
CAUGHT   wait: serveQuestionWait loses the remote-answer gate
CAUGHT   wait: serveQuestionWait loses its res.on('close') cleanup
CAUGHT   wait: servePlanWait loses its res.on('close') cleanup
CAUGHT   wait: serveMessageWait loses its res.on('close') cleanup
CAUGHT   wait: servePlanWait loses its sessionExists check
CAUGHT   answer: the 'mismatch' arm collapses into the 404
CAUGHT   answer: plan-answer's 'mismatch' arm collapses into the 404
CAUGHT   answer: message-answer's 'mismatch' arm collapses into the 404
CAUGHT   answer: serveSessionAnswer loses its token gate
CAUGHT   toggle: the 409 for REMOTE_ANSWER=false becomes a silent success
CAUGHT   toggle: switching off stops releasing plan and message holds
CAUGHT   toggle: serveRemoteAnswerToggle loses its token gate
CAUGHT   management: serveManagementProject loses its 404 for an unknown dir
CAUGHT   management: serveManagementProject loses its ID_RE check
CAUGHT   management: serveManagementFile loses the servable-set 403
CAUGHT   analytics: serveAnalytics stops passing the report list through

ALL MUTATIONS CAUGHT
```

`server/api.ts` is byte-identical to its pre-mutation state afterwards (`git status`
shows it unmodified).

The refactored server was also booted for real and answered live requests:

```
$ SHOW_USAGE=false PORT=4787 tsx server/index.ts
  ⚡ Claude Sessions dashboard → http://localhost:4787
health HTTP 200
sessions HTTP 200
```

**Not verified, needs a human:** nothing here exercises a real `claude` CLI hook against
a live session — every wait is driven by a synthetic HTTP client, so the hook contract
itself (what the CLI does with a 403 vs a 404) is still only covered by the doc comments.
The dashboard UI was not opened against these routes either.
