# Review 2 — `2026-10-09-pin-reorder-design.md`

Reviewer: fresh subagent (Fable 5.1), read-only. Verified every code claim against the tree at `main` (`07aa36a`, the commit that addressed review 1); the
mockup was read in full. Two of the findings below were checked empirically in the browser pane (Chrome 152) with a throwaway page served from the scratchpad
and torn down by pid — the method and the numbers are under each finding. Doc lines are `design.md:<n>`; mockup lines are `mockups.html:<n>`.

## Verdict: REVISE

Review 1's six Important findings are all addressed in `07aa36a` (checked one by one, see "Review 1 follow-up"). Round 2 found one Critical that review 1
missed: the drag design as written — pointer capture on the grip plus a live DOM reorder of the dragged row — loses the capture on the first downward swap,
so the drag freezes and never writes. Three Important: a false statement about polling, a keyboard focus claim that the browser does not honour, and an
unspecified concurrency edge.

## Critical

### C1 — `setPointerCapture` on the grip is released the moment React moves the dragged row (design.md:89-92)

§4.3 specifies "`setPointerCapture` on the grip" and, in the same bullet, "the dragged row carries `.pin-row.drag` and moves live as the pointer crosses
another row's vertical midpoint". Those two cannot coexist. Moving a node with `insertBefore` (what React 18.3.1 — `node_modules/react/package.json` — does for
a keyed reorder) removes it from the document and re-inserts it, and removal is an implicit release of pointer capture.

Measured in the pane (Chrome 152): a grip that called `setPointerCapture` on `pointerdown` (`hasPointerCapture` = `true`) and whose `<li>` was moved by
`insertBefore` on the first `pointermove` reported `hasPointerCapture` = `false` immediately after the move, fired `lostpointercapture`, and then received **0**
further `pointermove` events and **0** `pointerup` events for the rest of the drag, while a `window` listener received 2 moves and the 1 `pointerup`.

Which node React moves is direction-dependent: for `[a,b,c,d] → [a,c,b,d]` React keeps `a` and `c` in place and moves `b` (the row with the lower old index is
the one re-placed). So dragging a row **down** moves the dragged row's own node on every swap and the capture dies on the first one; dragging **up** moves the
other row and works. Built as written, a downward drag freezes after one swap, the `pointerup` never reaches the grip, `onReorder` is never called, and the
row stays in `.drag` with a live draft. The pane checklist at design.md:182 ("drags live") would pass if the tester happens to drag upward.
→ Drop `setPointerCapture` and attach `pointermove` / `pointerup` / `pointercancel` to `document` for the drag's lifetime, matched by `pointerId` — the mockup
already works this way (`mockups.html:295-331` listen on `document`, no capture) and the spec already puts the `Escape` listener there (design.md:94). Keep
`touch-action: none` on the grip. Add "drag the second row down two places" to the §6 pane list so the downward path is the one checked.

## Important

### I1 — "a 3s poll" of the pins does not exist (design.md:96)

"If the `pinned` prop changes mid-drag (a 3s poll or another tab)". `usePins` fetches `GET /api/pins` once on mount and never again
(`client/src/hooks/usePins.ts:21-23` "Fetched once on mount, not polled", `:31-38`); nothing else in the client reads `/api/pins` (grep). The sessions poll
is 3s; the pins are not polled, and a change in another tab cannot reach this tab mid-drag at all — which is exactly why the 409 rule in §2 exists. The only
thing that changes the prop mid-drag is a same-tab `setPin` reply (the second-finger Unpin case, I3). The reset-to-prop rule is still right; the stated cause is
false, and an implementer reading it may go looking for a poll to pause.
→ "If the `pinned` prop changes mid-drag (a pin or unpin answered in this tab — the pins are fetched once, not polled)".

### I2 — "Focus stays on the moved row's grip after the re-render" is not something the browser does (design.md:100-101, :106-108)

The sentence reads as a property the build gets for free once the grip is not `disabled`; §4.3's `aria-disabled` rationale (design.md:106-108) is built on
the same assumption. Measured in the pane (Chrome 152): with a grip focused, moving its own `<li>` by `insertBefore` left `document.activeElement` at `body`;
moving a *different* row left focus in place. Per C1's analysis React moves the pressed row's node on `ArrowDown` (`[a,b,c,d]`, ↓ on `b` → `[a,c,b,d]` moves
`b`) and the other row on `ArrowUp`. So after one `ArrowDown` focus is on `body`, the next `ArrowDown` reaches no handler, `preventDefault` never runs, and the
page scrolls — the exact failure design.md:107-108 sets out to prevent, arriving by a different route. `ArrowUp` works. `aria-disabled` is still the right
call (it is necessary), but it is not sufficient.
→ State it as a requirement with its mechanism: after a keyboard move the grip must be re-focused explicitly — a ref map keyed by dirName and a
`useLayoutEffect` (or `flushSync` + `.focus()` in the handler) that focuses the moved dirName's grip once the `pinned` prop carries the new order. Add
"press ↓ three times on the first row, then ↑ three times" to the §6 pane list.

### I3 — A drag in flight when `busy` turns non-null has no stated outcome (design.md:96, :106)

`busy` is null during a drag (nothing is in flight until `pointerup`), so the Unpin buttons are enabled (`PinPicker.tsx:80` `disabled={busy !== null}`) and a
second finger can tap one mid-drag. design.md:106 then says the grips "ignore pointer and key input" while `busy` is non-null. Read literally, that includes the
`pointerup` that ends the drag: the draft is never committed or dropped, `.drag` stays on the row, and the document `Escape`/`pointermove` listeners (after
C1's fix) stay attached. Read loosely, the `pointerup` still fires `onReorder` while a `setPin` is in flight — the "neither may start under the other" rule
at design.md:75-76 is then broken from the grip side. design.md:96 covers the *prop* change that follows the Unpin reply, not the `busy` transition that
precedes it.
→ One sentence: "`busy` turning non-null while a drag is in progress cancels the drag like `Escape` does — start order restored, nothing written; the Unpin
reply then lands as a normal prop change."

## Minor

- design.md:87 — "while the filter box has text": `matchesPinFilter` trims the query (`client/src/lib/pins.ts:12-13`), so a whitespace-only query filters
  nothing. Say grips hide when `query.trim() !== ''`, so the grips and the list agree on what "filtered" means.
- design.md:119 — the grip "stretched to the row height" differs from the mockup (`mockups.html:78` `height:36px; align-self:center`) and is not in the
  "Differs from the mockup" bullet at :124. Add it there (it is review 1's accepted suggestion, so it only wants recording).
- design.md:44, :159 — `{order: ['a', 3]}` is "not `{order: string[]}`" by §3.2 step 2 (→ 400), but an implementer who checks only `Array.isArray` lets
  `setPinOrder` answer it (→ 409, §6 settings row `[a, b, 3]`). Add `{order: ['a', 3]}` → 400 to the api-pins cases so the handler's element check is pinned.
- design.md:104 — "under the dragged row" also covers keyboard moves, which drag nothing. "under the moved row".
- design.md:22 — "The root `package.json` (the only one)": three copies exist under `.claude/worktrees/*/package.json` (checkouts of the same file).
  Harmless; "the only one in the tree" or drop the parenthesis.
- design.md:115 — `.pin-head` gaining the 28px lead column offsets the "Project" header over the Not-pinned rows too, which have no grip column. The mockup
  does the same (`mockups.html:208-209`, Not pinned rendered at `:229`), so it is what was approved — noting only so the implementer does not "fix" it.
- design.md:92 — "then drop the draft — the optimistic `pinned` prop already holds that order": true only because `reorder` calls `setPins` synchronously
  before its first `await` (so React batches it with the draft reset). Worth one clause, or the row flickers if someone moves the optimistic write after a
  fetch.

## Review 1 follow-up (all addressed in `07aa36a`)

- I1 root `package.json`, no dnd dependency — design.md:22; `package.json:34-41` confirmed, no `client/package.json`.
- I2 three surfaces, Lookout tile named with no code change — design.md:9, :18, :190; `server/lib/hub-widgets.ts:53-55`.
- I3 `aria-disabled` not `disabled`, presses while busy dropped — design.md:102, :106-108 (but see I2 above: necessary, not sufficient).
- I4 409 text placement when the row is gone, failed re-fetch rolls back — design.md:72-73, :103-105.
- I5 phone column shifts, `.drag` grip colour, `.moved` flash dropped, midpoint rule called out — design.md:117, :121, :123-124.
- I6 `settings.md` and DESIGN.md §8.4b in §5 — design.md:132, :134; `.claude/DESIGN.md:323-324` says "moved unchanged".
- Minors: configs.md bullet wording (:130), `PinsResponse` JSDoc and route-list comment (:135-136), check order before clamp (:59-61), draft dropped on
  write (:92), Escape on `document` (:94), grip height (:119), distinct test title (:165-166), second-finger case (:96), mockup prose — all present.

## Verified true this round (no finding)

- `setPinned` appends via `clampPinned`; `persist`, `readStored`, `cached`, `resetSettings`, `MAX_PINNED_PROJECTS = 50` (`server/lib/settings.ts:75`,
  `:94-95`, `:125-131`, `:167`, `:309-315`, `:319-345`).
- `servePinsWrite` gate order and messages (`server/api.ts:1714-1729`); `readJsonBody` null on non-JSON (`:343-348`); `sendBadBody` 400 (`:450-454`);
  `methodNotAllowed` 405 (`server/index.ts:137`); `/api/pins` wiring (`:222-225`); route-list comment (`:10`); `pinsPayload` (`:1655-1664`).
- `usePins` `busy` slot, messages, `setPin` contract (`client/src/hooks/usePins.ts:40-58`); `PinPicker` `act()` early return on busy, error keyed by dirName,
  rows keyed by dirName, `pinned`/`onUnpin` gate (`PinPicker.tsx:43-51`, `:73-91`); `PinnedProjectsGroup` passes `pinned`/`onUnpin` (`:23-30`); launch sheet
  passes neither (`SpawnPanel.tsx:189`).
- `readGitStats` maps `getPinnedProjects()` in order (`server/lib/git-stats.ts:422`); `gitPendingRows` keeps pin order per group (`hub-widgets.ts:53`).
- Existing pin CSS (`styles.css:1816-1840`): `.pin-age{grid-column:1}` / `.qp-term{grid-column:2;grid-row:1/span 2}` on the phone, `md` block at `:1837`
  is `@media (min-width:768px)`; `.set .pin-list` unclamped (`:1819`); `.main` has no `overflow-y` (`:279`) and nothing between `body` and `.main` scrolls —
  document scroll, as :98 says. All six tokens named in §4.4 exist in every theme block (`:15-104`).
- `pruneProjects` same-reference convention (`client/src/lib/filterSort.ts:163-167`).
- §6 tables: all eight `movePin` rows and all nine `setPinOrder` rows recompute as stated; the existing git-stats title at `test/api-git-stats.test.ts:77`
  differs from the proposed "follows a reorder"; `test/pins-client.test.ts:3` already imports `lib/pins.js`; `test/api-pins.test.ts` has the 403/400 shapes
  to copy (`:59`, `:70`).
- Copy: "Saved", the grip `aria-label`, and the filter placeholder match the mockup (`mockups.html:123`, `:187`, `:224`); the 409 body
  `pins changed — reload` and the hook text "Pins changed in another tab — reloaded." are consistent between §3.2, §4.2 and §6.
- No `.claude/rules/` directory. CLAUDE.md hard rules touched — tokens only below the theme block, zero new deps, ESM, `shared/types.ts` first (no new type
  needed, reply is `PinsResponse`), docs under `docs/subsystems/` — are respected. The spec provides exact test cases and no literal test code (global rule).

## Probe method (for the record)

A static page with four `<li>` rows each holding a 28×36 `<button>`, served by `python3 -m http.server` on 127.0.0.1:48731 from the scratchpad (pid recorded
and killed afterwards; port confirmed free). Focus: `gb.focus()`, `insertBefore(rb, rd)`, read `document.activeElement.id` (→ `""`), then `gc.focus()`,
`insertBefore(ra, rd)` (→ `"gc"`). Capture: `pointerdown` on grip b calls `setPointerCapture`; the first `pointermove` moves `rb` with `insertBefore` and
records `hasPointerCapture` (→ `false`) and `lostpointercapture` (fired); counters for later `pointermove`/`pointerup` on the grip (0 / 0) vs `window` (2 / 1)
over one `left_click_drag` from the grip to 350px below it.
