---
id: ref-1
title: Dated probe figures in session-surfaces.md read as live numbers
created: 2026-09-07
kind: chore
tags: docs
---

## What exists today

`docs/subsystems/session-surfaces.md` states measured probe results as bare
numbers, with nothing marking them as a reading taken on a particular day:

- line 46 — "1504/1504 across the newest 12 transcripts"
- lines ~131-138 — the title-join table: 722 transcripts, 251 / 193 / 189 / 4 / 62

Both are already stale as live figures: `server/lib/transcript.ts` now says 652
transcripts and `server/lib/archived.ts` describes a 669-record store. They read
as current facts about the machine, which they are not, and nothing regenerates
them.

## Why it should change

A number that changes without anyone editing the doc is drift the provenance
stamp cannot catch — the sources can be untouched while the figure goes wrong,
so every future `/docs-sync` pass reports the doc `current` while it states
something false. It also cost review time in the 2026-09-07 pass: the agent
reconciling the doc had to stop and flag them rather than decide.

## Rough shape

Three options, and picking one is the work:

1. Keep them as evidence but date them — "as of 2026-08-14, 1504/1504 across the
   newest 12 transcripts" — so a reader knows it is a record, not a live count.
2. Drop the figures and point at the command that prints them, which is what the
   docs-sync guardrail on volatile data asks for.
3. Keep the ratio-shaped claims (1504/1504 says "the join never missed") and drop
   the absolute counts, which are the half that rots.

The same question applies wherever else a doc quotes a one-off measurement; worth
a grep for bare totals before settling on a convention.
