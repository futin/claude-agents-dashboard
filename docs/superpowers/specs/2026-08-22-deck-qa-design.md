# Predefined Q&A cards in tutor decks — design

Each deck section gains one optional **Q&A card**: 2–4 questions a learner working that
section would actually ask, each with a pre-written grounded answer behind a native
`<details>`. Generated at deck-write time, when the generating session still holds the
full lesson + codebase context — the same moment it already writes per-option quiz
feedback. Static HTML only: works on GitHub Pages, offline, from `file://`, with no
change to the deck's no-network contract.

Status: **approved 2026-08-22** (via dashboard remote answer; recommendations stand —
Q&A card last in section, retrofit both decks now).

## Why generation-time and not runtime

The deck contract (tutor skill, `references/deck.md` §1) forbids any network layer in a
deck — checklist item 5 literally greps for `fetch(` — and that constraint is worth
keeping: it is what makes a deck a durable, portable artifact. The generator, meanwhile,
already anticipates learner confusion (that is what quiz distractors are), so asking it
to also write "the questions you'd want to ask next" is marginal effort with full
context. Live answering is a separate, dashboard-only feature
(`2026-08-22-guide-ask-design.md`); this card is the half that works for every reader
everywhere.

## What changes, and where

This feature edits the **global tutor skill** (`~/.claude/skills/tutor/`), not this
repo's server or client. It ships value to every project the skill is used in; this
repo's two decks get it via retrofit (below).

### `references/deck.md`

1. **§1 Structure** — a section's card run becomes: concept cards, quiz cards, then
   *optionally one* Q&A card, always last in its section (it answers questions the
   section has raised; before the quiz it would leak hints).
2. **§2 Card types** — sixth type, **qa card**:
   - Header line, e.g. "Questions you might ask".
   - 2–4 items; each is a native `<details>` with the question as its `<summary>` and
     the answer as its body. Collapsed by default, no JS required — identical mechanics
     to the existing "More detail" block.
   - Answer shape: ≤120 words, grounded with the same `file:line` discipline as concept
     prose; a short `<pre>` excerpt is allowed under the existing labeling rule.
   - Content rule: questions must be *adjacent confusions* — things the section's
     material provokes but doesn't answer ("why not X instead?", "what happens when
     Y?"). Never a restatement of a quiz question, and never new material big enough to
     need its own quiz (that test already exists for the "More detail" block; reuse it
     verbatim).
   - Navigation: an ordinary card in the flat list; `Next` never blocks on it.
3. **§8 Pre-handover checklist** — extend item 3 (no empty feedback) to also cover empty
   `<details>` bodies inside qa cards. No other check changes: qa cards have no
   correct-option semantics, so the answer-leak items don't apply.
4. **§7 Update flow** — no mechanism change. A regenerated section regenerates its qa
   card with the rest of its wrapper; untouched sections keep theirs byte-identical.

### `SKILL.md`

One line in Pedagogy defining the qa card's place in a section (mirroring §1's order),
so a deck-mode session knows the shape before opening `deck.md`. No new guardrail: the
answer-leak ban governs quiz options, and qa answers are deliberately visible-on-tap.

### Retrofit of this repo's two decks

`docs/published-guides/tutor/write-paths-deck.html` and `write-paths-2-spawn-deck.html`
predate the card. Adding qa cards is content, not source drift, so the stamp-driven
update flow won't trigger it on its own (a known property: decks only watch files their
stamp cites). Retrofit = one tutor-skill refresh session per deck that regenerates each
section's qa card only, leaves everything else byte-identical, and restamps
(`generated` + `commit`) — the same wrapper-scoped edit discipline §7 already defines,
with wrap-time confirmation before each write.

## Non-goals

- No runtime Q&A, no network, no JS beyond what decks already carry (zero new JS: native
  `<details>` does the work).
- No Q&A on the mental-model or recap cards — sections only.
- No attempt to make questions adaptive to the learner's quiz score.

## Testing / verification

The tutor skill has no test suite; verification is the deck checklist plus targeted
checks on the retrofitted decks:

- Checklist §8 passes end to end on both retrofitted decks (including the extended
  item 3).
- `grep -c 'card-qa'` per deck ≥ 1 per section touched; every qa `<details>` has
  non-empty summary and body.
- Byte-diff of each deck before/after retrofit shows changes only inside section
  wrappers (qa card insertions), the stamp, and the recap's "built at" line.
- Both decks still render from `file://` with no console errors (manual, needs a human).

## Open decisions (flagged at approval)

1. Q&A card placement: end of section after quizzes (recommended) vs interleaved after
   the concept cards.
2. Retrofit both existing decks now vs let them pick the card up at their next natural
   refresh — proposed **retrofit now** (they are the demo content for the Guides tab).
