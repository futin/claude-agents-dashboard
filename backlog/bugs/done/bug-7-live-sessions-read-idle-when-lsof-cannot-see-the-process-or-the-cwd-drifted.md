---
id: bug-7
title: Live sessions read IDLE when lsof cannot see the process or the cwd drifted
created: 2026-08-28
tags: sessions, scan, spawn
updated: 2026-09-02T15:54:20Z
groom-elapsed: 110
started: 2026-09-02T15:35:19Z
execute-elapsed: 1141
---

## Symptom

A session that is demonstrably running — a Bash tool call rendered in its activity line,
last message 1s old — renders gray **IDLE** instead of green **WORKING**.

Observed on a dashboard-spawned session (`surface: dashboard`, row title
`bl claude-agents-dashboard bug-2`, project `claude-agents-dashboard`, branch `main`,
40.1k tokens, `IDLE · Bash Show bug-2 · 1s ago`) launched from a dashboard sitting in
`../backlog-manager`, while two ordinary `backlog-manager` rows in the same snapshot
correctly showed WORKING.

Not spawn-specific. Cause A below mislabels **any** session started from the native
installer's `claude`; the spawned session merely hits it first, because `CLAUDE_BIN`
points at exactly that shim.

## Repro

Cause A (probe blind to the binary):

```bash
ps -o pid=,ucomm= -p <pid of a native-install claude session>   # -> 2.1.250, not "claude"
lsof -c claude -a -d cwd -Fn                                    # that pid is absent
lsof -p <pid> -a -d cwd -Fn                                     # but its cwd resolves fine
```

Measured 2026-08-28 with three desktop-app sessions and one native-install session live:
the aggregate probe returned 3 of the 4 pids. Missing pid `93162`
(`~/.local/bin/claude -p --session-id … --remote-control`), cwd
`/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard`.

Cause B (cwd drift):

1. Start any session, let it run `cd <subdir> && …` in one Bash tool call.
2. Every transcript record from that point carries `cwd: <repo>/<subdir>`.
3. The row flips to IDLE and stays there while the session keeps working.

Confirmed in `~/.claude/projects/-Users-…-claude-agents-dashboard/f9388f02-….jsonl`:
record 97 is `Bash {"command": "cd backlog/bugs/open && sed -i '' …"}`; records 98-100
carry `cwd: …/claude-agents-dashboard/backlog/bugs/open` while `lsof` still reported the
process cwd as the repo root. `GET /api/sessions` reported that session's `projectPath`
as `…/claude-agents-dashboard/backlog/bugs/open`.

## Affects

- `server/lib/transcript.ts:261` — `if (!cwd && typeof rec.cwd === 'string')` inside the
  **newest-first** scan, so `parsed.cwd` is the *newest* record's cwd
- `server/lib/transcript.ts:123` — `readTail` is the only read; there is no head read, so a
  session's launch cwd is not recoverable today
- `server/lib/scan.ts:346` — `const projectPath = parsed.cwd || null`, the single value that
  feeds the row label, the Settings project filter *and* the liveness gate
- `server/lib/scan.ts:362` — the `dead` gate: `live !== null && projectPath !== null && !live.has(normCwd(projectPath))`
- `server/lib/scan.ts:387` — `else if (dead) status = 'idle'`
- `server/lib/scan.ts:349` — the `refreshCwd` self-exclusion, which compares the same value
- `shared/types.ts:42` — `projectPath: string | null`, whose meaning this fix pins down
- `docs/subsystems/sessions.md:192-209` — the liveness paragraph; `:11-13` — "real path from
  the transcript's `cwd`"
- `test/scan.test.ts:401` — "a worktree session is live on its own cwd, not its parent repo",
  which asserts exact per-cwd matching **on purpose** and must stay green

Line numbers above are as of 2026-09-02 (`main` at `2d1e3d8`); the three `scan.ts` numbers in
the original capture (191/283/305) predate bug-12.

## Cause

Two independent causes were captured. **A is already fixed**; B is still live, and the live
re-measurement below shows B is a different shape than the capture assumed.

**A — FIXED by bug-12, not by this item.** `20e917e fix(scan): identify claude processes by
pid, not binary filename` (2026-09-01) replaced `lsof -c claude` with `ps -Ao pid=,comm=` →
`lsof -p <pids> -a -d cwd -Fn`, matching the launcher path's basename instead of p_comm.
Re-verified live 2026-09-02: the probe now returns all five running pids including
`~/.local/bin/claude` (pid 31636). The original diagnosis is kept below as the record.

> `~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/2.1.250`, a Mach-O
> executable whose *filename is the version string*. `ucomm` (p_comm) is therefore `2.1.250`,
> and `lsof -c claude` — a prefix match on that name — never saw it, while the desktop app's
> binary is literally named `claude` and passed. Every native-install session's cwd was
> silently absent from the live set, the `dead` gate fired, and `status` was forced to `idle`
> regardless of the transcript. The probe's fail-open contract did not help: it fails open
> only when `lsof` *errors*, and there it exited 0 with a confidently incomplete set.

**B — `projectPath` is the newest record's cwd, and the newest cwd is not always the process's
cwd.** `readTranscript` scans newest-first, so `parsed.cwd` is whatever cwd the *last* record
carried (`transcript.ts:261`); `scan.ts:346` makes that `projectPath`, and the gate compares it
for exact string equality against a set of **process** cwds. That comparison has two failure
directions, not one — and only the first was captured:

- **Shell drift** (the reported repro). A `cd` inside a Bash tool call moves the *transcript's*
  cwd for the rest of the session; the claude process itself never chdir'd. The launch cwd is
  the one that matches `lsof`, the newest cwd matches nothing, the gate fires, and the row goes
  gray while the session works. Verified 2026-09-02 on the exact file named in the repro
  (`f9388f02-…jsonl`, 218 KB): head record (`type: attachment`) carries
  `…/custom-projects/claude-agents-dashboard`, newest record carries
  `…/claude-agents-dashboard/backlog/bugs/open`.
- **Process drift** (new; the capture missed this). Entering a git worktree mid-session chdir's
  the claude **process**, so the newest transcript cwd is the correct one and the launch cwd is
  the stale one. Verified live 2026-09-02: transcript `f4f08da0-…jsonl` has head cwd
  `…/custom-projects/backlog-manager` and newest cwd
  `…/backlog-manager/.worktrees/runs-view-redesign`, while `lsof` reports pid 24675's cwd as
  exactly that worktree path.

So **neither cwd is reliable alone**, which rules out both directions the capture proposed:
pinning `projectPath` to the first record fixes shell drift and introduces a brand-new false
IDLE for every process-drift session, and containment matching (live cwd at-or-under
`projectPath` or vice versa) deliberately breaks `test/scan.test.ts:401` and scales badly
upward — one claude sitting in `~` would mark every session under it live and make the gate
useless.

Population measured 2026-09-02 across all 650 transcripts under `~/.claude/projects`:

- 30 (4.6%) have a newest cwd different from their head cwd; **every** one drifts *deeper*, and
  every drifted tail is a worktree path.
- 0 of 650 lack a `cwd` in their first 256 KB. Worst case the first cwd-bearing record *ends*
  at byte 7,811 (p99 7,323, median 5,191) — it is always the head `attachment` record.
- 445 of 650 exceed the 256 KB tail window, so for most files the launch cwd cannot be
  recovered from the bytes the tail read already decoded.

Why the bug surfaced when it did: at the moment of the screenshot no other session held the
repo root as its cwd. Per-cwd granularity (the documented limit) normally *masks* the defect —
a second session sitting in the same directory makes a mislabelled one read live by accident.

## Fix

Give every session **two** cwd keys and treat either one matching as proof of life. Fixes both
drift directions without widening the gate to whole subtrees.

**1. `server/lib/transcript.ts` — expose the launch cwd.**

- Add a `readHead(filePath, headBytes)` beside `readTail`, same shape and same
  read-what-exists tolerance.
- Add `originCwd: string | null` to `ParsedTranscript`: the cwd of the **oldest** record that
  carries a string `cwd`, i.e. where the session was launched.
- Resolve it without paying for a second read when one isn't needed: when the tail window
  already started at byte 0 the oldest line in the tail *is* the first record, so scan the
  already-decoded lines forward instead of touching the disk. Only a truncated tail
  (`tail.truncated`) triggers a head read.
- Head window: **16 KB** — a little over 2× the worst case measured above. If no record in that
  window carries a `cwd`, `originCwd` is `null` (fail open, see step 2), not a guess.
- Memoize per file path — a transcript's launch cwd never changes, and the scan re-reads every
  session every 3 s. Entry holds the resolved value plus the file size it was established at;
  drop the entry when the file has **shrunk**, which means rotation or truncation. This is the
  same invalidation rule `title-cache.ts:137-139` already uses, for the same reason.
- Add test seams mirroring `resetTitleCache` / `titleCacheStats`: a cache reset and a counter of
  head reads actually performed.

**2. `server/lib/scan.ts` — one label key, two liveness keys.**

- `projectPath` (and therefore `project`, the pill and the Settings filter) becomes
  `parsed.originCwd ?? parsed.cwd` — the launch directory, which is the session's stable
  identity and never a fragment like `open` or `bugs`.
- The `dead` gate matches on **either** key: a session is dead only when the live set is
  non-null, at least one key is non-null, and *neither* `originCwd` nor `parsed.cwd` (both
  through `normCwd`) is in the live set. Keep today's fail-open shape: both keys null ⇒ not
  dead.
- Still exact equality per key. No containment, no prefix matching — per-cwd granularity stays
  the documented limit and `test/scan.test.ts:401` stays green unmodified.
- Leave the `refreshCwd` self-exclusion at `:349` comparing `projectPath`. The token-refresh
  session never cd's, so its origin and newest cwd are identical and behaviour is unchanged.
- No new API field. The client reads `project`, never `projectPath` (verified: zero references
  in `client/src`), so `shared/types.ts:42` needs only its doc comment tightened to say
  *launch* cwd.

**Assumption flagged, not asked** (the user was away when this was groomed): step 2 changes one
user-visible label. A session that *entered* a worktree mid-session will show the parent repo in
its pill and group under the parent repo in the filter, instead of the worktree directory it
shows today. Sessions **launched** in a worktree — every dashboard/orchestrator spawn, since
`spawn.ts` passes `cwd: ref.path` — are unaffected, because their origin *is* the worktree. If
that trade is unwanted, the narrower variant is: leave `projectPath` on `parsed.cwd` and use the
two-key OR for the gate only. That still fixes the IDLE symptom, and leaves the garbage `open`
pill from the repro in place.

**3. `docs/subsystems/sessions.md`.** The liveness paragraph (`:192-209`) gains the two-key
match and *why* both keys are needed — shell drift moves the transcript, process drift moves the
process — plus the head-read memo. The row-label bullet (`:11-13`) changes from "real path from
the transcript's `cwd`" to the transcript's *first* `cwd`. Both statements are currently drift.

**4. Test cases.** `test/transcript.test.ts`:

1. Tail-truncated fixture, head cwd `/a/repo`, newest cwd `/a/repo/sub` ⇒ `originCwd === '/a/repo'` and `cwd === '/a/repo/sub'`.
2. No-drift fixture ⇒ `originCwd === cwd`.
3. Fixture whose first 16 KB of records carry **no** `cwd` ⇒ `originCwd === null`.
4. Memo: two `readTranscript` calls on the same path ⇒ head-read count `1`; append records and re-read ⇒ still `1`; rewrite the file **smaller** and re-read ⇒ `2`.
5. Whole file inside the tail window ⇒ `originCwd` resolved with head-read count `0`.

`test/scan.test.ts` (all four via injected `liveCwds`, fixture: origin `/a/repo`, newest `/a/repo/backlog/bugs/open`, recent + unfinished turn):

6. The reported repro — `liveCwds: new Set(['/a/repo'])` ⇒ `status === 'working'`, `projectPath === '/a/repo'`, `project === 'repo'`. Today: `idle` and `open`.
7. The process-drift mirror — `liveCwds: new Set(['/a/repo/backlog/bugs/open'])` ⇒ `status === 'working'`.
8. Genuinely dead and drifted — `liveCwds: new Set(['/a/other'])` ⇒ `status === 'idle'`. Proves the OR didn't turn the gate into a no-op.
9. Head miss — `originCwd === null`, `liveCwds` holding only the newest cwd ⇒ `status === 'working'` and `projectPath` = the newest cwd. The fail-open path is exactly today's behaviour.
10. `test/scan.test.ts:401` runs unmodified and green.

**Acceptance bar (mutation).** Remove the origin key from the gate ⇒ case 6 must fail. Remove
the newest key ⇒ case 7 must fail. If either mutation leaves `pnpm test` green, the tests do not
prove the fix and are not done. Verify with `pnpm test` and `pnpm typecheck`, and quote the
output.

`In the browser (playwright MCP tools):` from the worktree run `pnpm build` (a fresh worktree
has no `client/dist`) then `pnpm dev` on ports 4273/5273, and open
`http://localhost:5273`. In a Bash tool call run `cd backlog && pwd` so this session's own
transcript cwd drifts one level below its launch cwd, then reload the Sessions view and find
this session's row: while its turn is mid-flight the dot must be green **WORKING** and the
project label must read the launch directory's basename (the worktree dir), not `backlog`.
Before the fix the same row reads gray **IDLE** with the label `backlog`.

## Outcome

**2026-09-02 — fixed as planned (two cwd keys, one liveness gate), verified live.**

Cause B re-confirmed against `main` at `9e9b77d` before any change: `transcript.ts` scans
newest-first so `parsed.cwd` is the *newest* record's cwd, and `scan.ts` compared exactly that
one value against a set of **process** cwds. Re-measured across all 652 transcripts on this
machine: 30 drift (all deeper), 0 lack a head `cwd`, worst first-`cwd` ends at byte 7,837 — so
the groom's 16 KB head window is still a little over 2x the worst case.

What shipped, matching the plan's steps 1-4 with the user's answer to the flagged assumption
(**launch cwd** — the plan's default, not the narrow gate-only variant):

- `server/lib/transcript.ts` — `readHead(filePath, headBytes)` beside `readTail`, `HEAD_BYTES =
  16 KB`, and `originCwd: string | null` on `ParsedTranscript` (oldest record carrying a `cwd`).
  An untruncated tail resolves it from the already-decoded lines with **no** disk read; only a
  truncated tail calls `readHead`, and that answer is memoized per path, dropped only when the
  file **shrinks** — the same invalidation rule as `title-cache.ts`. Test seams
  `resetOriginCache()` / `originCacheStats()` mirror `resetTitleCache` / `titleCacheStats`.
- `server/lib/scan.ts` — `projectPath = parsed.originCwd || parsed.cwd || null` (the label,
  pill and Settings filter now name the launch directory, never a fragment like `open`), and the
  `dead` gate matches on **either** key by exact equality: dead only when the live set is
  non-null, at least one key is non-null, and neither is in the set. Fail-open shape kept.
- `shared/types.ts` — `Session.projectPath` doc comment pinned to the *launch* cwd. No new API
  field; the client reads `project`, never `projectPath`.
- `docs/subsystems/sessions.md` — the row-label bullet now says the transcript's *first* `cwd`,
  and the liveness paragraph gains the two-key match, both drift directions, the memoized head
  read and the worktree-label trade-off. The `docs-sync` stamp is deliberately left alone for
  `/docs-sync` to re-baseline.

### `pnpm typecheck`

```
> claude-agents-dashboard@0.1.0 typecheck /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
> tsc --noEmit
```

(no output, exit 0)

### `pnpm test` — 1106 cases, 0 failed

```
  ✓ originCwd is the oldest cwd, cwd the newest, when the tail is truncated
  ✓ originCwd equals cwd when the session never drifted
  ✓ originCwd is null (fail open) when no cwd sits in the head window
  ✓ originCwd is memoized per path; only a shrunk file re-reads the head
  ✓ originCwd costs no head read when the whole file is inside the tail window
Passed: 17  Failed: 0

  ✓ liveness: a worktree session is live on its own cwd, not its parent repo
  ✓ liveness: shell drift — live on the launch cwd reads working, labelled by launch dir
  ✓ liveness: process drift — live on the newest cwd also reads working
  ✓ liveness: a drifted session with neither cwd live is still idle
  ✓ liveness: an unresolvable launch cwd falls open to the newest cwd alone
Passed: 53  Failed: 0

ALL PASS
```

Both test files are purely additive (`git diff --numstat`: `60 0 test/scan.test.ts`,
`80 0 test/transcript.test.ts`), so plan case 10 holds — `test/scan.test.ts:401` runs
unmodified and green.

### Acceptance bar (mutation) — met, plus two extra

| mutation | case that must fail | result |
| --- | --- | --- |
| `liveKeys = [parsed.cwd]` (drop the origin key) | 6, shell drift | ✗ `liveness: shell drift …` — `Passed: 52 Failed: 1` |
| `liveKeys = [parsed.originCwd]` (drop the newest key) | 7, process drift | ✗ `liveness: process drift …` — `Passed: 52 Failed: 1` |
| memo disabled (`prev` forced `undefined`) | 4, memo | ✗ `second read served from the memo` |
| `projectPath = parsed.cwd` (label reverted) | 6, label half | ✗ `+ '/a/repo/backlog/bugs/open'` vs expected `/a/repo` |

Each mutation was reverted from a backup and the full suite re-run green afterwards.

### Live end-to-end (the plan's browser step, run in the main checkout)

This session's own transcript is 470 KB — past the 256 KB tail window — so it exercises the
truncated-tail head read for real. `cd backlog && pwd` in a Bash tool call drifted its
transcript cwd one level below its launch cwd, and the real probe confirmed a clean A/B: the
launch cwd was in the live set and the drifted cwd was **not**, so only the origin key could
save the row.

```
$ lsof -p 24675,30389,32761,60284,70188 -a -d cwd -Fn | grep ^n | sort | uniq -c
   1 /Users/andrejajevtic/Documents/custom-projects/backlog-manager
   1 /Users/andrejajevtic/Documents/custom-projects/backlog-manager/.worktrees/runs-view-redesign
   2 /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
   1 /Users/andrejajevtic/Documents/timify-projects/microservice
```

`GET /api/sessions` (dev server on 4700/5700, the user's own 4173/5174 left untouched):

```json
{
  "id": "606079c7-82fd-47fb-990a-86f723cc6559",
  "status": "working",
  "project": "claude-agents-dashboard",
  "projectPath": "/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard",
  "branch": "main",
  "activity": { "tool": "Bash", "detail": "Query the live API for this session's row" }
}
```

The Sessions view rendered that row with a green **WORKING** dot and the pill
`claude-agents-dashboard`. Pre-fix the same row read gray **IDLE** with the pill `backlog` —
which is what mutations 1 and 4 above reproduce at the test level.

**Not verified, needs a human:** the process-drift direction was proven only by unit test
(case 7) and by the population measurement, never by live-driving a session into a worktree
mid-run and watching its row; and the label trade-off the user accepted (a session that
*enters* a worktree now shows its parent repo in the pill and groups under it in the Settings
filter) was not exercised in the browser.
