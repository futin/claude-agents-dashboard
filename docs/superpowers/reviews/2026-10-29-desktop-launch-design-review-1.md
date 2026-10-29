# Review 1 — `docs/superpowers/specs/2026-10-29-desktop-launch-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-29. Inputs: the spec, this repo, the sibling `backlog-manager`, and the desktop app bundle at
`/Applications/Claude.app/Contents/Resources/app.asar` (the spec's source for the link handler). Every claim below was read off the code, not the document.

**Verdict: APPROVE WITH FIXES.** No Critical findings. Five Important ones, all of the "an implementer must guess" or "edge case missing" kind; the facts the
spec states about both repos and the app bundle check out.

## Verified facts (no finding)

| Spec line | Claim | Where it holds |
|---|---|---|
| 7 | Every dashboard session is a headless `claude -p` child | `server/lib/spawn.ts:605-655` (`launch`, `buildSpawnArgs` `-p`) |
| 11-12, 36 | `code/new` reads `q`/`prompt`, `folder`, `file`, `environment`, `runner_pool`, `ssh_host`/`ssh_port`; `resume` imports the transcript | `app.asar`: `nmr=["folder","file",...ydr]`, `ydr=["ssh_host","ssh_port","ssh_folder"]`, `rmr=["environment","runner_pool"]`; `/new` handler `s=(q ?? prompt)?.slice(0,nN)`; `case vu.Resume` → `importCliSession(e)` |
| 20, 72 | Board dispatches through `POST /api/spawn`; orchestrate, resume, watchdog resume, `spawnAbort`, Jira all go through one `spawn()` | `backlog-manager/server/src/agents/agents.service.ts:369` (`dispatch`), `:606` (`spawnInProject`), `:1583-1631` (`spawn`), `:1531` (`spawnAbort`), `:665`, `:1085`; `jira-dispatch.service.ts:149` |
| 46-47, 48-49 | Doc sections exist and say what the spec says | `docs/subsystems/spawn.md:124` and `:320` |
| 55 | `open-folder.ts` launches `open` via `execFile` | `server/lib/open-folder.ts:8,15` |
| 58, 97 | Spawn gates today: remote-answer toggle, `probeSpawn`, `refuseWrite`, `MAX_LAUNCHING`, membership | `server/api.ts:1128-1140`, `:1210-1213` |
| 76 | Shared settings are the server's `.dashboard-settings.json` (`ServerSettings`) | `shared/types.ts:1062`, `client/src/components/settings/SettingsView.tsx:52` |
| 77, 91 | The board reads the dashboard's `/api/health` once per status | `backlog-manager/server/src/agents/dashboard-status.service.ts:109` |
| 82 | Headless resume is restricted to `sdk-cli` / `claude-agents-dashboard` entrypoints | `server/api.ts:1168`, `server/lib/scan.ts:138-140`, `server/lib/entrypoint.ts:7,17` |
| 85 | `hasLiveChild` is the store's own check | `server/api.ts:1183-1185` |
| 89 | `MAX_LAUNCHING` = 4, counting `'launching'` entries only | `server/lib/spawn.ts:493`, `server/api.ts:1137` |
| 92 | The board has a home/non-home machine notion | `backlog-manager/server/src/agents/dashboards/dashboards.service.ts:31-41` (`Machine.home`) |
| 94-95 | `AgentDispatchResult` is `{sessionId: string}`; `spawn()` 502s on a 200 without one; abort and claims key on the session id | `backlog-manager/shared/types.ts:1158-1160`; `agents.service.ts:1627-1629`; `:544`, `:580` |
| 100-101 | The board appends the finish clause at the end | `backlog-manager/server/src/agents/prompt.util.ts:49-58` (`${text} ${clause}`) |
| 102 | `PROMPT_CAP` refusal names the number | `server/lib/spawn.ts:170-171` (`prompt must be at most 4000 characters`) |
| 117 | The handler has a `cold_start` path | `app.asar`: `xB(e,V,{coldStart:r,argvCapped:n})`, `cold_start:i` in the code/new telemetry |

## Important

### I1 — line 82 (decision 4): a hand-over request cannot pass today's parse, which the spec says to reuse unchanged

"The server validates the id exactly as a headless resume does today" routes the request through `parseSpawnRequest`, which refuses a body without a
non-empty `prompt` (`server/lib/spawn.ts:163-168`: `prompt is required` / `prompt must not be empty`) before it even looks at `resume`. The
`claude://resume?session=<id>` link carries no prompt, and nothing in the spec says the hand-over sends one. A literal build either 400s every hand-over
or has the client send a dummy prompt the server then ignores — the spec must pick. Suggested fix: state that a `surface: 'desktop'` + `resume` body
carries no `prompt` and that the parse is relaxed for exactly that shape (prompt optional, ignored if present), with a test case: `{resume, surface:
'desktop'}` without `prompt` → 200; the same with `surface: 'dashboard'` → 400 `prompt is required`.

### I2 — lines 97-99 (decision 8) and 88-89 (decision 6): the existing check order runs `probeSpawn` and the launch-count rail *before the body is read*, and the file documents that order as deliberate

`server/api.ts:1128-1140` runs `remoteAnswer` → `probeSpawn` (404 `spawn unavailable`) → `refuseWrite` → `MAX_LAUNCHING` (429) and only then
`readJsonBody`. The `surface` field lives in the body, so a desktop request on a Mac with no `CLAUDE_BIN` is 404'd before the server can learn it is a
desktop request, and the headless rail counts it before the desktop counter can. The doc comment at `server/api.ts:1101-1113` says neither ordering
"should be corrected … without reading this paragraph" and cross-references `serveTranscribe`. The spec says `probeSpawn` "does not apply" but not that
the gate order must change, nor what replaces the pre-body rail for desktop. Suggested fix: state the new order explicitly — toggle → `refuseWrite` →
read body → parse (which yields `surface`) → per-surface availability probe (`probeSpawn` or `desktopAvailable`) → per-surface rail — and say that the
comment at `api.ts:1101` is rewritten to match. Also say whether the desktop time-window counter and the headless `'launching'` count share one cap of
4 or hold one each ("same cap as `MAX_LAUNCHING`" reads either way). The client side has the same gap: `AsideBoard.tsx:95` and `AsideStrip.tsx:68` hide
the New session button entirely when `spawnAvailable` is false, so a Mac with the app but no CLI can never reach the Desktop pick unless that gate
becomes `spawnAvailable || desktopAvailable`.

### I3 — lines 46-47 and 81-87 (anti-goal, decisions 4-5): after a hand-over the dashboard still offers a headless resume on the same transcript, and none of the listed liveness signals can see the desktop app's process

Two measured facts: (a) a transcript's `entrypoint` is the **first** record's (`server/lib/transcript.ts:440`, `if (!entrypoint && …)`), so a row that
was handed over keeps reading `dashboard` (`scan.ts:139`) even after the app appends `claude-desktop` records; (b) the desktop app's own `claude` child
carries no `--session-id` / `--resume` in argv (read off this machine's four live desktop children on 2026-10-29: `claude stream-json --effort=… --model=…
--permission-prompt-tool=stdio … --await-initialize`; the id goes over stdin), so `liveSessionIds` (`scan.ts:496` matches only `--session-id|--resume`)
and therefore `processLive` (`scan.ts:651`) never flag it, and `hasLiveChild` never knew it. The result: `resumeEligible` (`client/src/lib/resume.ts:35-38`)
keeps offering the resume composer on a handed-over row, and the server's 409 checks at `api.ts:1172-1199` all pass, so a tap in the chat drawer puts a
second headless writer beside the app's live session — the exact fork the anti-goal names. The same gap re-offers "Open in desktop app" on a row the app
already owns. Suggested fix: decide the post-hand-over rule in the spec. The cheapest honest one is a transcript-level signal the dashboard already parses:
a row whose records include an entrypoint of `claude-desktop` (or whose last record's entrypoint differs from its first) is desktop-owned — no headless
resume, no second hand-over — and the pill says so. Name the test case: transcript with first record `claude-agents-dashboard` and a later
`claude-desktop` record → resume 409/400, hand-over refused.

### I4 — lines 73-74 (decision 1) and 83 (decision 4): no response is specified when `open` fails

`open` is an external call that fails in practice (scheme not registered, app missing after `desktopAvailable` was cached, `execFile` timeout — `open-folder.ts:15`
uses 5 s). The spec says the route "returns 200" and nothing else; `serveOpenFolder` answers 500 `open failed` for the same program (`api.ts:1590-1594`).
Suggested fix: state the status and body for an `open` rejection on both the launch and hand-over paths (500 `open failed` to match `open-folder`, or
502 if the builder prefers "upstream"), that nothing is counted in the rail on failure, and the client copy for it. Also decide whether `desktopAvailable`
is probed per request or cached like `probeSpawn` (`spawn.ts:269-272`): a cached true that goes stale is the main way this failure happens.

### I5 — lines 104-105 (decision 10) and 74: today's client treats a `SpawnResponse` without `sessionId` as a failed launch

`useSpawn.launch` resolves `(body as SpawnResponse)?.sessionId ?? null` and every caller reads `null` as "launch failed" (`client/src/hooks/useSpawn.ts:9,
59`). A desktop 200 with no `sessionId` therefore surfaces as a failure in the form unless `useSpawn`'s contract changes with it, and `SpawnResponse`
(`shared/types.ts:2109-2111`) is `{sessionId: string}` for `ResumePanel.tsx:22` and `gitSync.ts:2` as well. Suggested fix: specify the new response shape
(`{surface: 'desktop'}` vs `{sessionId, surface?: 'dashboard'}` as a discriminated union) and that `useSpawn` resolves a typed result, with the test
case: desktop 200 body → form shows the confirmation, not `Launch failed`.

## Minor

- **Line 86** cites the `ps` argv probe to `api.ts`; it lives in `server/lib/scan.ts:537` (`liveSessionIds`), `api.ts:1193` only calls it.
- **Lines 85-86** enumerate the 409 checks incompletely: the held question/plan/reply sockets (`api.ts:1174-1176`) and the `already resuming` launch-store
  check (`api.ts:1198-1200`) are missing, and `processLive` is a row field derived from the same `ps` set (`scan.ts:651`), not a third check. "The same
  checks a headless resume's 409 makes" is the operative rule; the list should match it or go.
- **Line 57 / 98-99**: a non-macOS host answers 501 on `open-folder` and `reveal` (`api.ts:1585,1869`) but the spec picks 404 for "desktop unavailable".
  Either is defensible; say which and why so the two `open` routes do not disagree by accident.
- **Lines 100-103 and 120**: the cap is readable now — `var nN=14336` sits in the same chunk as `claudeURLHandler` and the `/new` handler slices `q` to it
  (`app.asar`). Since `PROMPT_CAP` is 4000 (`spawn.ts:67`), the existing parse already refuses before the app could truncate; the builder's measurement
  should confirm 14336 and may then find decision 9 needs no second cap. Note also that the board's own `PROMPT_MAX` is 8000
  (`backlog-manager/server/src/agents/agents.service.ts:81`), above the dashboard's 4000 — pre-existing, not this spec's, but the form counter should
  count against the dashboard's number.
- **Line 36**: the handler also reads `ssh_folder` (`ydr`), omitted from the list. Harmless under the SSH non-goal.
- **Lines 55-56**: `test/outbound.test.ts` pins network modules only (`ALLOWED` at `test/outbound.test.ts:62-66`), not argv shapes, so the hedge resolves
  to "nothing to extend". What does need extending is the per-module launched-program list in `.claude/CLAUDE.md` §Code rules and `docs/overview.md`'s
  `lib/` map — the spec names neither.
- **Line 117 (Unverified, cold start)**: the handler takes an `argvCapped` flag on a cold start, and when it is set the code/new path refuses SSH params and
  the cowork path drops `folder`/`file`. Worth adding to the cold-start probe: a long `q` on a closed app.
- **Line 12 / 83**: a second hand-over of an already-imported id (`importCliSession` twice) is unverified — add to the Unverified list, or have the server
  refuse the second (which I3's rule would do).
- **Line 104**: "the launch form closes and shows a short confirmation" — where the confirmation lives once the modal is closed (toast, aside line) is not
  among the builder's named choices on line 109-112; add it.
- **Line 31** writes the call as a shell (`open "claude://…"`) while line 74 specifies `execFile` with an args array; the first is illustrative, but one
  spelling avoids a reader taking the quotes literally.
- **Unverified addition**: one validator in the bundle (`Be(e)`, the `claude://` link allowlist) rejects a `q` whose decoded value starts with `/`. It did
  not appear in the `claudeURLHandler` path I traced, and the board's prompts are prose, but a dashboard-form prompt that starts with a slash command is
  worth one probe.

## Checklist coverage

1. Facts — every cited file, type, function and doc section exists and says what the spec says (table above); the app-bundle claims were re-read.
2. Contradictions — none between sections; the one example value (`MAX_LAUNCHING` = 4) matches.
3. Edge cases — I1 (missing prompt), I3 (concurrent writer after hand-over, duplicate hand-over), I4 (`open` failure), I2 (gate order / shared cap).
4. Copy — "Stop it first" and the confirmation sentence are the only copy; consistent where repeated.
5. Scope — non-goals named; the backlog-manager change is sequenced after this PR and depends only on fields this PR adds.
6. CLAUDE.md — no new dep, no new outbound kind, types-first, class names stable: respected. The launched-program list in CLAUDE.md needs the new module
   added (Minor above).
