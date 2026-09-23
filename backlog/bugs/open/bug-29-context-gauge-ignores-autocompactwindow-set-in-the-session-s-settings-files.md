---
id: bug-29
title: Context gauge ignores autoCompactWindow set in the session's settings files
created: 2026-09-23
tags: sessions, context
updated: 2026-09-23T08:14:09Z
groom-elapsed: 129
groom-tokens: 51476
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

**The premise holds, proven from Claude Code's own source rather than from a transcript.** No `[1m]` session on this machine has compacted yet, so step 2 of
the repro is still unobserved. But the resolver that decides the compaction window is readable in the shipped binary
(`~/.local/share/claude/versions/2.1.280`, searched for `autoCompactWindow` on 2026-09-23), and it leaves no doubt:

- `ok(model, settingsWindow)` resolves the window in this order, first hit wins: the session's own `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env (clamped up to a
  100k floor) → the `autoCompactWindow` setting → server-side `clientdata` → an experiment → a per-model default → `auto`, which is the model's maximum.
  Every branch returns `Math.min(modelMax, configured)`. So a `[1m]` session with `autoCompactWindow: 200000` gets a 200k window, not 1M.
- The auto-compact threshold is that window minus a summary buffer (`nV`). The 4 recorded `compact_boundary` records (plain `claude-opus-5`, window 200k)
  fired at `preTokens` 167,917–171,135, which puts the buffer near 30k.
- `/autocompact` writes the value to `userSettings`. It is read back from the merged settings, whose sources are
  `userSettings < projectSettings < localSettings < flagSettings < policySettings` (later wins). The setting is honoured only while `autoCompactEnabled` is not
  `false`: `am()` gates it, and with auto-compact off nothing compacts at all.
- Claude Code's own help text says it plainly: "The actual threshold is the minimum of this setting and your model's maximum context window."

So the dashboard's defect is real. `resolveWindow` (`server/lib/transcript.ts:262`) reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from **the dashboard server's**
`process.env` (line 264), which says nothing about any monitored session. It never reads `autoCompactWindow`, nor an `env` block, from any of the session's
settings files. `readTranscript` calls it as `resolveWindow(tokens, model)` (line 430) with no notion of the session's project directory, even though it
computes `originCwd` two lines earlier. After bug-26 lands, a `[1m]` session under this machine's settings compacts near 170k while its card reads against 1M.
The gauge would sit near 17% when the session is about to compact.

Today bug-26's family regex hides this for the wrong reason: every Opus/Sonnet/Fable session already reads against 1M, so `[1m]` sessions are no worse off
than plain ones. **This fix depends on bug-26** and must land after it. Before bug-26 there is no reliable model maximum to take the minimum against.

## Fix

Apply the same `min(modelMax, configured)` rule Claude Code applies, reading `configured` from the session's own settings files.

1. **New module `server/lib/compact-window.ts`** (zero deps, like the rest of `server/`). Export
   `sessionCompactWindow(projectDir: string | null, homeDir?: string): number | null`.
   - Read these files, lowest precedence first, and let later files win key by key: `<claudeHome>/settings.json`, then `<projectDir>/.claude/settings.json`,
     then `<projectDir>/.claude/settings.local.json`, then the managed file (`/etc/claude-code/managed-settings.json` on Linux,
     `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS). Skip the project files when `projectDir` is null. Use `claudeHome()` from
     `management.ts` for the home dir, not a new `os.homedir()` join.
   - If the merged `autoCompactEnabled` is `false`, return `null`: nothing compacts, so the model maximum is the honest denominator.
   - Otherwise, a positive integer in the merged `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` wins, raised to a 100,000 floor. Claude Code copies a settings `env`
     block into its own process env, so this is the env branch of its resolver. Else a positive integer `autoCompactWindow`. Else `null`.
   - Cache each file's parsed JSON by `mtimeMs` + `size`. One `stat` per file per poll is the steady-state cost. Do not re-read on every poll. A missing,
     unreadable or malformed file contributes nothing and never throws.
   - Not recoverable from disk, so out of scope: `--settings` flag settings, a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` exported in the shell that launched the
     session, and the server-side `clientdata`/experiment windows. Say so in the module's header comment.
2. **`resolveWindow` gets an optional `compactWindow?: number | null` argument** (after bug-26's `identityModel`). The order becomes:
   1. The dashboard's own env override (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_OBS_CONTEXT_WINDOW`), unchanged. It is the manual escape hatch
      `docs/workflows/configuration.md:52` documents, and it still wins.
   2. `modelMax` from bug-26's rules: tokens > 200k, a `[1m]` identity, or a `[1m]` `message.model` give 1M, anything else gives 200k.
   3. If `compactWindow` is a positive number **and `tokens <= compactWindow`**, return `Math.min(modelMax, compactWindow)`. Otherwise return `modelMax`.
      Context above the configured window proves the cap is not in force for this session (a flag override, or a setting changed after compaction was due),
      so the token count beats the file, the same way bug-26 lets proof beat identity.
3. **`readTranscript`** passes `sessionCompactWindow(originCwd)` to `resolveWindow`. Use `originCwd`, not the live `cwd`: Claude Code loads project settings
   once, from the directory it was launched in, so a session that has since `cd`'d elsewhere still runs on the launch directory's settings. Keep `readTranscript`'s
   signature unchanged, so the four callers (`scan.ts:273`, `scan.ts:517`, `management.ts:441`, and `api.ts:1357`) need no edits. Give
   `sessionCompactWindow` a `homeDir` test seam and a `reset*` for its cache, as `title-cache.ts` does.
4. **Tests** (`test/compact-window.test.ts` for the module, `test/transcript.test.ts` for the resolver; tmpdir homes and project dirs throughout):
   - `resolveWindow(1000, 'claude-opus-5', {}, 'claude-opus-5[1m]', 200000)` → `200000`. With `compactWindow` `null` → `1000000`.
   - `resolveWindow(1000, 'claude-opus-5', {}, 'claude-opus-5', 500000)` → `200000`: the setting never raises a window above the model's maximum.
   - `resolveWindow(250000, 'x', {}, 'claude-opus-5[1m]', 200000)` → `1000000`: tokens above the configured window mean the cap is not in force.
   - The dashboard env override `'400000'` still beats `compactWindow` `200000` → `400000`.
   - `sessionCompactWindow`: user file `{"autoCompactWindow": 200000}` → `200000`. Project `.claude/settings.json` sets `300000` → `300000`. Also a local
     file at `400000` → `400000`. The local file wins over the project file, which wins over the user file.
   - A user file with `{"autoCompactWindow": 300000, "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000"}}` → `250000`. With the env value `"50000"`, the
     result is `100000` (the floor).
   - `{"autoCompactWindow": 200000, "autoCompactEnabled": false}` → `null`.
   - No files at all → `null`. A malformed JSON file → treated as absent, no throw. `projectDir` `null` → only the user file is read.
   - Cache: rewrite the user file with a new value and a changed mtime, and the next call returns the new value. Two calls with nothing changed read each
     file once.
   - `readTranscript` fixture with a `[1m]` model attachment, `originCwd` pointing at a tmp project whose `.claude/settings.json` sets
     `"autoCompactWindow": 200000` → `contextWindow` `200000`, label `'200k'`. The same fixture with the project file deleted → `1000000`. Point the
     user-level read at an empty tmp home, so the real `~/.claude/settings.json` cannot leak into the result.
   - Mutation proof: make `sessionCompactWindow` return `null` unconditionally, and the `readTranscript` 200k fixture must fail.
5. **Docs.** `docs/subsystems/sessions.md:72-74` (after bug-26 rewrites it) gains one sentence: the window is capped at the session's `autoCompactWindow`,
   read from its user, project, local and managed settings. `docs/workflows/configuration.md:52` should say the variable in the *dashboard's* env is a global
   override, and that a session's own value belongs in its settings files.
6. **Live probe before done.** From a scratch directory, run `readTranscript` over every `~/.claude/projects/*/*.jsonl`. Under this machine's
   `"autoCompactWindow": 200000`, every session under 200k tokens must report `contextWindow` `200000`, `[1m]` sessions included. No session may report
   `1000000` unless it has passed 200k tokens. When a `[1m]` session next auto-compacts, check that its `compact_boundary` `preTokens` sits near 170k. That
   closes the one step of the repro this groom proved from source instead of observing. No browser MCP server is configured in this repo's `.mcp.json`, so
   the probe stands in for a browser check.
