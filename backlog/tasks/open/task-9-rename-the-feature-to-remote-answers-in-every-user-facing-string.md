---
id: task-9
title: Rename the feature to "remote answers" in every user-facing string
created: 2026-09-01
from: idea-11
---

## Goal

One name for one feature. The switch is called *remote answer* everywhere in code, in the
API contract and in the env var, but reads **"phone answers"** in the toolbar pill, the
Settings row, the `UserPromptSubmit` banner and three docs. "Phone" is wrong on the merits,
not merely inconsistent: the answer surface is any browser (laptop, tablet, another tab on
the same machine), and the switch governs plan send-backs and permission decisions as well
as plain replies.

Settled during grooming (idea-11's open questions):

- **Plural, "remote answers"**, in every user-facing string. It matches the Settings group
  header that already reads `Remote answers · every device`. `REMOTE_ANSWER`, the file names
  `remote-answer.md` / `remoteState.ts` and every identifier stay exactly as they are — those
  name one flag and one module, not the feature, and renaming them would turn a string change
  into an API/config change.
- **Scope reaches the hook scripts and the hooks learning guide**, including regenerating the
  guide's page and re-stamping its provenance.
- **"Phone" stays wherever it means the device.** That is the large majority of hits — ntfy
  push copy, LAN/tailnet access lines, the Claude phone app, CSS breakpoint comments,
  `vite.config.ts`'s `Phone (LAN)` log line, and every "answerable from the phone" /
  "buzzes the phone" comment. This rename is **not** a global find-and-replace on the word.

No behaviour change, no API field, no new test surface. `styles.css` already uses the `ra-`
prefix (`ra-pill`, `ra-dot`) and needs no change. Settings storage keys are code-side
constants (`client/src/lib/settings.ts`), never the visible label — nothing to migrate.

## Plan

Eight edits, one rebuild, one re-stamp. Do them in this order — the guide's markdown quotes
the hook script verbatim, so the script has to change before the guide is regenerated.

**1. The pill — `client/src/components/RemoteAnswerToggle.tsx`**

Two visible strings, both currently `phone answers`:

- line 20, the unavailable branch: text becomes `remote answers: disabled`.
- line 40, the live button: text becomes `remote answers: ` followed by the existing
  `on`/`off` expression.

Leave the `title` attributes, the `ra-warn` spans and the module doc-comment alone — none of
them says "phone". Lowercase in both, matching the pill's existing style.

**2. The Settings row — `client/src/components/settings/SettingsView.tsx:260`**

`name="Phone answers"` becomes `name="Remote answers"`. Sentence case, matching the sibling
rows. Its `hint` prop says nothing about phones and does not change. Note the group directly
above it already reads `Remote answers · every device`; after this edit the group and row
agree instead of contradicting each other.

**3. The module doc — `server/lib/remoteState.ts:4`**

"whether a question waits for a phone answer" → "whether a question waits for a remote
answer". Singular here, because it describes one question waiting. Nothing else in this file
says "phone".

**4. The hook — `scripts/remote-decision-hook.sh`**

Two lines, and only these two:

- line 3, header comment: "accepting phone answers" → "accepting remote answers".
- line 61, the first line of the heredoc Claude actually reads: "the dashboard is accepting
  phone answers" → "the dashboard is accepting remote answers".

Do **not** touch line 8 ("the one decision surface the phone can answer") or line 63 ("from
their phone") — both mean the device, and line 63 in particular is telling the model where
the user physically is. Keep the heredoc's line count identical so the guide's cited line
range (`scripts/remote-decision-hook.sh:60-68`) stays valid.

`scripts/ask-remote-hook.sh` and `scripts/plan-remote-hook.sh` are listed as sites in
idea-11 but need **no edit**: their flagged lines (`ask-remote-hook.sh:9`,
`plan-remote-hook.sh:16`) both read "answerable from the phone", which is device meaning, and
`ask-remote-hook.sh:2` already says "hook for remote answers". Verified during grooming —
confirm with grep rather than forcing an edit.

**5. The wording rule — `docs/subsystems/remote-answer.md:227`**

This line *states the rule being changed*, so it is a rewrite, not a substitution. It
currently reads that the pill's wording is "phone answers", never "instead of the terminal".
Rewrite it to say the wording is "remote answers", and add the reason the name changed: the
answering surface is any browser, and the switch governs plan send-backs and permission
decisions too, so a device word understates it. Keep the second half of the sentence intact —
"never 'instead of the terminal': on only *allows* remote answers, gate 3 still sends
desk-time questions to the terminal" is a separate rule and still true.

Every other "phone" in this file (lines 4, 22, 61, 147, 224, 252, 256) is the device. Leave
them.

`docs/subsystems/remote-plan.md` needs **no edit** — idea-11 lists line 104, but that line
reads "answerable from the phone", device meaning. Verified during grooming.

**6. The setup doc — `docs/workflows/remote-answer-setup.md:52`**

"check the **phone answers** pill in the toolbar" → "**remote answers** pill". Lines 12–13 on
the same page say "answer from a phone" / "open the dashboard from that phone" — device, leave
them.

**7. The open bug that quotes the banner — `backlog/bugs/open/bug-6-installer-skips-dashboard-token-when-answer-token-is-indented.md:125`**

Its plan instructs a future session to suppress the `"dashboard is accepting phone answers"`
banner. After step 4 that quoted phrase no longer exists in the script, so update the quote to
`"dashboard is accepting remote answers"`. Change the quoted string only — do not touch the
rest of bug-6's plan, and do not change its status.

**8. The hooks learning guide — `docs/guides/learning/hooks/`**

The page is generated. Edit the sources, then rebuild; never hand-edit `index.html`.

- `guide/lifecycle.md:69` — inside the fenced excerpt quoting the heredoc. Must end up
  character-identical to the script's new line 61, or the guide misquotes it.
- `guide/lifecycle.md:81` — prose, "the dashboard is accepting phone answers" → "remote
  answers". This sentence explains why the instruction is conditional; the condition is the
  toggle, which is precisely the thing being renamed.
- `tools/figures.mjs:174` — the SVG figure title, "PreToolUse holds for a phone answer" →
  "holds for a remote answer". Singular, matching the surrounding "One turn:" phrasing. This
  string is emitted into the page as a `<title>` element, so it must change before the build.
- Then, from the repo root, in this order:
  - `node docs/guides/learning/hooks/tools/build.mjs` — regenerates `index.html` from the
    markdown plus `figures.mjs`. It fails loudly on a missing figure key rather than emitting a
    page with a hole in it.
  - `node docs/guides/learning/hooks/tools/check.mjs` — four checks over the generated page
    (no surviving `.md` links, prose fidelity, no leaked markdown syntax, no external assets).
    Exits non-zero on failure.
  - `node docs/guides/learning/hooks/tools/citations.mjs` — reports each `file:N-M` excerpt as
    fresh / stale / gone / abridged. The `scripts/remote-decision-hook.sh:60-68` excerpt should
    stay **fresh**: step 4 changes one line's text without moving any line, and this tool
    classifies by how many distinctive lines still exist. A `gone` here means the heredoc's
    shape changed — go back and fix step 4 rather than running `--fix`.
- `README.md:1` — the `study-provenance` comment stamps `commit=092484b date=2026-08-17` and
  lists `scripts` among its sources, so this change drifts it. Re-stamp `commit=` to the SHA
  this task lands as and `date=` to the merge date. That has to happen after the commit exists,
  so either amend or add a follow-up commit; note in the PR which one you did. Leave the
  `sources=` list alone — no file joins or leaves it.

**What NOT to do**, restated because it is the whole risk in this task: no `sed -i` sweep over
the word "phone". The 100-plus other occurrences across `client/src`, `server/lib`,
`docs/subsystems` and `docs/workflows` are correct as written, and a blanket replace would
produce nonsense like "buzzes the remote" and "a remote propped on the desk".

## Test cases

1. `pnpm typecheck` exits 0. String-only edits; a non-zero exit means a JSX edit broke
   something structural.
2. `pnpm test` exits 0 with the same case count as before the change. No test asserts the pill
   label, the Settings row name or the hook banner text (verified during grooming), so this is
   a pure regression check — a *changed* count means the branch touched more than strings.
3. `grep -rn "phone answer" --include="*.ts" --include="*.tsx" --include="*.sh" --include="*.md" --include="*.mjs" --include="*.html" -i .`
   run from the repo root, excluding `node_modules/` and `.worktrees/`, returns hits **only**
   inside `backlog/ideas/open/idea-11-*.md` (or `backlog/ideas/done/` once idea-11 is archived
   there) and this task file. Both are the historical record of the rename and keep the old
   phrasing on purpose. Any hit in `client/`, `server/`, `scripts/` or `docs/` is a missed site.
4. `grep -c -i phone` over `client/src`, `server`, `docs/subsystems` and `docs/workflows`
   drops by exactly the number of lines steps 1–6 touched in those trees — 6 lines
   (`RemoteAnswerToggle.tsx` ×2, `SettingsView.tsx` ×1, `remoteState.ts` ×1,
   `remote-answer.md` ×1, `remote-answer-setup.md` ×1); `scripts/` drops by 2. A larger drop
   means a device-meaning line was caught in the sweep — that is the failure mode this case
   exists to catch, so diff and restore rather than accepting it.
5. `node docs/guides/learning/hooks/tools/check.mjs` exits 0 after the rebuild.
6. `node docs/guides/learning/hooks/tools/citations.mjs` reports the
   `scripts/remote-decision-hook.sh` excerpt as `fresh`, and reports no new `gone`.
7. `git diff --stat docs/guides/learning/hooks/index.html` shows the file changed. An
   unchanged `index.html` means `build.mjs` was never run and the browser page still says
   "phone answers".
8. In the browser (playwright MCP tools): start the dev server, open `http://localhost:5174`,
   and confirm the toolbar pill reads `remote answers: on` or `remote answers: off` — no
   occurrence of the word "phone" anywhere in the toolbar.
9. In the browser (playwright MCP tools): on `http://localhost:5174`, open the **Settings**
   view from the side rail, scroll to the group headed `Remote answers · every device`, and
   confirm its first row is labelled `Remote answers`. Its On/Off segmented control must still
   be present and clickable.
10. In the browser (playwright MCP tools): resize the viewport to 390×844 (phone width), reload
    `http://localhost:5174`, and confirm the toolbar pill still renders on one line — the new
    label is two characters longer than the old one, and the toolbar is the tightest layout in
    the app. If it wraps or clips, the fix is a CSS adjustment in the `ra-pill` block of
    `client/src/styles.css`, not a shorter label; the label was chosen deliberately.

## Done when

- The pill, the Settings row, the `remoteState.ts` doc-comment, the hook banner and its header
  comment, `remote-answer.md`'s wording rule, `remote-answer-setup.md`'s pill reference and
  bug-6's quoted phrase all say "remote answer(s)".
- The hooks guide markdown, `figures.mjs` and the regenerated `index.html` agree with the
  script, and `check.mjs` plus `citations.mjs` both pass.
- The guide's `study-provenance` stamp names this change's commit and date.
- Every remaining "phone" in the repo means the physical device, provable by test cases 3
  and 4.
- `pnpm typecheck` and `pnpm test` are green, with the command output pasted into the PR — not
  summarised.
- The PR body follows `.github/pull_request_template.md`, groups *What changed* by boundary
  (Client / Server / Hook / Docs), and states what was **not** verified. Known candidate for
  that line: whether the renamed `UserPromptSubmit` banner still reads correctly to a live
  model mid-session — the string change is safe, but nothing in this task exercises an actual
  hook firing against a running Claude Code session.
