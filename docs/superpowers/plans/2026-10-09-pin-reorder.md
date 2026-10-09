# Pinned Project Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose:** this plan specifies behaviour, signatures and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch (user's global CLAUDE.md, §Learnings). Where the template asks for a
> code block, read the behaviour list instead and write the code yourself. If the spec and this plan disagree, the spec wins; if you think both are
> wrong, say so in your report rather than guessing. Size figures below are soft targets, never a reason to drop a rule.

**Goal:** Let the user reorder pinned projects with a drag grip (and ↑/↓ on a focused grip) in Management › Pinned, saved server-side so Management › Git
and the Lookout git-pending tile follow the new order.

**Architecture:** One new settings writer, `setPinOrder`, accepts only an exact permutation of the stored pins; one token-guarded route,
`POST /api/pins/order`, carries the whole order. The client gets a pure `movePin` helper, an optimistic `usePins.reorder`, and a grip column in `PinPicker`
driven by hand-rolled pointer events on `document` plus a keyboard path. Every downstream surface already reads the stored order, so none of them changes.

**Tech Stack:** Node + TypeScript via `tsx` (server, Node built-ins only), React 18 + Vite (client), node-assert tests in `test/` run by `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-10-09-pin-reorder-design.md` — read it whole before Task 1; §4.3 is the part most likely to be gotten wrong.
Mockups: `docs/superpowers/specs/2026-10-09-pin-reorder-mockups.html` (variant A; the spec's §4.4 lists where the build differs from it).

## Global Constraints

- Work on branch `feat/pin-reorder` cut from `main`. Commit with `git commit -- <paths>` after checking `git status` and `git branch --show-current`.
- `server/` takes **no new dependencies** and no new outbound call. The client adds **no drag-and-drop dependency** (root `package.json` is the only one).
- ESM; server imports use the `.js` suffix; cross-boundary imports are `import type`.
- **No colour or shadow literal** in `client/src/styles.css` below the theme-token block — tokens only (`--ink`, `--ink3`, `--strip-hi`, `--cyan`,
  `--shadow2`). **No `max-width` media query** (`test/breakpoints.test.ts` fails on one): phone is the base tier, desktop is `@media (min-width:768px)`.
- Keep existing class names stable. New classes: `pin-row g`, `pin-head g`, `pin-grip`, `pin-row drag`, and one class for the Saved/error label beside the
  Pinned heading (name it `pin-saved`).
- Exact copy:
  - 403 body `{error: 'bad token'}`; bad body `{error: 'expected {order: string[]}'}`; 409 body `{error: 'pins changed — reload'}` (em dash).
  - Client 409 text `Pins changed in another tab — reloaded.`; 403 and network texts are the ones `setPin` already returns in `client/src/hooks/usePins.ts`.
  - Heading label `Saved`. Grip `aria-label` `Move <name>, position <i> of <n>` (1-based).
- Busy sentinel for a reorder is the string `'order'` (real dirNames come from `encodeProjectDir` of an absolute cwd, so they start with `-`).
- Authored prose and comments wrap at 160 columns; comments say *why* only.
- Test runs stay in the foreground — no background wait loops. If you start a dev server, record its pid and kill only that pid.

## Review Focus

1. **A downward drag of two or more places** — the dragged row keeps following the pointer and exactly one write fires on release. Pointer capture is
   released when React moves the dragged node, so a captured implementation freezes after one swap (spec §4.3, measured in review 2). Owned by Task 4
   (pane step, named case).
2. **↓ pressed repeatedly on a focused grip** — focus stays on the same project's grip and the page never scrolls; React moving the focused `<li>` drops
   focus to `<body>` unless the grip is re-focused. Owned by Task 4 (pane step, named case).
3. **The optimistic order when the rows and the order disagree** (a row the order does not name, or a name with no row) — no row vanishes or duplicates
   before the server answers. Owned by Task 2 (`applyPinOrder` cases).
4. **Unpin tapped by a second finger mid-drag** — the drag cancels, nothing is written, the unpin lands. Owned by Task 4 (pane step: simulate by starting a
   drag with a pointer event and clicking Unpin before releasing).
5. **A dead pin (project no longer listed) in the stored list** — it is reorderable, and an order that leaves it out is refused. Owned by Task 1
   (api-pins case).

---

### Task 1: Server — `setPinOrder` and `POST /api/pins/order`

**Files:**
- Modify: `server/lib/settings.ts` (new export beside `setPinned`, ~line 330)
- Modify: `server/api.ts` (new `servePinsOrder` beside `servePinsWrite`, ~line 1714)
- Modify: `server/index.ts` (wire beside `/api/pins` at ~222-225; add the route to the route-list comment near line 10)
- Modify: `shared/types.ts` (`PinsResponse` JSDoc, ~line 1588: also the payload of a successful `POST /api/pins/order`)
- Test: `test/settings.test.ts`, `test/api-pins.test.ts`, `test/api-git-stats.test.ts`

**Interfaces:**
- Consumes: `cached`, `readStored`, `persist` in `settings.ts`; `tokenOk`, `readJsonBody`, `sendBadBody`, `pinsPayload` in `api.ts`; `methodNotAllowed` in
  `index.ts`.
- Produces: `setPinOrder(order: unknown): string[] | null` exported from `server/lib/settings.ts`; route `POST /api/pins/order` answering `PinsResponse`.

Behaviour (spec §3):
- `setPinOrder` runs `readStored()` first when `cached` is null. It returns `null` and stores nothing unless `order` is an array of strings that is an exact
  permutation of the current `pinnedProjects` (same length, every element stored, no duplicates, string equality only — nothing joined into a path).
  Otherwise it stores the order through `persist` and returns a copy of the stored list. An identical order and an empty-for-empty order both succeed.
- `setPinned`, `clampPinned` and `MAX_PINNED_PROJECTS` are untouched: a new pin still appends.
- `servePinsOrder` gates in this order: `tokenOk` fails → 403 `{error: 'bad token'}`; body not `{order: string[]}` (including an array holding a
  non-string) → `sendBadBody` with `{error: 'expected {order: string[]}'}`; `setPinOrder` null → 409 `{error: 'pins changed — reload'}`; success → 200 with
  `pinsPayload(config)`. No membership check against enumerated projects.
- Any method other than POST on `/api/pins/order` → existing `methodNotAllowed` (405).

- [ ] **Step 1: Create the branch.** `git switch -c feat/pin-reorder` from an up-to-date `main`.
- [ ] **Step 2: Write the failing `setPinOrder` cases** in `test/settings.test.ts`, following that file's existing reset/fixture pattern:

  | Stored | `order` | Expect |
  |---|---|---|
  | `[a, b, c]` | `[c, a, b]` | returns `[c, a, b]`; `getPinnedProjects()` is `[c, a, b]` |
  | `[a, b, c]` | `[c, a, b]`, then `resetSettings()` and re-read | still `[c, a, b]` |
  | `[a, b, c]` | `[a, b, c]` | returns `[a, b, c]` |
  | `[]` | `[]` | returns `[]` |
  | `[a, b, c]` | `[a, b]` | `null`; stored list unchanged |
  | `[a, b, c]` | `[a, b, c, d]` | `null`; unchanged |
  | `[a, b, c]` | `[a, b, b]` | `null`; unchanged |
  | `[a, b, c]` | `[a, b, 3]`, then `'a,b,c'`, then `null` (three asserts) | `null` each time; unchanged |
  | `[a, b]` then `setPinned(c, true)` | — | `[a, b, c]` |
  | `[a, b, c]` | `[c, a, b]`; mutate the returned array | `getPinnedProjects()` still `[c, a, b]` (returns a copy) |

  Use dirName-shaped strings (`-Users-x-a` etc.) if the file's other pin cases do; check before choosing.
- [ ] **Step 3: Write the failing route cases** in `test/api-pins.test.ts` with its `withServer` / `plantProject` helpers. The harness defines no token: the 403 case sets
  `ANSWER_TOKEN=s3cret` in its env string (as the existing one at ~line 60 does); the other cases run with plain `ENV` and send no Bearer.
  - No token → 403; stored order unchanged.
  - With token: body `{}` → 400; `{order: 'x'}` → 400; `{order: ['a', 3]}` → 400; a non-JSON body → 400. Each leaves the order unchanged.
  - Pins `[p, q]`, order `[p]` → 409, body `error` is exactly `pins changed — reload`, order unchanged.
  - Pins `[p, q, r]`, order `[r, p, q]` → 200; `body.pinned.map(r => r.dirName)` equals `[r, p, q]`; a following `GET /api/pins` gives the same list.
  - A dead pin (pinned, then its project dir removed so it is no longer listed): an order omitting it → 409; an order including it at the front → 200
    with it first.
  - `GET /api/pins/order` → 405.
- [ ] **Step 4: Write the failing downstream case** in `test/api-git-stats.test.ts`, beside the existing case at ~line 77, titled `follows a setPinOrder
  reorder` (distinct from the existing title). Reuse that case's fixture-repo setup: pin `a`, `b`; call `setPinOrder([b, a])` directly; `GET /api/git-stats`
  lists `b` before `a`.
- [ ] **Step 5: Run `pnpm test`** — expect the new cases to fail (missing export / 404 or 405), nothing else.
- [ ] **Step 6: Implement** `setPinOrder`, `servePinsOrder`, the `index.ts` wiring and route-list line, and the `PinsResponse` JSDoc line.
- [ ] **Step 7: Run `pnpm test` and `pnpm typecheck`** — all green. Paste the case-count line in your report.
- [ ] **Step 8: Commit** `feat(api): POST /api/pins/order saves a reordered pin list` with the four source files and three test files.

---

### Task 2: Client pure helpers — `movePin` and `applyPinOrder`

**Files:**
- Modify: `client/src/lib/pins.ts`
- Test: `test/pins-client.test.ts`

**Interfaces:**
- Produces:
  - `movePin(order: readonly string[], name: string, toIndex: number): string[]` (spec §4.1).
  - `applyPinOrder<T extends { dirName: string }>(rows: readonly T[], order: readonly string[]): T[]` — the optimistic re-sort `usePins.reorder` needs
    (spec §4.2 "rows re-sorted into `order`"). Not named in the spec; it is pulled out as a pure function only so it can be unit-tested.

Behaviour:
- `movePin`: `name` not in `order` → returns `order` itself (same reference), checked before clamping. Then `toIndex` is clamped to `[0, order.length - 1]`.
  Clamped index equal to the current index → `order` itself. Otherwise a new array with `name` removed and re-inserted so it sits at `toIndex` in the result.
- `applyPinOrder`: returns a new array of the same rows, those named in `order` first in `order`'s sequence, then any row `order` does not name in its
  original relative position. A name in `order` with no row is skipped. Never drops or duplicates a row.

- [ ] **Step 1: Write the failing `movePin` cases:**

  | `order` | `name` | `toIndex` | Expect |
  |---|---|---|---|
  | `[a, b, c, d]` | `d` | 0 | `[d, a, b, c]` |
  | `[a, b, c, d]` | `a` | 3 | `[b, c, d, a]` |
  | `[a, b, c, d]` | `b` | 2 | `[a, c, b, d]` |
  | `[a, b, c, d]` | `c` | 1 | `[a, c, b, d]` |
  | `[a, b, c, d]` | `b` | 1 | same reference (`assert.strictEqual`) |
  | `[a, b, c, d]` | `x` | 0 | same reference |
  | `[a, b, c, d]` | `a` | 99 | `[b, c, d, a]` |
  | `[a, b, c, d]` | `d` | -5 | `[d, a, b, c]` |
  | `[a, b, c, d]` | `x` | 99 | same reference (not-found wins over clamping) |
  | `[a, b, c, d]` | `d` | 99 | same reference (clamps to its own index) |

  Also assert the input array is not mutated by a real move.
- [ ] **Step 2: Write the failing `applyPinOrder` cases** (rows are `{dirName}` objects; assert on the dirName sequence, and on object identity for one row):

  | rows | `order` | Expect |
  |---|---|---|
  | `[a, b, c]` | `[c, a, b]` | `[c, a, b]`, each element the same object as in `rows` |
  | `[a, b, c]` | `[a, b, c]` | `[a, b, c]`, a new array |
  | `[a, b, c]` | `[c, a]` | `[c, a, b]` (unnamed row kept, after) |
  | `[a, b]` | `[b, x, a]` | `[b, a]` (unknown name skipped) |
  | `[]` | `[a]` | `[]` |
- [ ] **Step 3: Run `pnpm test`** — the new cases fail.
- [ ] **Step 4: Implement both helpers.**
- [ ] **Step 5: Run `pnpm test` and `pnpm typecheck`** — green.
- [ ] **Step 6: Commit** `feat(client): movePin and applyPinOrder helpers`.

---

### Task 3: `usePins.reorder`

**Files:**
- Modify: `client/src/hooks/usePins.ts`

**Interfaces:**
- Consumes: `applyPinOrder` (Task 2); route `POST /api/pins/order` (Task 1).
- Produces: `PinsControl.reorder(order: string[]): Promise<string | null>` — null on success, else the text to show; never throws. `busy` holds `'order'`
  while it runs.

Behaviour (spec §4.2):
- Synchronously, before the first `await`: remember the current `pins`, set `busy` to `'order'`, and set `pins` to a copy whose `pinned` is
  `applyPinOrder(pins.pinned, order)`. The synchronous optimistic write matters — `PinPicker` drops its drag draft right after calling `reorder` and relies
  on the prop already holding the new order (spec §4.3).
- POST `{order}` to `/api/pins/order` with the same Bearer header `setPin` builds.
- 200 → `pins` = reply. 403 → restore the remembered `pins`, return the existing token message. 409 → `GET /api/pins`; on success `pins` = that reply and
  return `Pins changed in another tab — reloaded.`; if the re-fetch fails, restore the remembered `pins` and return the network text. Any other failure →
  restore and return what `setPin` returns for the same outcome (server `error`, else its `Failed (<status>).` fallback; the network text only on a throw).
- Always clear `busy` at the end. Update the hook's JSDoc (it says the list changes "only when someone clicks" — a drag is now the other writer).
- Do not change `setPin`.

- [ ] **Step 1: Implement** as above.
- [ ] **Step 2: Run `pnpm typecheck` and `pnpm test`** — green (no new unit test: the repo does not render hooks under test; the behaviour is exercised by
  Task 4's pane steps).
- [ ] **Step 3: Commit** `feat(client): usePins.reorder, optimistic with rollback`.

---

### Task 4: Grip, drag and keyboard in `PinPicker`; CSS

**Files:**
- Modify: `client/src/components/PinPicker.tsx`
- Modify: `client/src/components/management/PinnedProjectsGroup.tsx` (pass `onReorder={reorder}`)
- Modify: `client/src/styles.css` (`.pin-*` rules, ~1816-1841, and the `md` block)

**Interfaces:**
- Consumes: `movePin` (Task 2), `PinsControl.reorder` and `busy` (Task 3).
- Produces: `PinPicker` prop `onReorder?: (order: string[]) => Promise<string | null>`. `SpawnPanel` passes nothing and renders exactly as before.

Behaviour — spec §4.3 in full; the points an implementer most often gets wrong:
- Grips exist only when `pinned`, `onUnpin` and `onReorder` are all present. They hide (the empty column stays) when `query.trim() !== ''`.
- **Drag:** `pointerdown` on a grip (primary button / any touch) starts it, unless `busy` is non-null — then it is ignored, the same early return `act`
  has (`PinPicker.tsx:44`); `aria-disabled` blocks nothing by itself and `reorder` does not check `busy`, so without this guard a drag begun during an
  in-flight Pin/Unpin writes an order under it; `pointermove`, `pointerup`, `pointercancel` and `keydown` (Escape) listeners go on
  `document` for the drag's lifetime, filtered by `pointerId`, and are removed when it ends. **Never call `setPointerCapture`.** The draft order swaps the
  dragged row past a neighbour when the pointer crosses that neighbour's vertical midpoint. Release with a changed draft → `onReorder(draft)` once, then clear
  the draft. Release unchanged, `pointercancel`, Escape, or `busy` becoming non-null → restore, write nothing. A `pinned` prop change mid-drag resets the draft
  to the new prop order.
- **Auto-scroll:** pointer within 48px of the viewport top/bottom while dragging → `window.scrollBy` toward that edge each animation frame; stop on end or
  on leaving the band. Re-evaluate the midpoint swap after each scroll step (the rows moved under a still pointer).
- **Keyboard:** `ArrowUp`/`ArrowDown` on a focused grip → `preventDefault`; if `busy` is non-null drop the press; else `movePin` by one and, if the result is
  a new array, `onReorder` it. Keep the moved dirName as "pending focus" (a ref) until the save has fully landed, and re-focus its grip (refs keyed by dirName, in a
  layout effect) on **every** `pinned` change while it is pending — not once. The rollback after a 403/409 moves rows again, and after ↑ it is the pressed
  row's own `<li>` that React moves back, so a one-shot re-focus loses focus on every refused save (every save in the pane). This refines the spec's
  "once `pinned` carries the new order" (§4.3). **Clear the mark from a passive effect that sees `busy` return to null**, never in the code after
  `await onReorder(...)`: `reorder` restores `pins` and clears `busy` before it resolves, React batches those with anything written in the await
  continuation into one commit, and the layout effect of that commit — the one moving the `<li>` back — would then find no mark.
- `aria-disabled="true"` on grips while `busy` is non-null; never the `disabled` attribute.
- **Feedback:** success → `Saved` label beside the Pinned count, gone after ~1.5 s. Failure → the existing per-row error keyed by the moved dirName, or, if that
  row is absent from `pinned` after the reply, the same heading slot as `Saved`.
- Only `.pin-head` and the pinned rows take `g`; "Not pinned" rows stay plain `pin-row`. The heading-slot failure text uses `pin-saved err`, and a new
  `.pin-saved.err{color:var(--red)}` rule sits beside `.pin-sub.err` (`styles.css:1831`, scoped to `.pin-sub`, so it does not reach the new class) — so a
  failure is not styled as a success.
- CSS per spec §4.4: `.pin-row.g` / `.pin-head.g` lead column 28px at both tiers; grip `grid-row:1/span 2` on phone, `grid-row:auto` at `md`; phone shifts of `.pin-age` (column 2) and `.qp-term` (column 3, both rows);
  `.pin-grip` 28px wide, min 36px tall, stretched to the row, `touch-action:none`, `cursor:grab`, `--ink3` → hover `--ink` on `--strip-hi`, `:focus-visible`
  outline `--cyan`; `.pin-row.drag` `--strip-hi` + `--shadow2` + `cursor:grabbing` with a `--cyan` grip; `.pin-saved` `--ink3` 12px with an opacity
  transition removed under `prefers-reduced-motion`. No `.moved` flash.

- [ ] **Step 1: Implement** the prop, wiring, grip rendering, drag, keyboard, feedback and CSS.
- [ ] **Step 2: Run `pnpm typecheck` and `pnpm test`** — green (`test/breakpoints.test.ts` and any theme-literal test included).
- [ ] **Step 3: Pane check** (`pnpm dev` via `preview_start`, or the worktree ports in the memory note; Management › Pinned with at least 4 pins). Confirm
  with `read_page` / `javascript_tool` / screenshots, and dispatch real pointer events from `javascript_tool` where a mouse drag is not possible:
  - Grips render; typing a space into the filter does **not** hide them; typing a letter does.
  - **Named case 1:** drag the second row down two places → it keeps moving after the first swap, `.drag` clears on release, and exactly one
    `POST /api/pins/order` is sent (`read_network_requests`).
  - **Named case 2:** focus the first row's grip, press ↓ three times then ↑ three times → `document.activeElement` is that project's grip after every press
    and `window.scrollY` never changes. (Each press triggers a 403 + rollback here, see below; repeat the case with the rollback in mind — the focus rule
    must hold either way.)
  - Escape mid-drag restores the order and sends nothing.
  - Start a drag, click Unpin on another row before releasing → the drag cancels, no order POST is sent.
  - At 375px width with enough pins to overflow, dragging near the bottom edge scrolls the page.
  - Light and one dark theme: grip, drag row and `Saved` slot use theme colours (screenshot).
  - The pane has no answer token, so every save answers 403: confirm the token message shows and the order rolls back. The 200 path is not verifiable here.
- [ ] **Step 4: Stop any server you started, by its recorded pid.**
- [ ] **Step 5: Commit** `feat(client): drag and keyboard reordering of pinned projects`.

---

### Task 5: Docs

**Files:**
- Modify: `docs/overview.md` (API table row for `POST /api/pins/order` next to `/api/pins`)
- Modify: `docs/subsystems/configs.md` (the "Pinned projects (#161)" bullet under §Mechanism: order is user-set, the permutation rule, why no membership check)
- Modify: `docs/subsystems/settings.md` (~line 66, the `pinnedProjects` paragraph: order is meaningful, `setPinOrder` rewrites it)
- Modify: `docs/subsystems/git-stats.md` ("in pin order" stays; add that the order is set in Management › Pinned)
- Modify: `.claude/DESIGN.md` §8.4b (~line 323: replace "moved unchanged" with one sentence on the grip column and the `Saved` label)

- [ ] **Step 1: Make the five edits.** Only the lines that change; do not reflow neighbouring prose. Leave each file's trailing `docs-sync` stamp alone.
- [ ] **Step 2: Commit** `docs: pinned project reordering`.

---

### Task 6: PR

- [ ] **Step 1: Run `pnpm test`, `pnpm typecheck` and `pnpm build`** — paste each command's last lines into the PR.
- [ ] **Step 2: Open the PR** per `.github/pull_request_template.md`: title `feat(pins): reorder pinned projects`; *Why this shape* / *What changed*
  grouped Server / Client / Docs / *Verification*. The "not verified, needs a human" line must say: the 200 save path (the pane has no answer token), and
  a real-finger drag on a phone.
