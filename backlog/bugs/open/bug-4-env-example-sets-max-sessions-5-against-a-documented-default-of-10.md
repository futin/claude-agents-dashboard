---
id: bug-4
title: .env.example sets MAX_SESSIONS=5 against a documented default of 10
created: 2026-08-27
tags: config, docs
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
