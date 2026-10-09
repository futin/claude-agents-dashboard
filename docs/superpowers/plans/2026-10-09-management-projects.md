# Management › Projects — implementation plan

**Spec:** the mock, `docs/guides/mockups/redesign-mock.html` — header comment (lines ~39-52), the `.pj-*` / `.pin-*` CSS block (~1425-1463), the
rail sub-nav markup (~1888-1896) and the `/* ── Projects: PinPicker on the ground, as tiles ── */` script block (~4016-4120). Where this plan and the
mock disagree, the mock wins unless a ruling below says otherwise.

**Goal:** Management's second sub-view is renamed **Pinned → Projects**, moves first on the rail (Projects | Git), and is redrawn from the mock: a
`Management · Projects` band, a toolbar with Tiles | Columns | Lists pills and a filter box, over the Pinned and Not-pinned groups drawn in the chosen
layout. The launch sheet's `PinPicker` is untouched.

## Global constraints

- Read `docs/overview.md` §Map and `docs/subsystems/git-stats.md` + `docs/subsystems/settings.md` + `docs/subsystems/breakpoints.md` before editing.
- ESM; client imports from `shared/` are `import type`. No new deps.
- **No hardcoded color or shadow in `client/src/styles.css`** below the theme-token block. Mock token → live token: `--bg-surface`→`--strip`,
  `--bg-subtle`→`--strip-hi`, `--border`→`--hairline`, `--border-strong`→`--hairline2`, `--text-primary/secondary/tertiary`→`--ink/--ink2/--ink3`,
  `--amber`→`--amber`, `--red-500`→`--red`, `--lift-card`→whatever the live `.git-card` / `.set-group` uses (copy it, do not invent one),
  radii `--r-lg`→`16px`, `--r-md`→`12px`, `--r-full`→`999px`.
- Mobile-first on the breakpoint ladder only (`sm` 640, `md` 768, `lg` 1024, `xl` 1280…). No other `@media` widths.
- Keep existing CSS class names stable; new classes use the mock's names (`.pj-*`, `.pin-filter`, `.pin-note`).
- Copy is exact (strings below, verbatim).
- `pnpm typecheck` and `pnpm test` green before every commit; commit messages Conventional Commits.
- Figures measured off this machine's data carry their date inline (unlikely to apply here).

## Rulings baked into this plan

1. Default `managementTab` stays `'git'` — the mock calls Git "the live tab" and says nothing about a default. Cost if wrong: one-line default change.
2. Stored `managementTab: 'pinned'` (older builds) is read as `'projects'` by `clampSettings` — a per-device setting must not silently snap back to Git
   after an upgrade.
3. Columns/Lists go two-up from `lg` (1024), single column below — the mock's 900px is off-ladder; at `md` the rail leaves ~240px a column.
4. Enter in the filter still pins the first offered match (parity with `PinPicker`); the mock is silent.
5. A refused pin/unpin shows its reason inline under that project, `.pin-sub.err` — kept from `PinPicker`; the mock fixture never refuses.

---

### Task 1: Rename the sub-tab Pinned → Projects

**Files:** `client/src/lib/settings.ts`, `client/src/components/SideRail.tsx`, `client/src/components/management/ManagementView.tsx`,
`client/src/components/management/GitView.tsx`, `client/src/lib/gitStatsText.ts`, `client/src/components/SpawnPanel.tsx`,
`client/src/hooks/usePins.ts`, `client/src/hooks/useGitStats.ts` (comment only), `test/client-settings.test.ts`, `test/git-stats-client.test.ts`.

- `ManagementTab = 'git' | 'projects'`; `MANAGEMENT_TABS = ['git', 'projects']`; `clampSettings` maps a stored `'pinned'` to `'projects'` (Ruling 2);
  default stays `'git'`.
- `SideRail` `SUBNAV.management.items` = `[{ value: 'projects', label: 'Projects' }, { value: 'git', label: 'Git' }]` (Projects first). Update the two
  doc comments that say `Git | Pinned` / `Git / Pinned` to `Projects | Git` / `Projects / Git`.
- `ManagementView`: branch on `'projects'`; band title `Management · Projects` (Task 3 replaces the body — for this task keep rendering the existing
  `PinnedProjectsGroup` under the renamed band so the app stays working). Doc comment says **Projects** and **Git**.
- Copy, verbatim:
  - `GIT_NO_PINS = 'No pinned projects yet. Pin one under Projects.'`; `GitView`'s link splits on `'Projects'` and sets `managementTab: 'projects'`,
    link text `Projects`.
  - `gitStateSentence` missing: `'Folder is gone. Unpin it under Projects.'` / `` `Folder is gone — ${r.path}. Unpin it under Projects.` ``
  - `SpawnPanel`: `Unpin it under Management › Projects.`
- Comments mentioning "Management › Pinned" / "switching to Pinned" in the files above say Projects.
- Tests: `client-settings.test.ts` — `clampSettings({ managementTab: 'projects' })` → `'projects'`, `{ managementTab: 'pinned' }` → `'projects'`,
  nonsense → `'git'`. `git-stats-client.test.ts` — the three copy asserts above updated.

### Task 2: Projects layout + grouping logic (pure, tested)

**Files:** create `client/src/lib/projectsView.ts`, create `test/projects-view.test.ts`, register it in `test/run-all.ts` (same pattern as the others),
`client/src/hooks/useSettings.tsx` (`OWNED_KEYS`).

- `export type ProjectsLayout = 'tiles' | 'columns' | 'lists'`;
  `PROJECTS_LAYOUTS = [{key:'tiles',label:'Tiles'},{key:'columns',label:'Columns'},{key:'lists',label:'Lists'}]`;
  `DEFAULT_PROJECTS_LAYOUT = 'tiles'`; `isProjectsLayout(v: unknown)`. Persisted per device under **`management.projectsLayout`** — add it to
  `OWNED_KEYS` next to `management.gitLayout` so Reset sweeps it. All three layouts are offered at every width (CSS stacks the columns).
- `splitProjects(pins: PinsResponse, query: string)` → `{ pinned: PinRow[]; offers: ProjectRef[]; pinnedShown: PinRow[]; offersShown: ProjectRef[] }`:
  `offers = [...recent, ...older]`; the `*Shown` lists filter with the existing `matchesPinFilter` from `lib/pins.ts`.
- `projectDir(path: string, home: string): string` → the `~`-shortened parent with a trailing `/` (`/Users/u/Projects/x` with home `/Users/u` →
  `~/Projects/`); reuse `shortenHome` + `splitPath`.
- Copy constants, verbatim:
  - `PROJECTS_BAND_SUB = 'Every project with a session in the last 30 days. Pin one to keep it in the launch sheet whatever the lookback; pins are stored by the dashboard server, so they show up on every device.'`
  - `PROJECTS_MISSING = 'Folder no longer exists. Hidden from every list until unpinned.'`
  - `noPinsText(total)` → `total === 0 ? 'No projects are pinned.' : 'No pinned project matches.'`
  - `noOffersText(total)` → `total === 0 ? 'Every project active in the last 30 days is already pinned.' : 'No project matches.'`
  - `LIST_SUB_OFFERS = 'a session in the last 30 days, gone from the launch sheet once it ages out'`
  - `LIST_SUB_PINNED = 'kept in the launch sheet whatever the lookback'`
- Tests: `isProjectsLayout` true for the three, false for `'cards'`/`undefined`; `splitProjects` concatenates recent+older in order and filters both
  groups by one query while the totals stay unfiltered; `projectDir` examples incl. a path outside home; the two note functions; `OWNED_KEYS` includes
  `management.projectsLayout`.

### Task 3: ProjectsView component + CSS

**Files:** create `client/src/components/management/ProjectsView.tsx`, delete `client/src/components/management/PinnedProjectsGroup.tsx`,
`ManagementView.tsx`, `client/src/styles.css`.

Structure (mock `renderPinned` + `tiles`/`columns`/`lists`):

- Root `<div className="usage-section pj-view">` (same outer as `GitView`, so band/toolbar spacing match Git). `SettingsBand scope="shared"
  title="Management · Projects" sub={PROJECTS_BAND_SUB}`.
- `usePins()`; while `pins === null` → `<div className="git-empty">Loading…</div>`.
- Toolbar `<div className="git-toolbar pj-toolbar">`: the `.seg` pills exactly like GitView's switcher (`role="tablist"`, `aria-label="Layout"`,
  `role="tab"`, `aria-selected`, `.on`) over `PROJECTS_LAYOUTS`, stored with `usePersistedState('management.projectsLayout', DEFAULT_PROJECTS_LAYOUT)`
  and read back through `isProjectsLayout`; then `<input className="pin-filter" type="text" placeholder="Filter by name or path"
  aria-label="Filter projects">`. Enter pins the first of `offersShown` and clears the filter (Ruling 4).
- Group head: `<div className="pin-group">{title}<span className="pin-count">{total}</span></div>`; titles `Pinned` / `Not pinned`; total is the
  unfiltered count.
- **Tiles**: Pinned group then Not-pinned group, each a `<ul className="pj-tiles">` of `<li className="pj-tile">` (`off` for an offer, `gone` for a
  pin with `listed === false`): `<span className="pj-id">` holding `.pj-name` (the `name`), `.pj-dir` (`projectDir`, omitted when `path === null`),
  the missing line `<span className="pin-sub">{PROJECTS_MISSING}</span>` for a dead pin, an error line `<span className="pin-sub err">` for a refusal;
  then `<span className="pj-tfoot">` with `<span className="pj-age">` = `Last session ${formatAgo(ms)} ago` or `No sessions` when
  `lastActiveMs === null`, and the button. Empty group → `<div className="pin-note">` with `noPinsText`/`noOffersText`.
- **Columns**: `<div className="pj-cols">` with two `<section>`s — **Not pinned on the left, Pinned on the right** — same tiles, same group heads.
- **Lists**: `<div className="pj-cols">` of two `SettingsGroup` cards (Not pinned left, Pinned right; add `className="pj-listcard"` support to
  `SettingsGroup` if needed): title `Not pinned` / `Pinned`, sub `` `${shown} of ${total} · ${LIST_SUB_OFFERS}` `` /
  `` `… · ${LIST_SUB_PINNED}` ``; each project one row (`SettingsRow`, extended with an optional `className` so it can carry `pj-srw` / `gone`):
  name = `name`, hint = dir + missing/error lines, control = `.pj-age` (`${formatAgo(ms)} ago` or `No sessions`) + the button. Empty → the `.pin-note`.
- Button: `<button type="button" className="qp-term">` (the live secondary button `PinPicker` uses) — label `Pin` / `Unpin`, or `Pinning…` /
  `Unpinning…` on the project in flight; every button disabled while any request is in flight. A click never moves a row by hand — `usePins`
  answers with the fresh payload.
- `ManagementView` renders `<ProjectsView />` for `'projects'`; delete `PinnedProjectsGroup.tsx` (nothing else imports it — verify).
- CSS (port of mock lines ~1425-1463 into `styles.css` next to the existing `.pin-*` rules, tokens per Global constraints):
  `.pj-toolbar .pin-filter` flex:1, min-width 200px, height 38px; `.pin-filter` base (36px, padding 0 12px, 13px, `--hairline2` border, 12px radius,
  `--strip` ground, focus border `--ink3`); `.pin-note`; `.pj-id/.pj-name/.pj-dir/.pj-age`; `.pj-tiles` grid `repeat(auto-fill,minmax(240px,1fr))`
  gap 12px; `.pj-tile` (+`.off` dashed transparent, `.gone` amber border); `.pj-tfoot`; `.pj-cols` single column gap 8px at base, **two columns gap
  24px from `lg` (1024)** (Ruling 3); `.pj-cols .pj-tiles` one column; `.pj-cols .pj-tile` row layout; Lists row rules (`.pj-srw`). The `.qp-term`
  inside tiles/rows is 32px tall. `.pj-listcard` cards inside `.pj-cols` must not inherit Settings' two-column grid.
- Verify in the browser (`preview_start`, dev server): all three layouts, the filter, a pin and an unpin, light + dark theme, 375px and ≥1280px.

### Task 4: Docs

**Files:** `docs/overview.md`, `docs/subsystems/settings.md`, `docs/subsystems/view-persistence.md`, `docs/subsystems/git-stats.md`,
`docs/workflows/configuration.md`, `docs/subsystems/configs.md`, `docs/subsystems/sessions.md` — wherever they say Management › Pinned / `'pinned'`.

- Rename to Projects; describe the Tiles | Columns | Lists switcher and the filter; document `management.projectsLayout` (per device, OWNED_KEYS,
  default `tiles`) in view-persistence; document the `'pinned'` → `'projects'` read in settings; `overview.md` §Map lists `ProjectsView.tsx` and
  `lib/projectsView.ts`, drops `PinnedProjectsGroup.tsx`.
- No new doc files.
