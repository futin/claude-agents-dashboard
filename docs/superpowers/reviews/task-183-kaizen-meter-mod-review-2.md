# Review 2 — task #183 (kaizen live meter mod), against spec #182 and review 1

Plan: scratchpad `task-183.md` (revision after review 1). Spec: `idea-182.md`. Previous review: `task-183-kaizen-meter-mod-review-1.md`.
Reviewed 2026-10-07. Installed CLI here is 2.1.280 (`claude --version`); the bundled `plugin-authoring` types file read for API facts is stamped 2.1.289
(`/private/tmp/claude-501/bundled-skills/2.1.289/.../plugin-authoring/types/claude-code.d.ts`, cited below as `types:<line>`). Reference plugin is
`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-modernization/` (cited as `ref:hooks/register.ts:<line>`). All checks read-only.

Verdict: **APPROVE WITH FIXES**. All nine previous findings are addressed; two are addressed with a residual gap (I-2, I-4). No Critical. The Important
findings are two false stated facts, one test that cannot pass as written (mock clock vs `Date.now()`), one missed compaction trigger, one unstated mock
mechanism, and one portability constraint on the path resolver.

## Part A — previous findings

| # | Status | Where in the plan | Note |
| --- | --- | --- | --- |
| I-1 | resolved | 111-112, 169-170 | `PUBLISHED_PATHS` gains `hooks`; sync test pins the new list and a `hooks/`-only diff changes the digest. |
| I-2 | resolved, residual gap | 62-65, 113-114 | Exact gitignore line and manifest tolerance for `plugin/.claude/` are now stated. Gap: the 2.1.289 engine lays types at `plugin/.claude-plugin/types/` instead — see N-4. |
| I-3 | resolved | 88-89, 97, 103-105, 134-136, 151-153 | Scope rule stated once, applied to all three events, `Agent`/`Task` rows go to the subagent table only, one test per rule. |
| I-4 | resolved, residual gap | 93-94, 135-136, 190 | Await-then-count, `{ skip }` and `agentId` excluded, auto-compaction listed as unverified. Gap: `trigger: 'precompute'` — see N-2. |
| I-5 | resolved | 100, 159 | `ui.close` hook added with a person-closes-then-reopen test. Minor: result is `void` on this build (M-2). |
| I-6 | resolved | 72-74, 161-163 | Four-line shape, fixture and expected strings. Values recomputed: 1234567 → `1.2M`, 450000 → `450k`, `1 compaction`, `87 turns`. |
| I-7 | resolved | 75-77, 173-174 | `kaizenScriptPath()` named, own file, no `claude-code` import, repo test imports only it. See N-6 for the `node:url` constraint. |
| I-8 | resolved | 98, 155-156 | Invalidate after each recorded call and measure while open; test covers open and closed. |
| I-9 | resolved | 152-153, 160, 167-168 | Caveat copy asserted "exactly as written in step 4"; `reading transcript…` pinned; `resume` is its own case. |

## Part B — checklist

1. Coverage. Spec has no explicit test cases; every spec section maps to a step and a test group: status line (Shape 1 → steps 2-3, Measure); toast
   threshold (Shape 1 → decision 53-54, Nudge); pane top-5 by tokens and wall time (Shape 2 → steps 2-4, Tool ledger, Agent rows, Live pane);
   `/kaizen-stats` on `$.session.id()` (Shape 3 → step 5, `/kaizen-stats` group); handoff button (Shape 3 → Handoff); scope split and log rule (→
   decisions 46-51, analytics doc 117-118); `live` not `billable` (→ Measure 132-133); desktop caveat (→ Done-when 187). Complete.
2. Values. Recomputed every expected value: Read (4000+8000)/4 = 3000 over 2 calls; Bash 400/4 = 100; wallMs Read 100+50 = 150, Bash 2000; Agent 2000/4 =
   500; `+2 more` for seven tools; thresholds 149,999 / 150,000 / 170,000 / 60,000 / 155,000 consistent with `>=` plus re-arm; `formatTokens` edges
   1000 → `1k`, 999999 → `1M` match rule 79-80; `formatUsd` 0.004 → `<$0.01`, 0.005 → `$0.01` match rule 80. `approxTokens` is `text.length / 4`
   (`plugin/skills/kaizen/kaizen.mjs:265`), the four kaizen fields exist in the analysis output (`kaizen.mjs:258` subagentTotals, `:452-453`
   compactions.count, `:483-488` totals.billableApprox / perTurn.count). No value errors.
3. Reality. Exist: `scripts/sync-plugin.ts:24` (`PUBLISHED_PATHS = ['.claude-plugin', 'skills']`), `test/sync-plugin.test.ts:67`,
   `test/plugin-manifest.test.ts:55` (`readdirSync('plugin').sort()` equality), `plugin/.claude-plugin/plugin.json` (name `claude-agents-dashboard`,
   version 0.1.0, no userConfig), `docs/overview.md:309-317` tree and `:310-311` "plain JS", `.claude/CLAUDE.md` §Orientation "plain JS" and §Commands,
   README `## Install the skills`, `docs/subsystems/analytics.md`. Do not exist (correct for Create): `plugin/hooks/`, `plugin/tests/`,
   `plugin/tsconfig.json`, `package.json` `test:mod`. Reference citations `ref:hooks/register.ts:925`, `:1117`, `:1151` are right. Two stated facts are
   false: line 33 (`$.process.run` in the reference — it is not there) and lines 40-42 (validate fails on main — it passes here). See N-3, N-5.
4. Interfaces. Every name a test consumes is produced in step 2 or 3 (`formatTokens`, `formatUsd`, `topBy`, `kaizenSummary`, `kaizenScriptPath`,
   command `kaizen-stats`, pane caveat copy). Consistent.
5. Order. Step 1 types → step 2 pure functions → step 3 wiring → 4/5 → 6 sync/manifest → 7 docs. Fine. Step 6's `hooks.json` assertion now has the file
   created in step 3 (review-1 M-3 closed).
6. Tests. Fail-before holds for every case except: Tool ledger durations (N-1) cannot be produced by the mechanism the plan prescribes; `precompute`
   has no case (N-2); the `/kaizen-stats` mock has no stated mechanism (N-3).
7. Conventions. No literal code (line 21-22), 160-column wrap, hard CLAUDE.md rules respected (no new server dep, plugin stays the only kaizen copy,
   log grammar untouched). Followed.

## Critical

None.

## Important

- **N-1 (plan 95, 144-145).** `mock.clock(on)` answers `$.clock` only ("Answers `$.clock` from a clock in memory … `clock.now` reads it", `types` on
  `Mock.clock`; `Date.now` appears nowhere in the 20,426-line types file). The reference's `const nowMs = () => Date.now()` (`ref:hooks/register.ts:43`)
  is used for nothing a test asserts on, and its tests use `clock.advance` only to fire timers. A hook that times `next(e)` with `Date.now()` sees ~0 ms
  no matter how far the test advances the mock clock, so the Ledger test's 100 / 2000 / 50 ms durations (and `Bash 2,000ms`, `Read 150ms`) cannot be
  produced. Fix: time with `await $.clock.now()` before and after `next(e)`; in the test, the downstream `on('tool.call', …)` hook does
  `await clock.sleep(ms)` (`MockClock.sleep`: "how a hook of the test's answers late") while the test advances the clock. Drop "as the reference does".
- **N-2 (plan 93-94, 135-136).** `SessionCompactInput.trigger` is `'manual' | 'auto' | 'plugin' | 'precompute'` (`types:10313`), and "`precompute` is the
  one dispatch that installs nothing: its result is kept for the next compaction" (`types:10310`). Its result is not `{ skip }`, so the plan's rule counts
  it, and then counts the real compaction again — two per compaction, plus a nudge re-armed before the context actually shrank. Fix: count and re-arm
  only when `e.agentId === undefined`, `e.trigger !== 'precompute'` and the result is not `{ skip }`; add a Subagent-scope case: a `session.compact` with
  `trigger: 'precompute'` leaves the count at 0.
- **N-3 (plan 33, 162, 165).** Line 33 says the reference "uses … `$.process.run`". It does not: no `process.run` call or `$.process` anywhere under
  `code-modernization/hooks/`, and its tests mock no process. So the plan's "with `$.process.run` mocked" (162, 165) names a mechanism nothing shows how to
  do. `'process.run'` is a hookable event (`types:6831`, result `{ exitCode, stdout, stderr, … }` `types:7700-7709`), and the kit's rule is that a test
  mocks a noun by registering a hook beneath. Fix: drop `$.process.run` from line 33, and state in the `/kaizen-stats` cases that the test registers
  `on('process.run', …)` returning `{ exitCode: 0, stdout: <fixture JSON>, stderr: '' }` (and `exitCode: 1` / `stdout: 'not json'` for the error cases),
  recording `e.argv` for the "called with `node`, …" assertion.
- **N-4 (plan 62-65, 113-114).** The 2.1.289 engine writes the types "beside that mod as `.claude-plugin/types/claude-code/index.d.ts`" (`types:5-6`) and
  recommends `"include": [".claude-plugin/types", "hooks", "types", "tests"]` (`types:76`); the 2.1.280 binary's `/plugin-types` writes `.claude/types`.
  The executor's build decides which. `.claude-plugin/` is inside `PUBLISHED_PATHS` (`scripts/sync-plugin.ts:24`) and the dirty check
  (`scripts/sync-plugin.ts:114`, `git status --porcelain -- plugin .claude-plugin`), so on the newer layout the generated types (a) make the tree dirty
  and block `pnpm plugin:sync` until ignored, (b) are hashed and shipped by sync if merely untracked, and (c) are not covered by the gitignore line the
  plan names. Fix: ignore both `plugin/.claude/types/` and `plugin/.claude-plugin/types/`; make the manifest test tolerate either; make `hashTree`
  skip ignored paths or exclude `types/` explicitly, with a sync test that a tree differing only under `.claude-plugin/types/` keeps the clean digest.
- **N-5 (plan 40-42, 183).** "`claude plugin validate plugin` fails on `main` today, because the name … is reserved" is false on this machine:
  `claude plugin validate plugin` on 2.1.280 printed `Validation passed with warnings` (one author warning). The plan already drops validate as a gate, so
  behaviour is unaffected, but the executor would otherwise skip a check that works. Fix: replace with "validate's result is build-dependent; run it and
  report the output in the PR". Related: line 183's `claude plugin details claude-agents-dashboard` reads the *installed* copy, which is a snapshot
  (`.claude/CLAUDE.md` §Commands, `plugin:sync`), so before `pnpm plugin:sync` it shows the old plugin. Say "after sync" or read `plugin/hooks/hooks.json`
  directly for that Done-when line.
- **N-6 (plan 75-77, 106, 173-174).** `kaizenScriptPath()` must turn `import.meta.url` into an absolute path, and the module "runs in an environment of
  its own, with no DOM and no Node" (plugin-authoring skill), so `node:url`'s `fileURLToPath` is unavailable there; the same file is imported by the
  `[repo]` test under Node. Fix: specify `decodeURIComponent(new URL('../skills/kaizen/kaizen.mjs', import.meta.url).pathname)` with no `node:` import
  (both runtimes have WHATWG `URL`), and have the [repo] Path test assert the returned string starts with `/` and `existsSync` is true. Keep Done-when 189.

## Minor (file only)

- **M-1 (plan 24).** Version drift: plan says 2.1.285, review 1 saw 2.1.292, this machine runs 2.1.280, the bundled skill's types say 2.1.289. Restate the
  version the executor actually runs, since N-4 depends on it.
- **M-2 (plan 100).** "Unless the result denies": `ui.close` result is `void` on 2.1.289 (`types:6927`). The reference's `result.deny !== undefined` check
  (`ref:hooks/register.ts:925-935`) is from an earlier shape. Say "await `next(e)`, then mark closed" and let the API win, as line 22 already allows.
- **M-3 (plan 91, 132).** `SessionContextUsage.tokens` is optional (`types:10412`). State what the status line prints before the first reading with
  `tokens` (for example `ctx —`), or the Measure test's first assertion is under-specified.
- **M-4 (plan 72-73).** The plural rule (80-81) names `turn` and `compaction` only; `3 subagents` is pinned but `1 subagent` is not. Add it to the rule.
- **M-5 (plan 54, 139).** The toast copy is only "names `/compact`". The spec's example is `ctx 180k — ~9k replayed per turn; phase done? /compact`. Pin
  the copy, or state that the per-turn figure is dropped (it needs a turn count and a delta the meter does not keep).
- **M-6 (plan 106).** Step 5 restates the resolver ("resolved from the module's own `import.meta.url`") instead of "use `kaizenScriptPath()`". One name.
- **M-7 (plan 99).** What the `kaizen-stats` `command.run` hook returns (`{ text }` or nothing) is unstated; the types say a command hook answers with
  `{ text }`. Say which, and that the text is empty or one line.
- **M-8 (plan 166).** `$.prompt` has `read`, `fill`, `suggest` and no `submit` method on this build (`types:2872` region), so "never calls
  `$.prompt.submit`" asserts the absence of something that cannot be called. Replace with: no `prompt.submit` event is dispatched (hook it in the test).
- **M-9 (plan 85, 47-48).** A modules-only `hooks.json` is valid (the test harness itself writes `{"modules":["./register.js"]}`); the reference file also
  carries command hooks. No change needed; recorded so the executor does not copy the reference's `hooks` key.
- **M-10 (plan 53).** `userConfig` type `number` exists (`ConfigKind`, `types:1875`) and the binary handles it. Confirmed, no change.
- **M-11 (plan 108-110).** Limits confirmed from the types: `timeoutMs` default 30 s, ten minutes at most (`types:3407`); each stream's first 4,194,304
  bytes with `isStdoutTruncated` (`types:3408`, `:7700`). Replace "unconfirmed" with these, and have the error line fire when `isStdoutTruncated` is set.
