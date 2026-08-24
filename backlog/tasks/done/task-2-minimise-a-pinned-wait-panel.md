---
id: task-2
title: Minimise a pinned wait panel
created: 2026-08-22
---

## Goal

`.qpanel` is pinned above the chat footer with `max-height:56vh` (`62vh` on a
phone). A two- or three-question `AskUserQuestion` fills that cap, so the chat
body it sits under shrinks to a few lines — exactly when the reader most needs
to scroll back through the transcript to *decide* what to answer. The terminal
dialog can be collapsed; the dashboard's could not. Give it the same escape
hatch.

## Plan

One toggle per wait panel, owned by the panel, defaulting to expanded.

- `client/src/lib/panelCollapse.ts` (new, pure): `collapsedSummary()` over a
  discriminated union (`question` / `plan` / `message`) → the one-line stub
  text, plus `fmtLeft()` moved out of `MessagePanel` so the stub's countdown
  and the expanded hint's countdown cannot drift.
- `client/src/components/PanelChrome.tsx` (new): `PanelHead` (the existing
  `.qp-head` row plus a caret button) and `MinimisedPanel` (the one-line
  stub). Shared by all three panels so the affordance sits in the same place
  in each.
- `QuestionPanel` / `PlanPanel` / `MessagePanel`: local `minimised` state,
  reset in the same effect that already resets the draft on
  `questionId` / `planId` / `messageId`. A **new** ask therefore always
  arrives expanded — minimising is a per-ask decision, never a standing one.
- `styles.css`: `.qpanel.min` (row, no `vh` cap) and `.qp-min` (the caret
  button). Theme tokens only.

Terminal states (`sent` / `gone`) are already one-liners — no toggle there.

Deliberately out: no persistence (not `localStorage`, not per session — a
collapsed panel that survives a reload is a wait you can miss);
`SpawnPanel`/`ResumePanel`/`PermissionBanner` untouched (the first two are
compose surfaces the reader opened on purpose, the banner is already one
line, none of them is a live hold); no auto-collapse heuristic ("2+
questions ⇒ start minimised" hides the question behind a tap on exactly the
asks that most need reading); no server change and no `shared/types.ts`
change — this is drawer chrome only.

## Test cases

`test/panel-collapse.test.ts`, node-assert like the other client-lib tests:

| case | expected |
|------|----------|
| `{kind:'question', questions:1}` | `1 question · tap to answer` |
| `{kind:'question', questions:3}` | `3 questions · tap to answer` |
| `{kind:'question', questions:0}` | clamps to the singular form |
| `{kind:'plan'}` | `plan waiting · revise from here` |
| `{kind:'message', secsLeft:42}` | `closes in 42s` |
| `{kind:'message', secsLeft:180}` | `closes in 3m` |
| `fmtLeft` | `0`→`0s`, `-5`→`0s`, `119`→`119s`, `120`→`2m` |

Plus `pnpm typecheck` and a browser pass on the drawer (question panel
minimised → chat body reclaims the height; a new question re-expands).

## Done when

`panelCollapse.ts` and `PanelChrome.tsx` exist and are used by all three
panels; the toggle is per-ask, non-persisted; the tests above pass.

## Outcome

Shipped (2026-08-22, prior to this backlog existing) — `client/src/lib/panelCollapse.ts`,
`client/src/components/PanelChrome.tsx`, and `test/panel-collapse.test.ts` are
all present in the tree. Migrated into this backlog on 2026-08-24; re-ran the
test file directly at migration time to confirm it still passes:

```
=== panelCollapse.ts ===

  ✓ one question reads singular
  ✓ several questions read plural, with the count
  ✓ a count of zero clamps to the singular form
  ✓ a plan says how it can be acted on
  ✓ a reply window carries its countdown
  ✓ a long window counts down in minutes
  ✓ fmtLeft switches to minutes at two minutes
  ✓ fmtLeft floors at zero

panelCollapse: 8 passed, 0 failed
```
