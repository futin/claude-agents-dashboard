---
id: bug-2
title: Empty sessions state always blames the lookback window
created: 2026-08-27
tags: ui, sessions, view-persistence
---

## Symptom

The Sessions tab shows one empty state — "No recent sessions in the lookback window." —
whenever the filtered list is empty, no matter which filter emptied it. When a persisted
project or status selection (or the activity window) is what hid every row, the message
names the wrong cause and reads as "the API returned nothing", so the user goes looking at
the server instead of at the toolbar.

Cost a real debugging round on 2026-08-27: the API was returning 10 sessions on both ports
the whole time.

## Repro

1. Open the Sessions tab with sessions present.
2. In the toolbar pick a project that has no recent activity, and/or set the activity
   window to "Last 15 min".
3. The list empties and reads "No recent sessions in the lookback window." — with no hint
   that a project/status filter, or a client-side window, did it.

`localStorage['dashboard.view']` persists that selection, so the misleading state survives
a reload and greets the *next* visit with no memory of having set a filter.

## Affects

- client/src/components/SessionList.tsx:69 — the single hardcoded empty-state string
- client/src/lib/filterSort.ts:101 — `applyView`: the three filters (projects / statuses / window) that can each empty the list
- client/src/components/SessionsView.tsx:27 — `dashboard.view`, the persisted selection
- client/src/lib/filterSort.ts:82 — `pruneProjects` already handles the sharpest form of this (a stale project name) but not the general case

## Cause

`SessionList` receives only the already-filtered array, so it cannot tell an empty payload
from a payload the toolbar emptied. `SessionsView.tsx:52` hands it
`applyView(data.sessions, view, Date.now())` and nothing else — `applyView`
(`client/src/lib/filterSort.ts:101`) returns `Session[]` and drops every trace of *which*
of its three predicates rejected rows. `SessionList.tsx:69` therefore has one branch
(`!sessions.length && !phantoms.length`) and one string, and that string describes the
*server's* lookback (`server/lib/scan.ts:214`, default 24h, `config.lookbackHours`) — true
only in the case where `data.sessions` itself is empty.

`pruneProjects` (`filterSort.ts:82`) already covers the sharpest instance — a persisted
project name the payload no longer contains at all — but only that one. It deliberately
leaves statuses and the activity window alone (fixed enums, cannot go stale), and it keeps
a selected project that still exists yet has nothing inside the window. Every one of those
survivors still lands on the lookback string.

## Fix

Give the empty state the information it lacks, as a pure function beside `applyView` so it
is testable without React.

**`client/src/lib/filterSort.ts`** — three additions, no change to `applyView`'s signature:

- `type FilterKey = 'projects' | 'statuses' | 'window'`.
- `describeEmpty(sessions, view, nowMs): EmptyState` where
  `EmptyState = { payloadEmpty: boolean; total: number; culprits: FilterKey[] }`.
  `payloadEmpty` is `sessions.length === 0`; `total` is `sessions.length`; `culprits` lists
  each predicate that rejected at least one row, always in the fixed order
  projects → statuses → window, and is always `[]` when `payloadEmpty`. An empty payload
  never blames a filter — that is the same "no sessions is no evidence" rule `pruneProjects`
  already follows.
- `hasActiveFilters(view)` (true when `projects.length || statuses.length || window !== 'all'`;
  sort key/dir do not count) and `clearFilters(view)` (returns `projects: []`, `statuses: []`,
  `window: 'all'`, sort key and dir preserved). `clearFilters` returns `view` itself when
  nothing is active, so the caller can compare by reference — same convention as
  `pruneProjects`.

**`client/src/components/SessionsView.tsx`** — compute `nowMs` once in the existing `shown`
memo and reuse it for `describeEmpty`, so the window predicate cannot disagree between the
list and its explanation. Pass `empty` and `onClearFilters={() => setView(clearFilters(view))}`
down to `SessionList`.

**`client/src/components/SessionList.tsx`** — split the one empty branch in two:

- `payloadEmpty` → keep the existing string verbatim ("No recent sessions in the lookback
  window."). It is correct here and only here.
- otherwise → name the count and the culprits, e.g. *"All 10 sessions are hidden by the
  project and activity window filters."*, with a **Clear filters** button calling
  `onClearFilters`. Label map: `projects` → "project", `statuses` → "status", `window` →
  "activity window"; join with commas and a final "and".

The button is worth its weight precisely because the selection is persisted in
`localStorage['dashboard.view']` — otherwise the user's only exit is finding the three
toolbar controls that did it.

**`client/src/styles.css`** — style the button under the existing `.empty` rule (line 335)
from theme tokens only; no literal color or shadow below the token block.

**`docs/subsystems/view-persistence.md:19`** — that line states the old single-message
behaviour as fact; rewrite it to the two-branch behaviour and note that `describeEmpty`
covers the cases `pruneProjects` deliberately does not.

### Test cases (`test/filter-sort.test.ts`)

Fixture: sessions with controllable `project`, `status`, `updatedMs`; a fixed `nowMs`.

1. `describeEmpty([], DEFAULT_VIEW, now)` → `{ payloadEmpty: true, total: 0, culprits: [] }`.
2. `describeEmpty([], { ...DEFAULT_VIEW, projects: ['a'], window: '15m' }, now)` → identical
   to case 1. This is the mutation-proving case: an implementation that blames filters
   whenever they are set fails here and only here.
3. 3 rows all `project: 'a'`, view `projects: ['b']` → `{ payloadEmpty: false, total: 3,
   culprits: ['projects'] }`.
4. rows all `status: 'idle'`, view `statuses: ['working']` → `culprits: ['statuses']`.
5. rows `updatedMs = now - 2h`, view `window: '15m'` → `culprits: ['window']`.
6. rows `project: 'a'`, `updatedMs = now - 2h`, view `projects: ['b'], window: '15m'` →
   `culprits: ['projects', 'window']` — order fixed, not view-key order.
7. Complement case: rows all `project: 'a'`, view `projects: ['a'], statuses: ['working']`
   with every row `idle` → `culprits: ['statuses']` only. A predicate that rejects nothing
   is never named.
8. `hasActiveFilters`: `DEFAULT_VIEW` → false; `{ window: '1h' }` → true; non-empty
   `projects` → true; non-empty `statuses` → true; a changed `sortKey`/`sortDir` alone →
   false.
9. `clearFilters({ projects: ['a'], statuses: ['idle'], window: '1h', sortKey: 'tokens',
   sortDir: 'asc' })` → filters reset, `sortKey: 'tokens'` and `sortDir: 'asc'` intact;
   `clearFilters(DEFAULT_VIEW) === DEFAULT_VIEW` by reference.

### Not covered here

The phantom-row rule stands unchanged: the empty state still renders only when both
`sessions` and `phantoms` are empty (`SessionList.tsx:66`). Nothing about launching rows
changes.
