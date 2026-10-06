# Review 1 — task #183 (kaizen live meter mod), against spec #182

Plan: /tmp/claude-1000/task-183.md. Spec: /tmp/claude-1000/idea-182.md. Reviewed 2026-10-06, installed CLI is 2.1.292 (plan says 2.1.285).
Event facts below come from the reference plugin (`code-modernization/hooks/register.ts`) and strings read out of the installed `claude` binary (read-only).

Verdict: **APPROVE WITH FIXES**. Spec coverage is complete and the example arithmetic is right. The defects are missing hook semantics and one missed repo seam (`sync-plugin.ts`).

## Checklist results

1. Coverage. Every spec section maps to a plan step.
   - Status line (ctx, $, turns, compactions, `live`): Goal 1, steps 2-3, Measure test.
   - Toast threshold: userConfig decision, Nudge tests.
   - Pane, top 5 tools and subagents by tokens and wall time: Goal 2, steps 3-4, Ledger and Agent-rows tests.
   - `/kaizen-stats` running kaizen.mjs on `$.session.id()`: step 5, `/kaizen-stats` tests.
   - Button handing off to `/kaizen`: Goal 3, Handoff test.
   - Scope split, `live` not `billable`, desktop caveat: Goal, decisions, Done-when "not verified".
   - The spec's "band" is deliberately dropped in favour of `$.ui.status`. That is fine.
   - Gap: "visible while it runs" has no mechanism (I-8).
2. Values. Recomputed: Read (4000+8000)/4 = 3000 tokens over 2 calls; Bash 400/4 = 100; wallMs Read 100+50 = 150, Bash 2000; seven tools minus five = `+2 more`; Agent 2000/4 = 500;
   thresholds 149,999 / 150,000 / 170,000 / 60,000 / 155,000 are consistent with a `>=` rule. `approxTokens` is `text.length / 4` unrounded (kaizen.mjs:265), as the plan says. No value errors.
3. Reality.
   - Exist: `plugin/.claude-plugin/plugin.json`, `plugin/skills/kaizen/kaizen.mjs`, `test/plugin-manifest.test.ts`, `docs/subsystems/analytics.md`, `docs/overview.md` §Map, README §Install the skills, `CLAUDE.md` §Commands.
   - Do not exist yet: `plugin/hooks`, `plugin/tests`, `plugin/tsconfig.json`. This is correct for Create.
   - The reference plugin paths are right. The reference `tsconfig.json` has `include [".claude/types","hooks","tests"]`.
4. Interfaces. The Path test consumes an unnamed export (I-7). `kaizenSummary`'s output shape is undefined (I-6).
5. Order. Fine. Step 6's hooks.json assertion needs the file that no step creates (M-3).
6. Tests. Findings I-6 and I-9.
7. Conventions. "Behaviour, not literal code" is followed. No hard CLAUDE.md rule is contradicted. M-2 notes two now-stale "plain JS" statements.

## Critical

None.

## Important

- **I-1 (doc 91-93, 147-150; step 7 has no sync item).** `scripts/sync-plugin.ts:24` fixes `PUBLISHED_PATHS = ['.claude-plugin', 'skills']`, and `test/sync-plugin.test.ts:67` pins that list.
  - `pnpm plugin:sync` hashes only those two paths (`scripts/sync-plugin.ts:60,64`), so `plugin/hooks/` is never compared.
  - After the version bump the first reinstall happens, because `.claude-plugin` changes. Every later mod-only edit reports "in sync" and never reaches a session.
  - Done-when line 150 ("run after `pnpm plugin:sync`") depends on the sync reaching `hooks/`.
  - Fix: add a step to extend `PUBLISHED_PATHS` with `hooks` (the whole mod, so also `tests`/`tsconfig.json` if they ship) and update `test/sync-plugin.test.ts:67` and `docs/overview.md` §Map. Or state explicitly that a version bump is required on every mod edit.
- **I-2 (doc 62-65, 91-93).** Step 1 runs `/plugin-types` from `plugin/`, so the types land in `plugin/.claude/types/`.
  - `test/plugin-manifest.test.ts:49` does `deepStrictEqual(readdirSync('plugin').sort(), [...])`. The plan's allowed-entries list (`hooks`, `tests`, `tsconfig.json`) omits `.claude`, so the manifest test fails on any machine that generated the types, though not on a fresh clone.
  - The `.gitignore` instruction ("add the types directory") is ambiguous. The existing `.gitignore` entries are root-anchored when they contain a slash, so `.claude/types/` would not match `plugin/.claude/types`.
  - Fix: name the exact path, ignore it as `plugin/.claude/types/`, and have the manifest test either allow `.claude` or ignore it.
- **I-3 (doc 78, 80, 85-87).** The plan never says how `agentId` scopes the hooks. In the reference, `turn.complete` and `tool.call` events carry `agentId` for subagent work (`register.ts:1117,1151`).
  - Unfiltered, subagent turns inflate the "turns" count, which the spec scopes to the main thread (Goal 1 "after every main-thread turn").
  - A subagent's inner tool calls (`agentId` set) would land in the main tool table. That also contradicts step 86-87, "Spend inside the subagent is invisible to a main-thread hook": the inner calls are visible, only their token spend is not.
  - The plan also does not say whether the `Agent` call itself appears in the tools table. Its 500-token result would sit there beside `Read`, and the tool tests are silent.
  - Fix: specify (a) `turn.complete` counts only events without `agentId`; (b) `tool.call` with `agentId` is excluded from the tools ledger, or put in a stated third bucket; (c) `Agent`/`Task` rows go to the subagent table only; add one test per rule.
- **I-4 (doc 79, 134).** `session.compact` is an interceptor event in the engine, not a notification. Its default result is `{ skip }` and its argument carries `trigger` and `agentId` (binary strings `"session.compact":"{ skip }"`, `restoreArgument ... ["trigger","agentId"]`).
  - A hook that counts before `await next(e)`, or ignores a `{ skip }` result, over-counts. One that ignores `agentId` counts a subagent loop's compaction as the session's.
  - The plan says only "count compactions and re-arm the nudge".
  - Fix: count and re-arm only after `next` returns a non-skipped result, and only when `agentId` is undefined. Add a test where downstream returns `{ skip }` and the count stays 0. Whether automatic compactions fire this hook is unverified, so mention it in the PR's not-verified list.
- **I-5 (doc 82-83, 127-128).** There is no `ui.close` hook. "A second run while the pane is open closes it" needs the mod to know the pane's open state.
  - The reference tracks it in a `ui.close` hook (`register.ts:925-933`).
  - When the person dismisses the pane, the mod would think it is still open. The next `/kaizen-stats` would close a pane that is not there and never reopen it.
  - Fix: add a `ui.close` hook for the pane id to the step 3 list, plus a test: close by person, then `/kaizen-stats` opens it again.
- **I-6 (doc 71, 129-130).** Two things are missing.
  - `kaizenSummary(analysisJson)` is described as "picks the fields the pane draws" with no output shape, so there is nothing to type or test against.
  - The test asserts the pane text "contains `totals.billableApprox`, `subagentTotals.tokens` and `compactions.count`, formatted". It does not say whether the field names or the formatted values appear, which formatter applies, or what the fixture is. The plan's own convention is exact values.
  - Fix: give a fixture (for example billableApprox 1234567 -> `1.2M`, subagentTotals.tokens 180000 -> `180k`, compactions.count 3), the label copy, and the expected strings.
- **I-7 (doc 137-138, 88-90).** The [repo] Path test needs an exported function that resolves the kaizen path (hooks/ -> `../skills/kaizen/kaizen.mjs`). Step 2's list names none.
  - A test that recomputes the path itself proves nothing about the mod's resolution.
  - A test under `test/` that imports mod code is pulled into the root `pnpm typecheck`, since `tsconfig.json` includes `test`. Any `import type ... from 'claude-code'` in that file or its imports then fails TS2307, because the types are gitignored and absent on a fresh clone.
  - Fix: name the resolver, say it lives in its own file with no `claude-code` import and no `$`, and say the [repo] test imports only that file.
- **I-8 (doc 12-13, 75-84).** The spec wants the pane "visible while it runs" and the plan says "recorded live", but no hook invalidates the pane after `recordCall` or a measure. The `ui.render` output is drawn only when the engine re-renders, as the reference does with `host.invalidate()`.
  - An open pane would show stale numbers until something else re-renders it.
  - Fix: state "after recording a call and after each measure, invalidate the pane when open" and add a test that a recorded call triggers a re-render.
- **I-9 (doc 86-87, 90, 84 vs 134).** Behaviour with no test case:
  - the one-line subagent caveat copy ("subagent rows count what each returned...");
  - the `reading transcript…` in-flight state;
  - `command.run` for `resume` (the Reset test covers only `clear`, although line 84 names both).
  - Fix: add the three cases. Reset on `resume` must be a separate case so deleting `'resume'` from the matcher fails a test.

## Minor (file only)

- **M-1 (doc 24).** The plan names Claude Code 2.1.285 and "143 tests"; the installed CLI here is 2.1.292. Re-state the version when the executor runs the checks.
- **M-2 (doc 94-100).**
  - `.claude/CLAUDE.md` Orientation describes `plugin/` as "plain JS, never imported by server or client".
  - `docs/overview.md:310-311` repeats it ("plain JS").
  - A TypeScript mod makes both stale. Step 7 only adds a Commands line and a Map line.
  - Amend those two lines too. Note `docs/overview.md` §Map lines 309-317 are the tree block, not the bulleted Map, so say where `plugin/hooks/` goes.
- **M-3 (doc 44-58, 60-100).** No step creates `plugin/hooks/hooks.json`, the `nudgeAtTokens` entry in `plugin.json`, or the `test:mod` script in `package.json`. They appear only under Decisions. Step 6's hooks.json assertion needs the file to exist. Add them to steps 3 or 6.
- **M-4 (doc 88-90).** `import.meta.url` inside a mod is untested territory. The reference plugin uses neither it nor any plugin-root lookup, and `claude plugin test` imports real files, so it cannot prove the live loader behaves the same. This is covered by the human check, but say it in the PR's Unproven row.
- **M-5 (doc 88-90).** `$.process.run` has default limits in the binary (a 30 s timeout constant and a 4 MiB output cap as read there; the exact option names are unverified). kaizen.mjs pretty-prints the whole analysis. A large session could truncate the output and hit the error line. Acceptable, but say which limits apply.
- **M-6 (doc 106).** Formatting edges are unspecified: 999,999 (`1000k` or `1M`), 1,000 (`1k`), and `formatUsd` between 0.005 and 0.0099 (rounds to `$0.01` versus `<$0.01`). Add one case each. Also state the singular/plural rule for `turn(s)` and `compaction(s)` (only 2 turns and 1 compaction are pinned).
- **M-7 (doc 80, 122-124).** Whether a tool result with `isError: true` is recorded is not stated. The reference reads `result.isError`.
- **M-8 (doc 86-87).** The caveat copy says "/kaizen-stats below has the full figure", but `/kaizen-stats` is the command that opened the pane. Say "the transcript figures below".
- **M-9 (doc 80).** "Time the call" does not say whether to use `$.clock` or `Date.now()`. The reference uses `Date.now()` under `mock.clock(on)`. Confirm the mock covers whichever the plan picks, since the Ledger test (doc 118-119) depends on it.
