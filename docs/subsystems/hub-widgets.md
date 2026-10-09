# Hub widgets

The dashboard serves two tiles to **Lookout**, the sibling hub app that polls any app answering its widget catalog contract v1 at `GET /api/hub/widgets` and
draws one tile per widget. The contract is defined in Lookout's own design spec, §5 (`../lookout/docs/superpowers/specs/2026-10-07-lookout-design.md` in the
sibling checkout). The dashboard does not hand-build it: [`lookout-widgets`](https://github.com/futin/lookout-widgets) derives every path, stamps `updatedAt`,
parses params and validates every reply with Lookout's own validator before it leaves the server. The design record is
[the producer spec](../superpowers/specs/2026-10-08-lookout-widgets-producer-design.md).

Code: `server/lib/hub-widgets.ts` (declarations), `serveHub` in `server/api.ts` (one request), the `/api/hub/` mount at the top of `createRequestListener` in
`server/index.ts`.

## Routes

| Route | Answer |
|---|---|
| `GET /api/hub/widgets` | the catalog: `app.name` "Claude Agents Dashboard", no icon, and the widgets below |
| `GET /api/hub/widgets/:id` | one widget's data; 404 `{ error: 'unknown widget <id>' }` for an id not in the catalog |
| `POST /api/hub/widgets/...` | action paths — always 404, since no widget declares an action |

A path under `/api/hub/` that the package does not own (`/api/hub/other`, a `PUT`) falls through to the ordinary route table exactly as before: the listener
re-enters itself once with the request marked. A POST body that is not JSON, empty, or over the 64 KiB cap reaches the package as `undefined`.

## The widgets

**`usage`** — gauge, "Claude usage", refreshed every 60 s (the usage cache's own age). Declared only when `SHOW_USAGE` is on, so with it off the catalog
holds `sessions` alone and `/api/hub/widgets/usage` is 404.

| Source (`getCachedUsageState()`) | Served |
|---|---|
| `fiveHour.utilization`, `fiveHour.resetsAt` | bar "5-hour", `resetsAt` only when non-null |
| `sevenDay.utilization`, `sevenDay.resetsAt` | bar "Weekly", `resetsAt` only when non-null |
| a window with `utilization: null` | no bar for it |
| `usage: null`, or any status but `ok` | 500 `{ error: 'usage <status>' }` |
| `ok` with both windows null | 500 `{ error: 'usage has no windows' }` |

**`sessions`** — list, "Sessions", refreshed every 10 s, tile `open: "/"`. One row per session from `scanSnapshot(config)`, the same scan `/api/sessions`
serves, so the two routes cannot disagree about a row's status; the row count is that scan's `MAX_SESSIONS` cap, and no `total` is sent.

| Session field | Row field |
|---|---|
| `id` | `id` |
| `sessionName ?? project` | `title` |
| `gitBranch`, `model`, `contextPct` | `subtitle`: `<branch> · <model> · ctx <rounded>%`, a null branch left out |
| `working` / `question` / `incomplete` / `idle` | `status`: `running` / `warn` / `error` / `idle` |
| `id` | `open`: `/?session=<encodeURIComponent(id)>`, the board's deep link |

## Why a usage failure is a 500, not a 0 % bar

A fabricated 0 % would read as real data — "you have used nothing" — which is the one wrong answer a usage tile can give. A 500 is a poller error to Lookout:
a tile that already has a good gauge keeps drawing it and turns **Stale** with its age once three intervals pass without a success; a tile that never had one
shows "No data yet" with "Claude Agents Dashboard answered 500". The reason stays readable to anyone curling the route.

## The dependency exception

`server/` is otherwise Node built-ins only. `lookout-widgets` is the one named exception (`.claude/CLAUDE.md`, "Keep new deps out of `server/`"): it has no
runtime dependencies of its own and is pinned to a git tag, `github:futin/lookout-widgets#v0.1.0`, with `dist/` committed so nothing builds at install.
`test/server-deps.test.ts` holds both ends: every bare import under `server/` must be exactly `lookout-widgets`, and `package.json` must carry that spec. The
package makes no network calls, so `test/outbound.test.ts` is unchanged.

## Adding a widget

1. Declare it in `createDashboardHub` (`server/lib/hub-widgets.ts`): an id, a title, a `render`, `refreshSeconds`, and a `load` that returns the render's
   shape — the package's README lists them. Feed it through an injectable getter, as `usage` and `sessions` are.
2. Add a mapping test to `test/hub-widgets.test.ts` with fixture getters.
3. The `checkWidgets` case at the top of that file already fetches the catalog and every widget through the handler and validates them against the contract.
   A widget with a required param needs a case there.

The package also supports actions (a POST route per declared action, with confirm and text input). None are declared here on purpose: the tiles only read
data the dashboard already exposes, and a write path through Lookout would need the token gate the dashboard's own writes carry.
