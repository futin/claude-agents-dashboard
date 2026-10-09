# Pinned project reordering — design

Decisions settled with the user on 2026-10-09. Mockups: [`2026-10-09-pin-reorder-mockups.html`](2026-10-09-pin-reorder-mockups.html) (variant A was picked;
B, C and the YAGNI'd D are kept there for the record).

## 1. Why

The stored pin list (`settings.ts` `pinnedProjects`) is ordered by when each project was pinned, and that order is load-bearing: Management › Pinned lists the
pins in it, and Management › Git draws its repos in it (Cards, Table, and inside each Triage group — `docs/subsystems/git-stats.md`). The only way to change it
today is to unpin and re-pin every project that should come after. The user wants to put the repos they look at most at the top.

## 2. Decisions

| Question | Decision |
|---|---|
| Interaction | **Variant A: an always-on drag grip** (`⠿`) leading every pinned row in Management › Pinned. Mouse and touch drag; keyboard ↑/↓ on a focused grip. Saves on drop / on each key press. |
| Rejected interactions | B (↑/↓ buttons per row): long moves are many clicks and many saves. C (a Reorder mode with Done/Cancel): an extra state for little gain at ≤ 50 rows. D (sort select + draggable Git cards): two writers of one order, and a sort mode that can silently override the manual one. |
| What follows the order | Only the two surfaces that already do: Management › Pinned and Management › Git. The sessions rail, the Claude Configs sidebar and the launch sheet keep sorting by last activity. The Lookout git widget is not touched. |
| Where reordering is offered | Management › Pinned only. The launch sheet's picker has no pinned group and gets no grips. |
| Write shape | One new route, `POST /api/pins/order`, carrying the **whole** new order — not a "move X to index i" delta. |
| Stale writes | The server accepts the order only when it is an exact permutation of the stored pins. Anything else is a 409, so a tab that missed a pin or an unpin elsewhere can neither drop nor resurrect a pin by reordering. |
| Drag library | None. Hand-rolled pointer events, matching the client's zero-dnd-dep state (`client/package.json` has only `react` and `react-dom`). |

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
- `toIndex` is clamped to `[0, order.length - 1]`.
- `name` not in `order` → returns `order` itself (same reference), so a caller can skip a write by reference comparison — the convention `pruneProjects` and
  `clearFilters` already follow.
- Moving to its current index → returns `order` itself, same reason.

### 4.2 `usePins` — `reorder`

`PinsControl` gains `reorder(order: string[]): Promise<string | null>`, same resolution contract as `setPin` (null on success, else the text to show; never throws).

- **Optimistic:** sets `pins.pinned` to the rows re-sorted into `order` before the request, so the dropped row stays where it was dropped.
- POSTs `{order}` to `/api/pins/order` with the same Bearer header as `setPin`.
- 200 → replaces `pins` with the reply.
- 403 → rolls back to the pre-drag `pins` and returns the same token message `setPin` returns.
- 409 → re-fetches `GET /api/pins` (the stored set changed under this tab), replaces `pins` with it, and returns `"Pins changed in another tab — reloaded."`.
- Any other failure → rolls back and returns the server's `error` or the fixed network text, as `setPin` does.
- Shares the `busy` slot with `setPin`, holding a sentinel that is not a dirName (e.g. `'order'`): while a reorder is in flight every Pin/Unpin waits, and while a
  pin/unpin is in flight the grips are disabled. Both race the same stored list, so neither may start under the other.

### 4.3 `PinPicker` — the grip

`PinPicker` gains an optional `onReorder?: (order: string[]) => Promise<string | null>`. `PinnedProjectsGroup` passes it; the launch sheet does not, and its
rendering is unchanged.

When `pinned`, `onUnpin` and `onReorder` are all present:

- Each pinned row gets a leading `<button type="button" class="pin-grip">⠿</button>` with an `aria-label` naming the project and its position
  ("Move claude-agents-dashboard, position 5 of 5").
- **Grips hide while the filter box has text.** A filtered list has gaps, so a drop position would be ambiguous. Rows keep their grip column (empty) so the
  layout does not jump while typing.
- **Pointer drag** (mouse, pen, touch alike — one `pointerdown` / `pointermove` / `pointerup` path, `setPointerCapture` on the grip, `touch-action: none` on the
  grip only so the page still scrolls from anywhere else):
  - While dragging, the order is a local draft; the dragged row carries `.pin-row.drag` and moves live as the pointer crosses another row's vertical midpoint.
  - On `pointerup`, if the draft differs from the order at drag start, call `onReorder(draft)` once. One drag is one write.
  - `pointercancel` or `Escape` during a drag restores the start order and writes nothing.
  - **Edge auto-scroll:** while dragging with the pointer within 48px of the viewport's top or bottom, the window scrolls toward that edge each animation frame
    (the Management page scrolls the document; `.main` has no `overflow-y`). Stops on drop, cancel, or leaving the band. Needed because 50 pins outgrow a phone
    screen.
- **Keyboard:** on a focused grip, `ArrowUp` / `ArrowDown` move the row one place (via `movePin`) and call `onReorder` once per press; `preventDefault` so the
  page does not scroll. Focus stays on the moved row's grip after the re-render. First row ↑ and last row ↓ do nothing and write nothing.
- **Feedback:** after a successful write, a `Saved` label fades in beside the Pinned heading's count and out again after ~1.5 s. A failed write shows its text
  where the per-row error already goes, under the dragged row (the existing `error` state, keyed by that dirName).
- Grips are `disabled` while `busy` is non-null.
- Dead pins (`listed: false`) are reorderable like any other: they are in the stored list, and the permutation rule requires them.

### 4.4 CSS

Ported from the mockup, tokens only (the theme rule in `.claude/CLAUDE.md`):

- `.pin-row.g` — a 28px lead column on the existing grid, at both the phone and the `md` layout; `.pin-head` gains the same lead column when the list has grips so
  the column header stays aligned.
- `.pin-grip` — 28×36, `color: var(--ink3)`, hover `var(--ink)` on `var(--strip-hi)`, `cursor: grab`, visible `:focus-visible` outline in `var(--cyan)`.
- `.pin-row.drag` — `var(--strip-hi)` fill, `var(--shadow2)` lift, `cursor: grabbing`.
- The `Saved` label — `var(--ink3)`, 12px, opacity transition; no transition under `prefers-reduced-motion`.

## 5. Docs

- `docs/overview.md` API table: add the `POST /api/pins/order` row next to `/api/pins`.
- `docs/subsystems/configs.md` §Pinned projects: the order is user-set now, the permutation rule, and why there is no membership check.
- `docs/subsystems/git-stats.md`: "in pin order" stays true; add that the order is set in Management › Pinned.

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
- `{}` / `{order: 'x'}` / non-JSON body → 400.
- Order missing one stored pin → 409 with `pins changed — reload`, unchanged.
- Valid permutation → 200, `body.pinned.map(r => r.dirName)` equals the sent order, and a following `GET /api/pins` agrees.
- A dead pin in the stored list must be included in the order; leaving it out → 409.
- `GET /api/pins/order` → 405.

**`test/api-git-stats.test.ts`** — one case beside its existing pin-order cases (which already plant real fixture repos): pin `a`, `b`; `setPinOrder([b, a])`;
`GET /api/git-stats` lists `b` before `a`. Proves the downstream claim in §1.

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
The pane has no answer token, so the save itself only proves its 403 + rollback there (memory: browser-verification-limits); the 200 path is the user's click,
stated in the PR's "not verified" line.

## 7. Out of scope

- Sorting the sessions rail, Configs sidebar or launch sheet by pin order.
- Reordering from Management › Git, and any sort-mode setting.
- Lookout's git widget ordering.
- Reordering the "Not pinned" group (it is recency, by definition).
