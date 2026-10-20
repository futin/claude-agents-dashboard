# Plan review 2 (re-check) — usage-limit alerts

Reviewed: the changed sections of `docs/superpowers/plans/2026-10-20-usage-limit-alerts.md` at commit 14ac312 (`docs: address plan review 1`), diff
`plan-r1.diff`, against `docs/superpowers/specs/2026-10-20-usage-limit-alerts-design.md` and the code in this worktree. Scope was the changed hunks only;
surrounding lines were read where a changed line depends on them. Every code claim a changed line makes was checked by reading the file at the cited line.

## Verdict

**APPROVE.** No Critical or Important finding. All four Important findings of review 1 (I1–I4) and every Minor item it listed are addressed, and each new
statement about the code is true.

## Review-1 findings → their fixes, verified

| Review 1 | Plan line now | Verified against |
| --- | --- | --- |
| I1 `status` out of scope | plan:168-169 — `onUsageReading(limits, now?)`, `ok = limits !== null`, "`refreshNow` derives it later, `usage.ts:379`" | `server/lib/usage.ts:329` (`limits`), `:380` (`status: limits ? 'ok' : 'unavailable'`) — the branch at `:334-362` has no `status`; the citation is one line off (`:379` is the `: null,` line, the status is `:380`), harmless |
| I2 push-unconfigured + recording-off row | plan:212-215 — both new cases plus the precedence sentence | spec:156-158 (recording note only "and push is configured"; `showUsage` "the outer gate") |
| I3 `copy` without `now` | plan:137-139 — fixed `now` = local 2026-10-20 10:00, both stamps derived from it | `date -j -f %Y-%m-%d 2026-10-21 +%a` → `Wed`; spec:135 short weekday (`Tue` example) |
| I4 reset tests without `t` | plan:118-119 preamble (hit at `S − 4 h`, +1 min each), explicit `t` at plan:123, 124, 125, 132, 135 | `RESET_STALE_MS = 60 min` (plan:98) and rules plan:113-114: `S + 1 min` → push, `S + 61 min` → stale, `S − 1 min` → not passed — consistent by inspection |
| Minor: memory vs file | plan:166 `resetUsageAlertsMemory()`, plan:180-182 mirror case (delete the file → second payload) | — |
| Minor: `usageCanSend` type | plan:162 `kind: UsageAlertKind` | — |
| Minor: rule order, `lastSeenT` | plan:104-105 | consistent with plan:130 (`{account:''}` is "not a reading" first, so it does not delete the record) |
| Minor: inside/after the inner `if` | plan:189-190 "after the inner `if (limits && …utilization != null)` block … (not inside it)" | `usage.ts:336-353` is that block, inside the `try` at `:335`; `limits` can be null there (`:329`), so the new `null fetch changes nothing` case (plan:183) matches the real call site |
| Minor: account seam | plan:166-167 `setUsageAlertsHome(dir)` → `readAccountProfile(homeDir)`, `clearAccountCache()` between cases | `server/lib/account.ts:103` (`readAccountProfile(homeDir?: string)`), `:96` (`clearAccountCache`), `:29-30` (`<home>/.claude.json`); `test/account.test.ts:113-125` already uses exactly that pattern |
| Minor: visual fixture, overview row | plan:61, plan:229-230 | `test/visual/fixtures/settings.ts:4-22` is a `ServerSettings` literal under `tsconfig.json:17` `include: [... "test" ...]`; `docs/overview.md:97` carries `notifyAvailable`, `:207-239` lists `lib/*` one per line |
| Minor: both mutations | plan:142-143 (a) and (b) | spec:182 "no reset without a hit" — both halves now named |
| Minor: deepLink prose, SettingsView comment | plan:199 `:117`, `:127`; plan:201 `:39` | `client/src/lib/deepLink.ts:117` lists `?view=git`, `?view=schedules`; `:127` names `managementTab`/`schedulesTab`; `SettingsView.tsx:39` "The five push events" |
| Minor: overview condition | plan:229 now unconditional | — |
| Minor: Review Focus 3 at the shell | plan:183 `null fetch changes nothing` | — |

## Checklist over the changed lines

1. **Coverage** — unchanged from review 1: every spec section and every spec test case (spec:175-178) maps to a task; the changes only add cases
   (`null fetch changes nothing`, the restart mirror, two `notifyRowState` cases, the second mutation). Nothing lost.
2. **Values** — `Resets Wed at 09:10.` is the correct weekday for local 2026-10-21; `Resets at 14:30.`, `No reset time reported.`, the extra-usage suffix,
   both titles and both Settings notes are unchanged and still verbatim from spec:132-137, 153-158.
3. **Reality** — every path and line the changed hunks cite resolves (table above). `resetUsageAlertsMemory`, `setUsageAlertsHome` are new names in the
   to-be-created `server/lib/usage-alerts.ts` (absent, as required).
4. **Interfaces** — `UsageAlertKind` (Task 2) is consumed by `usageCanSend` (Task 3) with the same spelling; `usageAvailable` (Task 1) by Task 4;
   `onUsageReading(limits: UsageLimits | null, now?)` matches its call `onUsageReading(limits)` at plan:189.
5. **Order** — 1 → 2 → 3 → 4 → 5 still holds; no changed line introduces a backward dependency.
6. **Tests** — the new cases fail before implementation (module or seam missing) and pin behaviour (payload count, ledger record) rather than internals.
   Review Focus 2 and 4 are now genuinely proven: the mirror at plan:180-181 is what distinguishes "file stopped it" from "memory stopped it".
7. **Conventions** — behaviour-not-code held (the one `new Date(2026, 9, 20, 10).getTime()` is an exact value, not a body); wrap ≤ 160 held in every
   changed line; no CLAUDE.md rule touched.

## Minor

- plan:61 — the fixture literal is `test/visual/fixtures/settings.ts:4-22` (not `4-20`), and its `events` map at `:15` is a `Record<NotifyEvent, boolean>`
  (`shared/types.ts:981`), so it gains the two usage keys as well as `usageAvailable`. Step 3 (plan:75-76) already says typecheck lists every such map,
  so no implementer guesses wrong; saying "gains `usageAvailable` and the two event keys" would make the file entry exact.
- plan:169 — "`usage.ts:379`" points at the `: null,` line; the status derivation is `usage.ts:380`. Off by one, harmless.
- plan:180-182 — after the fix, `second process finds the claim` is the first half of `restart at 100% sends nothing` without the re-arm (reset memory,
  feed 100, one payload). Both Review Focus items stay pinned, but the two cases now prove the same thing; keep both for the names in Review Focus 2/4, or
  fold the second into a comment on the first.
- plan:162 — `usageCanSend(kind: UsageAlertKind)` makes `notify.ts` import a type from `usage-alerts.ts` while the Task 3 shell in `usage-alerts.ts`
  imports `sendUsageEvent` from `notify.ts`. A type-only cycle is erased by `tsx`/`tsc` and is harmless; worth an `import type` (which CLAUDE.md requires
  anyway), nothing more.
- plan:172 vs plan:174 (unchanged lines, but the new mirror at plan:180-181 leans on them) — "missing or corrupt → empty ledger" and "in-memory ledger …
  used as the base when the file cannot be read" can be read as conflicting for a *missing* file. The mirror case resets memory first, so it passes under
  either reading; stating "missing → empty; unreadable/corrupt → memory" would remove the ambiguity for `write failure still sends`.
- plan:199 — `deepLink.ts:127` does not list the views; it names the `managementTab`/`schedulesTab` settings a tab-bearing view maps to. A `usage` view
  carries no tab, so that comment likely needs no edit; `:117` does list the views and does.

## Decisions logged (autopilot)

- Approved without requesting edits: every finding is Minor and none would change what an implementer builds.
