# Review 2 — Lookout widgets producer design

Document: `docs/superpowers/specs/2026-10-08-lookout-widgets-producer-design.md` (126 lines, at `5429049`).
Reviewer: Fable 5.1, fresh session, 2026-10-08. Checked against the dashboard at `5429049` and the Lookout sibling repo
(`../lookout/docs/superpowers/specs/2026-10-07-lookout-design.md` §5/§6/§10, `../lookout/shared/contract/*`, `../lookout/shared/examples/`).
Previous round: `2026-10-08-lookout-widgets-producer-design-review-1.md`.

## Verdict: APPROVE WITH FIXES

All seven round-1 Important findings are resolved in the text (I1 Stale rationale rewritten, I2 row cap bound to `maxSessions`, I3 helper contents
named, I4 tests ported with the examples, I5 both-null → 500, I6 harness hits `sessions` only, I7 missing case reported). Five new Important
findings, none Critical and none undercutting a recorded decision: one "move" that would break Lookout, one packaging gap (TypeScript tests under
`node --test` on Node 20), two unspecified call shapes, and one description of Lookout's rendering that does not match Lookout's spec.

## Important

### I1 — spec:18 vs spec:21 — "moved from `lookout/shared/contract/`" would break Lookout, which the spec says is not switched here

Spec:18 says the contract files are "moved from `lookout/shared/contract/`" and "the `lookout/shared/examples` fixtures they import move with them".
Spec:21 says "Lookout switching to import from the package is filed in Lookout's own backlog, not done here". In Lookout, `shared/contract/*` is
imported by 40 files (`server/src/prober/classify.ts`, `server/src/poller/poller.service.ts`, `client/src/tiles/*.tsx`, `shared/api.ts`, …) and
`shared/examples` by 10 (`test/fixture-app/fixture-app.ts`, `server/src/prober/prober.service.test.ts`, …; `shared/examples/index.ts:3` says the
fixture app serves them). A literal move deletes Lookout's only copy before Lookout has a dependency on the package.

→ Say **copied**: the package starts from a copy of Lookout's three contract files and `shared/examples/index.ts`; Lookout's own copies stay
untouched until its backlog item replaces them. One word on spec:18, and the "one source of truth" sentence becomes "will be, once Lookout switches".

### I2 — spec:28 / spec:88 — TypeScript tests cannot run under `node --test` on Node 20 with `typescript` as the only dev dependency

Spec:28: "Node ≥ 20 … dev dependency `typescript` only". Spec:88: "Tests run with `node --test` against `dist/`". Spec:116: the contract tests
are ported "from jest to `node:assert`", i.e. they stay TypeScript source (they import `../examples` and `./validate` as the originals do,
`validate.test.ts:1–3`). Node 20 has no type stripping (`--experimental-strip-types` arrived in 22.6, default in 23.6), so `node --test` cannot
execute a `.test.ts` file; `tsx` is not in the dependency list; and the two `tsconfig` builds at spec:88 are the ESM and CJS *shipping* builds.

→ Say how test files reach Node: a third `tsconfig.test.json` that compiles `src/**/*.test.ts` to an untracked `build-test/` beside `dist/`, or
tests written as `.test.js` importing `dist/esm`, or `tsx` as a second dev dependency (then amend spec:28). Any one line resolves it.

### I3 — spec:62 vs spec:71 — the "injectable clock" has no injection point

Spec:62 gives the full option bag: `createHubHandler({ app, widgets, onDrop? })`. Spec:71 stamps `updatedAt` "from an injectable clock", and
spec:114 tests "`updatedAt` stamping". Nothing says where the clock is injected or its shape, so an implementer must either widen the signature
on their own or make the clock a module global.

→ Add `now?: () => Date` (or `clock?`) to the option bag at spec:62, default `() => new Date()`.

### I4 — spec:80 — `checkWidgets(handler, cases?)`: the shape of `cases` is unspecified

The kit is the package's public surface for three repos (spec:83). "Every case's params, when given" and "a widget with a non-optional param and no
case" (spec:82) imply a case binds a widget id to a params map, but whether it is `{ widgetId, params }[]`, `Record<widgetId, Record<paramId,
string>[]>`, or something else is left to the implementer, as is whether a widget with a case is *also* fetched without params, and whether the
failure message carries the case's params.

→ One sentence: e.g. `cases: { widget: string; params: Record<string, string> }[]`; a widget with ≥ 1 case is fetched once per case and not
without params; a widget with no case is fetched without params.

### I5 — spec:99–101 — what Lookout renders on a 500 is misdescribed

The spec: "the tile goes **Stale**, keeping the last good gauge with its age, and a tile that never had one stays empty". Lookout's spec:
Stale is "no successful fetch for more than 3 × the interval … 'stale' badge with its age" (lookout spec:362–364; §10 row "Data fetch fails, last
value exists → Last value kept, stale badge once over 3 × interval", lookout spec:427). So for the first three minutes of 500s the tile is simply
**Fresh** with the last gauge; the badge comes after. And a tile with no last value is not empty: it shows "No data yet" plus the reason
"<app> answered <status>" (lookout spec:358–360), so the 500 *is* visible on the tile, which makes the "reason is still visible to anyone curling
the route" clause unnecessary rather than wrong.

→ Rewrite the two sentences: last good gauge kept at full colour, "stale" badge after 3 × 60 s; never had one → "No data yet · Claude Agents
Dashboard answered 500". The decision (throw, don't fabricate a bar) stands.

## Minor

- spec:41 — "`actions` (widget level)" in a load result: the `list` render has no widget-level `actions` (`lookout/shared/contract/types.ts:93–97`;
  lookout spec:192–193 names `stat`, `gauge`, `status` only). Spec:34's "typed per render" covers it; one parenthesis saves a question.
- spec:66 — a POST to the catalog, data or options path is inside the subtree with an owned method; say `null` (falls through to static) or 404.
  Still open from round 1: HEAD `/api/hub/widgets` → `null` → `serveStatic` (`server/index.ts:367`).
- spec:106 — "parse the JSON body on POST": `readJsonBody` returns `null` on a body that does not parse (`server/api.ts:336–340`) and every existing
  caller answers 400. Say 400 (the spec's `body` is "already-parsed JSON or `undefined`", spec:63, so `null` must not reach the handler).
- spec:97 — `getCachedUsageState()` returns `status: 'unavailable'` on its very first call and only then starts the fetch (`server/lib/usage.ts:435–442`).
  After a dashboard restart, Lookout's first poll is a 500 ("No data yet") for up to one interval. Consistent with the rule at spec:99; worth one line.
- spec:37 / spec:70 — a `choice` param with neither `options` nor `loadOptions` (the validator allows it, `validate.ts:101–110`): build throws, or the
  value passes unchecked like a `text` param? One clause.
- spec:92–93 — where the handler instance lives: if `hub-widgets.ts` imports `scanSnapshot` from `server/api.ts`, that is a `lib/` → `api.ts` import
  (the reverse of every existing edge). Say the bindings and `createHubHandler` call happen in `api.ts` (or `index.ts`) and `hub-widgets.ts` exports
  only the declaration factory that takes the getters.
- spec:34 — `load(params)`: `params` is presumably `Record<string, string>` (query strings); say so, since `ParamDecl` values are strings by contract.
- spec:3 — "#186 (idea) → the task it was promoted to": #186 is still `type:idea,in-progress` (`gh issue view 186`); fill in the task number once groomed.
- spec:28 — still open from round 1: package floor Node ≥ 20 while the dashboard declares `engines.node >= 18` (`package.json:28–30`). Say whether the
  dashboard's floor moves.
- spec:20 — still open from round 1: the Docker deps stage runs `pnpm install --frozen-lockfile` on `node:20-alpine` without `git` (`Dockerfile:2–6`);
  one Verification line that the lockfile's codeload tarball resolves without git.

## Verified true (no finding)

- Round-1 resolutions hold against the code: `sweepTerminalDecisions()` + `scanSessions` with the six injected stores is exactly `server/api.ts:131–157`;
  `adoptLaunched`/`listLaunching`/usage attach/error fallback are `server/api.ts:140–180` and stay out of the helper; `maxSessions` default 5
  (`server/lib/config.ts:124`, `server/lib/scan.ts:507,552`); no uncapped total exists.
- `RateLimit.utilization` is 0–100 percent (`shared/types.ts:689–691`), so it maps to `percent` unscaled; `resetsAt` ISO or null (`:693`);
  `UsageStatus` is `ok | token-expired | signed-out | unavailable` (`:745`); `CACHE_TTL_MS = 60_000` (`server/lib/usage.ts:44`).
- `Session` fields `sessionName: string | null`, `gitBranch: string | null`, `model`, `contextPct: number`, `status` four-way enum
  (`shared/types.ts:56–74`); deep link `?session=<id>` accepts hex UUIDs (`client/src/lib/deepLink.ts:15–19`).
- `validateCatalog` returns the normalised catalog plus `dropped` with `widgetId: null` for a bad icon (`validate.ts:20–21,145–148,164`);
  `validateData` clamps `percent` and rejects empty `bars` (`validate.ts:221,244`); `refreshSeconds` clamped 2–3600 (`validate.ts:127`).
- Lookout hub POSTs `{ input }` and expects `{ ok, message? }` (lookout spec:197–200); `http` is a Stale kind, not Bad data (lookout spec:251–253).
- `test/api-harness.ts` runs `SHOW_USAGE=false` and `SKIP_PROC_SCAN=true` (`test/api-harness.ts:27–29`); `/api/sessions` dispatch is `startsWith`
  (`server/index.ts:361`) so `/api/hub/` cannot collide; no auth layer sits above the route table for a hub prefix to bypass.
- `test/outbound.test.ts:115–118` slices the CLAUDE.md rule from "Keep new deps out of" to `` `client/dist/` `` and only asserts `lib/git-fetch.ts`,
  so an inserted exception sentence keeps it green. No bare non-builtin import exists under `server/` today.
- Dashboard `moduleResolution: Bundler` (`tsconfig.json:5`) reads the `import` + `types` conditions of the proposed `exports` map; Lookout is NestJS
  on jest (`lookout/package.json`), backlog-manager runs jest (`backlog-manager/package.json:16,54`), so spec:83's "jest (Lookout, backlog-manager)"
  is right.
- Relative-import claim at spec:29: a `./paths.js` specifier resolves inside `dist/cjs` as it does inside `dist/esm`.
