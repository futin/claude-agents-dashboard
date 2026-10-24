# Routine drawer form — design

Date: 2026-10-24. Mockups (layout B, every row opened): https://claude.ai/artifact/8cEpfNJpjK8HxVqZTjLXC6 (private to the author).

## Intent

The New job / Edit job drawer (`client/src/components/routines/JobDrawer.tsx`) edits a routine by its raw file: a textarea holding the frontmatter and the
body, checked against `POST /api/routines/validate` as it is typed. Only the Kind cards (new job) and the Repos helper (`foreach:` / `cwd:`) are controls.
The user named three pains with that, all three equally:

- **Cron syntax.** Writing or decoding `25 9 * * 1-5` to say "weekdays at 09:25".
- **Remembering keys.** Which keys exist, and what `model`, `effort`, `permission-mode`, `timeout` etc. accept.
- **Phone editing.** Typing frontmatter into a textarea on a phone.

The goal is a small form that does everything the file does today, and that a later setting (a token limit was named, out of scope here) can join without
the form being redesigned.

## Goals

- Every key `parseJob` (`shared/routine-file.ts`) knows today is editable through a control: `cron`, `machines`, `run` (via Kind on a new job), `foreach`,
  `cwd`, `enabled` (via the existing save buttons and ledger toggle), `model`, `effort`, `permission-mode`, `allowed-tools`, `max-turns`, `timeout`, and the
  body (prompt, or the inside of the shell job's ```` ```bash ```` block).
- The raw file stays one click away and is the same text the form edits.
- A new **Manual** schedule: a routine that is never installed and runs only through Run now.
- Adding a setting later is one parser key plus one field definition; no layout work.

## Non-goals

- A token limit, or any other new key besides `cron: manual`.
- A visual cron builder (hour grid, minute picker, next-five list). Mocked and set aside as YAGNI; Custom covers the odd schedule.
- Jitter or a "randomized delay" like the user's reference screenshot showed. The routines here fire on the minute, as today.
- Changing the file format beyond `cron: manual`, the validator's rules, the save/reconcile/delete flow, the disk-changed guard, or the API.

## Anti-goals (a failure even if it works)

- **The form eats the file.** A form edit that rewrites the whole frontmatter, drops comments, reorders keys or normalises a value the user did not touch.
  Every control rewrites only its own line(s); every other byte survives.
- **Two sources of truth.** A form state that can drift from the text. There is one `text` state; every value the form shows is derived from it on every
  render. A row may keep short-lived UI state that holds no value of its own: which preset tab is selected (picking Custom while the cron still matches a
  preset, or Weekly before a day is picked), and a half-typed input (a minute, a time, a timeout) until it is valid enough to write. Closing the row or
  switching to File drops that state, and the row reads back from the text.
- **Guessing.** A value the form cannot represent being shown as something it is not (an odd cron shown as "Daily"). It shows as Custom or as "edit in
  File", never coerced.
- **A worse phone.** The phone drawer is the main reason for this; it must be better there than the textarea, not just equal.

## Decided by the user

1. **Layout B — summary rows.** The drawer's controls become one list of rows. Each row shows its key's label and its current value in plain words (e.g.
   "Weekdays at 09:25", "All pinned (6)", "opus · high effort"); tapping a row opens its control in place, under the row. Layouts A (one long form) and C
   (tabs) were mocked and declined.
2. **Form | File switch.** A segmented `Form | File` control in the drawer header. File shows the full text in the existing `.rtn-ta` textarea; edits in
   either view are the same `text` state, so switching never loses anything.
3. **Manual is added** as a schedule preset, with its own behaviour end to end (§Manual).
4. Every row's opened state looks as the mockups show (see the artifact). Projects are picked through the Repos row; machines through the Machines row (§Rows).

## The field registry

The form is a list of field definitions, rendered in order. A field definition has:

- `key` — the frontmatter key(s) it owns (`limits` owns `max-turns` and `timeout`; `repos` owns `foreach` and `cwd`; `prompt`/`script` own the body).
- `label` — the row's left text.
- `kinds` — which job kinds show the row (shell vs claude; see §Rows).
- `read(text)` — the value the control shows, or an "unreadable" marker when the line exists but the form cannot represent it.
- `write(text, value)` — the new text. Writes only the lines the field owns, in place; inserting a missing key places it in a stable position (after `run:`
  like `serializeEnabled` does, or after a sibling key — builder's call); a "Default" / blank value removes the line.
- `summary(value)` — the plain-words text the closed row shows; a distinct dim text for "not set / default".
- the control component that opens under the row.

Writes go through `writeFrontmatterLine` from `shared/frontmatter.ts` (what `serializeEnabled` and `setRepos` already use). A remove-a-line helper does not
exist yet; `setRepos` has a local `drop()` that shows the shape. The existing `readForeach` / `setRepos` / `jobPins` in `client/src/lib/routines.ts` become
the Repos field's read/write rather than being reimplemented.

Field definitions and their read/write/summary functions are plain functions in a client lib module (testable under node-assert in `test/`, like
`test/routines-view.test.ts` does for `client/src/lib/routines.ts`). The React rows only render them.

**Unreadable values.** If a field's line is present but `read` cannot represent it (a cron no preset matches is not unreadable — it is Custom; an
`allowed-tools` written as a nested block is), the row's summary reads "edit in File" and its control is replaced by that one line with a link that switches
to File. If the frontmatter itself cannot be found (no opening or closing `---`), every row shows that state and the drawer shows one message: the file can't
be read as a form, fix it in File.

**Validation in rows.** `/validate` errors carry a 1-based `line`. Each error whose line holds a key owned by a field is shown inside that field's row (the
`.rtn-vmsg.err` line under its control) and turns the row's closed summary red ("cron needs fixing" style). Errors at line 0, or on lines no field owns,
show where they show today, under the rows. The `Valid · …` summary line and the `acceptEdits` amber note stay; the amber note moves into the Permission row.

## Rows

Order and visibility, by kind:

| Row | Shell | Claude prompt / skill | Owns |
|-----|:-----:|:---------------------:|------|
| Schedule | ✓ | ✓ | `cron` |
| Machines | ✓ | ✓ | `machines` |
| Repos | ✓ | ✓ | `foreach`, `cwd` |
| Script | ✓ | | the inside of the body's first ```` ```bash ```` fence |
| Prompt | | ✓ | the whole body after the closing `---` |
| Model | | ✓ | `model`, `effort` |
| Permission | | ✓ | `permission-mode` |
| Limits | ✓ (timeout only) | ✓ (max turns + timeout) | `max-turns`, `timeout` |
| Tools | | ✓ | `allowed-tools` |

The kind is read from the `run:` line on every render: `shell` shows the Shell column, `claude` the Claude column. A missing or invalid `run:` shows only
Schedule, Machines, Repos and Limits (timeout), and the validator's `run` error shows under the rows; the body is then reachable only in File.

A key present in the file whose row the kind hides (a `model:` line in a shell job) stays in the file untouched and is visible only in File. An error on
such a line — or on any line whose owning row is hidden — shows under the rows, so a disabled Save always has a visible reason.

**New job** keeps the existing Kind cards and Name field above the rows (picking a kind still replaces the text with that kind's `jobTemplate`). **Edit job**
has no Kind control, as today.

Per row, what the control does (the mockups show each opened):

- **Schedule** — a `.seg` of six presets: Manual, Hourly, Daily, Weekdays, Weekly, Custom (§Schedule presets).
- **Machines** — two `.rtn-pick` chips, `mac` and `wsl`; the chip matching `RoutinesResponse.machine` carries a small "this machine" label. None picked writes
  `machines: []` and shows the validator's own `machines needs mac, wsl or both` in the row. A hint says which machine this dashboard is and that it comes from the OS or
  `ROUTINE_MACHINE` in `.env` (`machineName` in `server/lib/routine-config.ts`) — machines are not configured in `.env`; the file decides which machines
  install a job.
- **Repos** — today's `All pinned (n) | Pick | Single cwd` segmented control, relabelled `All pinned | Pick | One folder`. All pinned lists the pinned
  names read-only; Pick shows them as toggle chips (today's behaviour, starting from every pin); One folder is a text input for `cwd:` with the pinned repos'
  paths offered as suggestions, any path allowed, empty meaning the routines folder's parent.
- **Script / Prompt** — the existing `.rtn-ta` textarea, holding only the script or only the prompt. The Script write keeps the fence lines and any text
  around the fence. A shell body with no ```` ```bash ```` fence reads as an empty script, and the first write appends a fence holding the script after any
  existing body text. A fence that opens and never closes reads as unreadable ("edit in File"), since a write could not know where the script ends.
- **Model** — a text input with suggestion chips `Default, opus, sonnet, haiku, fable` (the file takes any one-token model, so free text stays allowed),
  and an Effort `.seg`: `Default, low, medium, high, max`. Default removes the line.
- **Permission** — `.seg`: `Default, plan, acceptEdits, auto`; acceptEdits shows the existing amber note in the row. `bypassPermissions` is not offered.
- **Limits** — Max turns (positive integer, blank removes the line) and Timeout (a number plus an `s | m | h` unit; blank removes the line, meaning the 1h
  default, and the summary says "1h timeout (default)").
- **Tools** — chips of the listed tools, each removable, plus an input to add one; empty list removes the line, summary "Any tool".

## Schedule presets

Reading a `cron` value into a preset (anything not matched is **Custom**, never an error):

| Preset | Recognised cron | Control | Summary |
|--------|-----------------|---------|---------|
| Manual | the literal `manual` | none; explains it runs only through Run now | "Manual · Run now only" |
| Hourly | `M * * * *`, or `M */N * * *` with N in 2, 3, 6, 12 | minute input + `1h 2h 3h 6h 12h` | "Every hour at :25" / "Every 2h at :25" |
| Daily | `M H * * *` | time input | "Daily at 09:25" |
| Weekdays | `M H * * 1-5` | time input | "Weekdays at 09:25" |
| Weekly | `M H * * d,d,…` with single weekday numbers (7 read as 0) | day chips Mon–Sun + time input | "Mon, Thu at 09:25" |
| Custom | anything else that parses | the cron text input + its five field names, the `describeCron` text and the next fire (`nextAfter`) | the `describeCron` text (§Plain words) |

A `cron` value that does not parse (the normal state while typing in the Custom input) reads as Custom too: the input holds its text, the `/validate` error
shows in the row, and the words and next-fire line are left out until it parses. A missing `cron:` line reads as Custom with an empty input.

`M` and `H` are single integers. Every preset but Manual and Custom also shows its next fire and the cron line it writes, as the mockups do. Preset writes
are quoted (`cron: "25 9 * * 1-5"`), as `jobTemplate` writes them; Manual writes bare `cron: manual`. Weekly with no day picked is an error in the row and writes nothing until one is picked.

Switching presets carries the time (and minute) over where both sides have one; Custom pre-fills with the current cron text. Leaving Custom for a preset
whose fields cannot be derived starts from 09:00 — builder's call on the exact default.

The existing `launchd cannot combine day-of-month and weekday` refusal shows in the Schedule row. No preset can produce it; only Custom can.

## Plain words for any cron

Decided by the user: `describeCron` (`shared/cron.ts`) is extended so a Custom cron reads in words too. Today it returns the raw source for anything beyond
one minute and one hour on a simple day shape, so nearly every Custom cron would show its own text and the "decoding cron" pain would stay exactly where it
is worst. After the change it covers steps, ranges and lists in every field, e.g. `*/15 9-17 * * 1-5` → "Every 15 minutes, 09:00–17:45, Mon–Fri" (the
mockup's wording; the exact phrasing is the builder's, as long as it is unambiguous and short enough for the ledger's when column). Anything it still cannot
phrase falls back to the raw source, as today.

`describeCron` is shared, so the ledger's when column (`JobLedger.tsx`), the server's `when` text (`server/api.ts` `routineSummary`) and the generated
`plugin/lib/cron.mjs` all change with it. That is wanted. Existing expectations of today's output in tests move with it; the simple shapes it already
phrases keep their current wording, so ledger text users already know doesn't shift.

## Manual

New file value: `cron: manual`. It keeps `cron` required, so a forgotten cron line is still an error rather than silently becoming Manual.

Behaviour, and where it lands:

- **Parser** (`shared/routine-file.ts`, and the generated `plugin/lib/routine-file.mjs` via `pnpm plugin:gen`): `manual` is a valid cron value. The launchd
  day-of-month/weekday check does not apply to it. How `RoutineJob` carries it (keeping `cron: 'manual'`, or a separate flag) is the builder's call, as long
  as no consumer passes `manual` to `parseCron` and reports it as broken.
- **Reconcile** (`server/lib/routine-reconcile.ts`): a manual job is never desired. `notDesired` gives it its own reason (alongside `disabled`), so a job
  switched from a schedule to Manual is uninstalled on the next reconcile, the same path a disabled job takes. `renderPlist` and the crontab line never see
  one.
- **API** (`server/api.ts`): `when` reads "manual", `nextAt` is null. `serveRoutines` computes its own `desired` (`s.job.enabled && onThisMachine`) and
  `installedFrom` returns it when the plan lists no change for the job, so that `desired` must also be false for a manual job — the same predicate as
  `notDesired` — or an enabled manual job reads `installed: true` and the drawer says "Installed on this machine as …".
- **Ledger** (`client/src/components/routines/JobLedger.tsx`): the when column reads "manual". Run now works as today. The enabled toggle is hidden for a
  manual row, since enabling it would suggest the job will fire, and so is the row menu's Pause/Resume item (`JobMenu.tsx`). `enabled:` has no meaning for a
  manual job: its row reads "manual" in the next column whatever `enabled:` says (never "paused"), and its status dot follows its last run as an enabled
  job's does (`rowText` / `dotTone` in `client/src/lib/routines.ts`). A manual file carrying `enabled: false` is valid and behaves the same.
- **Drawer save buttons**: on a New job whose schedule is Manual, the two buttons Save and install / Save, keep paused become one **Save**, which writes
  `enabled: true` (nothing installs either way). Edit job keeps Save and reconcile: reconcile is what uninstalls a job just switched to Manual.
- **Wrapper** (`plugin/lib/run-routine.mjs`): a `schedule` trigger computes no slot for a manual job (no `parseCron` of `manual`). A schedule-triggered run of
  a manual job cannot happen once reconcile has removed the install; it need not be refused.
- **Validate summary**: `routineSummary` keeps its format (`<when> · claude · 6 repos · mac + wsl`); only `when` reads "manual". The mockups' "Valid ·
  Claude skill · …" lines are illustrative, not a format change.
- **Docs**: in `docs/subsystems/routines.md`, the key table's `cron` row gains `manual`; §Reconcile's "Desired is every valid file with `enabled: true`…"
  gains "and a cron other than `manual`"; the §UI Drawer line describes the rows, the Form | File switch and Manual's single Save. The `RoutineJob.cron`
  comment in `shared/types.ts` ("Five-field cron") gains `or manual`.

Because the wrapper and its generated libs are under `plugin/`, the change reaches running sessions only after merge plus `pnpm plugin:sync`.

## Constraints

- `CLAUDE.md` code rules apply: existing CSS class names stay stable (`.rtn-drawer`, `.rtn-field`, `.rtn-ta`, `.rtn-vmsg`, `.seg`, `.rtn-pick`, `.rtn-in`,
  `.rtn-kind` …); new classes use an `rtn-f-` prefix, as the mockups do. No literal colour or shadow below the theme-token block in `styles.css`; the
  mockups use only existing tokens.
- Client and shared only, except Manual's server and plugin touchpoints listed above. No new dependency anywhere; no new API field (Manual is a new value of an
  existing field, `RoutineJob.cron` — if the builder adds a flag to `RoutineJob` instead, `shared/types.ts` changes first, per the API-field rule).
- The drawer's existing behaviour is kept as is: validate-as-typed with the sequence guard, the disk-changed guard and Reload, read-only for a non-owner
  (rows show values; controls disabled; File read-only), the `locked` state, Save and install / Save, keep paused / Save and reconcile, Delete, Escape and
  back-to-close, and the dirty-close guard on the backdrop.
- Phone (< 640px): the rows are the drawer's full width; an opened row's control wraps rather than scrolls sideways (the wrap is scoped under an `rtn-f-` ancestor, never added to the app-wide `.seg`). The mockups' 375px frames are the target.

## Verification the builder owns

- Node-assert unit tests for every field's `read` / `write` / `summary`, including: a write leaves comments and every other line byte-identical; a Default
  write removes the line; an unreadable value reads as unreadable; each preset row of the table above, both directions, and a Custom fallback for each
  near-miss (`25 9 * * 1-3` is Custom, not Weekly; `25 */5 * * *` is Custom, not Hourly).
- Manual: parser accepts `manual` and still rejects an absent `cron`; reconcile does not desire and does uninstall a manual job (in the existing
  `test/routine-reconcile.test.ts` style); the wrapper computes no slot; the regenerated `plugin/lib/*.mjs` matches (`test/plugin-manifest.test.ts`).
- `describeCron`: the simple shapes keep today's exact text; steps, ranges and lists in each field get words; an unphraseable cron falls back to its source.
- `pnpm test:visual`: no baseline shows the drawer, but the Jobs shots change — the fixture's `*/30 9-18 * * 1-5` reaches the ledger through
  `describeCron` — and need re-baselining (macOS only, on demand).
- In the browser: open Edit job on a real routine, change each row, confirm File shows only those lines changed, save, confirm the ledger and the installed
  job follow.

## Left to the builder

- Component split (one `JobRows` component, a row component, per-field controls) and where the field registry module lives.
- Where an inserted key goes when the file lacks it, as long as it is stable and never reorders existing lines.
- Whether one or several rows may be open at once (the mockups show one).
- The exact default time when leaving Custom, and the exact wording `describeCron` produces.
- How `RoutineJob` represents Manual.

## Calls the author made (not discussed with the user)

- `cron: manual` rather than an omitted `cron` line.
- Hourly gained an interval (`1h`–`12h`), written as `M */N * * *`; the parser already accepts steps.
- Model and Effort each gained a `Default` option that removes the line; Model stays free text with suggestions.
- "Single cwd" is relabelled "One folder", with pinned paths offered as suggestions.
- The `acceptEdits` warning moves into the Permission row.
- A dashed "Token limit — later" row appears in the mockups only, to show where a future field lands; it is not built.
- Rows may hold short-lived UI-only state (selected preset, half-typed input) that never carries a value the text lacks.
- A manual row hides the ledger's enabled toggle; a New job on Manual gets one Save button.
- The validate summary's format is unchanged; only `when` reads "manual".
