# Re-check of review 1 fixes — Git Sync button plan

Date: 2026-10-01. Reviewer: Fable 5.1 subagent, read-only. Scope: only the hunks in `scratchpad/review1.diff` against
`docs/superpowers/plans/2026-10-01-git-sync-button.md` (plan) and `docs/superpowers/specs/2026-10-01-git-stats-design.md` §9 (spec). Unchanged sections
were not re-reviewed.

## Verdict

**APPROVE WITH FIXES** — no Critical. Two Important: a note-derivation mechanism that goes silent on a repeated 403, and a Files list that omits a file
the same task tells the implementer to edit.

## What was verified against the code

| Plan claim | Code | Result |
| --- | --- | --- |
| plan:39 `server/lib/spawn.ts:91,178-180` — NAME_RE, silent drop | `server/lib/spawn.ts:91` `const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;` (not exported); `:178-180` name → `undefined` when it fails | correct |
| plan:124-125 `NAME_CAP` (60), "Mirrors server/lib/spawn.ts" comment style | `client/src/lib/spawnOptions.ts:41-42`; `server/lib/spawn.ts:69`; no `NAME_RE` in the client file yet | correct |
| plan:152 N1 `syncSessionName('café+ü')` = `git-sync caf---` | recomputed: `é`,`+`,`ü` are each one code unit outside the class → `caf---` (source string is NFC) | correct |
| plan:153 N2 70-char name → length 60 | `9 + 70 = 79` → cut to 60 | correct |
| plan:93 `permissionTitle` is a local literal in `SpawnPanel.tsx` | `client/src/components/SpawnPanel.tsx:99-101`, `const`, not exported | correct |
| plan:114 `Settings` type exported from `client/src/lib/settings.ts` | `settings.ts:68` | correct |
| plan:212-214 Reset sweep scans source for literal `usePersistedState('…')` keys and fails outside `OWNED_KEYS` unless in `exempt` | `test/client-settings.test.ts:18-27` (regex requires a single-quoted literal), `:325-338` (`exempt` at `:333`, `missed` at `:334`) | correct; range off by a few lines (Minor) |
| plan:222-223 `useSpawn` reports `needsToken`/`error` via state, `launch` returns `null` for both | `client/src/hooks/useSpawn.ts:49-63` | correct, but see I-1 |
| plan:257-258 off rows span `COLS - 1` (`GitTable.tsx:38`), sub-rows `colSpan={COLS}` (`:75-101`) | `:38`, `:75`, `:92`, `:98`, `:101`; branch rows `:82-86` sum `2 + (COLS-3) + 1 = COLS` so they widen too | correct |
| plan:192 Create `gitSyncRuns.ts`, `useGitSync.ts`; plan:109-110 Create `gitSync.ts`, `test/git-sync-client.test.ts` | none exist | correct |
| plan:212 fallback `{}` through `usePersistedState` survives junk | `client/src/hooks/usePersistedState.ts:11-22` fail-open, shallow merge; a non-object parses through to `parseSyncRuns` | correct |
| spec:338-339 name rule ↔ plan:38-40, 124-126, 150-155 | same charset, same `-` replacement, cap stated in the plan | consistent |

## Findings

### Important

**I-1 — plan:222-225 — the "effect keyed on `needsToken` and `error`" goes silent on a second consecutive 403.**
`useSpawn.launch` sets `needsToken` to `true` on a 403 (`client/src/hooks/useSpawn.ts:49-52`) and nothing ever resets it before the next launch
(`:40-44` only clear `error`). So: first click → 403 → `needsToken` false→true → effect fires → note shows. Second click on the same host → `start` clears
the note (plan:225) → 403 → `setNeedsToken(true)` is a no-op → neither dependency changed → effect does not run → the note stays empty. `start` is not
refused on that path (plan:220 gates on `pending`, `available`, `canSync`, `runFor`; `available` is `spawnAvailable`, not the token), so a user without a
token sees the 403 note once and then nothing.
→ Derive the note on the `pending` true→false transition instead: an effect on `[pending]` that, when `pending` is false and a `start` is outstanding
(ref), reads `needsToken` / `error` from that render. Both are set in the same continuation as `finally { setPending(false) }` (`useSpawn.ts:50,59,62`
precede `:65`), so React 18 batches them into the render where `pending` drops. Keep the precedence (`needsToken` beats `error`) and the "repo last
started" name. Alternatively include a per-start attempt counter in the dependency list and gate on `!pending`.

**I-2 — plan:108-110 — Task 2's Files list omits `client/src/lib/spawnOptions.ts`, which plan:125-126 tells the implementer to modify.**
The `NAME_RE` mirror "added to `client/src/lib/spawnOptions.ts` beside `NAME_CAP`" is a real edit to an existing file, but the task's Files block lists
only two Creates. Under subagent-driven development the Files block is the implementer's scope statement, and Task 5's "cross-check every name against
the code as merged" (plan:286) also walks the Files lists.
→ Add `- Modify: client/src/lib/spawnOptions.ts (NAME_RE mirror beside NAME_CAP)` to Task 2's Files.

### Minor

- **plan:124-126** — "Uses a client `NAME_RE` mirror" cannot literally be the replacement pattern: `NAME_RE` is anchored with a distinct first-character
  class, while the sanitizer needs a per-character negated class (`[^A-Za-z0-9 ._-]`, global). The implementer will write two patterns; say "validated
  against the client `NAME_RE`" and name the second pattern so the two char classes are visibly the same.
- **plan:152** — N1 relies on `é` and `ü` being precomposed (NFC) in the test source; an editor that normalises to NFD would make the expected value
  `git-sync cafe--u-`. Either state the NFC assumption or spell the two characters as `é` / `ü` in the case.
- **plan:213** — the Reset sweep lives at `test/client-settings.test.ts:325-338` (the `exempt` set is `:333`), not `326-335`.
- **plan:282** — the heading is "## Where each setting lives, and why" (`docs/subsystems/settings.md:6`); the plan's abbreviated "§Where each setting
  lives" resolves but is not the exact anchor.
- **plan:154-155** — N3's parity check must strip the regex delimiters and trailing `;` from the server line before comparing with `.source`; obvious,
  but worth one clause so the test is not written as a substring match that would pass on a stale server regex containing the client one.

## Checklist coverage (changed sections only)

1. Coverage — spec:338-339 (name rule) → plan Task 2 `syncSessionName`, N1–N3; spec:339-340 (Git Sync settings group) → Task 1. Nothing uncovered.
2. Values — `git-sync repo` (R1), `git-sync claude-agents-dashboard`, `git-sync caf---`, length 60, `management.syncRuns` (T5), `permissionTitle`
   sentence: all recomputed or read; all match.
3. Reality — every path and symbol named in the hunks exists or correctly does not (table above). One omission in a Files list (I-2).
4. Interfaces — `syncSessionName` produced and consumed inside Task 2; `SYNC_RUNS_KEY` produced in Task 2, pinned by T5, deliberately not consumed by
   Task 3's `usePersistedState` call (literal key, reason stated). `GitSyncControl.phaseFor(repo: RepoGitStats)` now typed. Consistent.
5. Order — Task 3's `exempt` edit lands in the same task as the literal key. No forward dependency.
6. Tests — N1–N3, T5 fail before implementation (module absent). The 403-note path (I-1) has no test and is hook logic, so it stays a manual check;
   the fix above keeps it that way but makes the behaviour correct.
7. Conventions — behaviour-not-code honoured in every hunk; 160-column wrap honoured except plan:93 and plan:257, which run past 160 (style only).
