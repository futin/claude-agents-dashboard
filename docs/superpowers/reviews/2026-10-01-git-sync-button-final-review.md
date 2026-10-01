# Final whole-branch review — `feat/git-sync-button` (25f5ce2..c693c6a)

Reviewer: Fable 5.1, read-only, 2026-10-01. Inputs: the review package diff, plan `docs/superpowers/plans/2026-10-01-git-sync-button.md`, spec
`docs/superpowers/specs/2026-10-01-git-stats-design.md` §9, the executor ledger `.superpowers/sdd/2026-10-01-git-sync-button/progress.md`, `.claude/CLAUDE.md`.

## Verification run

- `pnpm test` in the worktree: exit 0, 1947 `✓` lines, 0 `✗`; `client/lib/gitSync.ts` suite 36 passed, 0 failed.
- `pnpm typecheck`: `tsc --noEmit` clean.
- `pnpm build` not run (the dispatch permitted test and typecheck only). The ledger records it green per task; the PR must quote it.
- Working tree clean before and after (`git status --short` empty).

## Spec compliance (§9) — COMPLIANT

| §9 bullet | Where | Status |
| --- | --- | --- |
| Button in Cards head right / Table last column / Triage row right | `GitCards.tsx:63-68`, `GitTable.tsx:186,208`, `GitTriage.tsx:278-281,301-309` | met |
| Hidden for `missing` / `not-git` / `error` / no origin; hidden while `spawnAvailable !== true` | `gitSync.ts:761-763` (`canSync`), `GitParts.tsx:126` | met |
| No Sync-all, no Prune | — | met |
| Click launches at once: `POST /api/spawn`, pin `dirName`, prompt `/claude-agents-dashboard:git-sync`, name `git-sync <repo>` with rejected chars → `-` | `gitSync.ts:766-782` | met (name also capped at 60, parity-tested against the server regex) |
| Model/effort/permission/remote control from Settings › Local › Git Sync, separate from New sessions | `settings.ts` fields, `SettingsView.tsx:497-525` | met |
| Runs in the pin's path (dirName, never a path) | `gitSync.ts:773` | met |
| Session id remembered per device in `localStorage`, keyed by toplevel; two pins share a run | `useGitSync.ts:585`, `gitSync.ts:797-799` | met |
| `working`/`question` → "Syncing · open" opens a drawer inside Management | `gitSync.ts:793`, `GitView.tsx:376-381` | met |
| launching / not in payload → "Syncing…" disabled | `gitSync.ts:789-794,815-821`, `GitParts.tsx:135` | met |
| `idle`/`incomplete` → run forgotten, repo re-polled | `gitSyncRuns.ts`, `useGitSync.ts:595-603` (calls `refresh`) | met |
| No server change | diff touches nothing under `server/` or `shared/` | met |

Ledger rulings weighed: `canSync` as a type guard (fine, removes a cast); `starting` field beyond the plan's interface (needed — `pending` is shared, so
without it every pill would read "Starting…"); idle = null | ended | failed (fine — `start()`'s `runFor` guard refuses the one-render click);
`.git-head-end` cluster instead of a bare last child (a layout fix, class names stable, tokens only). All four are justified improvements.

## Review Focus (the five input classes)

1. **Running sync drops out of the payload.** `syncPhase` rule 4 returns `unseen` under the 24h TTL (`gitSync.ts:794`); `reconcileRuns` drops only
   `ended`/`failed` (`gitSyncRuns.ts:859`); the pill reads "Syncing…" disabled, so the drawer cannot open. Tested P5/P6/P8/H5. Correct. But see Important #1:
   the same rule turns a *never-seen* failed launch into a 24h-disabled pill.
2. **Two pins, one toplevel.** `runFor` keys by `repo.toplevel` (K1 tested); `start` refuses when `runFor` is non-null (`useGitSync.ts:627`). Both pills
   show the run and read "Starting…" together during the POST (shared toplevel, acceptable). Correct.
3. **Ceiling below the setting.** `syncRequest` clamps to `allowedPermissionModes(ceiling)`'s last entry (`gitSync.ts:776`, R4/R5/R6); the Settings select
   draws the ceiling with a hint (`SettingsView.tsx:471-475`). Correct.
4. **Junk in localStorage.** `usePersistedState` already fail-opens on bad JSON; `parseSyncRuns` rejects non-objects, arrays, empty keys, non-string
   fields, non-finite `launchedAtMs` (S1–S5). Nothing throws in render. Correct.
5. **Repo stops being ok mid-run.** `canSync` hides the pill; the run stays in `runs`, so `hasRuns` keeps the poll alive and `reconcileRuns` iterates runs
   not repos (H3). No crash path: `phaseFor` is per repo and `runFor` returns null for a non-ok one. Correct.

## Issues

### Critical (must fix)

None.

### Important (should fix)

1. **A launch that fails while Management is unmounted leaves the pill disabled for 24h with no way out** — `client/src/lib/gitSync.ts:794`,
   `client/src/hooks/useGitSync.ts:591`. The gated sessions poll lives in `useGitSync`, which mounts only with `GitView`. The server keeps a `failed`
   launching entry for `FAIL_TTL_MS = 5 min` (`server/lib/spawn.ts:458`). Sequence: click Sync, switch to Sessions to watch it (or to another section), the
   child dies (auth expired, model unavailable, CLAUDE_BIN typo); return to Management more than 5 minutes later. The failed entry is gone, no row ever
   existed, and `syncPhase` rule 4 yields `unseen` until `launchedAtMs + 24h`: the pill reads "Syncing…" disabled for a day, the note never shows, and only a
   hand edit of `localStorage['management.syncRuns']` clears it. The spec's "when the session ends the run is forgotten" has no end for a session that never
   began. This is a plan defect (Q6 picked one TTL for both the never-seen and the seen-then-vanished cases), not a transcription error. Fix shape: keep a
   `seen` flag on the run (set the first time a row or launching entry carries its id), and apply a short TTL (for example 10 min) while unseen, 24h once
   seen — or let a click on an unseen pill forget the run after confirming. Either is client-only.
2. **The reconcile write can drop a run that a launch recorded in the same instant** — `client/src/hooks/useGitSync.ts:599`. `setStored(r.runs)` is a
   value write computed from the render's `stored`, while `start`'s `.then` writes functionally (`:633-636`). If the launch promise settles between the commit
   of a payload render that ends another run and that render's passive-effect flush, React applies the queued functional add first and then this replace,
   and the new run is lost: the pill goes back to "Sync" and a second sync can be started on a repo already syncing. Narrow window (one frame, and only
   while another run ends in that payload), but a correctness defect in exactly the state path the dispatch asked about, and the fix is two lines: write
   `setStored(cur => reconcileRuns(parseSyncRuns(cur), data, now).runs)` and keep the closure's `r` only for the note and `onEnded`.
3. **Functional updates are smuggled through a value-typed setter** — `client/src/hooks/useGitSync.ts:585,633`. `usePersistedState` is typed
   `[T, (v: T) => void]`; `useGitSync` instantiates it with `T = unknown`, so passing an updater function typechecks only because any function is
   `unknown`. It works today because the setter is React's raw `setState`. If `usePersistedState` ever wraps its setter (a synchronous write, a
   cross-tab broadcast), the function itself becomes the stored value, `JSON.stringify` yields `undefined`, and every run is lost without a type error.
   Fix: type `usePersistedState`'s setter as `Dispatch<SetStateAction<T>>` (what it already is at runtime) and store `SyncRuns`, not `unknown`; or do the
   merge in the hook with a value write and accept the race in #2 is then the only one to fix.

### Minor (nice to have)

- `client/src/hooks/useGitSync.ts:626-638`: `start`'s `useCallback` depends on `runs`, a fresh object from `parseSyncRuns` every render, so the memo never
  hits. Harmless; either drop the `useCallback` or memoize `runs` on `stored`.
- `client/src/hooks/useGitSync.ts:631`: a launch that settles after `GitView` unmounts (user leaves Management inside the POST round trip) is never
  recorded — `setStored` on an unmounted hook is a no-op. The spawn route answers as soon as the child is forked, so the window is tens of ms; worth a
  one-line comment or a module-level pending-run stash if #1's `seen` flag is added anyway.
- `client/src/hooks/useGitSync.ts:654`: `closeChat` is a new function per render, so `ChatDrawer` re-subscribes its Escape and back-close handlers on every
  3s poll. `SessionsView` does the same with an inline arrow, so this is consistent, not a regression.
- `client/src/styles.css:2687`: `.git-arow.quiet>.git-rowbtn{display:flex;width:100%}` no longer matches — the row button moved under `.git-qhead`. Dead
  rule; the replacement `.git-qhead>.git-rowbtn` carries the layout. Leave or delete.
- `client/src/components/settings/SettingsView.tsx:473-475`: before `/api/health` has answered, `allowedPermissionModes(undefined)` is three modes, so the
  hint reads "This host limits launches to 'auto' or below" for up to one poll. Transient and the same fallback the launch sheet uses.
- `client/src/hooks/useSessions.ts:684-687`: when disabled, the effect calls `setState` with a fresh object each time its deps change, so a disabled
  consumer re-renders once per `query`/`refreshMs` change. Negligible; `SessionsView` never passes `enabled`, so its path is byte-for-byte the old one
  (`opts.limit` undefined → `scanQuery` falls back to `maxSessions`, Q1 tested).

## Code quality and repo rules

- Cross-boundary imports are `import type` (`gitSync.ts:724`, `useGitSync.ts:545`, `GitCards.tsx:39-40`, etc.). No plugin import; the prompt is a literal.
- `styles.css` additions use tokens only; `color-mix(... transparent)` is the file's existing idiom (`:1222` is the same expression). No class renamed.
- Settings stay flat; `clampSettings` validates each new field independently (C1–C4 tested).
- The `management.syncRuns` literal is used at the `usePersistedState` call so the Reset sweep sees it, with `SYNC_RUNS_KEY` pinned by T5. The sweep's
  `exempt` set documents why Reset leaves it.
- Table: `COLS = 7`; off rows span `COLS - 1`, sub-rows `COLS`, so the new column is absorbed. The pill's click stops propagation.
- Triage quiet row: row button and pill are siblings under `.git-qhead`; no button-in-button.
- Tests verify real behaviour (pure functions, source-text parity for `NAME_RE`). The React hook has no test by design; its two effects are the Important
  findings above, so a human click on a repo with something to sync remains the only proof of the launch → drawer → re-poll loop, as the plan states.
- Docs: `git-stats.md` §Client, `settings.md`, `spawn.md` and `overview.md` name only identifiers that exist in the code; the docs-sync stamp gained the
  three new sources.

## Declined to judge

1. Resuming an ended sync from the Management drawer's `ResumePanel` (the drawer passes `spawnAvailable`) creates a session that no run tracks — the
   resume composer is the drawer's generic feature and the spec says only dashboard-launched syncs are detected; the executor rules whether to hide it here.
2. Two devices or two tabs starting a sync on the same repo — the spec makes tracking per device on purpose.
3. `useGitSync` adds a second 15s `/api/health` poll via `useRemoteAnswer` while Management › Git is open — the pattern `SettingsView` and `SessionsView`
   already follow; not a change in kind.
4. `pnpm build` — not run here; permitted commands were `pnpm test` and `pnpm typecheck`. The PR must quote its output.

## Assessment

**Ready to merge: With fixes.**

**Reasoning:** Every §9 bullet is implemented and tested where it is pure; the four ledger rulings are sound. The three Important findings are all in the
hook's state handling: one plan-level gap (a never-seen failed launch disables the pill for 24h), one narrow write race, and one type hole that lets the
race's fix silently regress later. All are client-only and small.
