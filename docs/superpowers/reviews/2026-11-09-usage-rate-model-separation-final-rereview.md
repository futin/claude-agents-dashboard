# Re-review — final-review fix round (1d55fd0..700ad18)

Verdict: APPROVED. No new Critical or Important findings.

Ran (foreground): `pnpm typecheck` clean; usage-rate-fit 33/0, api-usage-rates 22/0, usage-rates-format 67/0, usage-rate-daily 18/0.

| Finding | Status | Evidence |
|---|---|---|
| I1 | resolved | usage-rate.ts:719 `if (days.length < 3) return new Map()`; separationContext falls back to SUB_ERR for an absent model (usage-rate.ts:868). usage-rate-fit test pins 2-day/1-day size 0 and 3-day non-zero (discriminating: fails without the guard). api-usage-rates fixture reworked to 3 days, 37 vs windows 25 asserted. Doc states the fallback. |
| I2 | resolved | `thinNotes` splits floors vs separation; UsageRates.tsx shows the fortnight note only for floor/absent-reason rows; separate SEPARATION_THIN_NOTE. Unit test in usage-rates-format. |
| I3 | resolved | THIN_HINT.mixed span-neutral; repriced only judged on current window so its hint stays accurate. |
| I4 | resolved | Types/JSDoc/docs reworded to ownership; mixed moved out of coverageRows into `sharedLine`; `windows` added consistently: shared/types.ts, emptyRates (0), shapeUsageRates (`distinctWindows`), client Ledger tile + Windows cell, visual fixture (128), only fixture sites found by grep. Coverage headline unchanged (parked, documented). |
| I5 | resolved | docs 17.7% (cv 22.1%, 14 days, dated). The remaining 21.7 at usage-limits.md:1055 is the historic 7-day pre-guard figure, labelled as such. |
| Deferred test | resolved | Source-text pin is acceptable: dailyRates' default ctx is numerically identical, so no behavioural test can discriminate; fixer reports mutation proof (drop `, ctx` -> 1 fail). Brittle to a rename, but the repo has the same pattern (tailnet.test.ts). |

Minor, not blocking: client/src/lib/usageRatesFormat.ts:271 comment ("reached a rate") and usage-rate.ts:73 ("Only {model} is ever fitted on") still use the old reach wording; no api-level test that a 2-day ledger reads `mixed` (the fit test covers the cause). Not run: pnpm test, test:visual, browser.
