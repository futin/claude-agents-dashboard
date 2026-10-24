# Review 2 — Routine drawer form design spec

Document: `docs/superpowers/specs/2026-10-24-routine-form-design.md` at commit 6b5547b ("docs: address spec review 1").
Previous round: `docs/superpowers/reviews/2026-10-24-routine-form-design-review-1.md`. Every round-1 Important finding was checked against the revised
text and is fixed (installed-for-manual at L178-180, Pause/Resume at L181-184, unparseable cron at L143-144, row visibility without `run:` at L101-102,
hidden-row errors at L104-105, Script without a fence at L120-122, docs touchpoints at L191-193). None is re-reported below.

Verified against: `shared/routine-file.ts`, `shared/cron.ts`, `shared/frontmatter.ts`, `client/src/lib/routines.ts`,
`client/src/components/routines/{JobDrawer,JobLedger,JobMenu}.tsx`, `client/src/components/routines/ctl.ts`, `server/api.ts`,
`server/lib/routine-reconcile.ts`, `server/lib/routine-config.ts`, `server/lib/spawn.ts`, `client/src/lib/spawnOptions.ts`, `plugin/lib/run-routine.mjs`,
`docs/subsystems/routines.md`, `shared/types.ts`, `test/cron.test.ts`, `test/plugin-manifest.test.ts`, `client/src/styles.css`, and the mockup artifact the
spec links (read through the Artifact tool). No `.claude/rules/` directory exists in the repo.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. Four Important findings: one false code claim, two requirements the text leaves unspecified where the code
has a definite (and wrong-for-the-spec) behaviour, and one control that cannot show a value the parser accepts.

## Important

- **[I] spec:82-83 with spec:95 — the Prompt row never receives its own error.** The routing rule sends each `/validate` error to the row owning its
  line, and "Errors at line 0 … show … under the rows". But the only prompt error, `claude job needs a prompt`, is pushed at line 0
  (`shared/routine-file.ts:217`), so under this rule it lands under the rows, not in the Prompt row, and the Prompt row's closed summary for an empty
  body is unspecified (the mock shows no such state). → Name `claude job needs a prompt` as Prompt-row-owned regardless of its line 0, and state the
  Prompt row's empty summary (e.g. "needs a prompt", red), or say explicitly that it stays under the rows.

- **[I] spec:182-184 — two more `enabled:`-driven readings exist beyond `rowText` / `dotTone`.** The ledger mutes the job name when
  `job?.enabled === false` (`client/src/components/routines/JobLedger.tsx:97`, class `rtn-muted`), and `routineSummary` appends `paused` as the last
  segment when `enabled` is false (`server/api.ts:1959`), which is the `Valid · …` line the drawer shows (spec:189-190 says only `when` changes). A
  manual file with `enabled: false`, which L184 declares valid and "behaves the same", would therefore read as muted in the ledger and `… · paused` in
  the drawer while the spec promises "never paused". → Extend the "`enabled:` has no meaning" rule to `JobLedger.tsx:97` and `routineSummary`
  (`server/api.ts:1959`): neither reads `paused` / mutes for a manual job.

- **[I] spec:187-188 — "(no `parseCron` of `manual`)" is false as a description of the wrapper.** On a `schedule` trigger `run-routine.mjs` always
  calls `parseCron(job.cron)` and records no slot only because the parse fails (`plugin/lib/run-routine.mjs:264-268`); nothing skips the call. As
  written it also contradicts spec:174 ("no consumer passes `manual` to `parseCron`"), so a builder reading L174 as a hard rule must add a guard the
  wrapper paragraph says is unnecessary. → Either reword L187 to "the parse fails and no slot is recorded, which is fine", or require the guard in the
  wrapper and say so in both places.

- **[I] spec:124 — the Effort `.seg` cannot show `effort: xhigh`.** The parser accepts any one token for `effort` (`shared/routine-file.ts:105-110,179`)
  and the wrapper passes it through unchanged (`plugin/lib/run-routine.mjs:315`); the dashboard's own launch form offers `xhigh`
  (`server/lib/spawn.ts:63`, `client/src/lib/spawnOptions.ts:23`). A file with `effort: xhigh` matches no chip in `Default, low, medium, high, max`,
  and the spec does not say whether that is "edit in File" (L76-78 reserve that for values `read` cannot represent) or what the seg selects. → Add
  `xhigh` to the seg (mirror `EFFORTS`), and state what an effort token outside the list reads as.

## Minor

- spec:107 vs mock — the spec keeps "the existing Kind cards", but the mock's card copy ("Runs a bash block. No tokens." / "claude -p with the prompt." /
  "The prompt is one /skill line.") differs from `JobDrawer.tsx:16-20` ("Runs a bash block. No tokens, no transcript." …). Say the cards keep today's
  copy, or list the new copy.
- spec:82, 113-114 — closed-row red summaries are given by example only ("cron needs fixing" style; the mock adds "pick at least one" for Machines). A
  one-line rule (e.g. "`<label> needs fixing`" everywhere, Machines excepted) would stop each row inventing its own.
- spec:185 — the phone label of the paused button is `Keep paused` (`JobDrawer.tsx:234`); the Manual single-Save paragraph names only the wide labels.
- spec:119 — "empty meaning the routines folder's parent" must *remove* the `cwd:` line: a blank `cwd:` is rejected with `cwd is empty`
  (`shared/routine-file.ts:100-104`). L64 covers "Default removes the line" for the registry in general; One folder's empty state should say it too.
- spec:122 with spec:81 — the unclosed-fence error is pushed at the fence's own line (`shared/routine-file.ts:215`), which the Script row owns, while
  L122 says the row reads as unreadable. Whether the message shows inside the "edit in File" row or under the rows is left to the builder; pick one.
- spec:202-203 — "no new API field" and "if the builder adds a flag to `RoutineJob` instead" are both allowed; the second is a new API field. Say the
  flag is the exception, or forbid it.
- spec:175-177 — the reconcile preview's `remove` change carries `why: skipped.get(name) ?? 'file gone'` (`server/lib/routine-reconcile.ts:328`); the new
  `notDesired` reason for Manual will surface verbatim there. Name the reason string (`manual`), so the preview and the tests agree.
- spec:101, 107 — on a New job the `kind` card state (`JobDrawer.tsx:38,165-166`) and the `run:` line are two sources once File lets the user edit
  `run:`; the spec reads kind from `run:` "on every render" but does not say the cards follow. One sentence settles it.
- spec:113 — the hint text quotes `machineName` correctly (`server/lib/routine-config.ts:66-75`: `ROUTINE_MACHINE` first, then Darwin → mac, else wsl).
  Fine, but the `bad ROUTINE_MACHINE` error path (returns the detected name plus an error) is not mentioned; the chip label still has a value, so no
  change needed, noted only so the builder does not treat `error` as "no machine".
- Mock — the date "Mon 27 Oct" for a next fire (already noted in round 1) and the "Valid · Claude skill · …" summary are mock-only; spec:189-190 already
  says so.

## Checked and fine

- `cron` is required and `cron is required` is a line-0 error (`shared/routine-file.ts:119-126`): L168's "keeps `cron` required" holds.
- `machines: []` yields `machines needs mac, wsl or both` on the `machines:` line (`shared/routine-file.ts:136`): L113-114 quotes it exactly.
- `describeCron` today returns the source for anything outside the four named shapes (`shared/cron.ts:169-182`, `test/cron.test.ts:208-218`); L156-164's
  extension is additive.
- `parseField` accepts `*/N` and ranges, refuses `5/15` (`shared/cron.ts:42-72`); the Custom preset (L143-144) routes a refused cron to the row error, not
  to "unreadable". Consistent with L76.
- `writeFrontmatterLine` inserts after `afterKey` or before the closing fence and keeps a trailing comment (`shared/frontmatter.ts:89-122`): L64's
  "Default removes the line" and comment preservation are implementable as stated.
- `serveRoutines` computes `desired` (`server/api.ts:1994`) and `nextAt` from it (`:1999`); L178-180 names the right place.
- `notDesired` (`server/lib/routine-reconcile.ts:203-210`) and the plan loop (`:254-262`) render only desired jobs: L175-177 holds.
- `JobMenu.tsx:27` is the Pause/Resume item; `JobLedger.tsx:86-90,123,126` the toggle: L181-182 names the right files.
- `.seg` is app-wide (`client/src/styles.css:737-747`) and no `rtn-f-` class exists yet: L207's scoping rule is necessary and correct.
- `pnpm plugin:gen` / `test/plugin-manifest.test.ts:65-91` pin the generated libs: L172 and L195's `pnpm plugin:sync` note are right.
- `useNarrow` threshold 640 (`client/src/hooks/useNarrow.ts`) and `ctl.phone` (`ctl.ts:18`) match L207's "< 640px".
- `jobTemplate` writes `cron: "0 7 * * 1-5"` quoted (`client/src/lib/routines.ts:276-301`) and `CLAUDE_HEAD` `cron: "0 22 * * *"` with a comment
  (`:259-273`): L147's quoting rule for `manual` is consistent with existing files.
- Docs lines the spec names exist where it says: `docs/subsystems/routines.md:72` (cron row), `:118` (Desired), `:293` (Drawer), `shared/types.ts:2043`.
- Scope (L199-207) is client + shared + the listed Manual touchpoints; nothing in scope depends on the out-of-scope Token-limit row (dashed in the mock).
- No new dependency, no colour literal, class names stable: CLAUDE.md code rules respected.
