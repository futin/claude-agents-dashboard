# Review 2 — `docs/superpowers/specs/2026-10-29-desktop-launch-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-29. Inputs: the spec at `a20dd42`, this worktree, the sibling `backlog-manager`, this machine's transcripts
under `~/.claude/projects` and the desktop app bundle (`/Applications/Claude.app`, 4.4212.0). Round 1 (`…-review-1.md`) is not repeated: its five
Important findings are all addressed (decisions 4, 8, 10, 11 and the `open`-failure paragraph), and its verified-facts table still holds. Every claim below
was read off the code, not the document.

**Verdict: APPROVE WITH FIXES.** No Critical findings. Seven Important ones; the largest is a false fact under decision 11 that the rest of that decision is
built on, and a hand-over race the new rail cannot see.

## Verified this round (no finding)

| Spec line | Claim | Where it holds |
|---|---|---|
| 73 | `URLSearchParams` is the right encoder: the app reads `q` with `searchParams.get("q")`, which decodes `+` as a space | `app.asar` `/new` handler: `searchParams.get("q")?.slice(0,nN)` |
| 82-83 | `parseSpawnRequest` answers 400 `prompt is required` before looking at `resume` | `server/lib/spawn.ts:163-168`, `:196` |
| 86-88 | The listed 409 checks are the headless resume's: held sockets, `hasLiveChild`, `liveSessionIds`, `already resuming` | `server/api.ts:1174-1200` |
| 104-105 | `probeSpawn` and `MAX_LAUNCHING` run before the body is read, and the comment says why | `server/api.ts:1128-1143`, doc comment above |
| 107 | `probeSpawn` is memoised for the process | `server/lib/spawn.ts:269-272` |
| 108 | `AsideBoard.tsx` and `AsideStrip.tsx` hide New session when `spawnAvailable` is false | `client/src/components/AsideBoard.tsx:95`, `client/src/components/sessions/AsideStrip.tsx:68` |
| 110-111 | `serveOpenFolder` answers 500 `open failed` with a 5 s `execFile` timeout | `server/api.ts:1594`, `server/lib/open-folder.ts:15` |
| 117-118 | `useSpawn.launch` resolves `sessionId ?? null` | `client/src/hooks/useSpawn.ts:10,59` |
| 122 | Registry path and join key: `claude-code-sessions/<install>/<account>/local_<uuid>.json`, `cliSessionId` | `server/lib/archived.ts:12-15,40` |
| 143 | `nN = 14336`; app 4.4212.0; `PROMPT_CAP` 4000; board `PROMPT_MAX` 8000 | `app.asar` `var nN=14336`; `Info.plist`; `spawn.ts:67`; `agents.service.ts:81` |
| 8-9, 47, 49 | The three cited doc sections exist | `docs/subsystems/session-surfaces.md:151`, `docs/subsystems/spawn.md:124,320` |

## Important

### I1 — line 121 (decision 11): "`entrypoint` is taken from the first record" is false; the scanner reports the **newest** stamped record, so a continued hand-over already reads `local`

`readTranscript` reads a 256 KB tail (`server/lib/transcript.ts:28,401`) and walks it **newest-first** (`:435`), taking the first `entrypoint` it meets
(`:440`, `if (!entrypoint && …)`) — the newest record that carries one, not the file's first record. Measured on this machine's own hand-over probe
transcript (`…/scratchpad-deeplink-probe2/48716273-….jsonl`, 23 `claude-agents-dashboard` records followed by 9 `claude-desktop`): `readTranscript(...)`
returns `entrypoint: claude-desktop`, so `sessionSurface` yields `local` (`server/lib/scan.ts:138-140`), the row loses the `dashboard` pill, `resumeEligible`
is already false (`client/src/lib/resume.ts:35`), and a headless resume already answers 400 `only dashboard sessions can be resumed` (`server/api.ts:1168`).
Round 1's I3 stated the opposite and the spec copied it.

Consequences for the decision as written: (a) "contains any `claude-desktop`-stamped record" asks for a whole-file scan the scanner does not do (tail only),
and for the continued case it is redundant with what `sessionSurface` already yields; (b) the test case "continued in the app → owned → 409 `session is
open in the desktop app`" collides with the existing 400 at `api.ts:1168` unless the new check is ordered before it — the spec does not say; (c) the
genuinely new case is only "imported but never continued" (registry row, no app record yet), which the registry half of the rule covers. Suggested fix:
restate the fact (newest stamped record within the tail), define `desktopOwned` as "a non-archived registry row names the id **or** `sessionSurface` is
`local` because the newest entrypoint is `claude-desktop`", drop the file scan, and set the continued-case expectation to the existing 400 (or state that the
409 check runs first and why).

### I2 — lines 86-88 (decision 5) and 89-91 (decision 6): a second hand-over tap races the first, and the new rail cannot see it

Decision 5 relies on "a resume of it is already in flight" (`server/api.ts:1198-1200`: `listLaunching().some(e => e.sessionId === rid && e.state === 'launching')`).
That check reads the launch store, and decision 1 says a desktop launch creates no child and no store entry; decision 6's desktop rail is a count-only
time window with no ids. So between `open` returning (milliseconds) and the app writing `local_<id>.json` (asynchronous, app-side), a second hand-over of the
same id passes every listed check and fires `importCliSession` twice — the double import round 1 flagged as unverified, now reachable by a double tap or two
devices. Suggested fix: name a per-id in-flight mark for desktop hand-overs (held until the registry row appears or a few seconds pass), answering 409
`already resuming` on the second, with the test case: two `{resume, surface: 'desktop'}` bodies for one id back to back → 200 then 409.

### I3 — lines 122-125 (decision 11): the registry read's failure direction is unspecified, and the existing reader is biased the other way

The one reader of that registry, `classify` (`server/lib/archived.ts:108-124`), is designed to say "not archived" on every doubt: prefix regex, malformed JSON,
absent flag all return `null`, because hiding a row is the costly error there. `desktopOwned` needs the inverse set — live rows' `cliSessionId` — and the
costly error is the inverse too (a false "not owned" admits a second writer, the anti-goal at line 46). The spec says nothing about an unreadable or
malformed record, a missing `claude-code-sessions` root, or a record with `isArchived` absent. Suggested fix: state the rule per case (missing root → not
owned; unreadable/malformed record → not owned, with the reason) and the test cases, and say the reader is a sibling of `classify` rather than a change to it.
Also, line 123 says "`scan.ts` already reads that registry" — `archived.ts` reads it (`archivedSessionIds`), `scan.ts` only filters on the injected set
(`server/api.ts:1403`, `scan.ts:717-724`).

### I4 — line 113 (decision 9): wrong path for the clause appender

The safety clause is appended by `backlog-manager/server/src/agents/prompt.util.ts:49` (`appendFinishClause`), called from `AgentsService.dispatch`
(`agents.service.ts:566`). `backlog-manager/server/src/jira/prompt.util.ts` exists but carries no clause. Suggested fix: cite `agents/prompt.util.ts`.

### I5 — lines 112-115 (decision 9) vs 143-145 (Unverified): the Desktop prompt cap is ambiguous, and one reading makes the form and the server disagree

`parseSpawnRequest` refuses at `PROMPT_CAP` = 4000 (`server/lib/spawn.ts:170-171`) before any surface is known, so a desktop cap of 14336 is unreachable —
the Unverified paragraph says as much. But decision 9 says the builder "measures the app's `q` cap first" and "the form counts against it when Desktop is
picked", which reads as a 14336 counter for Desktop; a form built that way accepts prompts the server 400s at 4000. Suggested fix: say the effective Desktop
limit is `min(PROMPT_CAP, app cap)` — 4000 today — the form counts against that, and the app-cap constant exists only so the minimum is explicit (or drop
the second cap and keep the measurement as a one-line comment).

### I6 — lines 127-128 (decision 12) vs 132 (Left to the builder), and decision 4: confirmation copy is owned twice and the hand-over's outcome copy is missing

Decision 12 fixes the copy ("Opened in the desktop app — the row appears in a few seconds") while line 132 lists "the confirmation copy" as the builder's.
And decision 12 covers only the launch form; the hand-over action lives on a session row (line 133), where the row already exists, so "the row appears" is
wrong there and nothing says what a successful hand-over shows, nor what a 500 `open failed` shows outside the form (line 111 names the form only).
Suggested fix: one owner for the copy, plus the hand-over's success and failure lines.

### I7 — line 134 (Left to the builder): `open -Ra Claude` is a Finder reveal, not a probe

`open -R` "Reveals the file(s) in the Finder instead of opening them" (`man open`); with `-a Claude` and no file it selects `Claude.app` in a Finder window.
A builder who takes that suggestion ships a Finder window on every memoised probe, i.e. every server start. Suggested fix: drop it; a `stat` of the bundle
path (what line 58 already names) is enough.

## Minor

- **Line 85**: "a live interactive terminal session leaves none of the liveness signals below" — `claude --resume <id>` in a terminal does leave the argv
  signal (`server/lib/scan.ts:496`); "may leave none" is the accurate claim, and it still carries the conclusion.
- **Line 104 (decision 8)**: 404 `desktop app unavailable` while the two other `open` routes answer 501 off macOS (`server/api.ts:1585,1869`) — carried
  from round 1, still unexplained. Either is fine; say which.
- **Line 31 vs 74**: `open "claude://…"` (shell quoting) vs `execFile` with an args array — carried from round 1; one spelling.
- **Line 123**: see I3's last sentence (`archived.ts`, not `scan.ts`).
- **Line 125 copy**: `session is open in the desktop app` is also the answer for a row whose registry entry is archived but whose transcript carries
  `claude-desktop` records (the second test case on line 126) — the session is then *not* open in the app. If I1's fix keeps that case, the copy should not
  claim it is.
- **Line 108**: `AsideStrip.tsx` is at `client/src/components/sessions/AsideStrip.tsx` — path only.
- **Line 116**: the union drops `surface?` optionality for headless; `ResumePanel.tsx:22` and `gitSync.ts:2` type the old `{sessionId}` and will need
  narrowing — the builder will hit it from the typecheck, but a line saying "callers narrow on `surface`" would save the guess.

## Checklist coverage

1. Facts — two false (I1, I4), one misattributed (I3, `scan.ts`); every other cited file, function, constant, doc section and app-bundle value re-read and
   holds (table above).
2. Contradictions — I5 (cap), I6 (copy ownership); example values (`MAX_LAUNCHING` 4, `PROMPT_CAP` 4000, `nN` 14336) recomputed and agree.
3. Edge cases — I2 (concurrent hand-over), I3 (registry read failure), I1 (ordering of the new 409 against the existing 400).
4. Copy — I6, and the Minor on line 125.
5. Scope — non-goals named; nothing in scope depends on the backlog-manager PR; the board's needs (decision 7) are described, not built here.
6. CLAUDE.md — no new dep, no new outbound kind (`open` is listed at `.claude/CLAUDE.md:85`), types-first, class names stable, settings in `ServerSettings`:
   respected. The launched-program list extension is now named (lines 56-57).
