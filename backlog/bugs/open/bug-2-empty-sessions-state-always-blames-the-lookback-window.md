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

unknown — likely just that `SessionList` receives the already-filtered array and has no
way to know which predicate dropped the rows, nor whether the unfiltered payload was
non-empty. The distinction lives in `applyView`'s caller, not in the list.

## Fix

unknown. Needs grooming: decide what the empty state should say (payload was empty vs. N
rows hidden by filters), whether it offers a "clear filters" action, and where the
which-predicate-fired information comes from — a richer `applyView` return, or passing the
unfiltered count down alongside the filtered one.
