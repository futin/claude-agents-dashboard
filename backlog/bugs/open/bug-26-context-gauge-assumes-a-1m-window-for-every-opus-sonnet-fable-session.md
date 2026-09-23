---
id: bug-26
title: Context gauge assumes a 1M window for every opus/sonnet/fable session
created: 2026-09-20
tags: sessions, context
updated: 2026-09-23T08:02:28Z
groom-elapsed: 160
groom-tokens: 43183
---

## Symptom

A session running plain `opus` (200k window) is shown against a 1,000,000-token denominator, so the context gauge reads roughly 5x safer than reality — a card
sitting at ~60% of its real window displays ~12%. The gauge is the main signal for "this session is about to compact", and it is wrong in the dangerous
direction: it never warns.

Noticed while asking why an Opus 5 session displayed a 1m context when nothing in config requests one. Config is clean — `~/.claude/settings.json` has
`"model": "opus"` with no `[1m]`, no context-related env var, and no `1m` anywhere in global or project settings. The session transcript records
`"model":"claude-opus-5"`. The 1M comes entirely from the dashboard's own inference.

## Repro

1. Run any session on plain `opus` (or `sonnet` / `fable`) without the 1m beta.
2. Open the Sessions view.
3. The context gauge for that card is computed against 1,000,000 rather than 200,000.

## Affects

- `server/lib/transcript.ts:23` — `LARGE_WINDOW_MODEL_PATTERNS = [/sonnet/i, /opus/i, /fable/i]`
- `server/lib/transcript.ts:266` — the `[1m]` marker check
- `server/lib/transcript.ts:267` — the family-regex branch that returns `LARGE_WINDOW`
- `server/lib/transcript.ts:268` — the token-count branch

## Cause

`resolveWindow` (`server/lib/transcript.ts:262`) returns `LARGE_WINDOW` at line 267 for any model id matching `LARGE_WINDOW_MODEL_PATTERNS`
(`transcript.ts:23`), and every Opus/Sonnet/Fable id does: the patterns match the family name, not the grant. Having a 1M-capable family says nothing about
whether this session got the 1M window. The `[1m]` check at line 266 was meant to be the real discriminator, but it tests `message.model` off the newest usage
record, and that field never carries the marker — so it is dead, and the family regex decides everything.

The capture's premise that "the granted window is not recoverable from the transcript" is **wrong** — measured 2026-09-23 over all 117 transcripts under
`~/.claude/projects/`. Claude Code writes an attachment record that names the exact model the session runs on, marker included:

```json
{"type":"attachment","attachment":{"type":"model","identity":{"modelId":"claude-opus-5[1m]","marketingName":"Opus 5 (1M context)",...},"text":"..."}}
```

- Present in 115/117 transcripts. The two without it are a 1.6 KB stub and a resumed session whose head is `last-prompt`/`mode` records (both CLI 2.1.26x).
- `identity.modelId` values seen: `claude-opus-5[1m]` ×26, `claude-opus-5` ×41, `claude-sonnet-5` ×20, `claude-haiku-4-5-20251001` ×24,
  `claude-opus-5-5` ×11. So a plain-`opus` session and a 1M one ARE distinguishable on disk; the dashboard reads the wrong field.
- It is re-emitted when the model changes mid-session: 2 transcripts go `claude-opus-5[1m]` → `claude-opus-5` (a `/model` switch), so the **newest**
  record is the truth, not the first.
- It is written near the start, not at the end: the first one ends at byte 32k (median) and up to 231k. That is past `HEAD_BYTES` (16 KB,
  `transcript.ts:32`), and on any long session it sinks below the 256 KB tail that `readTranscript` reads (`DEFAULT_TAIL_BYTES`, `transcript.ts:24`). That
  is exactly the problem `server/lib/title-cache.ts` already solves for `custom-title`: tail scan first, one backward hunt on a miss, then remembered.

## Fix

Resolve the window from the newest `attachment.type === "model"` record's `identity.modelId`, and delete the family regex.

1. **Find the identity the way the title is found.** Add a model-identity lookup with the same contract as `resolveSessionTitle`
   (`server/lib/title-cache.ts:130`). Search the tail lines for the newest model attachment first. On a miss, use the remembered answer if its searched range
   still reaches the tail window. Otherwise do one backward chunked hunt from `tailStart` and cache the result with `scannedFrom`/`size`. Drop the entry when
   the file shrinks. Pre-filter on a cheap substring marker such as `"type":"model"`, then `JSON.parse` and check `type === 'attachment'`,
   `attachment.type === 'model'` and a string `identity.modelId` before accepting a hit. The marker also matches ordinary text, so the check is required.
   Choose the shape: generalise `title-cache.ts` into a marker+extractor cache that serves both lookups, or add a sibling module. Do not copy
   `scanBack`/`readTitleAt` into a second file. `readTranscript` passes the result to `resolveWindow` (`transcript.ts:430`).
2. **New `resolveWindow` order.** Add an optional `identityModel` argument.
   1. Env override (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_OBS_CONTEXT_WINDOW`) — unchanged, wins.
   2. `tokens > STANDARD_WINDOW` → `LARGE_WINDOW`. This is proof, so it beats any identity.
   3. The identity contains `[1m]` → `LARGE_WINDOW`.
   4. The `message.model` string contains `[1m]` → `LARGE_WINDOW`. Keep this check: it is harmless and becomes live if the format ever carries the marker.
   5. Otherwise `STANDARD_WINDOW`. This covers a present identity without the marker, and also no identity at all (the 2/117 case).

   Delete `LARGE_WINDOW_MODEL_PATTERNS` and its comment block (`transcript.ts:16-23`). Replace the comment with one sentence that points at the attachment
   record.
3. **Decisions the capture left open, settled here:**
   - *Over-warning on a genuine 1M session* — moot. That session has a `[1m]` identity, so it reads against 1M from the first poll. Only the 2/117 transcripts
     with no identity start at 200k, and `contextPct` is already clamped to 100 (`transcript.ts:431`, `client/src/components/sessions/atoms.tsx:74`). The
     gauge never renders more than 100%.
   - *Sticky promotion* — not needed. The identity is cached, so it cannot oscillate. The token-promotion fallback can only drop back after a real
     compaction, and then 200k is the honest answer for a session with no identity.
   - *Haiku* — 200k is correct. Its identity (`claude-haiku-4-5-20251001`) has no marker, and Haiku 4.5's window is 200k. Pin it with a test, below.
4. **Tests** (`test/transcript.test.ts`; mirror `test/title-cache.test.ts` for the cache):
   - `resolveWindow(1000, 'claude-opus-4-8', {})` → `200000`, and the same for `'claude-sonnet-5'` and `'claude-fable-5-1'`. These replace the 1M
     expectations at lines 32-33.
   - `resolveWindow(1000, 'claude-opus-5', {}, 'claude-opus-5[1m]')` → `1000000`. With identity `'claude-opus-5'` → `200000`. With identity
     `'claude-haiku-4-5-20251001'` → `200000`.
   - `resolveWindow(250000, 'x', {}, 'claude-opus-5')` → `1000000`: proof beats identity.
   - An env override of `'400000'` beats a `[1m]` identity → `400000`.
   - `readTranscript` fixture: model attachment `claude-opus-5[1m]`, then assistant records whose `message.model` is `claude-opus-5` → `contextWindow`
     `1000000`, label `'1M'`.
   - Same fixture plus a later attachment `claude-opus-5` → `200000`. Newest wins.
   - Fixture with a `[1m]` attachment followed by more than `tailBytes` of padding, read with a small `tailBytes` → still `1000000`. A second read of the
     unchanged file adds no full scan (stats counter).
   - A user message whose text contains the literal `"type":"model"` and `[1m]` → does not promote.
   - The existing assertion at `test/transcript.test.ts:69` expects `1000000` for plain `claude-opus-4-8` with no attachment. It becomes `200000`.
   - Mutation proof: stub the identity lookup to return null, and the `[1m]` fixture test must fail.
5. **Docs.** Rewrite `docs/subsystems/sessions.md:72-74`, which currently says "1M for Sonnet/Opus/Fable". The window now comes from the session's own model
   attachment. It is 1M only when that attachment carries `[1m]` or when context has passed 200k.
6. **Live probe before done** (unit tests alone have hidden a bad join here before). Run `readTranscript` over every file in `~/.claude/projects/*/*.jsonl`
   from a scratch directory. The set with `contextWindow === 1000000` must equal the files whose newest model attachment carries `[1m]`, plus any with more
   than 200k tokens. Plain `claude-opus-5` sessions must report `200000`. No browser MCP server is configured in this repo's `.mcp.json`, so this probe
   stands in for a browser check. Optionally confirm by eye that a plain-opus card on the Sessions view reads `/ 200k`.

Out of scope, worth its own item: `~/.claude/settings.json` sets `"autoCompactWindow": 200000`. That makes Claude Code compact a `[1m]` session near 200k
(the 4 recorded `compact_boundary` records have `preTokens` of 168-171k). After this fix those sessions read against 1M while they compact at around 17% of
it. That is the same dangerous direction, from a different cause. `resolveWindow` honours the env form of this setting only from the dashboard's own process
env. It does not read it from the session's settings files.
