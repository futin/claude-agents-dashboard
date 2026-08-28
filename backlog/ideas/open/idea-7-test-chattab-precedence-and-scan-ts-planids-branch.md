---
id: idea-7
title: Test chatTab precedence and scan.ts planIds branch
created: 2026-08-27
tags: tests, client
---

## Problem

The same tab-precedence rule is implemented twice and tested neither time, so a regression
that swaps two of its levels would go undetected on both sides of the FE/BE boundary:

- `client/src/components/SessionRow.tsx:24` — `chatTab()` picks the drawer's tab by
  precedence (question > plan > reply > permission > chat). It is a private, unimported
  function, and no `*.test.tsx` exists anywhere under `client/`.
- `server/lib/scan.ts` — a parallel precedence computes `status`. Its `remotePlan` /
  `planIds` branch has no case in `test/scan.test.ts` either.

Filed as an idea rather than a task because the blocker is a decision, not just work:
there is currently no client-side test infrastructure at all, so "add a test" isn't yet a
plan. This is the mirror-case problem — the rule is proved in neither direction.

## Rough shape

Three options, roughly increasing in cost:

1. **Extract and unit-test.** Move `chatTab` into a plain `client/src/lib/` module and test
   it with the existing node-assert runner — no new dependency, no component rendering. Adds
   the `planIds` case to `test/scan.test.ts` in the same pass.
2. **Share one implementation.** Both copies encode the same product rule; put it in
   `shared/` and have both sides import it, so there is one place to test and no drift.
   Largest change, best end state.
3. **Add a real component test runner** (vitest + testing-library) and test `SessionRow` as
   rendered. Most faithful, but introduces client test tooling this repo has so far avoided.

Option 1 or 2 fits the repo's zero-dependency instinct; option 2 also removes the
duplication that made this a two-sided problem.

## Open questions

- Is the precedence genuinely meant to be identical on both sides, or do the drawer tab and
  the row status intentionally differ in some case? If they differ, sharing is wrong and
  each needs its own test.
- Is adding client test tooling wanted at all, or should client logic be kept extractable so
  the node runner stays sufficient?
- Does `scan.ts`'s `planIds` branch have a fixture shape already available in
  `test/scan.test.ts`, or does it need a new transcript fixture?
