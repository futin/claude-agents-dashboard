# Pinned project reordering — design

Decisions settled with the user on 2026-10-09. Mockups: [`2026-10-09-pin-reorder-mockups.html`](2026-10-09-pin-reorder-mockups.html) (variant A was picked;
B, C and the YAGNI'd D are kept there for the record).

## 1. Why

The stored pin list (`settings.ts` `pinnedProjects`) is ordered by when each project was pinned, and that order is load-bearing: Management › Pinned lists the
pins in it, and Management › Git draws its repos in it (Cards, Table, and inside each Triage group — `docs/subsystems/git-stats.md`), as does the Lookout git-pending tile inside each of its groups. The only way to change it
today is to unpin and re-pin every project that should come after. The user wants to put the repos they look at most at the top.

## 2. Decisions

| Question | Decision |
|---|---|
| Interaction | **Variant A: an always-on drag grip** (`⠿`) leading every pinned row in Management › Pinned. Mouse and touch drag; keyboard ↑/↓ on a focused grip. Saves on drop / on each key press. |
| Rejected interactions | B (↑/↓ buttons per row): long moves are many clicks and many saves. C (a Reorder mode with Done/Cancel): an extra state for little gain at ≤ 50 rows. D (sort select + draggable Git cards): two writers of one order, and a sort mode that can silently override the manual one. |
| What follows the order | Only the three surfaces that already do, with no code change to any of them: Management › Pinned, Management › Git, and the Lookout git-pending tile (`gitPendingRows` keeps pin order inside each of its pull / push / unreadable groups, `server/lib/hub-widgets.ts`). The sessions rail, the Claude Configs sidebar and the launch sheet keep sorting by last activity. |
| Where reordering is offered | Management › Pinned only. The launch sheet's picker has no pinned group and gets no grips. |
| Write shape | One new route, `POST /api/pins/order`, carrying the **whole** new order — not a "move X to index i" delta. |
| Stale writes | The server accepts the order only when it is an exact permutation of the stored pins. Anything else is a 409, so a tab that missed a pin or an unpin elsewhere can neither drop nor resurrect a pin by reordering. |
| Drag library | None. Hand-rolled pointer events. The root `package.json` (no `client/package.json` exists) carries no drag-and-drop dependency and this adds none. |

## 3. Server

### 3.1 `settings.ts` — `setPinOrder`

New export beside `setPinned`: `setPinOrder(order: unknown): string[] | null`.

- Returns the stored list (a copy) after replacing it with `order`, and persists through the existing `persist`.
- Returns `null`, storing nothing, unless `order` is an array of strings that is an exact permutation of the current `pinnedProjects`: same length, every
  element stored, no duplicates. Membership is string equality against the stored list; nothing is joined into a path.
- An `order` identical to the stored one succeeds and still returns the list (a no-op write is not an error; whether it re-persists is the implementer's call).
- An empty stored list and an empty `order` succeed.
- Runs `readStored()` first when `cached` is null, like every other accessor.

No change to `clampPinned`, `MAX_PINNED_PROJECTS` or `setPinned`: a new pin still appends at the end.

### 3.2 Route — `POST /api/pins/order`

- Wired in `server/index.ts` beside `/api/pins`. POST only; any other method answers the existing `methodNotAllowed`.
- Handler `servePinsOrder` in `server/api.ts` beside `servePinsWrite`, with the same gates in the same order:
  1. `tokenOk` fails → 403 `{error: 'bad token'}`.
  2. Body is not `{order: string[]}` → `sendBadBody` with `{error: 'expected {order: string[]}'}`.
  3. `setPinOrder` returns null → 409 `{error: 'pins changed — reload'}`.
  4. Success → 200 with the fresh `pinsPayload(config)`, the same body `GET /api/pins` answers.
- No membership check against the enumerated projects (unlike pinning): a permutation of the stored list cannot add a dir, which is the property the pin gate
  exists to protect.
- `shared/types.ts`: no new type. The request body is small enough to type inline in the handler and the hook, as `servePinsWrite` does today; the reply is
  `PinsResponse`.

## 4. Client

### 4.1 `lib/pins.ts` — `movePin`

Pure helper: `movePin(order: readonly string[], name: string, toIndex: number): string[]`.

- Returns a new array with `name` removed from its index and inserted at `toIndex`, where `toIndex` is the position it occupies in the **result**.
- `name` not in `order` → returns `order` itself (same reference), so a caller can skip a write by reference comparison — the convention `pruneProjects` and
  `clearFilters` already follow. Checked first, before clamping.
- `toIndex` is then clamped to `[0, order.length - 1]`.
- Clamped index equal to the current index → returns `order` itself, same reason.

### 4.2 `usePins` — `reorder`

`PinsControl` gains `reorder(order: string[]): Promise<string | null>`, same resolution contract as `setPin` (null on success, else the text to show; never throws).

- **Optimistic:** sets `pins.pinned` to the rows re-sorted into `order` before the request, so the dropped row stays where it was dropped.
- POSTs `{order}` to `/api/pins/order` with the same Bearer header as `setPin`.
- 200 → replaces `pins` with the reply.
- 403 → rolls back to the pre-drag `pins` and returns the same token message `setPin` returns.
- 409 → re-fetches `GET /api/pins` (the stored set changed under this tab), replaces `pins` with it, and returns `"Pins changed in another tab — reloaded."`.
  If that re-fetch fails, rolls back to the pre-drag `pins` and returns the fixed network text instead.
- Any other failure → rolls back and returns the server's `error` or the fixed network text, as `setPin` does.
- Shares the `busy` slot with `setPin`, holding a sentinel that is not a dirName (e.g. `'order'`): while a reorder is in flight every Pin/Unpin waits, and while a
  pin/unpin is in flight the grips ignore input (§4.3). Both race the same stored list, so neither may start under the other.

### 4.3 `PinPicker` — the grip

`PinPicker` gains an optional `onReorder?: (order: string[]) => Promise<string | null>`. `PinnedProjectsGroup` passes it; the launch sheet does not, and its
rendering is unchanged.

When `pinned`, `onUnpin` and `onReorder` are all present:

- Each pinned row gets a leading `<button type="button" class="pin-grip">⠿</button>` with an `aria-label` naming the project and its position
  ("Move claude-agents-dashboard, position 5 of 5").
- **Grips hide while the filter is non-blank** (`query.trim() !== ''`, the same test `matchesPinFilter` applies).
  A filtered list has gaps, so a drop position would be ambiguous. Rows keep their grip column (empty) so the
  layout does not jump while typing.
- **Pointer drag** (mouse, pen, touch alike — `pointerdown` on the grip starts it; `pointermove` / `pointerup` / `pointercancel` are listened for on
  `document` for the drag's lifetime and matched by `pointerId`; `touch-action: none` on the grip only so the page still scrolls from anywhere else). **No
  `setPointerCapture`:** React re-places the dragged row's own `<li>` on a downward swap, and moving a node releases capture (`lostpointercapture`; measured
  in Chrome by review 2), so a captured downward drag freezes after one swap and never writes. The mockup uses the same `document` listeners.
  - While dragging, the order is a local draft; the dragged row carries `.pin-row.drag` and moves live as the pointer crosses another row's vertical midpoint.
  - On `pointerup`, if the draft differs from the order at drag start, call `onReorder(draft)` once, then drop the draft — the optimistic `pinned` prop
    (§4.2) already holds that order, because `reorder` sets it synchronously before its first `await`. One drag is one write.
  - `pointercancel`, or `Escape` (listened for on `document` for the drag's lifetime, since focus may not be on the grip), restores the start order and
    writes nothing.
  - If the `pinned` prop changes mid-drag, the draft resets to the new prop order and the drag continues from there. `usePins` fetches once on mount and
    never polls, so only this tab's own `setPin` reply can do that; another tab's change surfaces as the 409 on drop.
  - If `busy` turns non-null mid-drag (a second finger tapped Pin or Unpin), the drag cancels like Escape: start order restored, nothing written. The
    `setPin` reply then lands as an ordinary prop change. This keeps a reorder from ever starting under an in-flight pin/unpin (§4.2).
  - **Edge auto-scroll:** while dragging with the pointer within 48px of the viewport's top or bottom, the window scrolls toward that edge each animation frame
    (the Management page scrolls the document; `.main` has no `overflow-y`). Stops on drop, cancel, or leaving the band. Needed because 50 pins outgrow a phone
    screen.
- **Keyboard:** on a focused grip, `ArrowUp` / `ArrowDown` move the row one place (via `movePin`) and call `onReorder` once per press; `preventDefault` so the
  page does not scroll. The moved row's grip is **explicitly re-focused** after the re-render (grip refs keyed by dirName, `.focus()` in a layout effect
  once `pinned` carries the new order): React re-places the pressed row's own `<li>` on ↓, and moving a focused node drops focus to `<body>`, so without
  this the second ↓ scrolls the page. First row ↑ and last row ↓ do nothing and write nothing. A press that
  arrives while `busy` is non-null is dropped (still `preventDefault`ed), not queued.
- **Feedback:** after a successful write, a `Saved` label fades in beside the Pinned heading's count and out again after ~1.5 s. A failed write shows its text
  where the per-row error already goes, under the moved row (the existing `error` state, keyed by that dirName) — unless that row is no longer in
  `pinned` after the reply (the usual 409: it was unpinned in another tab), in which case the text shows beside the Pinned heading, where `Saved` goes.
- While `busy` is non-null the grips carry `aria-disabled="true"` and ignore `pointerdown` and key input (a drag already running is cancelled, above);
  they are **not** `disabled`. A `disabled` button loses
  focus (Chrome drops it to `<body>`), and every key press sets `busy`, so the focused grip would lose focus on the first press and the next ↓ would scroll
  the page instead.
- Dead pins (`listed: false`) are reorderable like any other: they are in the stored list, and the permutation rule requires them.

### 4.4 CSS

Ported from the mockup, tokens only (the theme rule in `.claude/CLAUDE.md`):

- `.pin-row.g` — a 28px lead column on the existing grid, at both the phone and the `md` layout; `.pin-head` gains the same lead column when the list has grips so
  the column header stays aligned. The mockup's `.wide` scope maps to the existing 768px `md` media query.
- Phone (below `md`), the other cells shift one column right: `.pin-row.g .pin-age` to column 2, and `.pin-row.g .qp-term` to column 3 spanning both rows.
  At `md` they return to `grid-column: auto; grid-row: auto`, as the un-gripped row does today.
- `.pin-grip` — 28px wide, at least 36px tall and stretched to the row height where the row is taller (toward the 44px touch floor, `.claude/DESIGN.md`),
  spanning both phone rows; `color: var(--ink3)`, hover `var(--ink)` on `var(--strip-hi)`, `cursor: grab`, visible `:focus-visible` outline in `var(--cyan)`.
- `.pin-row.drag` — `var(--strip-hi)` fill, `var(--shadow2)` lift, `cursor: grabbing`; its grip turns `var(--cyan)`.
- The `Saved` label — `var(--ink3)`, 12px, opacity transition; no transition under `prefers-reduced-motion`.
- **Dropped from the mockup:** the `.pin-row.moved` flash. The live move during the drag and the `Saved` label already confirm the drop.
- **Also differs:** the grip stretches to the row height (mockup: fixed 36px, centred), per §4.4 above.
- **Differs from the mockup:** the mockup swaps rows as soon as the pointer enters another row's box; the build swaps at the vertical midpoint (§4.3), which
  stops a row bouncing back and forth at a boundary.

## 5. Docs

- `docs/overview.md` API table: add the `POST /api/pins/order` row next to `/api/pins`.
- `docs/subsystems/configs.md`, the "Pinned projects (#161)" bullet under §Mechanism: the order is user-set now, the permutation rule, and why there is no
  membership check.
- `docs/subsystems/settings.md`, where it describes the stored `pinnedProjects`: the list's order is meaningful and `setPinOrder` rewrites it.
- `docs/subsystems/git-stats.md`: "in pin order" stays true; add that the order is set in Management › Pinned.
- `.claude/DESIGN.md` §8.4b: the Pinned card is no longer "moved unchanged" — one sentence on the grip column and the `Saved` label.
- `server/index.ts` route-list comment (top of file): add `POST /api/pins/order`.
- `shared/types.ts` `PinsResponse` JSDoc: also the payload of a successful `POST /api/pins/order`.

## 6. Tests

Exact cases. No literal test code is provided here on purpose; the implementer writes it.

**`test/settings.test.ts` — `setPinOrder`**

| Stored | `order` | Expect |
|---|---|---|
| `[a, b, c]` | `[c, a, b]` | returns `[c, a, b]`; `getPinnedProjects()` is `[c, a, b]` |
| `[a, b, c]` | `[c, a, b]`, then `resetSettings()` and re-read | still `[c, a, b]` (persisted) |
| `[a, b, c]` | `[a, b, c]` | returns `[a, b, c]` |
| `[]` | `[]` | returns `[]` |
| `[a, b, c]` | `[a, b]` (missing) | null; stored list unchanged |
| `[a, b, c]` | `[a, b, c, d]` (extra) | null; unchanged |
| `[a, b, c]` | `[a, b, b]` (duplicate, same length) | null; unchanged |
| `[a, b, c]` | `[a, b, 3]` / `'a,b,c'` / `null` | null; unchanged |
| `[a, b]` then `setPinned(c, true)` | — | `c` appended last (pin still appends) |

**`test/api-pins.test.ts` — `POST /api/pins/order`**

- No token → 403, stored order unchanged.
- `{}` / `{order: 'x'}` / `{order: ['a', 3]}` / non-JSON body → 400.
- Order missing one stored pin → 409 with `pins changed — reload`, unchanged.
- Valid permutation → 200, `body.pinned.map(r => r.dirName)` equals the sent order, and a following `GET /api/pins` agrees.
- A dead pin in the stored list must be included in the order; leaving it out → 409.
- `GET /api/pins/order` → 405.

**`test/api-git-stats.test.ts`** — one case beside its existing pin-order cases (which already plant real fixture repos), titled distinctly from the
existing pin-order case (e.g. "follows a reorder"): pin `a`, `b`; `setPinOrder([b, a])`; `GET /api/git-stats` lists `b` before `a`. Proves the downstream
claim in §1.

**`test/pins-client.test.ts` — `movePin`**

| `order` | `name` | `toIndex` | Expect |
|---|---|---|---|
| `[a, b, c, d]` | `d` | 0 | `[d, a, b, c]` |
| `[a, b, c, d]` | `a` | 3 | `[b, c, d, a]` |
| `[a, b, c, d]` | `b` | 2 | `[a, c, b, d]` |
| `[a, b, c, d]` | `c` | 1 | `[a, c, b, d]` |
| `[a, b, c, d]` | `b` | 1 | same reference |
| `[a, b, c, d]` | `x` | 0 | same reference |
| `[a, b, c, d]` | `a` | 99 | `[b, c, d, a]` (clamped) |
| `[a, b, c, d]` | `d` | -5 | `[d, a, b, c]` (clamped) |

**Not unit-tested, verified in the browser pane:** the grip renders, hides under a filter, drags live, auto-scrolls, ↑/↓ move focus with the row, Escape cancels.
Two cases by name, since each failed in a probe before its rule was written: drag the second row down two places (it must keep moving and write once on
drop), and press ↓ three times on the first row then ↑ three times (focus stays on that grip throughout and the page never scrolls).
The pane has no answer token, so the save itself only proves its 403 + rollback there (memory: browser-verification-limits); the 200 path is the user's click,
stated in the PR's "not verified" line.

## 7. Out of scope

- Sorting the sessions rail, Configs sidebar or launch sheet by pin order.
- Reordering from Management › Git, and any sort-mode setting.
- Any code change to the Lookout git-pending tile (it follows the new order on its own, §2).
- Reordering the "Not pinned" group (it is recency, by definition).
