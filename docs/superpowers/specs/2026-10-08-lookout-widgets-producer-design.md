# Lookout widgets producer — design

Backlog: futin/claude-agents-dashboard#186 (idea) → the task it was promoted to. Contract source: `../lookout/docs/superpowers/specs/2026-10-07-lookout-design.md` §5
(widget catalog contract v1). Decisions below were settled with the user on 2026-10-08.

## 1. Why

Lookout shows tiles for any app that serves contract v1 at `GET /api/hub/widgets`. The dashboard serves nothing there, and backlog-manager and the other
sibling apps will want widgets too. Hand-building the catalog, data routes, `updatedAt` stamping, param parsing, relative-path rules, action routes and contract
tests per app means N drifting copies, each checked only by Lookout's prober after it has shipped. One package does the plumbing once and validates every reply
with Lookout's own validator before it leaves the app.

## 2. Decisions

| Question | Decision |
|---|---|
| Where the pipeline lives | A separate, **public** package, new repo `futin/lookout-widgets`. Public because the dashboard repo is public: a private git dependency would break every clean install of it. |
| What the package holds | The contract (`types.ts`, `paths.ts`, `validate.ts`, moved from `lookout/shared/contract/`, unchanged but for `.js` import suffixes; their jest tests are ported to `node:test` + `node:assert`, and the `lookout/shared/examples` fixtures they import move with them) plus the producer and the test kit. One source of truth for both sides of the wire. |
| How the dashboard server consumes it | `"lookout-widgets": "github:futin/lookout-widgets#v0.1.0"` in `dependencies`. `.claude/CLAUDE.md` §Code rules gains one named exception to "keep new deps out of `server/`": this package, which itself has zero runtime deps. A test pins it as the only non-builtin bare import under `server/`. |
| How it ships ESM and CJS | Committed `dist/esm` and `dist/cjs` (the latter with its own `{"type":"commonjs"}` `package.json`) behind an `exports` map with `types`. No install-time build: pnpm blocks dependency lifecycle scripts by default, and a git dep that needs `prepare` would need a TypeScript toolchain at install. A package test rebuilds and fails if `dist/` differs. |
| Who owns contract version bumps | The package. `contract: 2` is a new major of `lookout-widgets`; each app bumps its pinned tag. Lookout switching to import from the package is filed in Lookout's own backlog, not done here. |
| Actions | The pipeline supports them (declaration, derived paths, routing, reply validation, test-kit coverage). The dashboard declares **none**: its candidate actions (reply, pause) cross the spawn and permission surfaces and need their own security review. |
| `optionsFrom` / icon | `optionsFrom` yes — a param may declare an options loader and the pipeline derives and serves the path. Icon no — it is a static file the app already serves; the app passes its path as `app.icon`. |
| First dashboard widgets | `usage` (gauge) and `sessions` (list). The "waiting on input" status widget is left for later. |

## 3. Package `lookout-widgets`

Plain TypeScript, ESM source, Node ≥ 20 (the dashboard's Docker image is `node:20-alpine`), zero runtime dependencies, dev dependency `typescript` only. Relative imports
carry a `.js` suffix (Node ESM requires it; the CJS build resolves the same specifier), so the files moved from Lookout change only their import specifiers.
The producer imports nothing but `../contract/*`.

### 3.1 Declarations (`producer/declare`)

- `WidgetDecl` — `id`, `title`, `render` (`stat` | `gauge` | `list` | `status`), `refreshSeconds`, optional `open` (relative deep link), optional `params`,
  optional `actions`, and `load(params)` returning (sync or async) the render's data shape **without** `updatedAt`. Typed per render so a `gauge` widget's
  `load` must return `{ bars }`.
- `ParamDecl` — the contract's `Param` minus `optionsFrom`, plus optional `loadOptions()` returning `ParamOption[]` (sync or async). A param may carry static `options` or
  `loadOptions`, not both (build throws). A value for a `loadOptions` param is passed to `load` unchecked; `load` owns rejecting it.
- `ActionDecl` — `id`, `label`, optional `confirm`, optional `input`, and `run(input, rowId)` returning `{ ok, message? }` (sync or async). `rowId` is
  `undefined` for a widget-level action.
- In a `load` result, `actions` (widget level) and `rows[].actions` hold **action ids** (strings) naming the widget's `ActionDecl`s. The handler expands each
  id into a full contract `Action` with its derived path. An id that names no declared action is a load error (500), never silently dropped.
- Ids — widget, param, action — must match `^[a-z0-9][a-z0-9-]*$`. Row ids are free-form strings and are `encodeURIComponent`-ed into paths.

### 3.2 Build (`producer/build`)

Pure: `buildCatalog(app, decls)` → contract `Catalog` (`contract: 1`). Throws on a malformed id, a duplicate widget id, or a duplicate param or action id within one widget (a programming error, caught by the
app's own tests). Derived paths, all relative by construction:

| What | Path |
|---|---|
| Catalog | `/api/hub/widgets` |
| Data | `/api/hub/widgets/<widgetId>` |
| Param options | `/api/hub/widgets/<widgetId>/params/<paramId>/options` |
| Widget action | `/api/hub/widgets/<widgetId>/actions/<actionId>` |
| Row action | `/api/hub/widgets/<widgetId>/rows/<encodeURIComponent(rowId)>/actions/<actionId>` |

The row id lives in the path because the hub POSTs only `{ input }` to `action.path` (Lookout spec §5 Actions).

### 3.3 Handler (`producer/handler`)

`createHubHandler({ app, widgets, onDrop? })` → `handle({ method, path, query, body })` → `Promise<{ status, json } | null>`. `query` is a `URLSearchParams`;
`body` is the already-parsed JSON (or `undefined`). Framework-agnostic: the dashboard's `node:http` router, a NestJS controller and an Express route each mount
it with a few lines of glue.

- **Not owned** → `null`: any path outside `/api/hub/widgets` and its subtree, and any method other than GET (catalog, data, options) or POST (actions).
- **Catalog** — built once at handler creation, then run through `validateCatalog`. The validator's **normalised** catalog is what is served. A widget the
  validator drops is removed and reported through `onDrop({ widgetId, reason })` (default: `console.warn`); an invalid `app.icon` reaches `onDrop` too, with
  `widgetId: null`. An invalid catalog as a whole is a thrown error at creation, not a served 500.
- **Data** — unknown widget → 404 `{ error }`. Params: only declared ids are read; a missing non-optional param or a `choice` value outside its static
  options → 400 `{ error }`. Calls `load`, expands action ids, stamps `updatedAt` (ISO-8601, from an injectable clock), runs `validateData` and serves the
  validator's **normalised** output (so `percent` arrives clamped). `load` throwing → 500 `{ error }`; validation failing → 500 `{ error: reason }`.
- **Options** — unknown widget/param, or a param without `loadOptions` → 404; result served as `{ options }`, each entry checked to be `{ value, label }`
  non-empty strings (500 otherwise).
- **Actions** — unknown widget/action, or a row-id segment that fails `decodeURIComponent` → 404. `input` taken from `body.input` when it is a string. `run` throwing → 500; a reply that is not
  `{ ok: boolean, message?: string }` → 500; otherwise 200 with the reply. The handler does no authentication: the mounting app guards its own write routes.

### 3.4 Test kit (`testkit`)

`checkWidgets(handler, cases?)` → `Promise<string[]>` (failure messages, empty when all pass). It fetches the catalog, asserts it validates with nothing
dropped, then for every widget (and every case's params, when given) fetches data and asserts a 200 that passes `validateData`. A widget with a
non-optional param and no case is reported as a failure (`<widgetId>: param <paramId> needs a case`), never skipped and never guessed. Framework-agnostic, so jest
(Lookout, backlog-manager) and the dashboard's node-assert runner both use it as `assert.deepStrictEqual(await checkWidgets(h), [])`.

### 3.5 Packaging

`package.json`: `"type": "module"`, `exports` with `import` → `dist/esm/index.js`, `require` → `dist/cjs/index.js`, `types` → `dist/esm/index.d.ts`, plus a
`./testkit` subpath. Two `tsconfig` builds. Tests run with `node --test` against `dist/`, including one ESM and one CJS smoke import, and the dist-drift test.

## 4. Dashboard

- **`server/lib/hub-widgets.ts`** — the declarations and `createHubHandler` call. Data sources are injectable (a usage getter, a sessions getter) so tests use
  fixtures; production binds `getCachedUsageState()` and a new helper `scanSnapshot(config)` in `server/api.ts`. The helper is exactly
  `sweepTerminalDecisions()` followed by the `scanSessions` call with the injected pending/plan/message/permission/archive/stop stores, so the two routes cannot
  disagree about a row's status. `serveSessions` calls it in place of those lines; `adoptLaunched`/`listLaunching`, the usage attach and the error fallback
  stay in `serveSessions` only.
  - `usage` — gauge, title "Claude usage", `refreshSeconds: 60` (the usage cache's own age). Bars "5-hour" and "Weekly" from `fiveHour` / `sevenDay`
    `utilization` with `resetsAt` when non-null; a window with `utilization: null` is omitted. No bar to show — `usage: null`, any non-`ok` status, or both
    windows `null` under `ok` — → `load` throws `usage <status>` (or `usage has no windows`) → 500. Lookout treats a 500 as an `http` poller error: the
    tile goes **Stale**, keeping the last good gauge with its age, and a tile that never had one stays empty. That is deliberate: a fabricated 0 % bar would
    read as real data, and the reason is still visible to anyone curling the route. Declared only when `config.showUsage` is on.
  - `sessions` — list, title "Sessions", `refreshSeconds: 10`, `open: "/"`. One row per session from the same scan `/api/sessions` uses: `id` = session id,
    `title` = `sessionName ?? project`, `subtitle` = `<gitBranch> · <model> · ctx <round(contextPct)>%` (`gitBranch` part omitted when null), `status` from `working→running`, `question→warn`,
    `incomplete→error`, `idle→idle`, `open` = `/?session=<id>` (the existing deep link, `client/src/lib/deepLink.ts`). Row count is the scan's own `maxSessions` cap
    (`MAX_SESSIONS`, default 5) — the same rows the Sessions page shows — and no `total` is sent, since the scan reports none beyond what it returns.
- **`server/index.ts`** — before the existing routes: when the pathname starts with `/api/hub/`, parse the JSON body on POST, call the handler, send its reply;
  `null` falls through to the existing table. GET only reads data the dashboard already exposes; with no actions declared, no POST reaches `run`.
- **Network surface** — unchanged. The package makes no calls; `test/outbound.test.ts` is untouched.
- **Docs** — new `docs/subsystems/hub-widgets.md`, one line in `docs/overview.md` §Map, the endpoint list in `server/index.ts`'s header comment, and the
  CLAUDE.md exception.

## 5. Testing

Package: build (ids, duplicates, every derived path relative), handler (each status above, `updatedAt` stamping, clamped output, action-id expansion,
`null` for foreign paths), options, actions, test kit (reports a bad widget, empty for a good set), ESM + CJS smoke, dist drift. The contract tests, ported from jest
to `node:assert`, keep every case and pass.

Dashboard: `checkWidgets` over fixture usage + sessions returns `[]`; mapping cases (null window omitted, both windows null → 500, usage-off undeclared,
`usage: null` → 500, status map, no `total`, deep link) through injected getters; route tests through `test/api-harness.ts`, which runs `SHOW_USAGE=false` and
so exercises `sessions` only (catalog 200 without `usage`, `sessions` data 200, unknown widget 404, foreign `/api/...` path still served by its old route);
`/api/sessions` unchanged after the `scanSnapshot` extraction; the dependency pin.

## 6. Out of scope

Dashboard actions; the "waiting on input" status widget; switching Lookout and backlog-manager onto the package (each in its own repo's backlog); any change
to the contract itself.
