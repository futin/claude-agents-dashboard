---
id: bug-20
title: Reset this device may leave the answer token behind
created: 2026-09-07
tags: settings, docs
---

## Symptom

`docs/subsystems/view-persistence.md` says "Reset this device" removes every
per-device key the doc lists. `OWNED_KEYS` in `client/src/hooks/useSettings.tsx:17-20`
holds six keys and does not include `dashboard.answerToken`, so a reset appears to
leave the stored answer token in `localStorage`. Either the doc overstates what
reset does, or reset is failing to clear a key it should.

`dashboard.settings` is not in `OWNED_KEYS` either, but that one is deliberate —
it is handled separately by `setStored(DEFAULT_SETTINGS)`. `dashboard.answerToken`
has no such second path.

Which of the two it is decides the fix, and that has not been established: the
token being deliberately preserved across a reset is a defensible design (a
phone that resets its view state does not want to lose its write credential),
in which case the doc is what changes.

## Repro

unknown — not yet reproduced in the browser. The read is static, from
`useSettings.tsx` against the doc's claim. To confirm: set an answer token on a
device, note `dashboard.answerToken` in `localStorage`, press Reset this device,
and re-read the key.

## Affects

- `client/src/hooks/useSettings.tsx:17-20` — `OWNED_KEYS`
- `docs/subsystems/view-persistence.md` — the "Clearing them all" bullet
- `client/src/lib/settings.ts` — where the per-device keys are defined

## Cause

unknown

## Fix

unknown — depends on which side is wrong. Either add `dashboard.answerToken` to
`OWNED_KEYS`, or state in view-persistence.md that the answer token survives a
reset and say why.

## Notes

Found during the 2026-09-07 `/docs-sync` pass, by the agent reconciling
`view-persistence.md`. It predates that doc's previous baseline, so no recent
commit introduced it.
