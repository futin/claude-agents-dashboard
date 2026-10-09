# Plan review 1 — pinned project reordering

Plan: `docs/superpowers/plans/2026-10-09-pin-reorder.md` · Spec: `docs/superpowers/specs/2026-10-09-pin-reorder-design.md` · Reviewed 2026-10-09 against `main` @ 0a42ca3.

## Verdict: APPROVE WITH FIXES

No Critical findings. Three Important ones: a wrong doc line reference, a keyboard re-focus rule that fails on the rollback path the pane step itself
exercises, and a missing "ignore `pointerdown` while busy" guard that the two-writers rule depends on. Every file path, exported name and line anchor the
plan cites exists where it says (checked below), the task order is sound, and every spec section and spec test case maps to a task.

## Checklist

### 1. Coverage — spec section / test case → task

| Spec | Task | Note |
|---|---|---|
| §2 no drag dep, root `package.json` only | Global Constraints L26 | `client/package.json` does not exist — confirmed |
| §2 launch sheet gets no grips | Task 4 L201 (`SpawnPanel` passes nothing) | `SpawnPanel.tsx:189` passes no `pinned`/`onUnpin` today |
| §3.1 `setPinOrder` | Task 1 L72-74 | |
| §3.2 route, gates, 405, no membership check | Task 1 L75-78 | |
| §4.1 `movePin` | Task 2 | |
| §4.2 `reorder` | Task 3 | |
| §4.3 grip, drag, keyboard, feedback, busy, dead pins | Task 4 | see I-2, I-3 |
| §4.4 CSS | Task 4 L219-222 | |
| §5 docs ×5 + `index.ts` route comment + `PinsResponse` JSDoc | Task 5; Task 1 L61-62 | see I-1 |
| §6 `settings.test.ts` 9 rows | Task 1 Step 2 (10 rows, superset) | |
| §6 `api-pins.test.ts` 6 bullets | Task 1 Step 3 (all six, plus non-string element) | |
| §6 `api-git-stats.test.ts` one case | Task 1 Step 4 | |
| §6 `pins-client.test.ts` 8 rows | Task 2 Step 1 (10 rows, superset) | |
| §6 pane cases (two named) | Task 4 Step 3 | |
| §7 out of scope | nothing in the plan touches those | |

Review Focus items 1, 2, 4 → Task 4 pane steps; 3 → Task 2 `applyPinOrder` table; 5 → Task 1 Step 3 dead-pin bullet. All present.

### 2. Values

- 403 / 400 / 409 bodies (L33) match spec L43-45, em dash included. `bad token` is the literal `api.ts:1715` uses.
- Client 409 text (L34) matches spec L72. 403 text and network text exist verbatim in `usePins.ts:50,54`.
- `aria-label` shape (L35) matches spec L86. `Saved` matches spec L111.
- `setPinOrder` and `movePin` tables match spec §6 row for row; the plan's extra rows are consistent with the behaviour text.

### 3. Reality (grep-verified)

| Plan claim | Code |
|---|---|
| `setPinned` ~L330 `server/lib/settings.ts` | `settings.ts:330` ✓; `cached` L94, `readStored` L167, `persist` L309 ✓ |
| `servePinsWrite` ~L1714 `server/api.ts` | `api.ts:1714` ✓; `tokenOk` L498, `readJsonBody` L343, `sendBadBody` L450, `pinsPayload` L1655 ✓ |
| `/api/pins` at `index.ts` ~222-225; comment near L10; `methodNotAllowed` | `index.ts:222-225`, `:10`, `:137` ✓ (exact-match `===`, so `/api/pins/order` falls through today) |
| `PinsResponse` JSDoc ~L1588 | `shared/types.ts:1588` ✓ |
| `api-git-stats.test.ts` existing case ~L77 | `:77` "two pins answer in pin order, and reordering…" ✓ — new title is distinct |
| `styles.css` `.pin-*` ~1816-1841, `md` block | `:1820-1841`, `@media (min-width:768px)` at `:1837` ✓ |
| `test/breakpoints.test.ts` fails on `max-width` | `:212` asserts no `max-width` query ✓ |
| `.main` has no `overflow-y` (spec L104) | `styles.css:279` `overflow-x:clip` only ✓ |
| `PinPicker` `error` state keyed by dirName, `busy` prop, `query` | `PinPicker.tsx:39,13,38` ✓ |
| `configs.md` "Pinned projects (#161)" under §Mechanism | `:96` under `:55` ✓ |
| `DESIGN.md` §8.4b "moved unchanged" ~L323 | `:324` under `:319` ✓ |
| `git-stats.md` "in pin order" | `:3` ✓ |
| `overview.md` API row | `:93` ✓ |
| `.github/pull_request_template.md` "not verified" line | `:55` ✓ |
| `settings.md` ~L21-22 for stored `pinnedProjects` | **✗ — see I-1** |
| `movePin` / `applyPinOrder` / `setPinOrder` / `servePinsOrder` do not exist yet | grep: none ✓ |

### 4. Interfaces

Task 3 consumes `applyPinOrder` (Task 2) and the route (Task 1); Task 4 consumes `movePin` (Task 2), `reorder` + `busy` (Task 3). Spellings and
signatures agree across tasks. `PinsControl.reorder(order: string[]): Promise<string | null>` matches `onReorder`'s type in Task 4.

### 5. Order

1 → 2 → 3 → 4 → 5 → 6, no forward dependency. No external prerequisites.

### 6. Tests

- Red phase: `tsx` does not throw on a missing named ESM export (probed: `import { setPinOrder } …` prints `undefined`), so Task 1 Step 5 / Task 2
  Step 3 fail as `… is not a function`, not as a link error — the "nothing else fails" claim holds.
- The tables pin observable behaviour (return values, stored list, HTTP status/body), not implementation.
- Review Focus 1, 2, 4 are pane-only by the spec's own decision (§6 L192) — acceptable; the plan names them.

### 7. Conventions

"Behaviour, never literal code" is held throughout. Size budgets are stated soft (L9). 160-column prose ✓.

## Findings

### Important

**I-1 — plan L249: wrong line anchor for `docs/subsystems/settings.md`.** The plan sends the implementer to "~lines 21-22, stored `pinnedProjects`".
`settings.md:21-23` is the Management › Pinned *page* paragraph; the stored key is described at `settings.md:66` ("`pinnedProjects` (#161, default `[]`)
rides in the same file: encoded project dir names that…"). An implementer editing L21-22 would describe the order rule in the wrong paragraph and leave
the storage paragraph saying nothing about it. → Change to "~line 66, the `pinnedProjects` paragraph".

**I-2 — plan L213-215 (and spec L107-109): the re-focus rule misses the rollback that the pane step exercises.** The rule is "focus in a layout effect
once `pinned` reflects the move". React's keyed reconciliation physically moves the node that moves *down* the list. ↓ moves the pressed row down → its
`<li>` moves → re-focus fires once → fine. ↑ moves the pressed row up → the *other* row's node moves, focus holds, the one-shot effect fires and is
spent; then the 403 rollback (every save in the pane, L238) puts the pressed row back *down* → now its node moves → focus drops to `<body>` → the next
↑ scrolls the page. Named case 2 (L231-233, "↑ three times … focus after every press") will fail against the rule as written and the implementer has
to rediscover why. The same holds for the 409 re-fetch path. → State the rule as: while a keyboard move is pending (set on the press, cleared when
`onReorder` resolves), the layout effect re-focuses that dirName's grip on **every** `pinned` change, not once. Note in the plan that the spec's wording
is the one-shot form and this plan overrides it (the plan's own L8 asks for exactly that call-out).

**I-3 — plan L206 + L216: no "ignore `pointerdown` while `busy` is non-null" rule.** Spec L114 says grips "ignore `pointerdown` and key input" while
busy. The plan carries the keyboard half (L213 "if `busy` is non-null drop the press") and the mid-drag half (L208 "`busy` becoming non-null → restore")
but for pointer start it only gives `aria-disabled="true"` (L216), which blocks nothing. A drag started while a Pin/Unpin is in flight (`busy` already a
dirName, never "becoming" anything) runs to release and calls `onReorder`, and `reorder` (Task 3) does not check `busy` either — two writers of the stored
list race, the thing spec §4.2 L75-76 forbids. The existing `act` guard (`PinPicker.tsx:44`) shows the shape. → Add to the Drag bullet: "`pointerdown` while
`busy` is non-null is ignored (no listeners attached)", and add a pane sub-step or a note that the drag-start guard is the pair of the mid-drag cancel.

### Minor

- **L36** — "a dirName … always starts with `-`" is not what the store enforces: `clampPinned` accepts any `/^[A-Za-z0-9-]+$/` string (`settings.ts:78`),
  so `order` is storable by hand. The real guarantee is `encodeProjectDir` (`management.ts:541`) of an absolute cwd and the `/api/pins` enumeration gate.
  Reword the rationale; the sentinel itself is fine.
- **L97** — "the token the harness uses": `test/api-harness.ts` defines no token. The 403 case sets `ANSWER_TOKEN=s3cret` in the env string
  (`api-pins.test.ts:60`); every 200 case runs with plain `ENV` (`:20`) and sends no Bearer. Say that so nobody hunts the harness or adds headers.
- **L111** — "the five source files": the Modify list is four (`settings.ts`, `api.ts`, `index.ts`, `types.ts`).
- **L181-182** — "the server's `error` string or the network text": `setPin`'s non-403 HTTP fallback is `Failed (<status>).` (`usePins.ts:52`); the network
  text is the `catch` path only (`:54`). "exactly as `setPin` does" resolves it, but the sentence before contradicts it. Spec L74 has the same slip.
- **L30 / L219** — say explicitly that the "Not pinned" rows stay plain `pin-row` (the mockup does this, `mockups.html:230`) and only `.pin-head` and the
  pinned rows take `g`; the plan leaves it to inference.
- **L220** — "stretched to the row" should also say `grid-row:1/span 2` on phone and `grid-row:auto` at `md` (mockup `:78-79`), since the phone row is a
  two-row grid (`styles.css:1822,1833`) and a grip that spans one row sits beside the path only.
- **L30-31 `pin-saved`** — the heading-slot failure text (L217-218) reuses the `Saved` class; say whether it takes the existing `.err` modifier
  (`PinPicker.tsx:127`) so the failure is not styled as a success.
- **Task 5** — the four `docs/subsystems`/`overview` files end in a `docs-sync` stamp (`settings.md:322`, `configs.md:158`, `git-stats.md:236`,
  `overview.md:358`). Say "leave the stamp alone" (or run `/docs-sync` after) so an implementer does not hand-edit a sha.
- **Spec L59** cites `pruneProjects` / `clearFilters` as living in `lib/pins.ts` by implication; they are in `client/src/lib/filterSort.ts:163,256`. Not a plan
  defect.
