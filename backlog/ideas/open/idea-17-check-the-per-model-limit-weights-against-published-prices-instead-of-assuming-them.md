---
id: idea-17
title: Check the per-model limit weights against published prices instead of assuming them
created: 2026-09-01
tags: usage, analytics, docs
---

## Problem

`bug-13` and `task-10` both treat "the opus:fable ratio should be about 2x" as the reference
the measurement is failing to hit. That premise was never verified — it came from recalled
list pricing, and nothing in this repo checks it.

The premise is doing real work in both items: it is the entire reason a fitted ratio of 4.20
is called a defect rather than a finding. If the 5-hour window's own per-model weighting is
not the API list-price ratio — and there is no published reason it must be — then
`task-10`'s per-request term is being asked to close a gap that may not exist, and its
live-data probe would refute the hypothesis after the work is already done.

Two distinct unknowns sit underneath:

- **The API list-price ratio** between the models in play (`claude-opus-5`, `claude-fable-5`,
  `claude-sonnet-5`, `claude-haiku-4-5`), including how cache reads and cache writes are
  priced relative to input.
- **Whether the 5-hour rate limit charges by that ratio at all.** The limit is a separate
  mechanism from billing; it may weight models differently, or include a per-request or
  per-turn component (which is `task-10`'s hypothesis), or both.

`TYPE_WEIGHTS` in `server/lib/usage-ledger.ts:54` encodes the first as `in: 1, out: 5,
cc: 1.25, cr: 0.1`, with the comment "deliberately only the ratios: a fitted per-model rate
already absorbs base price differences". Whether those four numbers are still current is
itself unchecked, and the sensitivity sweep in `bug-13` shows the fitted ratio moves from
4.20 to 5.04 as the cache-read weight goes 0.1 → 1.0, so they are not decorative.

## Rough shape

Verify the token-type weights and the model-price ratios against a real source, then record
where the number came from so the next reader does not have to re-derive it.

- The repo already has a blessed reference for this: the `claude-api` skill, whose own
  trigger says never to answer model pricing from memory. Use it rather than recalled
  figures; that is the whole point of it existing.
- If `TYPE_WEIGHTS` is off, correcting it is a one-line change with a wide blast radius —
  every fitted rate, every drift verdict, and the `mix-shift` classification all move.
  Needs the existing fixtures re-baselined, and a note in `docs/subsystems/usage-limits.md`
  about what the numbers mean and when they were last checked.
- Whatever is confirmed, stamp it: a dated provenance line beside `TYPE_WEIGHTS` saying
  what was checked and against what. Untraceable constants are how this became a question.
- The limit's own per-model weighting is probably not documented anywhere. If so, say that
  explicitly in `usage-limits.md` rather than leaving the card's copy implying a price list
  — which is `bug-13`'s complaint from the other direction.

Cheap, and it gates real work: if the limit demonstrably does not track list prices, then
`bug-13` is purely a copy fix and `task-10` loses its motivation.

## Open questions

- Is the per-model weighting of the 5-hour window published anywhere at all, or only
  observable by fitting — i.e. is this repo's measurement the only available source?
- If it is only observable by fitting, is a measured 4.20 a defect or simply the answer, and
  what would distinguish those two? (`task-10`'s two-term fit is one attempt; a controlled
  single-model burn is another.)
- Do cache reads count toward the 5-hour limit at the same 0.1 ratio they are billed at?
  This is the single biggest lever on every number the Usage tab prints — 97.2% of opus's
  raw tokens on the live logs are cache reads.
- Should `TYPE_WEIGHTS` become configurable rather than a constant, so a repricing is a
  settings change instead of a code change? Probably not worth it for four numbers, but it
  is the obvious next thought and should be answered rather than left hanging.
