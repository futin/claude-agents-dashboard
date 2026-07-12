# Session status (the left dot)

`Session.status` (4 states), computed in `scan.ts` from `transcript.ts` signals.
`question` (blue) overrides everything; otherwise it's a 2×2 of `recent` × `turnComplete`:

`recent` = last **conversational message** (`transcript.ts` `lastMessageTs`) is newer than
`activeWindowMin`. **Not file mtime** — selecting a session in Claude Code appends
timestamp-less `mode`/`last-prompt`/`custom-title` records that bump mtime with no turn
happening, which used to flip idle sessions to `working`. mtime is only a fallback when no
message timestamp exists (and still the coarse `lookbackHours` enumeration filter in `scan.ts`).

|                          | recent (< `activeWindowMin`) | stale               |
|--------------------------|------------------------------|---------------------|
| **pending** (no end_turn)| 🟢 `working`                 | 🟡 `incomplete`     |
| **finished** (end_turn)  | 🟡 `incomplete`              | ⚪ `idle`           |

- **question** (blue) — newest assistant action is an unanswered `AskUserQuestion`. Beats all.
  `ExitPlanMode` is NOT treated as a question.
- **working** (green, pulsing) — recent AND the turn is unfinished = machine actively churning.
  **Only this state** counts toward `totals.active`. A finished turn (end_turn) is NOT working
  even if recent — the ball is in the human's court.
- **incomplete** (yellow, "pending") — either recent + finished (your turn to reply) or
  stale + unfinished (stalled mid-task).
- **idle** (gray) — stale AND the last turn finished cleanly.

**Process-liveness gate (overrides the 2×2):** a cleaned/interrupted session's last
record often has no `end_turn`, so on disk it looks recent + pending = `working` forever
even though nothing runs. So `scan.ts` `liveCwds()` shells out to `lsof -c claude -a -d cwd
-Fn` for the set of cwds with a live `claude` CLI process; a session whose `projectPath`
isn't in that set is forced to `idle`, no matter the transcript. `-c claude` is
case-sensitive → CLI only, not the capital-`C` `Claude.app` shell. **Granularity is per-cwd**
(claude doesn't hold the `.jsonl` open and exposes no session id in argv/env), so two
sessions in the same directory can't be told apart — a dead one there still reads live.
Probe is fail-open: `null` (no lsof / timeout / error) skips the gate. Injectable via
`ScanOptions.liveCwds` for tests; `skipProcScan` also disables it.

**Docker:** the dashboard container only has its own process namespace — `lsof -c claude`
inside it can never see the host's real `claude` CLI process, so the gate would force every
session to `idle` even while genuinely working. `config.ts` `isDockerContainer()` detects
`/.dockerenv` and defaults `skipProcScan: true` in that case (override with `SKIP_PROC_SCAN`
env either way); `api.ts` passes `config.skipProcScan` into `scanSessions`.

**Empty-session filter:** `/clear` (and opening a new session) starts a fresh UUID
transcript holding only `queue-operation`/`attachment`/meta records with no user/assistant
message yet. Its fresh mtime would read recent + `turnComplete`(default) = `incomplete`,
showing a phantom "pending" row beside the real session `/clear` abandoned — and there's no
on-disk link from the new session back to the cleared one to dedupe by. So `scan.ts` drops
any transcript whose `hasMessages` is false (`transcript.ts` = `newestMessageSeen`, true
once a `message.role` user/assistant record appears in the tail). Nothing to show → not
shown. The old session ages to `idle` on its own once stale.

Signals come from the **newest message record** (newest tail record with `message.role` of
`user`/`assistant`): `transcript.ts` exposes `turnComplete` (default true; false unless that
record is an assistant with `end_turn`), `waitingOnQuestion`, and `lastMessageTs` (that
record's timestamp — the recency signal). Records without a role (usage-only, meta,
last-prompt, queue-operation) are ignored for state.
