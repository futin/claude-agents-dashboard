---
id: ref-3
title: remote-message and remote-plan share most of their docs-sync sources
created: 2026-09-07
kind: chore
tags: docs
---

## What exists today

The provenance checker reports, on every run:

```
overlap: 1 warning(s)
  docs/subsystems/remote-message.md ~ docs/subsystems/remote-plan.md share 7/11 and 7/12 sources
```

The seven shared sources are `server/lib/idle.ts`, `server/api.ts`,
`server/index.ts`, `server/lib/scan.ts`, `client/src/components/PanelChrome.tsx`,
`client/src/lib/panelCollapse.ts` and `client/src/components/SessionRow.tsx`;
each doc then owns one store module (`messages.ts` / `plans.ts`), one panel and
one `usePending*` hook. `docs/.docs-sync.yml` already declares one deliberate
pair as `overlap-ok` (push-notify subsystem ~ setup workflow), so the mechanism
for saying "this sharing is honest" exists and has not been used here.

The 2026-09-07 docs-sync pass showed the practical cost: both agents had to be
told explicitly not to document each other's panel, and both independently
recorded the same `BM_ORCH_RUN` and `atDesk` facts in their own words.

## Why it should change

It is the duplicate-home smell the checker exists to surface: a fact about the
shared seam — route ordering, the idle sweep, hold precedence — has two plausible
homes, so it gets written twice and the two copies drift. Left as-is, the warning
also becomes background noise on every run, which is how a real one gets missed.

## Rough shape

Two honest outcomes, and choosing is the work:

1. **Declare the pair `overlap-ok`** in `docs/.docs-sync.yml` with a reason, if
   the judgement is that a message hold and a plan hold are genuinely separate
   subsystems that happen to run through one seam. Cheapest, and keeps the
   reader's mental model of "one doc per pill".
2. **Merge the shared seam into one home** — either a third doc owning the
   pending-hold machinery (panel chrome, collapse, route order, idle sweep, hold
   precedence, which now lives in `client/src/lib/holds.ts` and is documented in
   neither), with both docs reduced to what is specific to their pill.

Note `remote-answer.md` shares much of the same seam without tripping the
threshold, so whatever is decided should cover all three, not just the pair the
checker names. Either outcome is a plan-file edit and therefore a bootstrap
decision, not something a `/docs-sync` maintenance pass may do inline.
