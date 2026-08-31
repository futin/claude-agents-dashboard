---
id: idea-15
title: Usage cannot be chosen as the landing view
created: 2026-08-31
---

## Problem

The Settings page's "Open on load" picker offers four choices — Last used, Sessions,
Management, Analytics — and neither **Usage** nor **Settings** is among them, though
both are real sections. Noticed in passing while working task-8; unrelated to it.

Two lists disagree about which sections are landable, and neither matches the rail:

- `client/src/components/settings/SettingsView.tsx:38` — the picker: `last`,
  `sessions`, `management`, `analytics`.
- `client/src/lib/settings.ts` `LANDINGS` — the validator: the same four **plus**
  `settings`, but still no `usage`. So a stored `landing: 'usage'` (hand-edited, or
  written by a future build) silently falls back to the default, while
  `landing: 'settings'` would validate but can never be selected.

The type says otherwise: `Landing = Section | 'last'`, and `Section` includes both.

## Rough shape

Decide the intended set once and derive both lists from it, rather than keeping two
hand-maintained arrays that already drifted. The rail's own `TABS`
(`client/src/components/SideRail.tsx`) is the natural source — a section you can
navigate to is a section you can land on.

If Settings is deliberately not landable (plausible — landing on a settings page is
odd), that is a reason to exclude it explicitly, not to leave it half-allowed.

## Open questions

- Is excluding Settings deliberate, or the same drift?
- Anything needed for a stored value naming a section a future build removes?
  `isSection` already exists for exactly that, and is not used here.
