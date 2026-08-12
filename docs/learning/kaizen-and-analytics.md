# kaizen + the Analytics tab — a Node/React learning walkthrough

This guide teaches how the `/kaizen` skill turns a finished session into a
post-mortem, and how the dashboard's **Analytics** tab builds its per-session
metadata from what `/kaizen` leaves behind. It focuses on *why* each piece was
built the way it was, contrasting each choice with the naive alternative.

> Mental model up front: `/kaizen` is a **producer**, the Analytics tab is a
> **consumer**, and the only wire between them is one append-only text file —
> `~/.claude/session-analytics-log.md`. Work is split in two: a **deterministic
> analyzer** computes every number, and **the LLM** supplies the judgment. The
> dashboard never writes — it recomputes the numbers live and pairs them with the
> one thing it *can't* recompute: the human-written lesson.

---

## 1. The skill is two files with two responsibilities

`.claude/skills/kaizen/` is:

- **`SKILL.md`** — instructions *to Claude*: the 7-step loop, how to read the
  numbers honestly, when to promote a lesson to global config.
- **`kaizen.mjs`** — a zero-dependency Node script that emits a `SessionAnalysis`
  JSON. Pure arithmetic, no LLM.

**Why split them?** The naive alternative is to let the model eyeball the
transcript and estimate "this cost about a million tokens." That hallucinates
figures and is never reproducible run-to-run. Pushing all arithmetic into
`kaizen.mjs` makes the numbers exact and deterministic; the skill explicitly
forbids the model from inventing them (`.claude/skills/kaizen/SKILL.md:19`). The
model only does what math can't — judge whether the work was any good.

The `.mjs` is deliberately zero-dep pure Node (not `tsx`, no repo) so the *global*
skill runs in **any** project. It is a hand-port of `server/lib/{analyze,agents,
scan}.ts`, which the header names as the unit-tested source of truth
(`.claude/skills/kaizen/kaizen.mjs:12`).

- **Bad alternative:** `import`-ing the repo's TypeScript directly. Con: the skill
  would only work inside this repo, with `tsx` installed. **Chosen:** duplicate the
  logic as vendored plain Node — costs a sync burden, buys "runs anywhere."

---

## 2. Reading tokens honestly — two totals, not one

`analyzeSession()` (`.claude/skills/kaizen/kaizen.mjs:188`) streams the `.jsonl`
line by line and, for each **assistant** message, sums
`usage.{input, output, cache_creation, cache_read}_tokens`. It derives two
headline totals (`kaizen.mjs:297`):

- `billableApprox` = `input + output + cacheCreation` — **real cost**; lead with it.
- `combined` = that **plus** `cacheRead`.

**Why two?** `cacheRead` is the cached prompt replayed on *every* turn, billed at
only ~10%. Reporting `combined` as "the cost" makes a long session look ~10× more
expensive than it was. So `combined` is only a *context-pressure* signal, never
"what this cost." The `notes[]` array bakes this caveat into the payload itself
(`kaizen.mjs:283`) so no downstream consumer can forget it.

- **Bad alternative:** report a single `total = everything`. Con: conflates real
  spend with cheap replayed cache; every retrospective over-reports cost.

### `byTool` is honest about being approximate

The transcript has **no per-tool token field**. So the analyzer takes each turn's
total output tokens and splits it *evenly* across the tool calls in that turn
(`kaizen.mjs:243`). That is why `approxOutputTokens` is labeled "approx"
everywhere. What *is* exact: `count`, `errors`, and `durationMs` — so firm claims
lean on those.

- **Bad alternative:** present a precise per-tool token cost. Con: it would be a
  fabrication — the data to compute it does not exist on disk.

### Subagents: counted separately, and exactly

`readAgents()` (`kaizen.mjs:131`) is a small event-parser/reducer that pulls exact
subagent `tokens`/`toolUses`/`durationMs` from two places: the `toolUseResult` on a
sync result block, and the `<subagent_tokens>` / `<tool_uses>` / `<duration_ms>`
tags inside async `<task-notification>` blocks. These are kept **out** of `totals`
and reported in `subagentTotals` instead (`kaizen.mjs:277`).

**Why separate?** This threads between two bad alternatives. Subagent turns carry
`isSidechain: true`:

- Count them in the main totals → **double-count** (they are already summarized
  back into the parent turn).
- Drop them entirely → **undercount** the session's true work.

So the analyzer skips sidechain lines for the main total (`kaizen.mjs:217`) *and*
re-adds exact subagent numbers as their own bucket. Hence the rule the skill
states: whole-session ≈ `combined` + `subagentTotals.tokens` (`kaizen.mjs:288`).

### Error signals are heuristics, and say so

`errorSignals` (`kaizen.mjs:301`) carries `toolErrors` (exact: `is_error` or
`<tool_use_error>`), `retries` (a tool re-run after it errored — a rework signal),
and `userCorrections` (a keyword regex like *no/wrong/actually/revert*). The last
is explicitly a "noisy lower bound, not a score." The skill therefore requires the
accuracy read to be a hedged verdict, never a fake percentage — there is no ground
truth on disk.

---

## 3. The 7-step loop and the global learning log

`SKILL.md` walks: (1) run the analyzer → (2) read tokens honestly → (3) find the
cost sinks → (4) hedged accuracy read → (5) concrete improvements → (6) **append
one lesson** → (7) offer to codify it.

Step 6 is the one that feeds Analytics. It appends exactly one line to
`~/.claude/session-analytics-log.md` in this **contract format**
(`.claude/skills/kaizen/SKILL.md:90`):

```
- 2026-07-12 [claude-agents-dashboard] d04e9b52: 1.0M billable (12.1M ctx), top cost 4 subagents (233k)... Lesson: <one concrete takeaway>.
```

The log is **global** (`~/.claude`, not per-project) on purpose: most habits —
verbose subagents, context bloat — recur regardless of repo, so one aggregation
layer beats scattered per-project notes. Step 6's "cross-project pattern watch"
counts *distinct `[project]` tags* expressing the same habit; at **≥ 4 distinct
projects** it flags the lesson for promotion to global `~/.claude/CLAUDE.md` (step
7) — but never silently; it is the user's call.

- **Bad alternative:** write the lesson into each project's `CLAUDE.md`. Con:
  cross-project habits fragment across five files and the recurrence is invisible.

### 3a. Two more line shapes, and why the log is append-only

A lesson alone can't say whether anyone *acted* on it, so step 7 appends a second
kind of line once the user has decided, and a `/kaizen review` sweep appends a
third. Three shapes, one grammar:

```
- 2026-07-12 [dashboard] d04e9b52: … Lesson: <takeaway>.              ← the lesson (step 6)
- 2026-08-01 [dashboard] d04e9b52: status actioned — project CLAUDE.md ← its fate (step 7)
- 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2            ← a sweep happened
```

`status` is `actioned` | `promoted` | `dropped`; a lesson with **no** status line
is still open. Note what step 7 does *not* do: edit the original line to mark it
done.

**Why append a second line instead of updating the first?** This machine runs many
sessions at once — that is the dashboard's whole reason to exist — and they share
this one file. A read-modify-write of a shared file races: the loser's entries
vanish with no error and no signal that anything was lost. Append-only makes
concurrent writers safe by construction, at the cost of a log that must be *read*
as an event stream rather than a table.

- **Bad alternative:** rewrite the lesson line to `[ACTIONED]`. Con: every status
  update becomes a whole-file rewrite that can silently eat a parallel session's
  freshly-logged lesson.

The third shape exists because per-session runs only ever see one session.
`/kaizen review` sweeps the whole log — grouping open lessons across projects,
promoting the recurring ones, pruning rules that never fire — and its `review:`
marker is how the next run (and the dashboard) knows when that last happened.

---

## 4. How the Analytics tab builds its metadata

The step-6 log line is the **sole trigger**. A session appears in the tab *only*
because `/kaizen` logged it. The pipeline is three small pure functions.

### 4a. Parse the log → lessons, statuses, review markers

`server/lib/sessionAnalyticsLog.ts` has one regex per line shape: `LINE_RE`
(`sessionAnalyticsLog.ts:66`) pulls `{date, project, idPrefix, lesson}` out of a
lesson line, `STATUS_RE` (`:69`) a `{status, date, note}`, `REVIEW_RE` (`:73`) a
sweep marker. `idPrefix` is a **short prefix** of the transcript UUID (`d04e9b52`),
not the full id. `recentLessons()` (`:184`) scans entries newest-first, dedupes by
`idPrefix` (a re-analyzed session keeps only its latest line), and caps at N.
Everything is **fail-open** — an unparseable line is skipped, a missing file yields
`[]`, it never throws.

`parseLogEvents()` (`:93`) reads all three shapes in one pass, and classifies each
line by the **first** pattern it matches: status → review → lesson. That ordering
is load-bearing — a status note that happens to contain the word `Lesson:` would
otherwise be parsed as a lesson and conjure a phantom card.

**Why keep the old single-shape parser too?** `parseSessionAnalyticsLog()` is still
what `scan.ts` calls, and the two new shapes have no `Lesson:` in them — so they
are *invisible* to it. Adding a line shape therefore can't disturb an existing
consumer, and that property is pinned by a test.

- **Bad alternative:** widen `LINE_RE` into one regex covering all three shapes.
  Con: every existing caller inherits the new shapes whether it wants them or not,
  and one regex serving three grammars is where the phantom-lesson bug lives.

`statusForSession()` (`:132`) then answers "what became of this session's lesson?"
— prefix match, newest wins, exactly mirroring `lessonForSession`.

### 4b. Resolve + re-analyze live

`server/lib/analytics.ts` `listReports()` (`analytics.ts:42`) is the heart. For
each recent lesson it:

1. Resolves `idPrefix` → a real transcript by **prefix-matching** the enumerated
   `listTranscripts()` list (`analytics.ts:51`).
2. Runs `analyzeSession(ref.file, ref.id)` **live** — the same analyzer, re-run
   fresh on every request.
3. Assembles an `AnalyticsReport` = `{sessionId, project, cwd, models, loggedAt,
   analysis, lesson, lessonStatus}` (`analytics.ts:55`).

If the transcript is gone, `analysis` is `null` and the card falls back to a
lesson-only view; `project` then falls back to the log's `[project]` tag.

`lessonStatus` is matched against the **resolved** full session id, not the logged
prefix — so a status line written months later, with a differently-truncated id,
still finds its lesson.

### 4c. The endpoint and the contract type

`serveAnalytics()` (`server/api.ts:369`) is `GET /api/analytics` →
`AnalyticsResponse {generatedAt, keep, reports, lastReviewAt, reviewDue}`. It is
**fail-open**: any throw logs and returns an empty list with `error: true`. It is
*not* polled (config changes only when `/kaizen` runs); it is fetched on section
mount + manual refresh. Config knobs: `ANALYTICS_KEEP=5`, `SHOW_ANALYTICS`
(`server/lib/config.ts:115`). The whole FE/BE contract is `SessionAnalysis`,
`AnalyticsReport` and `LessonStatus` in `shared/types.ts:311` — the single source of
truth both sides import as `type`.

`reviewStatus()` (`analytics.ts:77`) computes `reviewDue`: lessons exist **and** no
`review:` marker within `REVIEW_INTERVAL_DAYS` (7). Two deliberate asymmetries — an
empty log is never "due" (nothing to sweep, so nagging a fresh install is noise),
while a log that has *never* been swept is due immediately. `now` is injectable, so
the 7-day boundary is unit-tested rather than waited out.

---

## 5. The key design decision: re-analyze live vs store the report

There was a *removed* alternative (`.claude/rules/analytics.md`): an earlier version
had `/kaizen` **POST the full report JSON** and the dashboard persist it. It was
scrapped. The trade-off:

| Store report JSON (rejected)                       | Re-analyze live (chosen)                          |
| -------------------------------------------------- | ------------------------------------------------- |
| Two writers → dashboard loses its read-only invariant | Only `/kaizen` writes; dashboard is a pure reader |
| Numbers freeze at analysis time, go stale          | Numbers always reflect the current transcript     |
| Needs a write endpoint + schema + storage          | Log holds only the lesson; numbers are recomputed |

The insight: **the numbers are deterministically recomputable, but the lesson is
not.** So the log stores only the irreducible human judgment, and the
expensive-*looking* "re-run the analyzer on every request" is actually the cheap,
correct choice.

### Prefix-match, never path-join

`idPrefix` is validated against `ID_RE` (`analytics.ts:24`) and used to `.find()`
within an *already-enumerated* transcript list — it is **never joined into a
filesystem path**. Same philosophy as `serveSessionDetail`.

- **Bad alternative:** `path.join(projectsRoot, idPrefix + '.jsonl')`. Con: a
  user-influenced string flowing into a path is a traversal waiting to happen.

---

## 6. FAQ: "How does the kaizen skill work?"

It runs a zero-dep Node analyzer (`kaizen.mjs`) over a session's transcript to get
*exact* token/tool/subagent numbers, then the LLM adds the judgment the numbers
can't: what the cost sinks were, an honest (hedged) accuracy read, and concrete
improvements. It closes by appending **one** dated lesson line to the global
`~/.claude/session-analytics-log.md`, and — if the same habit has now shown up in
≥ 4 projects — offers to promote it to global `CLAUDE.md`. Whatever the user decides
(including "no"), it appends a `status` line so the lesson is settled instead of
being re-proposed forever. The division of labor is the whole point:
**deterministic numbers, human judgment, never mixed.**

Two smaller modes hang off the same log. **Mid-session capture**: when the user
corrects course, the lesson is appended *then* — friction is most accurate at the
moment it happens, and reconstructing it later from a keyword count over the
transcript is guesswork. A later full run supersedes it automatically, since
consumers keep the newest line per session. **`/kaizen review`**: a whole-log sweep
that batches promotions and prunes rules that stopped earning their keep, because
config only ever grows unless something removes from it — and every line of a
`CLAUDE.md` is paid for in input tokens on every session.

## 7. FAQ: "How is the Analytics tab's metadata built?"

Entirely from that one log file, read-only. `sessionAnalyticsLog.ts` parses each
line into `{date, project, idPrefix, lesson}` and takes the newest N (deduped), and
in the same pass collects the `status` lines and the newest `review:` marker.
`analytics.ts` resolves each `idPrefix` to a transcript by prefix-match, re-runs the
*same* analyzer live to regenerate fresh numbers, and packages
`{analysis, lesson, lessonStatus, …}` into an `AnalyticsReport`. `serveAnalytics`
returns them at `GET /api/analytics`, along with `lastReviewAt` / `reviewDue`. The
lesson and its status are the only stored artifacts; every number on the card is
recomputed on the fly, so the dashboard stays read-only and never shows stale
figures.

---

**Relevant files**

- `.claude/skills/kaizen/SKILL.md` — the LLM instructions: 7-step loop, token-honesty rules, promotion policy, the status/review/capture modes.
- `.claude/skills/kaizen/kaizen.mjs` — the zero-dep deterministic analyzer (`analyzeSession`, `readAgents`); vendored port of the server libs.
- `~/.claude/session-analytics-log.md` — the single append-only wire between producer and consumer (global; lesson, status and review lines).
- `server/lib/sessionAnalyticsLog.ts` — parses the log (`LINE_RE`/`STATUS_RE`/`REVIEW_RE`, `parseLogEvents`, `recentLessons`, `statusForSession`); fail-open.
- `server/lib/analytics.ts` — `listReports`: prefix-resolve transcript, re-analyze live, build `AnalyticsReport`; `reviewStatus`: the 7-day sweep clock.
- `server/lib/analyze.ts` — the in-repo source of truth for the analyzer (`kaizen.mjs` mirrors it).
- `server/api.ts` — `serveAnalytics` (`GET /api/analytics`), fail-open.
- `shared/types.ts` — `SessionAnalysis` / `AnalyticsReport` / `AnalyticsResponse`, the FE/BE contract.
- `server/lib/config.ts` — `ANALYTICS_KEEP`, `SHOW_ANALYTICS` toggles.
- `.claude/rules/analytics.md` — the read-only invariant and the removed POST-report design.
