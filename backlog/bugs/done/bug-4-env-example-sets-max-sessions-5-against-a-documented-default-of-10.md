---
id: bug-4
title: .env.example sets MAX_SESSIONS=5 against a documented default of 10
created: 2026-08-27
tags: config, docs
updated: 2026-09-01T15:43:03Z
started: 2026-09-01T15:37:49Z
execute-elapsed: 314
---

## Symptom

Following `.env.example`'s own instruction — "Copy to .env and adjust. All values optional
(defaults shown)" — silently halves the session cap to 5, while the docs continue to state
the default is 10.

## Repro

```bash
cp .env.example .env && pnpm dev
```

`maxSessions` is 5, not the documented 10.

## Affects

- .env.example:13 — active `MAX_SESSIONS=5`
- server/lib/config.ts:92 — `DEFAULTS.MAX_SESSIONS: 10`
- docs/workflows/configuration.md:19 — documents the default as 10

## Cause

`.env.example:13` is the only uncommented setting in the file; the other 20+ (lines 7-124)
are all `#`-prefixed. `parseEnv` skips comment lines but reads active ones, so the copied
file feeds 5 into `toPosInt(src('MAX_SESSIONS'), DEFAULTS.MAX_SESSIONS)` and overrides the
default. Nothing downstream corrects it.

## Fix

Comment out `.env.example:13` like every other line in the file. If 5 is genuinely the
intended default, change `DEFAULTS.MAX_SESSIONS` and the docs instead — but pick one, since
right now all three disagree.

**Decision (orchestrator pre-flight, 2026-09-01):** 5 is the intended default. Change
`DEFAULTS.MAX_SESSIONS` in `server/lib/config.ts:92` from 10 to 5 and update the documented
default in `docs/workflows/configuration.md:19`. Leave `.env.example:13` active as it is —
after this change all three agree on 5.

## Outcome

**2026-09-01 — fixed.** Took the orchestrator's decision: 5 is the intended default.
`server/lib/config.ts:92` `DEFAULTS.MAX_SESSIONS` 10 → 5, and
`docs/workflows/configuration.md:19` now documents `5`. `.env.example:13` left active and
unchanged. All three sources now agree on 5.

`systematic-debugging` re-confirmed the mechanism against current code, with one correction
to the filed `## Cause`: `.env.example` has **four** active lines, not one —
`PORT=4173`, `ACTIVE_WINDOW_MIN=5` and `LOOKBACK_HOURS=24` all already matched their
defaults exactly. `MAX_SESSIONS=5` was the sole disagreement, which is what made "copy this
file verbatim" silently change behaviour.

Two tests, both written and watched fail before the change (`test/scan.test.ts`):

- `loadConfig applies defaults when no .env` — assertion flipped to expect 5.
- **`.env.example active lines match DEFAULTS`** (new) — parses `.env.example` with the real
  `parseEnv` and asserts every active key exists in `DEFAULTS` and equals it. This guards the
  whole bug class, not just this one knob: any future uncommented line that drifts from its
  default fails the suite.

Red-green evidence — before the fix:

```
$ npx tsx test/scan.test.ts
  ✗ loadConfig applies defaults when no .env
  ✗ .env.example active lines match DEFAULTS
    .env.example MAX_SESSIONS=5 disagrees with DEFAULTS.MAX_SESSIONS
Passed: 40  Failed: 2
```

After the fix:

```
$ npx tsx test/scan.test.ts
Passed: 42  Failed: 0
```

Full suite and typecheck:

```
$ pnpm test
  ... 1007 passing cases ...
ALL PASS

$ pnpm typecheck
> tsc --noEmit
TC_EXIT=0
```

Original repro, re-run against the fixed code:

```
copied .env.example -> 5
no .env at all      -> 5
```

**Verification note.** The worktree had no `node_modules` and no `client/dist`; before
`pnpm install` + `pnpm build`, `test/api-usage-rates.test.ts` "a near-miss path is not the
rates endpoint" failed because the SPA shell it asserts on did not exist. Environmental, not
caused by this change — it passes once the client is built. Nothing was run against a live
dashboard; the fix is config + docs only.

**Surfaced, not fixed — needs its own item.** `client/src/lib/settings.ts:76` sets
`DEFAULT_SETTINGS.maxSessions: 10`, a *per-browser* default that every poll sends as
`?limit=10` and which therefore overrides the server default in the UI. It sits outside this
item's stated scope (the decision named only `config.ts:92` and `configuration.md:19`), but
it means a fresh browser still renders 10 rows even though the server default is now 5. Worth
filing separately.
