# Review 1 — Routine drawer form design

Document: `docs/superpowers/specs/2026-10-24-routine-form-design.md` (branch `docs/routine-form-spec`, commit a03b07c). Reviewer: Fable 5.1, 2026-10-24.
Mockup artifact read: https://claude.ai/artifact/8cEpfNJpjK8HxVqZTjLXC6.

## Verdict: APPROVE WITH FIXES

No Critical findings. The code facts the spec states check out (parser keys, `writeFrontmatterLine`, `serializeEnabled`'s `run:` anchor, `setRepos`'s
local `drop()`, `notDesired` reasons, `routineSummary` format, `machineName`, the launchd refusal, `describeCron`'s current shapes, the class names).
The Important findings are gaps an implementer would have to guess at, plus one API consequence of Manual the spec does not list.

## Important

**[I] spec:170 — `installed` reads true for a Manual job.** `server/api.ts:1996` computes `desired = s.job !== null && s.job.enabled && onThisMachine`
on its own, not through `notDesired`; `installedFrom` (`server/api.ts:1964-1971`) returns that `desired` whenever the plan lists no change for the name,
which is exactly the state after reconcile has removed the job. So an enabled `cron: manual` job would carry `installed: true`, and the drawer subtitle
(`JobDrawer.tsx:139-140`) would read "Installed on this machine as …". `nextAt` is fine (`nextFire` at `api.ts:1974-1977` already yields null when
`parseCron` fails). → Add to §Manual **API**: `serveRoutines`' `desired` must also be false for a manual job (or derive it from the same predicate
`notDesired` uses), so `installed` is false.

**[I] spec:171-172 — the ledger toggle is hidden, but `JobMenu` still offers Pause / Resume.** `client/src/components/routines/JobMenu.tsx:27` renders
`job.enabled ? 'Pause' : 'Resume'` for every parsed job, and `PATCH /api/routines/:name` still flips `enabled:`. The spec's reason for hiding the toggle
("enabling it would suggest the job will fire") applies to the menu item too; as written the implementer must guess whether it stays. Related: a manual
job saved with `enabled: false` (possible through File, or an existing paused job switched to Manual) reads `paused` in the Next column and is muted
(`client/src/lib/routines.ts:127`, `dotTone` at `:525`) with no control left to resume it except File. → State what the menu does for a manual row, and
what a paused manual row shows (or that Manual is independent of `enabled`, so the row never reads `paused`).

**[I] spec:136 — an unparseable cron has no preset.** The table's Custom row is "anything else that parses"; §Schedule presets then says nothing about a
cron `parseCron` rejects (`shared/cron.ts:74-92`: wrong field count, bad range, `5/15`). Such a line is present, so it is not the §Unreadable case either,
and it is the normal state while typing in the Custom input. The Custom control is specified as showing `describeCron` and `nextAfter`, neither of which
exists for it. → Say: an unparseable cron reads as Custom with its text, the row shows the `/validate` error (its line is the cron line, so §Validation in
rows already routes it there), and the words/next-fire line is omitted or reads blank.

**[I] spec:87-103 — row visibility in Edit job when `run:` is absent or invalid.** Rows are shown "by kind", and Edit job "has no Kind control"; the
kind can only come from the text's `run:` line, but the spec never says so, nor what shows when the line is missing (`run is required`, line 0) or
not `shell`/`claude` (`shared/routine-file.ts:143-147`). New job has the same hole once the user edits `run:` in File, since L38 makes the text the only
source of truth. → State that `kinds` is read from the `run:` line on every render, and name the row set shown when it is absent or invalid (e.g. the
kind-independent rows only, with the `run` error under the rows).

**[I] spec:81-83, 101 — an error on a line owned by a hidden row vanishes.** `model:`, `effort:`, `permission-mode:`, `allowed-tools:` and
`max-turns:` are accepted by the parser for a shell job too (`shared/routine-file.ts:21-23` has no per-kind check), and L101 says such a line stays
in the file. A `model: a b` line in a shell job then raises `model must be one token` on a line the Model field owns, but the Model row is not
rendered for shell, so the error has nowhere to show while Save stays disabled (`canSave` needs `errors.length === 0`, `JobDrawer.tsx:100`).
→ Say an error whose owning row is hidden for the kind shows under the rows with the unowned ones.

**[I] spec:94, 116 — Script row with no ```` ```bash ```` fence.** The parser reports `shell job needs a ```bash block` on the `run:` line
(`shared/routine-file.ts:214-215`), and `run` is owned by no field, so the error shows under the rows; but what the Script row reads and writes when
the fence is absent (or unclosed) is unspecified. The mock's hint says "The fence is written for you", which implies the write creates one. → Define
`read` (empty / unreadable) and `write` (insert a fence at the body's end, or refuse) for a body with no fence, and the unclosed-fence case.

**[I] spec:179 — the docs touchpoint is too narrow.** Besides the `cron` row of the key table, `docs/subsystems/routines.md:118` defines Desired as
"every valid file with `enabled: true` whose `machines` names this machine", `:293-294` describes the drawer as validate-on-keystroke with the two
save buttons and no Form view, and `shared/types.ts:2043` documents `cron` as "Five-field cron". All three become false. → List them under **Docs**
(and the `RoutineJob.cron` comment under the type-first rule, since the spec itself invokes it at L189).

## Minor

- spec:139 vs spec:160 and the mock — "Preset writes are quoted" includes Manual, but the Manual value is shown as bare `cron: manual` everywhere else.
  Say which (the parser unquotes either, `routine-file.ts:29-32`).
- spec:132 vs spec:212 — the Hourly interval set is fixed to {2, 3, 6, 12} in the table, then "the Hourly interval set beyond the five above" is left to
  the builder; if the builder adds 4h or 8h the table and the L199 tests move. Pick one home for the set.
- spec:109-110 — "None picked shows the validator's own `machines needs mac, wsl or both`" only holds if the write is `machines: []`
  (`routine-file.ts:136`); removing the line gives `machines is required` at line 0, which shows under the rows. State the write.
- spec:113 — the relabel drops today's phone labels `All | Pick | cwd` (`JobDrawer.tsx:188`) for the mock's full labels at 375px. Call it out as intended.
- spec:118-119, 156 — the row summary for a preset ("Daily at 09:25") and the `Valid · …` line's `describeCron` text for the same cron ("09:25 daily",
  kept on purpose by L156) sit a few lines apart in one drawer with two phrasings. A deliberate choice, but worth one sentence saying so.
- spec:144 — the quoted refusal is the tail of the real message `cron: launchd cannot combine day-of-month and weekday; use one`
  (`routine-file.ts:152`); the mock also drops the `cron: ` prefix. Say whether the row strips it.
- spec:120 — "the existing amber note" reads `permission-mode acceptEdits: the run can edit files…` today (`JobDrawer.tsx:220`); the mock's row version
  drops the `permission-mode acceptEdits:` prefix. Call the difference out.
- spec:136, 150 — the mock's Custom closed summary reads "Every 15 min, 09–17, weekdays" while its opened hint reads "Every 15 minutes, 09:00–17:45,
  Mon–Fri"; the spec says both are the same `describeCron` text. Note that the mock's short form is not a second format.
- spec:174 — the New-job hint under the footer (`JobDrawer.tsx:244-248`, "Save and install writes … Save, keep paused writes …") describes two buttons;
  say what it reads when Manual collapses them to Save.
- spec:193 — "an opened row's control wraps" needs `.seg` to wrap; the mock adds `flex-wrap:wrap` to `.seg` itself, which is an app-wide class
  (`styles.css:737`, also the stage's `.seg .ictl`). Scope it under an `rtn-f-` ancestor rather than on `.seg`.
- spec:203 — no visual baseline shows the Job drawer (`test/visual/views.spec.ts` shoots the Jobs and Runs pages only). The Routines shots will still
  change, because the fixture `pr-triage` cron `*/30 9-18 * * 1-5` (`test/visual/fixtures/routines.ts:131`) reaches the ledger through `describeCron`.
  Fix the reason.
- spec:123 — a tool name containing a comma cannot round-trip through the inline list (`routine-file.ts:35-40` splits on `,`); and quoted items
  (`["Bash(git:*)"]`) are unquoted on read and would be rewritten bare. Worth a line, or an unreadable rule.
- spec:171 — "Run now works as today" also depends on `runnable` (`JobLedger.tsx:63`), which already ignores cron; fine, but the phone row renders the
  toggle in `.rtn-act` (`JobLedger.tsx:126`) — hiding it there changes the phone row's control count, which the Jobs phone shots will show.
- spec:189 — `RoutineJob.cron`'s doc comment (`shared/types.ts:2043`) says "Five-field cron"; covered by the docs finding above, listed here because it is
  the one `shared/types.ts` edit the spec's own type-first rule asks for.
- Mock only: "Next: Mon 27 Oct 09:25" under Weekdays/Weekly — 2026-10-24 is a Saturday, so the next weekday fire is Mon 26 Oct. Illustrative, not in
  the spec text.

## Checked and fine

- Reconcile really does uninstall a not-desired job that is installed (`routine-reconcile.ts:326-329`, tests at `test/routine-reconcile.test.ts:297-316`),
  so "the same path a disabled job takes" is right, and `render` is only called for desired jobs (`:256-258`), so `renderPlist` never sees Manual.
- The wrapper already tolerates an unparseable cron when computing the slot (`plugin/lib/run-routine.mjs:265-268`), so "computes no slot" needs no code
  beyond the parser accepting `manual`; and `routineSummary` / the ledger's `when` already fall back to `job.cron` (`api.ts:1955`, `JobLedger.tsx:80`),
  so "when reads manual" is free once the parser accepts it.
- Comments survive `writeFrontmatterLine` (`frontmatter.ts:71-82, 102-115`), and the Claude template's `# cwd:` comment line is not matched by
  `keyAt` (`:96-100`), so the anti-goal at L36 is achievable with the named helper.
- All the mock's CSS tokens exist in `styles.css`'s token block (`--strip-hi`, `--steel`, `--hairline`, `--shadow2`, `--green-tint`, `--amber-tint`,
  `--amber-ink`, `--red-tint`); no `rtn-f-` class exists yet, so the prefix is free.
- The Hourly intervals 2, 3, 6, 12 all divide 24, so `*/N` over hours is a true "every Nh"; `*/4` and `*/8` would be too but are Custom by the table.
- `useShellNarrow` switches at 640 (`client/src/hooks/useNarrow.ts:19, 74`), matching L193.
- CLAUDE.md rules touched: class names stable, no colour literals, types-first for an API field, `pnpm plugin:gen` + `test/plugin-manifest.test.ts`,
  `pnpm plugin:sync` after merge, no new deps — all respected in the text.
