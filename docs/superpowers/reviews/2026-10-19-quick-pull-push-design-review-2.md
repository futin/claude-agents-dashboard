# Review 2 — Quick pull and push from the Sync key (design spec)

Document: `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md` (213 lines). Reviewer: fresh session, Fable 5.1, 2026-10-19. Round 1 is
`2026-10-19-quick-pull-push-design-review-1.md`; its eight Important findings are all addressed (I1 L37, I2 L41-44, I3 L69, I4 L106-110, I5 L82-86,
I6 L88-91, I7 L64-69, I8 L121-124) and are not re-raised. Every claim below was checked against the worktree (branch `feat/quick-pull-push`, HEAD a170435)
and, for the git behaviour, against `git version 2.50.1 (Apple Git-155)` in a throwaway tmpdir repo with a bare origin and one linked worktree.

## Verdict: APPROVE WITH FIXES

No Critical findings. Three Important ones, each a sentence or a table row; none needs a design decision.

## Important

### I1 — L121-124: where the quick-op wait sits relative to fetch-all's in-flight marker is unstated, and the two readings differ
The spec keys three things on "in flight": a quick op gets 409 while "the server's fetch-all is in flight" (L121), `fetchAll` "awaits every held quick-op
lock before `runFetch` starts" (L123-124), and the tick "does not start fetch-all while any quick-op lock is held" (L123). In the code there are two
candidates for "in flight": `inFlight` (`server/lib/git-fetch.ts:132`), set synchronously at `:224` before `runFetch` runs and what both the join (`:222`,
"a call while one runs gets that run's promise", D6) and the tick (`:199`) key on; and `runningSinceMs` (`:229`), set inside `runFetch` and what the client's
clock shows. The spec does not say which the 409 uses or where the wait goes:
- wait placed before the join check at `:222` → two Fetch all presses during a quick op both run `runFetch`, breaking D6;
- 409 keyed on `runningSinceMs` → a quick op on repo B is accepted while `fetchAll` waits for A's lock, so the awaited set grows and the button's "a second
  or two longer" (L124) is not bounded.
→ One sentence: the join check stays first; the wait lives inside the in-flight promise, after the join and before `runFetch`; the 409 keys on `inFlight`,
so it covers the waiting phase and the set of locks `fetchAll` waits on can only shrink.

### I2 — L179: the mockup carries no `Read-only…` string; the listed mockup differences are the wrong ones
`grep -i 'read.only'` and `grep -i token` over `docs/superpowers/specs/2026-10-19-quick-pull-push-mockups.html` find nothing — the truncated
`Read-only from this network` was the spec's own first draft (review 1, M3), not the mockup's. Meanwhile the mockup copy that does differ from the table is
still uncalled (checklist 4): `nothing to pull` / `nothing unpushed` / `2 unpushed` / `3 to pull` pills (mockup `:237`, `:243`), `main has diverged from origin`
(`:282`, table L161 reads `<branch> has diverged — use Sync`), `main is PR-only` and `fix/deck-paths has diverged` without ` — use Sync` (`:283`), and the
combined result `Moved main forward 5 commits. fix/deck-paths has diverged: use Sync.` (`:248`), a move plus a refusal, which the table's "both" row
(L173, two moves) does not cover. `Fast-forward main by 1 commit` (`:282`) is identical to L156 and is not a difference.
→ Replace the sentence with the real list, or with "every sub-line, pill and result string in the mockup is superseded by this table"; and say whether the
move-plus-refusal result is one line (`moved main forward 5. fix/x: git refused — …`) or two quick-op lines.

### I3 — L152-177: one enabled sub-line is missing and no precedence is given among the disabled reasons, which the spec then asks tests to pin
The table has Pull sub-lines for "trunk on it", "trunk elsewhere" and "both", but not for row 2 alone (L82: the current branch behind its `origin/…`
upstream, trunk up to date) — the most common branch-pin case. Several disabled reasons can hold at once and the table does not order them:
- on the trunk, `currentVsUpstream` is null by contract (`shared/types.ts:1713-1716`), so Push's `main is PR-only — use Sync` (L162) and `No upstream — use
  Sync` (L163) both fit; on the trunk with `ahead == 0` neither is named (`Nothing to push`?);
- trunk checked out elsewhere with nothing on the current branch fits both `Nothing to pull` (L160) and `main is checked out in another worktree` (L165);
- L86 says `counts: null` "disables it" — Pull as a whole, or the current-branch part with the trunk row still applying, as L100-102 lets a diverged current
  branch do?
L198 asks for "client tests for the menu's enabled/disabled/sub-line logic as a pure function", so whatever the implementer guesses becomes a pinned expected
value. → Add `Fast-forward fix/x by N commit(s)` to the table and one line of precedence (for example: quick op running › write access › Sync running ›
detached › diverged › upstream gone › trunk PR-only / no upstream › trunk elsewhere › nothing), and say `counts: null` blocks only the current-branch part.

## Minor

- M1 — L37: `GitBranches.tsx:68` is `:69` (`{here && <GitSyncButton repo={repo} sync={sync} />}`).
- M2 — L143-144: `FETCH_ENV` and `SSH_BATCH` are module-private (`server/lib/git-fetch.ts:38`, `:40`), and the "user's own ssh wins, else BatchMode" choice
  is computed inside `fetchGroup` (`:291-298`), not in the overlay. "Reuse it rather than copy it" therefore means exporting the overlay plus that decision as
  one helper; say so, or the second launcher inlines a third copy of the ssh rule.
- M3 — L170: `Needs the Answer token` departs from both existing token sub-lines, which share one shape — `FETCH_NEEDS_TOKEN` (`client/src/lib/gitStatsText.ts:42`)
  and `SYNC_NEEDS_TOKEN` (`client/src/lib/gitSync.ts:25`): `<Thing> needs the Answer token — set it under Settings › Local › Connection.` Either use that
  sentence or say the short form is deliberate because the menu item is narrow.
- M4 — L137: review-1 M4's second half is still open: the route needs a row in `docs/overview.md`'s route table (`:99-103`), and the new module a line in the
  overview's `lib/` map (`:211-214`), beside the `server/index.ts` comment row the spec now names.
- M5 — L68: "a successful stats poll that follows by more than 30s" does not say what it follows (the op's answer, presumably). `useGitStats` exposes
  `updatedAt` (`client/src/hooks/useGitStats.ts:86`) and `refresh()` (`:15`, `:85`); name them as the clock and the trigger so the hook is not re-plumbed.
- M6 — L132-133, L177: 60s is per git call, and a Pull is up to three calls (fetch, fast-forward current, move trunk), so an op can run ~180s before
  `git took over 60s` is shown. Either cap the whole op or word the result line as the call that timed out (`git fetch took over 60s …`).
- M7 — L146: the scanner also flags any bare `fetch(` call (`test/outbound.test.ts:56`, `(?<![\w$])fetch\s*\(`), not only imports — a local helper named
  `fetch` in the new module would fail the `ALLOWED` deep-equal. Worth one word so the builder names it `fetchOrigin` or similar.
- M8 — L121 vs L176: the 409 body is `A fetch is running — try again in a moment` and the result line `claude-global: a fetch is running — try again in a
  moment.` (lower-case after the prefix, with a full stop). Consistent with the `git refused — …` row, but say the client lower-cases the server's copy
  rather than the server sending two shapes.

## Checked and true (no finding)

- L24 trunk is PR-only; git-sync's `push-trunk` reports `pr-only` and routes trunk commits through the carry question — `plugin/skills/git-sync/SKILL.md:88-91`.
- L38 Inspector footer draws `GitSyncButton` with `label="Clean up via Sync"` — `GitInspector.tsx:196`.
- L41-42 today's key is `null` when `!sync.available || !canSync(repo)`; `canSync` is `state === 'ok' && hasOrigin` — `GitParts.tsx:48`, `lib/gitSync.ts:52-54`.
- L55 the Sync key's click calls `stopPropagation` — `GitParts.tsx:60`.
- L57 `.git-mx-wrap{padding:0 0 16px;overflow-x:auto}` — `styles.css:3040`.
- L60 `.git-sync.on` cyan + `git-spin` — `styles.css:2952-2953`.
- L64-67 three `.git-sync-note` divs under the band; `.git-sync-note` is `--amber-text` — `GitView.tsx:79-81`, `styles.css:2957`; `useGitSync` nulls `note`
  on every `start` — `useGitSync.ts:96`.
- L69 `GIT_POLL_MS = 30_000` — `client/src/lib/gitPoll.ts:10`.
- L86 `counts: null` when the upstream is configured but gone — `shared/types.ts:1712-1713`.
- L88 `branches` excludes the trunk — `shared/types.ts:1721`.
- L89 `%(worktreepath)` is in `LOCAL_REF_FORMAT`, read for every local ref — `server/lib/git-stats.ts:148`.
- L89-91 the comparison "set and not this pin's `toplevel`" is safe as written on git 2.50.1: both `rev-parse --show-toplevel` and `%(worktreepath)` come back
  realpath'd (`/private/var/…` for a `/var/folders/…` tmpdir, main and linked worktree alike), so no extra `realpathOr` (`git-stats.ts:216`, `:363`) is
  needed for the new field. A linked-worktree pin reads the main checkout's path for `main`, as L90 says.
- L97 `git fetch origin main:main` from a linked worktree is refused when `main` is checked out elsewhere:
  `fatal: refusing to fetch into branch 'refs/heads/main' checked out at '…'`, exit 128 — so the refusal's first stderr line is usable as L175's copy.
- L106-108 `gitTracked` drops only an absent upstream and `origin/<trunk>` — `GitParts.tsx:170-174`; `currentVsUpstream` is null on the trunk — `types.ts:1713-1716`.
- L118 `MERGE_HEAD` etc. are per-worktree, hence `--git-path` — consistent with the reader's own per-toplevel calls (`git-stats.ts:276-285`).
- L122 fetch-all groups pins by `--git-common-dir` — `git-fetch.ts:245-273`; `lock` fetch error — `git-fetch.ts:110`.
- L123 the tick starts a fetch only when `inFlight === null` — `git-fetch.ts:199`.
- L127 runs live in `localStorage` (`usePersistedState`) and `phaseFor` reads them — `useGitSync.ts:108-111`.
- L131-132 fetch-all sets `core.hooksPath=/dev/null`; `FETCH_TIMEOUT_MS = 30_000`; reader `GIT_TIMEOUT_MS = 5000` — `git-fetch.ts:29`, `:22`; `git-stats.ts:42`.
- L137 `server/index.ts` header has `/api/git-stats` and `/api/git-fetch` rows — `server/index.ts:13-14`; 409 has precedent (`/api/codegraph/run`, `docs/overview.md:102`).
- L138 `serveGitFetch` starts with `refuseWrite` — `server/api.ts:1740-1741`.
- L139 `dirName` resolved against the enumerated pins, never a client path — `server/api.ts:1648-1657` (`resolveProject`).
- L143-144 array-form, detached, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=''`, `SSH_ASKPASS=''`, `LC_ALL=C`, `ssh -o BatchMode=yes` — `git-fetch.ts:33-40`, `:53-60`, `:296-298`.
- L146 `outbound.test.ts` scans only net-module imports and bare `fetch(`; it pins `git-fetch.ts` by CLAUDE.md text in the slice before `` `client/dist/` `` —
  `test/outbound.test.ts:20`, `:42-61`, `:115-119`; the CLAUDE.md paragraph it reads — `.claude/CLAUDE.md:76-80`.
- L149 "The reader stays read-only" heading — `docs/subsystems/git-stats.md:11`.
- L170 `READ_ONLY_TEXT` used whole by the Fetch all key — `writeRefusal.ts:7`, `gitClock.ts:138`.
- L186 no-`title` rule — `docs/subsystems/usage-limits.md:388-390`; `.claude/rules/` does not exist.
- L187-188 Retry fetch key disables on `writeAccess === 'none'` or `tokenRequired && !tokenStored` — `GitParts.tsx:152`.
- L25 the mockup's left-out artboard is headed "Left out · A git console per repo" — mockups `:198`.
