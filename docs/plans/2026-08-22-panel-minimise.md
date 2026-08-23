# Plan — minimise a pinned wait panel (2026-08-22)

## Why

`.qpanel` is pinned above the chat footer with `max-height:56vh` (`62vh` on a
phone). A two- or three-question `AskUserQuestion` fills that cap, so the chat
body it sits under shrinks to a few lines — exactly when the reader most needs to
scroll back through the transcript to *decide* what to answer. The terminal
dialog can be collapsed; the dashboard's could not.

## Shape

One toggle per wait panel, owned by the panel, defaulting to expanded.

- `client/src/lib/panelCollapse.ts` (new, pure): `collapsedSummary()` over a
  discriminated union (`question` / `plan` / `message`) → the one-line stub text,
  plus `fmtLeft()` moved out of `MessagePanel` so the stub's countdown and the
  expanded hint's countdown cannot drift.
- `client/src/components/PanelChrome.tsx` (new): `PanelHead` (the existing
  `.qp-head` row plus a caret button) and `MinimisedPanel` (the one-line stub).
  Shared by all three panels so the affordance sits in the same place in each.
- `QuestionPanel` / `PlanPanel` / `MessagePanel`: local `minimised` state, reset
  in the same effect that already resets the draft on
  `questionId` / `planId` / `messageId`. A **new** ask therefore always arrives
  expanded — minimising is a per-ask decision, never a standing one.
- `styles.css`: `.qpanel.min` (row, no `vh` cap) and `.qp-min` (the caret
  button). Theme tokens only.

Terminal states (`sent` / `gone`) are already one-liners — no toggle there.

## Deliberately out

- **No persistence.** Not in `localStorage`, not per session. A collapsed panel
  that survives a reload is a wait you can miss.
- **`SpawnPanel` / `ResumePanel` / `PermissionBanner` untouched.** The first two
  are compose surfaces the reader opened on purpose; the banner is already one
  line. None of them is a live hold.
- **No auto-collapse heuristic.** "2+ questions ⇒ start minimised" hides the
  question behind a tap on exactly the asks that most need reading.
- **No server change and no `shared/types.ts` change.** This is drawer chrome.

## Tests

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
