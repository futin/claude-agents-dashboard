# Sessions page redesign (redesign branch)

Port of `docs/guides/mockups/redesign-mock.html` artboard `#sessions` to the client.
Behaviour and test cases only — no literal code. Decisions taken with the user on
2026-09-11: all five views ship in one pass; **Board** is the default view; below 1100px
the two aside cards move **above** the list.

## Shape

- Two columns on the `.wrap.broad` width: a main column and a **320px aside**.
  - **Aside · Account** card: the two rate-limit gauges (5h, Week) with their time
    strips — today's `UsageBar` / `TimeStrip`, restyled to the 10px track. The
    `token-expired` / `signed-out` line replaces the gauges as it does today.
  - **Aside · Board** card: clock, origin badge, facts (active sessions, need you, rows
    shown, claude processes), the remote-answers switch, and a full-width 36px
    **New session** button shown only when spawn is available.
  - Below 1100px the aside becomes a two-card row above the toolbar; below 700px the two
    cards stack.
- **Toolbar**, one row: a labelled **view switcher** (Board · List · Split · Tiles ·
  Triage) on the left; on the right one shared track holding a **filter button**
  (icon), a hairline, the label `Sort: <key> (asc|desc)`, and a **sort button** (icon).
  Both buttons open a popover (outside click and Escape close it; only one open at a
  time). The filter button is raised (white) only while a filter is active, and then
  carries a count badge.
  - Filter popover: Project (radio pills, "All projects" first, then `distinctProjects`),
    Status (multi-pick pills with the status dot; none picked = all), Active in the last
    (the existing `ACTIVITY_WINDOWS` as a pill switch), **Clear all** (disabled when
    nothing is set).
  - Sort popover: the four existing keys (Recency, Tokens, Name, Status) with a tick on
    the current one and a short hint each, then an Ascending / Descending switch.
- **Views** render the same filtered + sorted array; only the shape differs:
  - **Board**: three columns — *Needs you* / *Working* / *Quiet* — from `triageGroups`.
    Card per session; the open one shows the expanded body inline.
  - **List**: one table — dot · session (name, project · branch) · model · context
    (bar + %, tokens under) · activity · last · chat button. The open row expands
    underneath itself, full width.
  - **Split**: a 300px list of compact rows and an inspector for the selected session
    (title, meta pills, Context and Now tiles, then the expanded body). First row
    selected by default when nothing is; selection is not persisted.
  - **Tiles**: two- or three-column metric cards (percent 30/700 as the figure); the open
    tile spans two columns. Phantom launches are dashed drop-target tiles.
  - **Triage**: *Needs you* cards naming the hold and one action that opens the chat
    drawer, then compact *Working* and *Idle* lists. **Amended during implementation:**
    the question text lives in the pending store the drawer reads, not on `Session`, so
    the card shows the hold's sentence plus the tool call that raised it; and a
    display-only second button was dropped — a button that does nothing is worse than
    none.
- **Expanded body** (kaizen lesson, stop control, subagent timeline) is one component
  reused by Board / List / Tiles inline and by Split's inspector. Triage has no expanded
  body.
- **Phantom launches** render in every view, never interactive, dashed where the view
  has a card and a plain row where it has rows.
- **Empty and loading states** are one component every view renders in place of its body.

## Changes by boundary

### Client — model (`client/src/lib/filterSort.ts`, new `client/src/lib/triage.ts`)
- `View` gains `layout: Layout` where `Layout = 'board' | 'list' | 'split' | 'tiles' |
  'triage'`, default `'board'`. `LAYOUTS` lists them with labels in switcher order.
  Persisted with the rest of `dashboard.view`; a stored value with no `layout` gains the
  default through the shallow merge.
- `SORT_LABEL: Record<SortKey, string>` and `filterCount(view): number` (projects
  selected ? 1 : 0, statuses selected ? 1 : 0, window !== 'all' ? 1 : 0).
- `triageGroups(sessions)` → `{ needs, working, quiet }`, in input order: `needs` =
  `holdKind(s) !== null` **or** `status === 'question'`; `working` = the rest with
  `status === 'working'`; `quiet` = everything else (`idle`, `incomplete`). A session
  appears in exactly one group.
- `chatTab(s)` and `HOLD_TABS` move out of `SessionRow` into `lib/holds.ts` so five views
  read one table.

### Client — components (`client/src/components/`)
- `SessionsView` owns: `view` (persisted), `expandedIds` (not persisted), `splitId`
  (not persisted), `chatId`, `spawnOpen`, the health poll. Renders aside + toolbar + the
  view named by `view.layout`.
- New `sessions/` folder: `atoms.tsx` (dot, status pill, tags, context figures, bar,
  activity line, chat button), `Expanded.tsx`, `EmptyState.tsx`, `BoardView.tsx`,
  `ListView.tsx`, `SplitView.tsx`, `TilesView.tsx`, `TriageView.tsx`.
- `Toolbar.tsx` rewritten around a `Popover.tsx` primitive (the outside-click / Escape
  handling `MultiSelect` had). `MultiSelect.tsx`, `Header.tsx`, `SessionList.tsx`,
  `SessionRow.tsx` are deleted; `AsideAccount.tsx` and `AsideBoard.tsx` take over the
  plate's contents. `SessionDetail.tsx`, `OriginBadge.tsx`, `RemoteAnswerToggle.tsx`
  stay.
- `App.tsx`: the sessions section uses `wrap broad`.

### Client — styles (`client/src/styles.css`)
- Plate, toolbar, `.rows` / `.row` / `.row-chat` blocks replaced. Cards follow §8.2: `--strip`,
  16px radius, no stroke, no shadow. Pills (`.proj-pill`, `.branch`, `.ag-pill`), `.tok`,
  `.pct`, `.detail` / `.agents` / `.tl-*`, `.usage` are restyled in place, since the chat
  drawer shares the first group. Tokens only — no literal colour or shadow.
- Motion as today: working dot ring, launching dot ring, needs-you button and triage
  accent fade, running timeline bar fade; all off under `prefers-reduced-motion`.
- The segmented track on the app ground uses `--hairline2`, not `--strip-hi` (two points
  off the ground on Daylight — the scope-pill lesson from §8.2).

### Docs
- `docs/subsystems/sessions.md`: the row section becomes "Views"; the toolbar section
  describes the switcher and the two popovers; the phantom-row section names how each
  view draws one.
- `docs/subsystems/view-persistence.md`: `layout` joins the `View` fields; `splitId`
  joins the not-persisted list.
- `.claude/DESIGN.md` §8.3: the Sessions page — aside, toolbar, the ground-track rule.

## Test cases (`test/filter-sort.test.ts`, new `test/triage.test.ts`)
- `DEFAULT_VIEW.layout === 'board'`; `LAYOUTS` has five entries in the order board, list,
  split, tiles, triage; every `Layout` value has a label.
- `filterCount`: default view → 0; one project → 1; one project + one status → 2;
  window `'1h'` alone → 1; all three → 3; two statuses still count 1.
- `SORT_LABEL` covers every `SortKey` (exhaustive over the union).
- `triageGroups`: a `remoteQuestion` idle session lands in `needs`; a `permissionWait`
  working session lands in `needs`, not `working`; a `status: 'question'` session with no
  hold lands in `needs`; a plain working one in `working`; `idle` and `incomplete` in
  `quiet`; input order is preserved within each group; the three groups partition the
  input (sizes sum to the input length, no id twice); empty input → three empty arrays.
- `chatTab` (moved): `remoteQuestion` → `answer`/answer tone; `permissionWait` → `allow?`
  /permission tone; nothing → `chat`/no tone; question outranks permission when both set.
- Existing 27 `filterSort` cases stay green unchanged.

## Not verified by tests (needs a human)
- Layout at widths between 700px and 1100px, and on a phone.
- The four dark themes: contrast of the raised filter button and the popovers.
- Keyboard focus order inside the popovers.
