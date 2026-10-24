# Routine Drawer Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the routine drawer's raw-file textarea with summary rows (a field registry over the same text), add a Form | File switch, a `cron: manual`
schedule end to end, and words for any cron in `describeCron`.

**Architecture:** The text stays the only state. A pure client module (`client/src/lib/routineForm.ts`) holds one field definition per row — `read(text)`,
`write(text, value)`, `summary(value)` — and an error router; React only renders it. Manual is a new value of the existing `cron` field: the shared parser
accepts it, reconcile and the API never desire it, the ledger never reads it as paused.

**Tech Stack:** TypeScript, React (Vite), Node + tsx, node-assert tests via `test/run-all.ts`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-routine-form-design.md` (read it whole before any task; the mockups it links are also in the author's scratchpad
at `/private/tmp/claude-501/-Users-andrejajevtic--claude-spares-spare-ERQr8H/42220fb0-1f89-4c88-be8b-95a08ee7998a/scratchpad/routine-form.html` — read
that file for every opened row's look and its CSS).

**This plan specifies behaviour and exact test cases, not literal code** (an override of the writing-plans template, per the user's global rules). Signatures,
values and test assertions are fixed here; bodies are the implementer's. Disagree with the plan when the code says otherwise, and say so in the task report.
Size budgets anywhere below are soft.

## Global Constraints

- ESM; server imports use the `.js` suffix; client imports from `shared/` as the existing files do: three hops from `client/src/lib/*.ts`
  (`../../../shared/...`, as `routines.ts:8`), four from `client/src/components/routines/*.tsx` (`../../../../shared/...`).
- No new dependency anywhere. No new API field; Manual is the value `'manual'` of `RoutineJob.cron` (the spec leaves the representation open; this plan picks
  the plain string).
- CSS: existing class names stay (`.rtn-drawer`, `.rtn-field`, `.rtn-ta`, `.rtn-vmsg`, `.seg`, `.rtn-pick`, `.rtn-in`, `.rtn-kind` …); new classes start
  `rtn-f-`; no literal colour or shadow below the theme-token block of `client/src/styles.css`; never restyle `.seg` globally (scope under an `rtn-f-` class).
- A form write touches only the lines its field owns; every other byte (comments, order, quoting, CRLF) survives. A field writes a key only when its value
  differs from what it read.
- Inserted keys go after the nearest *preceding* key that exists, in this order: `cron, machines, run, foreach, cwd, enabled, model, effort, permission-mode,
  allowed-tools, max-turns, timeout`; with none present, before the closing `---`.
- `plugin/lib/{cron,frontmatter,routine-file}.mjs` are generated: after any change to `shared/cron.ts` or `shared/routine-file.ts` run `pnpm plugin:gen` and
  commit the output with it.
- Tests: add cases to the named existing test file (each exports `run()` and is already wired into `test/run-all.ts`); a new test file must be imported and
  called in `test/run-all.ts` the same way. Run single files with `npx tsx test/<file>.test.ts`. Never run the whole `pnpm test` before a push (CI does).
- Comments explain why, not what; wrap new prose at 160 columns.
- Commits: `git add <files>` then `git commit -- <files>` as separate commands, Conventional Commits, ending with
  the Co-Authored-By attribution line the implementing session is given. Never push.

## Review Focus

1. **A file written by hand with comments and quoting** (the `jobTemplate` heads carry a trailing `# …` comment on every line): a row edit must keep the
   comment and the alignment padding, and a row the user never touched must not requote its value. Pinned by Task 4's byte-identity cases.
2. **CRLF files** (written on Windows / WSL editors): writes and removals keep `\r\n`; a removed line leaves no stray `\r`. Pinned by Task 4.
3. **A file switched from a schedule to Manual and back** while the ledger shows it: the row must never read "paused", never show a next fire for Manual, and
   reconcile must uninstall on the switch. Pinned by Task 2.
4. **Mid-typing Custom cron** (`*/1`, `25 9 * *`): must stay Custom with its text, never flip to a preset or lose characters. Pinned by Task 5.
5. **A field whose line exists in a shape the form cannot write** (block-list `allowed-tools:`, an unclosed bash fence, an unknown machine): shows
   "edit in File" and the write is never called. The read side is pinned by Task 4; that the row never writes is checked by hand in Task 7 Step 2b.

---

### Task 1: `cron: manual` in the shared parser

**Files:**
- Modify: `shared/cron.ts` (new export), `shared/routine-file.ts:118-125` (cron block) and `:148-152` (launchd check), `shared/types.ts:2043` (comment)
- Regenerate: `plugin/lib/cron.mjs`, `plugin/lib/routine-file.mjs`
- Test: `test/cron.test.ts`, `test/routine-file.test.ts`

**Interfaces:**
- Produces: `isManualCron(cron: string): boolean` in `shared/cron.ts` — true exactly for the string `manual` after trimming (case-sensitive; `Manual` is
  not manual and fails as a cron). Every later task uses this, never a string compare of its own.

- [ ] **Step 1: Failing tests.** In `test/cron.test.ts`: `isManualCron('manual') === true`, `isManualCron(' manual ') === true`, `isManualCron('Manual')
  === false`, `isManualCron('0 9 * * *') === false`. In `test/routine-file.test.ts` (use its existing job-text builder):
  - (the file's `claude(...)` / `shell(...)` builders at `:33-39` hardcode `cron: "0 9 * * *"`, so passing `cron: manual` through `extra` gives `cron given
    twice`; `.replace('cron: "0 9 * * *"', 'cron: manual')` on their output, or write the text inline)
  - `cron: manual` with `machines: [mac, wsl]`, `run: shell`, a bash block → `errors` is `[]`, `job.cron === 'manual'`.
  - `cron: "manual"` (quoted) → valid, `job.cron === 'manual'`.
  - `cron: manual` with `machines: [mac]` → no launchd error (the dom/dow check is skipped).
  - no `cron:` line → still exactly `{ line: 0, message: 'cron is required' }` among the errors.
  - `cron: Manual` → an error on the cron line (the five-fields message), not valid.
- [ ] **Step 2:** `npx tsx test/cron.test.ts` and `npx tsx test/routine-file.test.ts` — the new cases fail.
- [ ] **Step 3:** Add `isManualCron`. In `parseJob`, a cron value for which `isManualCron` holds is accepted without `parseCron`; the launchd check runs only
  for a cron that is not manual. Change the `RoutineJob.cron` comment to "Five-field cron or `manual`, local time of the machine that runs it."
- [ ] **Step 4:** `pnpm plugin:gen`; then the two files above plus `npx tsx test/plugin-manifest.test.ts` pass.
- [ ] **Step 5:** Commit `feat(routines): accept cron: manual in the job parser` with the three source files, the two test files and the two regenerated
  `.mjs`.

### Task 2: Manual end to end — reconcile, API, ledger, menu, docs

**Files:**
- Modify: `server/lib/routine-reconcile.ts:203-210` (`notDesired`), `server/api.ts:1953-1959` (`routineSummary`) and `:1985-1994` (`desired` in
  `serveRoutines`), `client/src/lib/routines.ts:124-127` (`rowText`), `client/src/components/routines/JobLedger.tsx:62` (the one `dotTone` caller to
  change; `RunsList.tsx:78` passes `true` and stays), `:86-89, 97`, `plugin/lib/run-routine.mjs` (test only, no change expected), `client/src/components/routines/JobMenu.tsx:26-28`, `docs/subsystems/routines.md:72` (key table), `:118` (§Reconcile "Desired is…")
- Test: `test/routine-reconcile.test.ts`, `test/api-routines.test.ts`, `test/routines-view.test.ts`, `test/run-routine.test.ts`

**Interfaces:**
- Consumes: `isManualCron` (Task 1).
- Produces: `scheduled(job: RoutineJob): boolean`, exported from `server/lib/routine-reconcile.ts` — `job.enabled && !isManualCron(job.cron)`. `notDesired`
  keeps its distinct reasons (`manual` before `disabled`) but `serveRoutines`' `desired` is `s.job !== null && scheduled(s.job) && onThisMachine`, so the two
  can't drift.
- Produces: `pausedLook(job: RoutineJob | null): boolean` in `client/src/lib/routines.ts` — true when the job exists, `enabled === false` and its cron is not
  manual. The ledger's muted name, its dot (`dotTone(pill, !pausedLook(job))`) and `rowText`'s "paused" all go through it.

- [ ] **Step 1: Failing tests.**
  - `test/routine-reconcile.test.ts`, in the style of "mac: a disabled file → remove": (a) a manual file (`cron: manual`, enabled) with nothing installed
    plans no change for it; (b) the same job installed from an earlier
    scheduled version plans `pull-pins:remove:manual` on mac (the `actions()` shape the disabled case asserts), and the wsl twin removes its crontab line.
    The new reason string is exactly `manual`. For (a), assert the action list has no `pull-pins:` entry at all.
  - `test/routine-reconcile.test.ts`: `scheduled` — enabled scheduled → true; disabled scheduled → false; enabled manual → false; disabled manual → false.
  - `test/api-routines.test.ts`, beside the `installedFrom` unit test (`:189-202`, next to its `:199` `desired=false` case):
    `installedFrom(report('in-sync', [], 1), 'x', scheduled(manualJob))` is false.
  - `test/run-routine.test.ts`, mirroring the `--trigger schedule 20 min after the slot` case (`:684-692`): a `cron: manual` shell job run with `--trigger
    schedule` exits 0 and its start record has `kind === 'start'` (a refusal record has no `slot` either), no `slot` key, and `late` is not true.
  - `test/api-routines.test.ts`: `/validate` of a manual job's text answers a
    summary starting `manual · shell ·` and not containing `paused`; with `enabled: false` added the summary still has no `paused`.
  - `test/routines-view.test.ts`: `rowText` of a manual job row with `enabled: false` and no runs → `nextLine === 'manual'` and pill `never run`;
    with `enabled: true` → `nextLine === 'manual'`; a scheduled job with `enabled: false` still reads `paused`; a manual job not on this machine reads
    `nextLine: '—'` and the `<machines> only` pill, as any job off this machine does (that branch keeps winning). `pausedLook`: null → false; scheduled
    disabled → true; manual disabled → false; scheduled enabled → false.
- [ ] **Step 2:** Run the four files; the new cases fail, except the run-routine pin, which already passes once Task 1 regenerated `routine-file.mjs`
  (`run-routine.mjs:265-267` records no slot when `parseCron` fails) — it guards against a regression, not a missing feature.
- [ ] **Step 3:** `notDesired` returns `'manual'` for a manual cron, checked right after `invalid` and before `disabled`. `serveRoutines`' `desired` also
  requires the cron not be manual. `routineSummary` appends `paused` only when `pausedLook`-equivalent holds (server side: `!enabled && !isManualCron(cron)`);
  `when` already falls back to `job.cron` for an unparsed cron, so it reads `manual` — keep that, don't special-case it. `rowText`'s `nextLine` is `manual`
  for a manual job before the paused check.
- [ ] **Step 4:** Ledger: dot and muted name use `pausedLook`; the enabled toggle (`toggle`, both the desktop cell and the phone `.rtn-act` copy) is not
  rendered for a manual job; `JobMenu` does not render Pause/Resume for a manual job. The when column already shows `manual`; leave it.
- [ ] **Step 5:** Docs: `routines.md` key table `cron` row → "five fields, local time of the machine that runs it, or `manual` (never installed; Run now
  only)"; the §Reconcile sentence gains "and a cron other than `manual`", and the reasons list (if the section enumerates `disabled`) gains `manual`.
- [ ] **Step 6:** Run the four test files and `pnpm typecheck`; all pass.
- [ ] **Step 7:** Commit `feat(routines): manual jobs are never installed and never read as paused`.

### Task 3: `describeCron` words for steps, ranges and lists

**Files:**
- Modify: `shared/cron.ts:161-182` (`describeCron` and helpers)
- Regenerate: `plugin/lib/cron.mjs`
- Test: `test/cron.test.ts:208-227`

**Interfaces:**
- Produces: `describeCron(cron: Cron): string` — same signature; output changes only for shapes it used to return as source.

**Rules** (the spec leaves wording to the builder; these are the plan's choice). The four shapes it phrases today come first and keep their exact text
(`22:00 daily`, `07:00 Mon–Fri`, `Sun 09:00`, `1st of month 09:30`). Everything else is `[T, D, Mo].filter(Boolean).join(', ')`, where any part that
cannot be phrased makes the whole result `cron.source`:

- **T (time).** One minute + one hour → `HH:MM`. One minute + every hour → `Every hour at :MM`. One minute + hour written `*/N` (values 0, N, 2N … to the
  end of the range, N ≥ 2) → `Every Nh at :MM`. One minute + a contiguous hour range a–b (≥ 2 hours, not all 24) → `Every hour HH:MM–HH:MM` (both ends at
  that minute). One minute + 2–4 non-contiguous hours → the times joined by `, ` (`09:00, 13:00, 17:00`). Every minute (60 values) → `Every minute`, or
  `Every minute, HH:00–HH:59` over a single hour or a contiguous hour range that is not all 24. Minute written `*/N` (0, N … to 59; N ≥ 2) →
  `Every N minutes`, plus `, HH:00–HH:LL` over a single hour or a contiguous hour range that is not all 24 (LL = the last minute value). Anything else → unphraseable.
- **D (days).** Every day (dom and dow both unrestricted) → empty. Weekday-only: one → `Mon`; a contiguous run → `Mon–Fri`; otherwise names joined by `/`
  (`Mon/Wed/Fri`), in Sun..Sat order. Day-of-month-only: one → `1st of month`; contiguous → `1st–7th of month`; otherwise `1st/15th of month`. Both
  restricted → unphraseable.
- **Mo (months).** All → empty; one → `Jan`; contiguous → `Jun–Aug`; else `Jan/Apr/Jul/Oct`.

- [ ] **Step 1: Tests.** Keep the two existing "named shapes" and "ordinals" tests as they are (they pin the old wording). Replace "anything else is the
  expression itself" with these exact pairs (input → output):
  - `*/15 9-17 * * 1-5` → `Every 15 minutes, 09:00–17:45, Mon–Fri`
  - `*/30 9-18 * * 1-5` → `Every 30 minutes, 09:00–18:30, Mon–Fri` (the visual fixture's `pr-triage`)
  - `*/15 * * * *` → `Every 15 minutes`
  - `* * * * *` → `Every minute`
  - `* 9-17 * * *` → `Every minute, 09:00–17:59`; `* 9 * * *` → `Every minute, 09:00–09:59`; `*/15 9 * * *` → `Every 15 minutes, 09:00–09:45`
  - `25 * * * *` → `Every hour at :25`
  - `25 */2 * * *` → `Every 2h at :25`
  - `0 9-17 * * *` → `Every hour 09:00–17:00`
  - `0 9,13,17 * * *` → `09:00, 13:00, 17:00`
  - `0  9   * *  1,3` → `09:00, Mon/Wed`
  - `0 9 * * 1,3,5` → `09:00, Mon/Wed/Fri`
  - `0 9 1 6 *` → `09:00, 1st of month, Jun`
  - `0 9 1,15 * *` → `09:00, 1st/15th of month`
  - `0 9 1-7 * *` → `09:00, 1st–7th of month`
  - `0 9 * 6-8 1-5` → `09:00, Mon–Fri, Jun–Aug`
  - fallbacks, returned as the normalised source: `0 9 1 * 1` (both day fields), `5,35 9 * * *` (two minutes), `*/15 */2 * * *`, `0 1,3,5,7,9 * * *`
    (five hours), `*/7 * * * *` is phrased (`Every 7 minutes`; 0,7…56 is a full `*/7`).
- [ ] **Step 2:** `npx tsx test/cron.test.ts` — new pairs fail, old shapes pass.
- [ ] **Step 3:** Implement. Detect `*/N` from the value set (start at the field minimum, constant step N, last value + N past the maximum), not from the
  source text, so `0-59/15` reads the same as `*/15`.
- [ ] **Step 4:** `pnpm plugin:gen`; `npx tsx test/cron.test.ts`, `npx tsx test/plugin-manifest.test.ts`, `npx tsx test/api-routines.test.ts` and
  `npx tsx test/routines-view.test.ts` pass (fix any expectation in those that pinned a raw-source `when`; note each in the commit body).
- [ ] **Step 5:** Commit `feat(routines): describe any cron in words`.

### Task 4: Field registry — line helpers and the non-schedule fields

**Files:**
- Create: `client/src/lib/routineForm.ts`
- Create: `test/routine-form.test.ts` (wire into `test/run-all.ts`)

**Interfaces:**
- Consumes: `writeFrontmatterLine`, `scalarEnd` (`shared/frontmatter.ts`); `readForeach`, `setRepos`, `ForeachMode` (`client/src/lib/routines.ts`);
  `JobError` (`shared/routine-file.ts`).
- Produces (all exported from `client/src/lib/routineForm.ts`):
  - `type FormKind = 'shell' | 'claude' | null` and `formKind(text: string): FormKind` — the `run:` value; anything else (or no line) is null.
  - `frontmatterReadable(text: string): boolean` — an opening `---` on line 1 and a closing `---`.
  - `fmValue(text: string, key: string): { value: string; line: number } | null` — the first top-level `key:` line inside the frontmatter: value with a
    trailing ` # comment` dropped (`scalarEnd`) and one pair of quotes removed; `line` is 1-based in the whole file.
  - `setKey(text: string, key: string, value: string | null): string` — `null` removes the key's line (only that line; CRLF kept on the others); a string
    writes in place via `writeFrontmatterLine`, or inserts after the nearest preceding existing key per the Global Constraints order.
  - `const UNREADABLE: unique symbol` and `type Read<V> = V | typeof UNREADABLE`.
  - `type FieldId = 'schedule' | 'machines' | 'repos' | 'script' | 'prompt' | 'model' | 'permission' | 'limits' | 'tools'`.
  - `interface Summary { text: string; tone: 'set' | 'dim' | 'err' }`.
  - `interface SummaryCtx { pinCount: number; kind: FormKind }` (limits needs the kind; the rest ignore it).
  - `interface FieldDef<V> { id: FieldId; label: string; keys: readonly string[]; kinds: readonly FormKind[]; read(text: string): Read<V>; write(text:
    string, v: V): string; summary(v: V, ctx: SummaryCtx): Summary }` — `keys` are the frontmatter keys it owns (empty for body fields).
  - Field values: `Machines = { mac: boolean; wsl: boolean }`; `Repos = { mode: ForeachMode; picks: string[]; cwd: string }`; `Script = string`;
    `Prompt = string`; `ModelEffort = { model: string | null; effort: string | null }`; `Permission = string | null`; `Limits = { maxTurns: string | null;
    timeout: string | null }`; `Tools = string[]`.
  - `FIELDS: { machines: FieldDef<Machines>; repos: …; script: …; prompt: …; model: …; permission: …; limits: …; tools: … }` (schedule joins in Task 5).
  - `visibleFields(kind: FormKind): FieldId[]` — in table order: shell → schedule, machines, repos, script, limits; claude → schedule, machines, repos,
    prompt, model, permission, limits, tools; null → schedule, machines, repos, limits.
  - `routeErrors(text: string, errors: JobError[], kind: FormKind): { byField: Partial<Record<FieldId, JobError[]>>; rest: JobError[] }`.

- [ ] **Step 1: Failing tests** in `test/routine-form.test.ts`. Use `jobTemplate('skill')` and `jobTemplate('shell')` from `client/src/lib/routines.ts` as
  fixtures (they carry trailing comments and alignment padding), plus a CRLF copy (`.replace(/\n/g, '\r\n')`). Cases:
  - `fmValue(skill, 'cron')` → `{ value: '0 22 * * *', line: 2 }`; `fmValue(skill, 'cwd')` → null (the `# cwd:` line is a comment).
  - `setKey(skill, 'model', 'sonnet')` changes only line 8: it equals the original line with `opus` replaced by `sonnet` (the padding after the value and
    the comment kept); every other line byte-identical (compare `split('\n')` with that one index excepted).
  - `setKey(skill, 'max-turns', null)` drops exactly that line; on the CRLF copy the result equals the LF result with `\n` → `\r\n`.
  - `setKey` inserting into a file without `effort:` but with `model:` puts `effort: high` on the line after `model:`; into a file with only `cron:`,
    `machines:`, `run:` it puts `timeout: 30m` after `run:`.
  - `formKind`: skill → `'claude'`; shell → `'shell'`; `run: bash` → null; no run line → null.
  - machines: `[mac, wsl]` → `{mac:true, wsl:true}`, summary `mac + wsl`; `[wsl]` → summary `wsl only`; `[]` → summary tone `err`, text `No machine`;
    `[mac, linux]` → UNREADABLE; a write of `{mac:true, wsl:false}` writes `machines: [mac]` keeping the template's comment; `{mac:false, wsl:false}` writes
    `machines: []`.
  - repos: read on skill → `{ mode: 'all', picks: [], cwd: '' }`, summary `All pinned (6)` with `pinCount: 6`; Pick `[a, b]` → summary `2 repos: a, b`;
    One folder with `cwd: ~/x` → summary `~/x`; no foreach and no cwd → summary dim `Routines folder's parent`. Writing mode cwd with cwd `~/y` drops
    `foreach:` and writes `cwd: ~/y`; cwd `''` removes `cwd:`. All/Pick writes delegate to `setRepos` (assert equality with `setRepos` output).
  - script: shell template → `git pull --ff-only --quiet`; write `echo hi` replaces only the fence's inside, fence lines and text before/after kept; a shell
    body with no fence reads `''` and writing `echo hi` appends `` ```bash\necho hi\n``` `` after the existing body text (one blank line between when the
    body is non-empty); an unclosed fence → UNREADABLE. Summary: first non-empty line; empty → tone `err`, text `Empty script`.
  - prompt: skill → `/git-sync`; write replaces everything after the closing `---` line, frontmatter byte-identical, result ends with one `\n`. Empty →
    summary tone `err`, text `No prompt yet`; long first line → cut at 60 chars with `…`.
  - model: skill → `{ model: 'opus', effort: 'medium' }`, summary `opus · medium effort`; both null → dim `Default model`; write `{model: null, effort:
    'medium'}` removes only `model:`; writing the read value back returns the text unchanged even when it was quoted (`model: "opus"`).
  - permission: skill → `acceptEdits`, summary `acceptEdits`; absent → dim `Default`; `bypassPermissions` reads as that token (summary shows it, tone
    `err`); write null removes the line.
  - limits: skill → `{ maxTurns: '60', timeout: '30m' }`, summary `60 turns · 30m timeout`; both absent on claude → `No turn limit · 1h timeout (default)`;
    with `kind: 'shell'` only the timeout part shows (`1h timeout (default)`). Writes: blank removes, `'2h'` writes `timeout: 2h`.
  - tools: skill → `['Bash', 'Read']`, summary `Bash, Read`; absent → dim `Any tool`; `[]` write removes the line; a block list (`allowed-tools:` then
    `  - Bash`) → UNREADABLE; writing `['Bash', 'Read']` back is a no-op.
  - `visibleFields` for each of the three kinds, exactly as listed above.
  - `routeErrors` on skill text: an error at the `model:` line → `byField.model`; at line 0 `claude job needs a prompt` → `byField.prompt`; `shell job needs
    a \`\`\`bash block` (any line) with kind shell → `byField.script`; an error on the `model:` line with kind shell → `rest` (hidden row); line 0
    `cron is required` → `rest`; an error on a comment line → `rest`; an error on the `cron:` line → `byField.schedule`; an error on the `machines:`
    line → `byField.machines`.
- [ ] **Step 2:** `npx tsx test/routine-form.test.ts` fails (module missing).
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4:** Test file passes; `pnpm typecheck` passes.
- [ ] **Step 5:** Commit `feat(routines): field registry for the drawer form`.

### Task 5: Schedule field — presets

**Files:**
- Modify: `client/src/lib/routineForm.ts`
- Test: `test/routine-form.test.ts`

**Interfaces:**
- Consumes: Task 4's `FieldDef`, `fmValue`, `setKey`, `UNREADABLE`; `parseCron`, `nextAfter`, `describeCron`, `isManualCron` (`shared/cron.ts`).
- Produces:
  - `type Preset = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'`.
  - `type Schedule = { preset: 'manual' } | { preset: 'hourly'; minute: number; every: 1 | 2 | 3 | 6 | 12 } | { preset: 'daily' | 'weekdays'; hour: number;
    minute: number } | { preset: 'weekly'; days: number[]; hour: number; minute: number } | { preset: 'custom'; text: string }` (`days`: 0 = Sun … 6,
    sorted, unique).
  - `cronFor(s: Schedule): string | null` — the cron line value the preset writes (`manual`, `25 */2 * * *`, …), null for weekly with no day.
  - `switchPreset(from: Schedule, to: Preset): Schedule`.
  - `FIELDS.schedule: FieldDef<Schedule>`.

- [ ] **Step 1: Failing tests.**
  - read (value of the `cron:` line → Schedule): `manual` → manual; `25 * * * *` → hourly every 1 minute 25; `25 */6 * * *` → hourly every 6; `25 9 * * *`
    → daily 9:25; `25 9 * * 1-5` → weekdays; `25 9 * * 1,4` → weekly days [1,4]; `25 9 * * 0,7` → weekly [0]; near-misses all custom with their text:
    `25 9 * * 1-3`, `25 */5 * * *`, `25 9 1 * *`, `*/15 * * * *`, `25 9 * 1 *`, `0-5 9 * * *`; mid-typing `*/1` and `25 9 * *` → custom with that text; no
    `cron:` line → custom `''`. A quoted value reads the same.
  - write (each preset back to text): daily 9:25 on the skill template writes `cron: "25 9 * * *"` and keeps the line's comment; manual writes bare
    `cron: manual`; weekly days [] → text unchanged; custom `'*/15 9-17 * * 1-5'` writes it quoted; round trip `read(write(t, s)) deep-equals s` for one value
    of every preset but custom-unparseable.
  - summary: manual `Manual · Run now only`; hourly `Every hour at :25` / `Every 2h at :25`; daily `Daily at 09:25`; weekdays `Weekdays at 09:25`; weekly
    [1,4] `Mon, Thu at 09:25`; weekly [0,6] `Sat, Sun at 09:25` (Mon-first order); custom parseable → `describeCron` text (`*/15 9-17 * * 1-5` →
    `Every 15 minutes, 09:00–17:45, Mon–Fri`); custom unparseable → tone `err`, text `Cron needs fixing`; custom `''` → tone `err`, text `No schedule`.
  - `switchPreset`: daily 9:25 → weekdays 9:25; daily 9:25 → hourly every 1 minute 25; hourly 25 → daily 9:25 (hour defaults 9); daily → weekly days [] at
    9:25; weekdays 9:25 → custom text `25 9 * * 1-5`; custom `0 14 * * *` → daily 14:00 (derived through read); custom `*/15 * * * *` → daily 9:00
    (not derivable); anything → manual is manual; manual → daily 9:00.
- [ ] **Step 2:** Tests fail. **Step 3:** Implement; recognition uses the raw token text per the spec's table (`M`, `H` single integers in range; day and
  month fields literal `*`), never the parsed sets. **Step 4:** Test file and `pnpm typecheck` pass.
- [ ] **Step 5:** Commit `feat(routines): schedule presets for the drawer form`.

### Task 6: The drawer — rows, controls, Form | File, Manual's Save

**Files:**
- Create: `client/src/components/routines/JobRows.tsx` (rows + per-field controls; split a `ScheduleControl.tsx` out if it passes ~200 lines)
- Modify: `client/src/components/routines/JobDrawer.tsx:184-222` (Repos block and File field), `:230-249` (footer and hint)
- Modify: `client/src/styles.css` (new `rtn-f-*` rules beside the other `rtn-` drawer rules)
- Modify: `docs/subsystems/routines.md:293-294` (Drawer line), `docs/overview.md:309` if the component list names drawer parts

**Interfaces:**
- Consumes: everything Task 4–5 produce; `RoutineCtl` (`ctl.pins`, `ctl.machine`, `ctl.phone`, `ctl.owner`, `ctl.locked`).
- Produces: `JobRows(props: { text: string; onText(next: string): void; errors: JobError[]; readOnly: boolean; ctl: RoutineCtl; onFile(): void })` —
  renders the visible rows, the routed errors inside rows and the `rest` errors under them.

Behaviour (the mockups show each opened row; follow their markup and the spec §Rows):
- [ ] **Step 1:** `JobRows`: one row open at a time (opening another closes the first). Closed row = label, summary (tone `dim` / `err` styled through
  existing tokens), and the row's routed errors turn it `err`. Opened row = the control under it. UNREADABLE → summary `edit in File`, control replaced by
  one line with a link calling `onFile`. `frontmatterReadable` false → every row in that state plus one message "This file can't be read as a form — fix it
  in File." Read-only: rows open, controls disabled.
- [ ] **Step 2:** Controls per spec §Rows: Schedule (six-preset `.seg`, per-preset inputs, the written cron line and next fire under daily/weekdays/weekly/
  hourly; Custom shows its input, the five field names, `describeCron` and next fire when it parses); Machines (two `.rtn-pick` chips, "this machine"
  marker on `ctl.machine`, the hint naming `ROUTINE_MACHINE`); Repos (today's seg relabelled `All pinned | Pick | One folder`, phone labels kept short
  `All | Pick | Folder`; One folder input with a `<datalist>` of pinned paths); Script/Prompt (the `.rtn-ta` textarea on that part only); Model (input +
  suggestion chips `Default, opus, sonnet, haiku, fable`, Effort seg `Default, low, medium, high, xhigh, max`); Permission seg `Default, plan, acceptEdits,
  auto` with the amber note on acceptEdits (text minus the `permission-mode acceptEdits:` prefix); Limits (Max turns number input; Timeout number + `s|m|h`
  seg; half-typed input stays local until valid); Tools (removable chips, an add input that refuses a name containing `,`).
- [ ] **Step 3:** `JobDrawer`: a `Form | File` `.seg` in the header (default Form; File shows today's textarea with today's error/valid lines); the old
  Repos block is removed (the Repos row replaces it); `errors` routed through `routeErrors`; `Valid · …` line stays under the rows. New job with a Manual
  schedule: one `Save` button calling `save(true)`, and the hint under the footer reads "**Save** writes the file with `enabled: true`. A manual job is never
  installed; it runs only through Run now." Everything in spec §Constraints' "kept as is" list still works.
- [ ] **Step 4:** CSS: `rtn-f-` rules from the mockup, tokens only; the opened control wraps at < 640px via a rule scoped under `.rtn-f-ctl` (or similar),
  not on `.seg`. `npx tsx test/ui-kit-guard.test.ts` passes.
- [ ] **Step 5:** Docs: the routines.md Drawer bullet describes rows, the Form | File switch and Manual's single Save.
- [ ] **Step 6:** `pnpm typecheck` and `pnpm build` pass.
- [ ] **Step 7:** Commit `feat(routines): drawer form rows with a Form | File switch`.

### Task 7: Verify in the browser

**Files:** none (fixes found here go back into the owning task's files, committed as `fix(routines): …`).

- [ ] **Step 1:** Start the preview (`.claude/launch.json` `dev-verify`, ports 4700/5700) or, in a worktree, the worktree setup on 4273/5273; record the pid you
  started and kill only that.
- [ ] **Step 2:** New job: pick each kind; open each row; switch Schedule through all six presets and confirm File shows only the `cron:` line changed; pick
  Manual → one Save. Edit an existing routine (a copy, never a live one's schedule): change Model, Limits, Tools; confirm File shows only those lines changed.
  Do not press Save on a real routine unless it is a throwaway created for the check, and delete it afterwards through the drawer.
- [ ] **Step 2b:** Unreadable shape (Review Focus 5): on the throwaway, write a block-list `allowed-tools:` in File, switch to Form → the Tools row reads
  "edit in File" with no control; Save, then confirm the file on disk is byte-identical to what File held (`shasum` before and after).
- [ ] **Step 3:** Phone width (375): every opened row wraps without horizontal scroll; screenshot the Schedule row opened.
- [ ] **Step 4:** Ledger: the throwaway manual job reads `manual`, has no toggle, no Pause in its menu.
- [ ] **Step 5:** Note for the report: `pnpm test:visual` Jobs shots change (`pr-triage` now reads in words) and need `pnpm test:visual --update-snapshots`
  on macOS; not run here unless asked.
