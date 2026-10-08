# Review 1 — Lookout widgets producer design

Document: `docs/superpowers/specs/2026-10-08-lookout-widgets-producer-design.md` (117 lines, untracked at review time).
Reviewer: Fable 5.1, fresh session, 2026-10-08. Checked against the dashboard at `b9052ea` and the Lookout sibling repo
(`../lookout/docs/superpowers/specs/2026-10-07-lookout-design.md` §5, `../lookout/shared/contract/*`).

## Verdict: REVISE

No Critical finding. Seven Important ones, two of which undercut decisions the spec records as settled: the `usage` widget's "throw so Lookout shows Bad data"
rationale rests on a misreading of Lookout's error classes, and the `sessions` widget's "20 rows, `total` = full count" has no data source in the scan it
says it reuses. The rest are edge cases and one self-contradiction about the ported tests.

## Important

### I1 — spec:93–94 — a 500 from `load` is an `http` error in Lookout, not Bad data

The spec: "`load` throws `usage <status>`, so the tile shows Bad data with a reason rather than an empty gauge." Lookout's poller classifies results as
`unreachable | timeout | bad-data | http` (lookout spec:251–253), and `http` drives the **Stale** treatment — "last value kept at full colour, 'stale'
badge with its age" (lookout spec:362–364). Bad data is reserved for a 200 that fails validation (lookout spec:366), and its copy is the fixed
"bad data from <app>" — the app's reason is not shown. So a 500 `{ error: 'usage token-expired' }` yields a Stale tile (or, with no last good value, an
empty one), and the reason string reaches nobody. The decision at spec:24/93 was taken on a false premise.

→ Either keep the 500 and rewrite the rationale honestly (Stale with the last good gauge, which is arguably the better UX for a token-expired blip), or
serve a valid gauge that carries the status some other way. Whichever, state what Lookout actually renders in each `UsageStatus` case.

### I2 — spec:97 — "At most 20 rows, `total` = full count" has no source in the scan being reused

`scanSessions` caps its own output at `config.maxSessions` (`server/lib/scan.ts:507`, default 5; `server/api.ts:80` caps the query override at 50) and
reports only `totals: { shown, active }` (`server/api.ts:167`), never an uncapped count. The spec binds the widget to "the same `scanSessions` call
`serveSessions` makes" (spec:90), which passes the base config — no `?limit=` override reaches the hub route. So with a default config the list holds at
most 5 rows, the 20-cap never bites, and `total` can only equal `rows.length`.

→ Say what `maxSessions` the hub scan runs with (base config, or a fixed override of 20 via `scanOverrides`), and define `total` as `totals.shown` or
drop it; add the "config.maxSessions > 20" case to the tests at spec:110 if the cap is kept.

### I3 — spec:90–91 — the "shared helper" must say whether it carries `serveSessions`'s side effects

`serveSessions` (`server/api.ts:127–175`) does three things besides the scan: `sweepTerminalDecisions()` before it (releases held waits), `adoptLaunched()`
after it (mutates spawn state), and `listLaunching()`. The spec's "extracted into one shared helper … so the two cannot disagree about a row's status"
is ambiguous about which of these the hub path inherits. Inheriting `sweepTerminalDecisions` is needed for status parity (the comment at
`server/api.ts:128–130` says a decided wait must not colour the row); inheriting `adoptLaunched` means a Lookout poll can retire a `launching` entry
that the dashboard's own client has not yet seen listed.

→ Name the helper's exact contents: scan + the six store injections + the sweep, and whether `adoptLaunched` stays in `serveSessions` only.

### I4 — spec:18 vs spec:85 — the ported contract tests are jest tests, not `node --test` tests, and import `../examples`

`lookout/shared/contract/validate.test.ts` uses jest globals (`describe`/`it`/`expect`, 143 occurrences) and imports `examples` from
`../examples` (`shared/examples/index.ts`, which itself imports `../contract/types`). `paths.test.ts` has 6 such calls. Spec:18 says they move
"unchanged but for `.js` import suffixes"; spec:85 says the package's tests "run with `node --test`". Both cannot hold: `expect` does not exist under
`node:test`, and `shared/examples` is outside `shared/contract/`.

→ Either move `shared/examples` into the package too and port the assertions to `node:assert` (say so), or add jest as a dev dependency (contradicts
spec:28 "dev dependency `typescript` only"). Pick one and amend both lines.

### I5 — spec:93 — both windows `utilization: null` → empty `bars` → validator 500, unstated

`RateLimit.utilization` is `number | null` for each window independently (`shared/types.ts:689–692`), and the usage cache reports `status: 'ok'`
whenever the fetch parsed (`server/lib/usage.ts:380`), so `usage` non-null with both windows null is reachable. The spec omits a null window, which
can leave `bars: []`; `validateData` then fails with "bars must hold at least one bar" (`lookout/shared/contract/validate.ts:244`) and the handler
serves 500 per spec:70. That is a third outcome the spec never names, and the test list at spec:110 does not cover it.

→ State it (throw `usage no-windows`, or fold into I1's redesign) and add the case to spec:110.

### I6 — spec:111 — route tests through the harness cannot exercise the `usage` widget as written

`test/api-harness.ts:27` runs every server with `SHOW_USAGE=false` so the scan stays off the usage cache; under spec:94 the `usage` widget is then
undeclared, and "data 200" can only mean `sessions`. Flipping the env body to `SHOW_USAGE=true` binds the production `getCachedUsageState()`
(spec:90), whose first call triggers `refreshNow()` → keychain read → `fetchUsage` (`server/lib/usage.ts:308–328`) — an outbound call from a test the
harness header promises makes none.

→ Say the harness route tests hit `sessions` only (and the catalog without `usage`), and that `usage` is covered by the injected-getter unit tests.

### I7 — spec:78–79 — `checkWidgets` with a widget that has a non-optional param and no case

The kit "for every widget (and every case's params, when given) fetches data and asserts a 200", while the handler returns 400 for "a missing
non-optional param" (spec:68). A widget with a required param and no supplied case therefore always fails, with no way to express "skip". The
dashboard's two widgets have no params so it does not bite today, but the kit is the package's public surface for backlog-manager and Lookout.

→ Define it: skip with a message, fail, or take the first static option. One sentence.

## Minor

- spec:28 — "Node ≥ 20" for the package, while the consuming dashboard declares `engines.node >= 18` (`package.json:28–30`). Not a failure
  (pnpm is not engine-strict by default), but say whether the dashboard's floor moves to 20 in the same change.
- spec:66–67 — `onDrop({ widgetId, reason })`: the validator also reports an invalid `app.icon` with `widgetId: null`
  (`lookout/shared/contract/validate.ts:146–147`). Say whether that reaches `onDrop` (it should — the dashboard passes `app.icon`, spec:23).
- spec:66 — the catalog is "run through `validateCatalog`" but the spec does not say the validator's *normalised* catalog (with `refreshSeconds`
  clamped 2–3600, `validate.ts:127`) is what gets served, as spec:70 does for data. Say so for symmetry.
- spec:96 — the field is `gitBranch`, not `branch` (`shared/types.ts:68`); and `ctx N%` from `contextPct` (a number) needs a rounding rule.
- spec:92 — bar labels "5-hour" / "Weekly"; the dashboard's own copy says "5-hour window" / "Weekly window" (`client/src/components/usage/UsageHistory.tsx:124–125`)
  and the type comments say "Current session" / "Current week" (`shared/types.ts:738–741`). Any is fine; pick one deliberately.
- spec:55/42 — row ids are `encodeURIComponent`-ed into paths; the handler must `decodeURIComponent` when routing, and a malformed escape throws
  `URIError`. Say 404 (or 400) for that.
- spec:37/68 — a `choice` param with `loadOptions` has no static options to check a value against; a param with both `options` and `loadOptions` is
  unspecified. One line each.
- spec:46 — duplicates are only forbidden for widget ids; duplicate param or action ids within a widget are unmentioned (they produce colliding paths).
- spec:65 — `HEAD /api/hub/widgets` → `null` → `serveStatic` (`server/index.ts:367`). Harmless, but the catalog is then "served" as `index.html` to a
  HEAD probe; note it or own HEAD.
- spec:20 — the Docker deps stage runs `pnpm install --frozen-lockfile` on `node:20-alpine` without `git` (`Dockerfile:2–6`). A frozen install of a
  `github:` dep resolves from the lockfile's codeload tarball and should not need git; worth one line in Verification since the image is cited as
  the Node floor's reason.
- spec:19 — "the only non-builtin bare import under `server/`" is true today (grep finds none), so the pin test starts green; fine.

## Verified true (no finding)

- Repo visibility PUBLIC (`gh repo view`), issue #186 open as `type:idea,in-progress`, Docker image `node:20-alpine`, pnpm 12.6.0 (blocks dependency
  lifecycle scripts by default), `CACHE_TTL_MS = 60_000` matches `refreshSeconds: 60`, `Session.status` enum and the four-way map, deep link
  `?session=<id>` accepted by `client/src/lib/deepLink.ts:15–19`, `/api/sessions` dispatch uses `startsWith('/api/sessions')` so `/api/hub/` cannot
  collide, `test/outbound.test.ts` scans `server/**/*.ts` only (node_modules untouched) and slices the CLAUDE.md rule up to `` `client/dist/` `` so an
  inserted exception sentence keeps it green, hub POST body `{ input }` and `{ ok, message? }` reply match lookout spec:198–200, contract types
  (`Param`, `ParamOption`, `Action`, `Row`, render shapes) match spec §3.1.
