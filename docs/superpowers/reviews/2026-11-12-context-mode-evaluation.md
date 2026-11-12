# context-mode — evaluation against our own transcripts

**Verdict (2026-11-12): do not install it, and do not build its hooks here.** Our tool output is mostly file content the model asked for, read once; a cap or
a trim would cut what it uses. The measuring tool stays: `pnpm replay:tool-output` (`server/lib/tool-output-replay.ts`).

## What context-mode is

[github.com/mksglu/context-mode](https://github.com/mksglu/context-mode), v2.1.8 (`890a3f6`), Elastic-2.0, Node ≥ 24.15. A plugin for Claude Code and nine
other agent hosts whose one job is keeping tool output out of the context window:

| Mechanism | What it does |
|---|---|
| PreToolUse deny | Denies a whole-file `Read` over 16 KB; the deny reason names the exact ranged read to run instead. |
| PostToolUse replace | Any result over 4 KB is indexed into SQLite FTS5 and swapped (`hookSpecificOutput.updatedToolOutput`, in the tool's own JSON shape) for a few BM25-picked chunks plus a `ctx_search` handle line. |
| MCP tools | `ctx_execute` runs a script and returns only what it prints; `ctx_index` / `ctx_search` search saved output. |
| Session journal | Logs prompts, edits and errors; after a compaction injects a ≤ 2 KB state block. |

Its own `bench/RESULTS.md`, not the README's 99.4 % headline: equal success in every arm of an 81-session Sonnet A/B; small tasks **+5.6 %** tokens (≈ 2k
tokens of tool schemas every session), large tasks −3.8 % tokens and −44 % cost; an earlier run had large tasks +19.6 % from extra `ctx_*` turns. The
post-compaction journal showed no gain (7/10 correct in every arm, retrieval tools called 0/10 times).

It is no replacement for caveman: caveman shortens what the model writes, context-mode what tools pour in.

## What we measured

Corpus: every `~/.claude/projects` transcript modified in the 30 days to 2026-11-12 — 4,300 transcripts (2,527 main, 1,773 subagent), 151,609 tool
results, 355.7 MB seen by the model. Weight is **byte-turns**: a result's UTF-8 bytes × the main-chain turns after it until the next compaction, since each
of those turns re-reads it from the prompt cache; ÷ 4 ≈ 3,087 M cache-read tokens. Each tool_use / tool_result id counts once.

**1. Which tool fills the context** (`pnpm replay:tool-output`, 2026-11-12): Bash 72.3 % of replay, Read 14.0 %, codegraph_explore 4.6 %, Agent 2.8 %.

**2. What the two hooks would have removed** (same run):

| Hook, threshold | Calls hit | Share of all replay |
|---|---:|---:|
| bash-trim (40 head + 40 tail lines, ≤ 2 KB a side) at 4 / 8 / 16 KB | 21,017 / 9,241 / 2,432 | 24.4 / 18.8 / 7.9 % |
| read-guard (net of a ranged re-read) at 8 / 16 KB | 1,072 / 654 | 4.3 / 2.3 % |

**3. What that Bash output was** (same run, *Bash by command kind*): file reads the model asked for — `sed -n` / `awk NR` ranges 45.4 % of Bash replay, `head`/`tail` 25.5 %,
`cat` 16.7 % — and **≈ 90 % of the bash-trim saving at 8 KB** lands on them. Tests, builds, typecheck, curl and gh together are under 1 %: the repos'
own rules already keep that output short. So "Read narrowly" moved file reads into Bash rather than shrinking them, and file reading (Read plus Bash
reads) is about three quarters of all replay.

**4. Are those reads redundant?** No (one-off scratch replay, 2026-11-12, not in the repo). A read is redundant when its lines were already in context in the
same compaction segment with no edit to that file since (Edit / Write, `sed -i`, a `>` redirect and a tree-changing git command reset a file; a subagent
call resets every file). Read ranges came from the line numbers in its output, Bash ranges from parsing `sed -n 'a,bp'`, `cat`, `head -n`, `awk NR` and
`nl`/`cat -n | sed -n`. Result: **0.3 %** of all replay is lines already in context. Reads are mostly 51–300 lines (64 % of read replay); over 300 lines is
24.5 %. Only 23.8 % of Bash read output parsed (compound commands were skipped), so the figure is from a large but not random sample.

**5. How long output lives** (one-off scratch cut over the replay lib's `turnsAfter`, 2026-11-12, not in the repo):

| Turns a result stayed in context | Share of all replay | of which in main sessions |
|---|---:|---:|
| ≤ 50 | 44.2 % | 23.0 % |
| 51–100 | 21.0 % | 18.7 % |
| 101–200 | 19.8 % | 19.8 % |
| > 200 | 15.0 % | 15.0 % |

Everything past 100 turns is in main sessions. Of the 2,167 main transcripts, 192 whose longest-lived result passed 100 turns carry 57.8 % of main replay.
Two upper bounds, both ignoring answer quality: if no result had lived past 100 turns (a reset or compaction every 100 turns), 15.4 % of replay goes;
if every main-session file read that lived past 50 turns had been a subagent's job returning a 1 KB summary, 27.3 % goes — before the subagent's own
cost (its preamble alone is tens of thousands of tokens) is paid back.

## Conclusion

The cost is new, mid-sized file content that lives for many turns, not waste. A trim, a dedupe or a whole-file deny would mostly remove content the model
used, at an answer-quality cost nobody has measured. The cost sits in long main sessions: levers that act on *how long* content lives — handing
exploration to subagents that return conclusions, compacting or clearing between tasks — are where any further saving is. Next step on that side is
kaizen naming the long-lived big reads per session (futin/claude-agents-dashboard#404).

Worth keeping from context-mode if a hook is ever built here: the deny reason names the exact next call; a ranged read always passes; a hook exits 0 and
logs on any internal error; a replacement output keeps the tool's own JSON shape or Claude Code silently keeps the original.
