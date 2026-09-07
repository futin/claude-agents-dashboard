---
id: idea-22
title: Apply the Token value reading aids to the Forecast tab
created: 2026-09-06
tags: ui, usage, forecast
promoted-to: task-23
updated: 2026-09-07T05:34:08Z
groom-elapsed: 399
groom-tokens: 116032
---

## Problem

`task-22` redesigns the **Token value** tab around a one-sentence lead, a status line that
answers the tab's question first, a closed-by-default `How to read this` drawer holding
every definition, and ⓘ panels on the figure labels. The **Forecast** tab beside it still
opens on the same kind of dense `.up-sub` paragraph (`UsageProfile.tsx` ~line 410: the
duty-cycle explanation, the learn-from-5h-predict-weekly rule, the confidence gates) and
scatters its explanations across the legend, the `RecordingStatus` line, the walk's
`walkAbsent` sentence and the per-cell tooltip. Once one tab reads the new way, the other
reads as the old way.

The user chose to ship Token value alone first, so this is the follow-up, not part of
`task-22`.

## Rough shape

- Same three moves: shrink the intro to one sentence, put a status line first (`confidence`
  + `RecordingStatus` already carry the answer — *is the forecast trustworthy yet, and when
  does the week hit 100%*), move the definitions into a `How to read this` drawer (duty
  cycle, weight, evidence, confidence, solid vs dashed, the 100% ceiling).
- Reuse `useFloatingTip` from `task-22` for ⓘ on the legend terms and the walk's
  `exhaustAt` label; the grid cells already use it.
- The grid, the walk chart and every number are untouched — presentation only.

## Open questions

- Does the Forecast tab need a status line at all, or does the existing `RecordingStatus`
  row become it with a leading question? Decide from the shipped `task-22` layout, not
  before.
- Should the two tabs share one `How to read this` component with two glossaries, or is
  that premature after one reuse?
