---
id: bug-29
title: Context gauge ignores autoCompactWindow set in the session's settings files
created: 2026-09-23
tags: sessions, context
---

## Symptom

`~/.claude/settings.json` sets `"autoCompactWindow": 200000`. If Claude Code honours that for a `[1m]` session, the session auto-compacts near 200k, but
the dashboard gauge measures it against 1,000,000. A card at ~85% of its real compaction threshold would then show ~17%. That is the same dangerous direction
as bug-26 (the gauge never warns), from a different cause. Found while grooming bug-26.

Today bug-26's family regex hides this, because every Opus/Sonnet/Fable session already reads against 1M. Once bug-26's fix lands, only sessions whose model
attachment carries `[1m]` read against 1M, and those are exactly the sessions this setting targets. The 26 `claude-opus-5[1m]` transcripts on this machine
are all affected if the premise holds.

**Unproven premise.** No transcript on this machine shows a `[1m]` session compacting yet. All 4 recorded `compact_boundary` records (`preTokens`
167,917–171,135, trigger `auto`) belong to plain `claude-opus-5` sessions, which compact near 200k anyway. So the symptom above is inferred from the
setting's name and from the memory note "set `autoCompactWindow` rather than dropping `[1m]`", not observed.

## Repro

1. Keep `"autoCompactWindow": 200000` in `~/.claude/settings.json`.
2. Run a session on `opus[1m]` until it auto-compacts. Note `compactMetadata.preTokens` on its `compact_boundary` record.
3. Watch that session's card on the Sessions view (after bug-26's fix) before the compaction. It reads against `1M`, not against the ~200k it compacts at.

## Affects

- `server/lib/transcript.ts:262` — `resolveWindow`, which reads the override only from the dashboard's own `process.env`
- `server/lib/transcript.ts:264` — the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_OBS_CONTEXT_WINDOW` env read
- `docs/subsystems/sessions.md:72` — the context bar description

## Cause

unknown — likely: `resolveWindow` treats `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as an override, but it reads the dashboard server's own env, not the monitored
session's. It never reads `autoCompactWindow` (or an `env` block) from `~/.claude/settings.json`, the project's `.claude/settings.json` or
`.claude/settings.local.json`. So a per-user or per-project compaction window never reaches the gauge. First confirm step 2 of the repro: that Claude Code
really compacts a `[1m]` session at `autoCompactWindow`.

## Fix

unknown
