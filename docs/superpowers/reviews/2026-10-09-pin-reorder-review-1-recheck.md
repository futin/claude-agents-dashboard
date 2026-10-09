# Plan re-check: pinned project reordering — review 1 follow-up (commit `db05e28`)

Scope: only the hunks `db05e28` touched in `docs/superpowers/plans/2026-10-09-pin-reorder.md` (lines 36, 97-98, 112, 183, 207-209, 216-220, 224-226, 256, 260),
checked against `docs/superpowers/specs/2026-10-09-pin-reorder-design.md`, `.claude/CLAUDE.md` and the code at `main` (`db05e28`).

## Verdict

**APPROVE WITH FIXES** — two Important findings, both one-sentence edits; nothing Critical.

## Verified as correct (changed lines, claim → evidence)

| Plan line | Claim | Evidence |
|---|---|---|
| 36 | dirNames come from `encodeProjectDir` of an absolute cwd, so start with `-` | `server/lib/management.ts:540-542` replaces every non-alphanumeric with `-`; a leading `/` becomes `-` |
| 97-98 | harness defines no token; existing 403 case at ~line 60 appends `ANSWER_TOKEN=s3cret` to its env string; other cases use plain `ENV` | `test/api-pins.test.ts:21` (`ENV` has no token), `:60` (`ENV + 'ANSWER_TOKEN=s3cret\n'`), `:71,81,93…` (plain `ENV`); `server/api.ts:498-499` `tokenOk` returns true with no `answerToken` |
| 112 | "four source files" | Task 1 Files list names `settings.ts`, `api.ts`, `index.ts`, `shared/types.ts` = 4 (plan 59-62) |
| 183 | `setPin`: server `error`, else `Failed (<status>).`, network text only on a throw | `client/src/hooks/usePins.ts:50-55` |
| 207-208 | `act` early-returns on `busy` at `PinPicker.tsx:44` | `client/src/components/PinPicker.tsx:44` `if (busy) return;` |
| 207-209 | `reorder` does not check `busy`; spec wants grips to ignore `pointerdown` while busy | plan Task 3 (176-185) specifies no busy check; spec §4.3 line 114 |
| 218-219 | after ↑ the rollback moves the pressed row's own `<li>` | React keyed diff: `[a,c,b]→[a,b,c]` places `b` (old idx 2, lastPlaced=2) then `c` (old idx 1 < 2) → `c`, the pressed row, is moved |
| 224 | the existing `err` modifier lives at `PinPicker.tsx:127` | `client/src/components/PinPicker.tsx:127` `<span className="pin-sub err">` |
| 226 | grip `grid-row:1/span 2` on phone, `auto` at `md` | spec §4.4 line 128-129 "spanning both phone rows"; `client/src/styles.css:1833` (phone `qp-term` spans `1/span 2`), `:1838-1840` (`md` is single-row, `grid-row:auto`) |
| 256 | `docs/subsystems/settings.md` ~line 66 is the `pinnedProjects` paragraph | `docs/subsystems/settings.md:66` |
| 260 | trailing `docs-sync` stamps | present in `overview.md:358`, `configs.md:158`, `settings.md:322`, `git-stats.md:236` |

Coverage (checklist 1): no spec section or test case was dropped by the commit; the busy-`pointerdown` guard (spec §4.3 line 114) is now covered where it was
missing before. Order (5): no new forward dependency. Conventions (7): all changed lines stay behaviour-not-code; no literal code added.

## Important

### I1 — plan 217-220: "pending focus until `onReorder` resolves" loses focus on exactly the rollback it was added to survive

**Claim in the plan:** keep the moved dirName as pending until `onReorder` resolves; the layout effect re-focuses on every `pinned` change while pending.

**Why it fails as written:** `usePins.reorder` restores `pins` (`setPins(remembered)`) and clears `busy` *before* its promise resolves — the same shape
`setPin` has at `client/src/hooks/usePins.ts:46-57`. The `await onReorder(...)` continuation in `PinPicker` runs in the next microtask, before React 18.3
(`package.json:39`) renders either update: state set from a promise continuation is DefaultLane and the render is scheduled through the Scheduler's
MessageChannel macrotask, so the rollback `setPins`, `setBusy(null)` and a `setPending(null)` (or `pendingRef.current = null`) written in that continuation
all land in **one** commit. The layout effect of that commit — the one that moves the pressed `<li>` back and drops focus to `<body>` — sees no pending
mark and does not re-focus. That is every save in the pane (403 each, plan 239-240, 245), so named case 2 fails on the second ↓.

**Fix (one sentence in the plan):** clear the pending mark from an effect that observes `busy` returning to `null` (a passive `useEffect` runs after the
layout effect of the same commit, which has already re-focused), or in `requestAnimationFrame` after the await — never in the `await` continuation itself.
Named case 2 (plan 238-240) is the test that catches the wrong choice; keep it.

### I2 — plan 224-225: "the existing `err` modifier" does not exist as a reusable modifier

`client/src/styles.css:1831` is `.pin-sub.err{color:var(--red)}` — scoped to `.pin-sub`. A `<span class="pin-saved err">` picks up no colour from it, so
the heading-slot failure text renders in `--ink3` exactly like `Saved`, the opposite of the sentence's intent. The pane cannot reach this branch (it needs
the 409 unpinned-elsewhere case), so nothing would catch it.

**Fix:** either say "add `.pin-saved.err{color:var(--red)}` beside `.pin-sub.err` (`styles.css:1831`), tokens only" or render the heading-slot failure as a
`pin-sub err` span placed in the heading slot. Pick one so the implementer does not have to guess.

## Minor (do not block)

- M1 — plan 207 adds the busy-`pointerdown` guard but no pane step exercises it (Step 3 only covers busy turning non-null *mid*-drag, line 242). A step like
  "click Unpin, then in the same tick dispatch `pointerdown` on another grip → no `.drag` class, no `/api/pins/order` request" would close checklist 6.
- M2 — plan 260 "each file's trailing `docs-sync` stamp": `.claude/DESIGN.md` carries none (grep count 0); say "the four `docs/` files'".
- M3 — plan 258 anchors §8.4b at "~line 323"; the sentence is at `.claude/DESIGN.md:324`. The `~` covers it.
- M4 — plan 226 now runs past 160 columns (one line); the plan's own convention at line 37 asks for 160. Wrap it.
- M5 — plan 207-209 is one 3-line sentence with two semicolons carrying three ideas (guard, rationale, listeners); splitting at "`pointermove`, …" reads
  easier. Taste only.
