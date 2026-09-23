---
id: task-30
title: Date every machine-population figure quoted in docs and code comments
created: 2026-09-23
from: ref-1
---

## Goal

Every number in `docs/` or a source comment that was read off this machine's own data — a count of transcripts, desktop-app records or project dirs, or a ratio
over them — says inline, beside the number, the date it was measured. Undated, such a figure reads as a live fact about the machine; nothing regenerates it, and
the `/docs-sync` provenance stamp cannot catch it going stale because the sources it describes never change. Dated, it is a record of a probe: true forever,
changes only when someone edits it, which is exactly the test the docs-sync "no volatile data" rule applies.

One normative line in `.claude/CLAUDE.md` makes this the convention, so the next probe figure is written dated instead of being found by the next sync pass.

## Plan

This plan states behaviour and the exact sites, never literal replacement text — word each edit to read naturally in its sentence.

**Why date rather than drop or point at a command** (ref-1 offered three options; this settles it). The docs-sync rule says to replace a volatile number with
the command that prints it, but no command in this repo prints any of these: each was a one-off probe run while designing the feature, and the figure is the
evidence for a design decision ("the registry join is worth 4 titles and loses 62", "every record carries `entrypoint`", "7,837 B is the worst offset, so
16 KB is 2×"). Dropping it deletes the evidence; keeping only the ratio (ref-1 option 3) still loses the "4 of 722" argument. Dating keeps the evidence and
removes the volatility. Do **not** re-measure and update any figure: a fresh number undated is the same defect, and the design decisions were made against the
old one. The figures stay verbatim.

**Sites.** Measurement dates below come from `git log -S` on each figure — the commit that introduced it.

| # | Site | Figure | Measured |
|---|------|--------|----------|
| 1 | `docs/subsystems/session-surfaces.md` ~line 46 | `1504/1504` across the newest 12 transcripts | 2026-08-17 (`3294b2d`) |
| 2 | `docs/subsystems/session-surfaces.md` ~lines 128–140 | title-join table: 722 / 251 / 193 / 189 / 4 / 62, and "four titles out of 722" in the paragraph after it | 2026-08-20 (`68a432f`) |
| 3 | `docs/subsystems/sessions.md` ~line 279 | worst first-`cwd` offset "across every transcript on this machine", 7,837 B | 2026-09-02 (`1fe2c8f`) |
| 4 | `docs/subsystems/sessions.md` ~line 353 | "parsing all 669 on this machine costs 4.0s" | 2026-09-01 (`a3c4b2b`) |
| 5 | `server/lib/transcript.ts` ~line 26 (`HEAD_BYTES` JSDoc) | "all 652 transcripts", 7,837 | 2026-09-02 (`1fe2c8f`) |
| 6 | `server/lib/transcript.ts` ~line 89 (`entrypoint` JSDoc) | `1504/1504` across the newest 12 | 2026-08-17 (`3294b2d`) |
| 7 | `server/lib/archived.ts` ~line 47 | "a 669-record store" | 2026-09-01 (`a3c4b2b`) |
| 8 | `server/lib/management.ts` ~line 410 | `75/75` project dirs, 0 missed | 2026-09-04 (`d84a875`) |

Site 2 notes: that table sits under the heading "Why `cloud` stays empty … (probed 2026-08-20)", but the heading is ~55 lines above it and the table's own lead-in
("Measured on this machine before believing it") and the "out of 722" sentence both read as current. Put the date in the lead-in sentence, and make the "out of
722" sentence read as the count at that time (e.g. "then on disk") rather than a standing total.

**Leave alone, deliberately:**

- `session-surfaces.md` ~lines 85–86 (`6/6 rows`, `437/438 files`) — table cells directly under the "(probed 2026-08-20)" heading, already read as dated.
- `docs/subsystems/usage-limits.md` and `server/lib/usage-*.ts` — that doc already carries its own dated-measurement framing ("Every measured number in this
  document predates the nested-transcript fix", the `bug-22` warning); re-dating its figures one by one is a separate question, not this task.
- Measurements of the code's own behaviour rather than of this machine's population — timings of a single operation, pixel offsets, "SIGTERM on the …",
  "measured 90s+", `r²` values. They do not drift as the machine accumulates sessions.
- Every docs-sync provenance stamp (`verified:` in the trailing `<!-- … -->` block). This edit changes no source a stamp covers.

**The convention line.** Add one bullet to `.claude/CLAUDE.md` under `## Where things go`, next to the "Reference docs" bullet. It must say: a figure read off
this machine's own data (counts of transcripts, records, dirs, or a ratio over them) carries its measurement date inline beside the number, in docs and in code
comments alike; replacing it with a command applies only when a command in the repo actually prints it. Keep it to the one-line normative register the rest of
that section uses — the reasoning lives in this task's history, not in `CLAUDE.md`.

**Edit shape.** Change only the lines holding the figure, plus at most the one following line where a comment or paragraph must rewrap. Never reflow a whole
paragraph or comment block (global rule: reflowing rewrites blame for no behaviour change). The date form is `YYYY-MM-DD`, matching the rest of these docs.

## Test cases

Each check is a command with an exact expected result.

1. `grep -n '1504/1504' docs/subsystems/session-surfaces.md server/lib/transcript.ts` prints exactly 2 hits, and for each, that line or the next one contains
   `2026-08-17`.
2. `grep -n -A1 '652 transcripts' server/lib/transcript.ts` output contains `2026-09-02`.
3. `grep -n -B1 -A1 '669' server/lib/archived.ts docs/subsystems/sessions.md` output contains `2026-09-01` once per file (2 files, each dated).
4. `grep -n -B1 -A1 '7,837' docs/subsystems/sessions.md` output contains `2026-09-02`.
5. `grep -n -B1 -A1 '75/75' server/lib/management.ts` output contains `2026-09-04`.
6. `grep -n -B3 '| transcripts on disk | 722 |' docs/subsystems/session-surfaces.md` output contains `2026-08-20`; and `grep -n 'out of 722'` on the same file
   either prints nothing or a line that no longer reads as a standing total (reviewer judgement — state which wording was chosen in the outcome).
7. Figures unchanged: every figure in the Sites table still appears verbatim — `grep -c` for each of `1504/1504`, `722`, `251`, `193`, `189`, `7,837`, `652`,
   `669`, `75/75` returns the same count before and after (record both in the outcome).
8. Deliberate non-edits hold: `git diff -- docs/subsystems/usage-limits.md` is empty, and `git diff docs/subsystems/session-surfaces.md` touches none of the
   `6/6 rows` / `437/438` lines.
9. `git diff --stat` lists exactly these 6 files: `docs/subsystems/session-surfaces.md`, `docs/subsystems/sessions.md`, `server/lib/transcript.ts`,
   `server/lib/archived.ts`, `server/lib/management.ts`, `.claude/CLAUDE.md` (plus this task file when it is archived). No stamp block line is in the diff.
10. `grep -n -i 'measur' .claude/CLAUDE.md` finds the new convention bullet under `## Where things go`.
11. `pnpm typecheck` exits 0 and `pnpm test` passes with the same case count as before — the `.ts` edits are comment-only.

## Done when

- All eight sites carry their measurement date inline, figures verbatim, and test cases 1–11 pass with their output recorded in `## Outcome`.
- `.claude/CLAUDE.md` carries the one-line convention.
- Nothing outside the six listed files changed.
