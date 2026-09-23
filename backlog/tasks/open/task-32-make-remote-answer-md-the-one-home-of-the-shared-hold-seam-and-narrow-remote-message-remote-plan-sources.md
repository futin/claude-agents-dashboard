---
id: task-32
title: Make remote-answer.md the one home of the shared hold seam and narrow remote-message/remote-plan sources
created: 2026-09-23
from: ref-3
---

## Goal

Clear the docs-sync overlap warning between `docs/subsystems/remote-message.md` and `docs/subsystems/remote-plan.md` by giving each fact about the shared
hold seam one home, not by silencing the checker. The checker reports this today (measured 2026-09-23, not the 7/11 the refactor was filed with):

```
overlap: 1 warning(s)
  docs/subsystems/remote-message.md ~ docs/subsystems/remote-plan.md share 8/12 and 8/13 sources
```

The eight shared sources are `server/lib/idle.ts`, `server/api.ts`, `server/index.ts`, `server/lib/scan.ts`, `client/src/components/PanelChrome.tsx`,
`client/src/lib/panelCollapse.ts`, `client/src/components/sessions/atoms.tsx` and `client/src/lib/holds.ts`.

`remote-answer.md` is already the home of that seam in practice. Both docs open with "Read that doc first; only the differences are below". Both send the
reader there for panel chrome. `server/lib/idle.ts`'s own header comment says "See `docs/subsystems/remote-answer.md`". This task makes that explicit and
removes the sources and restated prose that only duplicate it.

### Why this shape and not the other two

- **Not `overlap-ok`.** The docs-sync bootstrap rule allows `overlap-ok` only when narrowing either doc's `sources` would lose a true staleness signal.
  It is meant for two docs over the same code in different registers. These are two sibling delta docs, and four of their shared sources are only
  referenced ("see remote-answer"). Narrowing loses nothing there, so the rule says narrow. It also avoids a `docs/.docs-sync.yml` edit, which is a
  bootstrap-only change.
- **Not a third "pending holds" doc.** The home already exists. A fourth doc would split the remote-answer story and add a doc to keep in sync.

## Plan

This is a docs-only change. Touch these three files and no others: `docs/subsystems/remote-answer.md`, `docs/subsystems/remote-message.md` and
`docs/subsystems/remote-plan.md`. Do not edit `docs/.docs-sync.yml`. Do not change any code.

**Run the checker by its real path.** `~/.claude/skills/docs-sync` is a symlink, and the checker's main-module guard compares `argv[1]` with
`import.meta.url`. Called through the symlink it prints nothing and exits 0, which looks like a clean run. Run it like this, from the repo root:

```bash
node "$(realpath ~/.claude/skills/docs-sync/tools/provenance.mjs)" --repo .
```

1. **Record the baseline.** Run the checker and save the `overlap:` block and the stale-file lists for the three docs in your notes. All three are stale
   today against baseline `f436519`. That is expected. This task does not fix that drift — see step 6.

2. **Narrow `remote-plan.md`'s stamp `sources`.** Remove these four:
   - `server/lib/idle.ts`. The doc only defers to remote-answer's idle-sweep section (the "So does coming back to the keyboard" invariant). `plans.ts` stays
     in sources, and it is the file that calls `sweepIdle`.
   - `client/src/components/PanelChrome.tsx` and `client/src/lib/panelCollapse.ts`. The "PlanPanel minimises…" paragraph only says "see remote-answer".
     There is no plan-specific branch in `panelCollapse.ts`.
   - `client/src/components/sessions/atoms.tsx`. The doc does not describe row rendering. The `plan?` label and its tone come from `chatTab` in
     `lib/holds.ts`, which stays.

   Keep `server/api.ts`, `server/index.ts`, `server/lib/scan.ts` and `client/src/lib/holds.ts`. Each one holds a slice this doc owns: its own handlers, its
   own `$`-anchored routes above the `:id` regex, `ScanOptions.planIds`, and the `plan?` label. Removing any of them would lose a true signal.

3. **Narrow `remote-message.md`'s stamp `sources`.** Remove `server/lib/idle.ts`, `client/src/components/PanelChrome.tsx` and
   `client/src/components/sessions/atoms.tsx`, for the same reasons as in step 2. **Keep `client/src/lib/panelCollapse.ts`.** It holds a message-only fact:
   `fmtLeft()` and the `closes in …` stub branch are used only by `MessagePanel` (checked 2026-09-23: `fmtLeft` is imported only by `MessagePanel.tsx`).

4. **Remove the restated idle policy from `remote-message.md`.** In "## The `released` status and the idle sweep", numbered steps 2 and 3 restate
   `backAtDesk()`'s zero-threshold rule and both fail directions. remote-answer.md's "The idle sweep: coming back to the desk" section already owns those
   facts. Replace the two steps with one sentence that links to
   `[the idle sweep](remote-answer.md#the-idle-sweep-coming-back-to-the-desk)` (same-directory link, as the doc's other remote-answer links are). Keep
   everything this store owns: step 1 (no entries means no-op), step 4 (terminal-backed entries settle as `released`), the whole headless-exemption
   discussion, the `BM_ORCH_RUN` sentence, the `CLAUDE_CODE_ENTRYPOINT` qualification, and the `released` vs `dismissed` paragraph. Renumber the list, or
   turn it into prose if two items read better that way. The push-notify fail-direction contrast that step 3 carries today moves with the link only if
   remote-answer.md does not already say it. Check that before you delete it. If it is missing there, add it to remote-answer's idle-sweep section in one
   clause, because it applies to every store.

5. **Say in `remote-answer.md` that it is the home.** Add one short paragraph near the top, after the opening, or at the start of "## Client surfaces".
   Name the shared hold machinery it owns for all three holds (question, plan, reply):
   - the `lib/idle.ts` `backAtDesk()` policy
   - the `PanelHead` / `MinimisedPanel` chrome and `lib/panelCollapse.ts`
   - the `holdKind` precedence in `lib/holds.ts`
   - the `$`-anchored route-order trap in `server/index.ts`

   Then say that remote-message.md and remote-plan.md document only their own deltas. Do not add sources to remote-answer's stamp. It already lists
   `idle.ts`, `PanelChrome.tsx`, `panelCollapse.ts`, `atoms.tsx` and `holds.ts`, and the route-order trap is covered by its `api.ts`/routing prose.
   Check the stamp before you edit it, and add `server/index.ts` only if the route-order claim you write is not already true of a listed source.

6. **Leave every `verified:` sha exactly as it is.** Narrowing `sources` can only shrink a doc's changed-file list, never hide drift in the sources it
   keeps. Re-stamping (`--stamp`) would mark all three docs as current against drift nobody reviewed (MessagePanel.tsx, PlanPanel.tsx, api.ts, scan.ts
   and more). That drift belongs to the next `/docs-sync` pass, not to this task.

7. **Re-run the checker** and compare it with step 1's baseline (see Test cases).

If step 7 still shows the remote-message ~ remote-plan warning, stop and report the new counts. Do not add an `overlap-ok` entry. That is a
`.docs-sync.yml` bootstrap edit and needs the user's sign-off.

## Test cases

Every check below uses the realpath checker command from the Plan.

1. **Overlap cleared.** The checker output has no line with both `remote-message.md` and `remote-plan.md`. Expected counts after narrowing: message 9
   sources, plan 9 sources, 4 shared (`api.ts`, `index.ts`, `scan.ts`, `holds.ts`), so 4/9 on each side. That is below the 0.5 threshold, so there is no
   warning.
2. **No new overlap pair.** Run `remote-answer.md` ~ `remote-message.md` and `remote-answer.md` ~ `remote-plan.md` through the same arithmetic. The
   checker must not print either pair. The output has no `overlap:` block at all, unless an unrelated pair that was already in step 1's baseline is
   still there.
3. **No drift hidden.** For each of the three docs, the checker's `changed:` list after the task is step 1's list minus only the files removed from that
   doc's `sources`. Concrete expectation for remote-message.md: `MessagePanel.tsx`, `holds.ts`, `api.ts` and `scan.ts` are still listed.
   `PanelChrome.tsx` and `atoms.tsx` are gone. The `verified:` value is still `f436519f31ef4120521792db7658e2bc5431f0e9` in all three stamps
   (`git diff` shows no change on any `verified:` line).
4. **Anchors resolve.** The checker's `links:` block reports no dead link in the three docs. That includes the new `#the-idle-sweep-coming-back-to-the-desk`
   anchor from remote-message.md.
5. **No fact lost.** Each of these facts is stated in remote-answer.md and nowhere else among the three docs:
   - unreadable idle (Docker, non-macOS) keeps the hold, and the sweep never guesses
   - `idleSecs === 0` turns auto-release off

   Check both with `grep -n 'idleSecs === 0\|Unreadable idle\|unreadable idle' docs/subsystems/remote-*.md`. remote-message.md may still say
   "unreadable TTY", which is a different fact. Hits for idle in remote-message.md and remote-plan.md must be links, not restatements. The
   headless-exemption facts (`headless: true`, `claude-desktop`, `BM_ORCH_RUN`, `sweepIdle` returns before reading idle) still appear in remote-message.md.
6. **Scope held.** `git diff --stat` touches only the three docs. `docs/.docs-sync.yml` is unchanged.
7. **Repo gates untouched.** `pnpm typecheck` and `pnpm test` pass. There is no code change, so this only confirms the tree is sane. Quote the case count.

## Done when

- The realpath checker run shows no remote-message ~ remote-plan overlap warning and no new overlap pair. Paste the `overlap:` section (or its absence)
  and the three docs' status blocks into the Outcome.
- `remote-answer.md` names itself as the home of the shared hold seam. remote-message.md no longer restates `backAtDesk()`'s policy.
- All three stamps keep `verified: f436519…`. The only stamp edits are the removed `sources` lines.
- `docs/.docs-sync.yml` and all code are unchanged.
- ref-3's other doc, `remote-answer.md`, is covered by the same decision. Record that in the Outcome, as the refactor asked. There is nothing to narrow
  there: it is the home.
