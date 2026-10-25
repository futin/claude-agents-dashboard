# Review 1 re-check — Chat PR card implementation plan

Plan: `docs/superpowers/plans/2026-10-25-chat-pr-card.md` · Spec: `docs/superpowers/specs/2026-10-24-chat-pr-card-design.md` · Scope: only the hunks in
`git diff HEAD~1 -- <plan>` (the response to review 1, `docs/superpowers/reviews/2026-10-25-chat-pr-card-review-1.md`). Reviewer: fresh subagent (Fable 5.1),
2026-10-25, HEAD `d82976e`. Every code claim below was read in the worktree.

## Verdict

**APPROVE WITH FIXES.** Review 1's C1 and I1–I5 are each resolved by the changed text, and every new code anchor and value checks out. One Important remains,
introduced by the I5 fix: the hook line no longer says which id `acceptPrAnswer` compares against, and the obvious choice (the fetch closure's id) makes the
compare a no-op, so Review Focus 5 would be pinned by a function the hook cannot fail. Four Minor wording items.

## Review 1 findings — status

| R1 | Plan hunk | Status |
|---|---|---|
| C1 Daylight tint form | :290-292 hexes `#aa3927` / `#6950a5`, `styles.css:130`; Step 2 runs the contrast test | Resolved — hexes verified at `client/src/styles.css:130`; `daylightMixTokens` regex (`test/daylight-contrast.test.ts:57`) parses `#rrggbb` only; the test is in `pnpm test` (`test/run-all.ts:137`). Pass claim recomputed with the test's own `tint`/`ratio` math (`:72-80`): red 14% over `--strip` 5.08, `--board` 4.66, `--strip-hi` 4.58; magenta 5.20 / 4.77 / 4.68 — all ≥ 4.5, so Step 2's "pass" holds (narrowly, see M5). |
| I1 A4 poisons A5 | :208-209 reset both caches before each case | Resolved — `resetStores` (`test/api-harness.ts:106-112`) calls `resetState/resetPending/resetPlans/resetMessages/resetSettings` only; `resetPrStatusCache` (:142) and `resetPrDetectCache` (:68) are Produced by Tasks 2 and 1 with those spellings. |
| I2 A4 title precedence | :213 A4's command carries `--title "Arg title"`, still expects `Real title` | Resolved — now discriminates `live.title ?? detected.title` from the reverse. |
| I3 S2 bucket collision | :160-161 QUEUED ×2 added | Resolved — recount: SUCCESS×2 + SC SUCCESS = passed 3; FAILURE + SC ERROR = failed 2; IN_PROGRESS + QUEUED×2 + SC PENDING = running 4; SKIPPED and `Other` excluded; total 9; 11 entries. Matches spec:97-110 (QUEUED → running at :103). |
| I4 band pill | :286 "the pill under the same condition as `.pr-top`" | Resolved — matches spec:184 (no pill when `live` is null). |
| I5 RF5 untested | :45-46, :244-245 `acceptPrAnswer`, :258-259 C8, :283-285 hook | Partly resolved — see **I1** below. |
| M2 LRU wording | :72 "64-entry cache evicting the oldest insertion (as `tasks.ts:235`)" | Resolved — `MAX_ENTRIES = 64` (`server/lib/tasks.ts:26`), eviction at `:235`. |
| M5 `GH_PR_RE` groups | :138 group 1 / group 2 | Resolved — consistent with Task 3's `repo` = group 1 (:204). |
| M6 draft pill tint | :289 `--ink2` on `--steel`, `test/daylight-contrast.test.ts:124` | Resolved — `:124` is `ink2: ['hairline2', 'steel', 'strip']`; `--steel` exists on `:root` (`styles.css:13`) and in every theme block. |
| M8 comment line | :206 `server/index.ts:421-422` | Resolved — the comment sits at `:421-422`. |

## Checklist on the changed text

1. **Values** — S2 recomputed (above); A4/A5 values match spec:120-125 (`gh not installed` is Task 2's classifier string, spec:112); band copy matches
   spec:184; Daylight hexes match `styles.css:130`. No copy string changed.
2. **Reality** — every anchor exists: `tasks.ts:235`, `index.ts:421-422`, `api-harness.ts:106-112`, `daylight-contrast.test.ts:124`, `styles.css:130`.
   `daylight-contrast.test.ts:56` is the function's first body line; the regex is `:57` (M4).
3. **Interfaces** — `resetPrStatusCache`, `resetPrDetectCache`, `acceptPrAnswer` are Produced where Consumed. `acceptPrAnswer`'s signature uses `SessionPr`
   and `SessionPrResponse`, Produced by Task 1 (:63) but absent from Task 4's Consumes line (:241) — M1.
4. **Tests** — C8 fails before implementation (module absent) and discriminates provided `prev` is non-null and the body's `pr` differs from it (M2). A4 now
   discriminates (I2 closed). S2 now gives each bucket a distinct count.
5. **Convention** — no literal code added; wrapped at 160.

## Findings

### Important

**I1 — plan:283-285 the hook does not say which id `acceptPrAnswer` gets as `currentId`, and the natural choice makes the compare a no-op.** The server answers
`{ id, pr }` with the id it was asked for (plan:203-205), so inside the effect that issued the fetch `body.id === id` always holds; passing the closure's `id`
means `body.id !== currentId` never fires, and a stale answer for the old session lands after the "reset to `null` on id change" — exactly Review Focus 5
(plan:45-46), now described as "pinned by C8". The previous wording ("drops answers that arrive for the old id") was removed from the hook line; the sibling
pins this with a `live` cleanup flag (`client/src/hooks/usePendingPlan.ts:63-73`) and reads a changing value through a ref (`tokenRef`, `:51-52`).
→ Add to plan:284: "`currentId` is the hook's latest id read from a ref at answer time (the `tokenRef` pattern, `usePendingPlan.ts:51-52`), never the fetch
closure's `id`, which the server echoes back unchanged" — or keep the sibling's `live` cleanup flag as well and say so.

### Minor

- **M1 — plan:241** Task 4 Consumes lists `PrChecks`, `SessionPrLive`, `SessionPrInfo`; `acceptPrAnswer` (:244-245) also takes `SessionPrResponse` and
  `SessionPr`. Add both to Consumes (Task 1 Produces them at :63).
- **M2 — plan:258-259** C8: say that in the other-id and `error: true` cases the body's `pr` differs from `prev` (a different PR or `null`) and `prev` is a
  non-null PR, so "prev (unchanged object)" is an identity assertion that a "return `body.pr`" implementation fails.
- **M3 — plan:216** A5 "same transcript with `--title "Arg title"`" — A4's transcript now carries the flag, so "the same transcript" suffices.
- **M4 — plan:291** `test/daylight-contrast.test.ts:56` → the `#rrggbb` regex is at `:57` (`daylightMixTokens` starts at `:55`).
- **M5 — plan:290-292** the 14% Daylight tints clear AA by 0.08–0.18 (red over `--strip-hi` 4.58:1, magenta 4.68:1). Worth one clause — "14%, not more:
  the red pill over `--strip-hi` sits at 4.58:1" — so the builder does not "soften" the tint and turn CI red. Also `--steel` (:289) is an opaque well colour,
  not a tint; `tintPairs` (`daylight-contrast.test.ts:93`) will not scan the draft pill (no `-tint` suffix), which is fine because `:124` pins `ink2` on
  `steel` directly — but call it "well" rather than "tint" to match `styles.css:13`.

## What was verified and how

- Contrast: replicated `tint` (`daylight-contrast.test.ts:78-80`, channel-wise sRGB mix) and WCAG `ratio` in node over Daylight's `--strip #ffffff`,
  `--strip-hi #f2f2f1`, `--board #f4f4f3` (`styles.css:126`) with `--red #aa3927`, `--magenta #6950a5` (`:130`).
- `tintPairs` picks `.pr-state.closed{color:var(--red);background:var(--red-tint)}` through the `named` branch (`:93-95`), then `mixes['red-tint']` from
  the Daylight hex line (`:176-178`) — the C1 path review 1 traced, now satisfied by the plan's hex wording.
- `usePendingPlan.ts:56-73`: id-change reset + `live` flag — the pattern the hook line dropped when it delegated to `acceptPrAnswer`.
