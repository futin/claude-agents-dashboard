# UI verify — routines per machine

Date: 2026-11-09. Branch `feat/routines-per-machine` at `b32ecf6`. Verdict: **PASS**.

No mocks exist for this change (the plan cites none, by design: the spec's UI bullets in §The `machines:` key and §Default working directory are the
reference), so this checks geometry and the spec's copy, not placement against a drawing.

## Inventory

| View | Reference | How opened | Data | States |
|---|---|---|---|---|
| Routines · Jobs | spec §The `machines:` key | `stage()` from `test/visual/stage.ts`, section `routines` | `test/visual/fixtures/routines.ts` (6 jobs, every ledger state; dir now `~/.claude/routines/jobs`) | 1440 and 375, daylight |
| New job drawer | spec §The `machines:` key, §Default working directory | `New job` / `New` button | template from `client/src/lib/routines.ts` | default (All pinned) and Repos → One folder / Folder |

Harness: a scratch Playwright spec over the repo's own `stage()` and mock API (`vite build && vite preview` on 4373, started and stopped by Playwright's
`webServer`). Re-runnable; not committed.

## Geometry

| Width | Jobs page overflow | Drawer overflow |
|---|---|---|
| 1440 | none | none |
| 375 | none | none |

`pnpm test:visual` (full suite, after re-baselining the 13 Routines shots in `b32ecf6`): 206 passed, 2 failed — `sessions · daylight · 1280 · detail` and
`sessions · daylight · 375 · detail`. Both are stale on `main`: their baselines date from #350 (2026-10-30) and the chat drawer changed in #393
(2026-11-05); this branch touches no Sessions code. Not re-baselined here.

## Copy and presence

| Check | 1440 | 375 |
|---|---|---|
| Jobs subtitle `Jobs defined in <dir>, run by launchd on this machine. They belong to this machine only — nothing syncs.` | match | hidden on phone (pre-existing `!phone` gate) |
| No `sync through git`, no machine chips, no `<machines> only` pill in the ledger | match | match |
| Drawer has no Machines row (rows: Schedule, Repos, Script, Limits) | match | match |
| Repos → One folder hint ends `Empty = your home folder.` | match | match |
| Repos summary with no folder: `Your home folder` | match | match |
| Title keeps the `mac` chip (`.rtn-here`) — the spec's "say once which machine" | match | match |

## Screenshots

Scratchpad (not committed): `jobs-1440.jpg`, `jobs-375.jpg`, `drawer-1440.jpg`, `drawer-375.jpg`.
