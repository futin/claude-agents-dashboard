# Sessions — live monitor, status machine, subagent detail

The default section: one row per Claude Code session, refreshed on the interval the Settings
page sets (3s by default), sorted most-recent-first. Everything is derived from the
transcript files on disk. `useSessions` also carries the per-device scan knobs as query
params, so a changed row count or window takes effect on the next tick.

## Per-session rows

- **Status dot** — one of four states (below).
- **Name + git branch** — a named session leads with its custom title and demotes the
  project to a pill; an unnamed one leads with the project itself (real path from the
  transcript's `cwd`). Either way the row also carries its `gitBranch`.
- **Model + CLI version** — what the session is running.
- **Surface pill** — where the session lives, when that isn't the obvious answer. A headless
  spawn appears in no other list, which is worth saying on the row rather than leaving to be
  rediscovered. `scan.ts`'s `sessionSurface` reads the transcript's own `entrypoint`: only
  `sdk-cli` (a headless `-p` run, which is what a [dashboard spawn](spawn.md) is) earns a
  `dashboard` pill, and everything else — an unrecognized or absent value included — is
  `local` and prints nothing at all. The fail direction is deliberate: under-claiming loses a
  pill, while a wrong `dashboard` would say a session is invisible to the desktop app when it
  is sitting in its sidebar. `lib/surface.ts` supplies the label and tooltip, and the pill has
  no handler of its own — clicking it toggles the row like the rest of `.r1`. Which surface
  can continue what is mapped in [session surfaces](session-surfaces.md).
- **Context bar + %** — current context tokens vs. the model's window (1M for
  Sonnet/Opus/Fable, 200k for Haiku and unknowns; override with
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). Turns orange/red as it fills.
- **Activity line** — the most recent tool call (e.g. `Edit server.ts`,
  `Task Explore: map the codebase`).
- **Relative time** — since the last conversational message.
- **Chat tab** — a full-height slab down the row's right edge (`.row-chat`), the way into
  this session's [chat drawer](chat.md). The card splits in two for it: `.row-main` carries
  the padding and the expand-on-click, the tab is its sibling, so opening the drawer no
  longer has to out-shout a row toggle it sits inside.

### The tab is also where a session says it needs a human

Every hold routes to the same place — the drawer — so they share the one control rather
than competing as separate pills among the printed fields. `chatTab()` picks the label from
the first match in this order, so the nearest thing to a blocked session wins:

| `Session` flag | Label | Tone |
| --- | --- | --- |
| `remoteQuestion` | `answer` | amber, pulsing |
| `remotePlan` | `plan?` | amber, pulsing |
| `remoteReply` | `reply?` | amber, pulsing |
| `permissionWait` | `allow?` | mustard, pulsing — answerable only in that terminal |
| none | `chat` | steel |

Mustard rather than amber for the last one keeps the "needs you, but not here" case visually
apart from the three you can act on from the phone. The label is `position: sticky` inside
the tab, so it rides the top of the viewport instead of drifting off with an expanded card's
subagent panel.

### Phantom rows: a session that doesn't exist yet

Above the real rows, `SessionList` also renders `SessionsResponse.launching` — sessions
[spawn](spawn.md) has started but whose transcript hasn't appeared on disk yet. They are a
different kind of thing from every other row here: nothing about them comes from a
transcript, because there isn't one. Each carries only what the launch request knew —
project name, a 120-character prompt preview — plus a state word: cyan `starting…`, or red
`failed` with the child's stderr tail (or a synthesized reason) as the activity line.

Three properties keep them from complicating the rest of this document:

- **Never interactive.** No chat tab, no expand, no hover lift — there is nothing to open.
  A row you cannot click needs none of the status machine below.
- **They disappear by themselves, with no client-side reconciliation.** `serveSessions`
  calls `adoptLaunched(ids)` with the freshly-scanned session ids *before* it calls
  `listLaunching()`, so the poll that first sees the real transcript is the same poll that
  stops sending the phantom. The row is never rendered twice, and the client never has to
  match one against the other.
- **They can outnumber the real rows only briefly.** A `launching` entry that nothing
  adopts is dropped after 60s; a `failed` one after 5 minutes. Both live in RAM only (the
  store in `server/lib/spawn.ts`), so a server restart clears them.

A launching entry also renders when the filtered session list is empty — a fresh dashboard,
or filters that exclude every real row, must still show the launch you just started, which
is why the empty state checks both lists.

## Custom session titles

Claude Code writes a session's name as a `custom-title` record in the transcript, and
finding it is harder than it looks: a named session used to show its title for a while and
then silently revert to the project name, for two independent reasons.

**It isn't the newest record.** The record is appended when a session is named *or
selected*, and ordinary work piles on top of it — so it's the newest record only right
after a select. `transcript.ts`'s newest-first scan breaks as soon as its handful of hot
fields are filled, usually within two records, while the title sits deeper.
`findSessionName` moves the lookup out of that loop and only `JSON.parse`s lines that
textually hold the `"custom-title"` marker, so the break stays and an *unnamed* session
never pays a full-window parse on every poll.

**It sinks below the tail window.** `readTranscript` reads only the last 256KB; on a busy
session the record ends up far below that (observed 764KB below EOF on a 1.2MB
transcript), where no scan order helps. Widening the window is not the fix — transcripts
here run to several megabytes and the scan re-reads every session on every poll. So
`title-cache.ts` searches the tail first (free — those bytes are already decoded) and only
on a miss hunts backward through the rest of the file a chunk at a time, newest hit wins.

**What gets remembered is the searched byte range, not just the answer** —
`resolveSessionTitle` stores `{ title, scannedFrom, size }` per file. A later poll can then
prove its own tail window joins up with the range already covered and skip the disk
entirely. A miss is cached too; otherwise every poll re-scans every untitled session.

Invariants:

- **Coverage never expires** — transcripts are append-only, so "already searched" stays
  true forever. A file that *shrank* was rotated or truncated and drops its entry.
- **A tail hit wins outright** over anything remembered: the tail is the newest bytes, so
  a rename takes effect on the next poll.
- **Chunks overlap by a whole record**, not by the marker's length. The first boundary is
  the tail window's own start, whose straddling record the caller already dropped as a
  partial line — so a record can begin just below the window and carry its marker just
  above it, and a marker-sized overlap would miss it.
- **The backward marker scan decodes latin1**, one char per byte, so string indices stay
  byte-exact no matter what UTF-8 sits around them. Decoding utf8 there would desync every
  offset.
- **`"New session"` is a placeholder, not a title** — an older real title still wins. Nor
  is the marker appearing inside message text: the recovered line fails to parse as a
  `custom-title` record, which is the right answer for a decoy.

## The status machine (the left dot)

`Session.status` (4 states), computed in `scan.ts` from `transcript.ts` signals.
`question` (blue) overrides everything; otherwise it's a 2×2 of `recent` × `turnComplete`:

`recent` = last **conversational message** (`transcript.ts` `lastMessageTs`) is newer than
`activeWindowMin`. **Not file mtime** — selecting a session in Claude Code appends
timestamp-less `mode`/`last-prompt`/`custom-title` records that bump mtime with no turn
happening, which used to flip idle sessions to `working`. mtime is only a fallback when no
message timestamp exists (and still the coarse `lookbackHours` enumeration filter in
`scan.ts`).

|                          | recent (< `activeWindowMin`) | stale               |
|--------------------------|------------------------------|---------------------|
| **pending** (no end_turn)| 🟢 `working`                 | 🟡 `incomplete`     |
| **finished** (end_turn)  | 🟡 `incomplete`              | ⚪ `idle`           |

- **question** (blue) — newest assistant action is an unanswered call to one of
  `transcript.ts`'s `WAIT_TOOLS`: `AskUserQuestion` **or** `ExitPlanMode`. Beats all. Both
  draw an approval surface and neither writes anything further to the transcript until you
  respond, so the unanswered `tool_use` record *is* the wait — readable off disk with no
  hook, unlike a permission dialog.
- **question** also comes from a **held remote wait** — `ScanOptions.pendingIds` (the ids
  from `pending.ts` `pendingSessionIds()`, injected by `api.ts`; `scan.ts` never imports
  the store, so it stays pure). This is the **first** rung of the ladder, above the
  liveness gate: the hook is holding a socket open right now, which beats `lsof`'s
  per-cwd guess, and it beats the transcript too — the wait is registered during
  `PreToolUse`, so the `tool_use` record isn't on disk yet and `waitingOnQuestion` would
  lag the entire wait. Also sets `Session.remoteQuestion`, which is what the row's
  chat tab reads `answer` from (see [remote-answer](remote-answer.md)). Omitted/null
  `pendingIds` ⇒ nothing flagged, statuses byte-for-byte as before.
- **question** also comes from a **held remote plan wait** — `ScanOptions.planIds` (from
  `plans.ts` `planSessionIds()`, injected the same way). Same kind of evidence as
  `pendingIds` — an open socket right now — so it sits immediately below it and still above
  the liveness gate, and sets `Session.remotePlan` (the tab's `plan?` label, see
  [remote-plan](remote-plan.md)). Suppressed when `remoteQuestion` already owns the row, so
  a session can only be flagged for one of the two.
- **question** also comes from a **held turn-end reply window** — `ScanOptions.messageIds`
  (from `messages.ts` `messageSessionIds()`, injected the same way). Same kind of evidence
  again — the `Stop` hook is holding a socket open right now — so it joins the chain
  immediately below `planIds`, still above the liveness gate, and sets
  `Session.remoteReply` (the tab's `reply?` label, see
  [remote-message](remote-message.md)). Suppressed when `remoteQuestion` or `remotePlan`
  already owns the row.
- **question** also comes from an open **terminal permission dialog** ("allow Bash:
  `pnpm dev`?") — `ScanOptions.permissionWaits` (`sessionId → notifiedAt`, from
  `permissions.ts`, injected by `api.ts`). The dialog never reaches the transcript, so
  without the PermissionRequest hook a parked session reads recent + pending = `working`.
  This rung sits **below** the liveness gate (a fire-and-forget notify proves nothing about
  liveness, unlike a held socket) and below `pendingIds`, `planIds` and `messageIds`. It self-clears: a message newer
  than `notifiedAt` means the dialog was answered. Also sets `Session.permissionWait`,
  which puts the row's tab in `allow?` — display-only, see
  [permission-notify](permission-notify.md).
- **working** (green, pulsing) — recent AND the turn is unfinished = machine actively
  churning. **Only this state** counts toward `totals.active`. A finished turn (end_turn)
  is NOT working even if recent — the ball is in the human's court.
- **incomplete** (yellow, "pending") — either recent + finished (your turn to reply) or
  stale + unfinished (stalled mid-task).
- **idle** (gray) — stale AND the last turn finished cleanly.

**Process-liveness gate (overrides the 2×2):** a cleaned/interrupted session's last
record often has no `end_turn`, so on disk it looks recent + pending = `working` forever
even though nothing runs. So `scan.ts` `liveCwds()` shells out to
`lsof -c claude -a -d cwd -Fn` for the set of cwds with a live `claude` CLI process; a
session whose `projectPath` isn't in that set is forced to `idle`, no matter the
transcript. `-c claude` is case-sensitive → CLI only, not the capital-`C` `Claude.app`
shell. **Granularity is per-cwd** (claude doesn't hold the `.jsonl` open and exposes no
session id in argv/env), so two sessions in the same directory can't be told apart — a
dead one there still reads live. Probe is fail-open: `null` (no lsof / timeout / error)
skips the gate. Injectable via `ScanOptions.liveCwds` for tests; `skipProcScan` also
disables it.

**Docker:** the dashboard container only has its own process namespace —
`lsof -c claude` inside it can never see the host's real `claude` CLI process, so the
gate would force every session to `idle` even while genuinely working. `config.ts`
`isDockerContainer()` detects `/.dockerenv` and defaults `skipProcScan: true` in that
case (override with `SKIP_PROC_SCAN` env either way); `api.ts` passes
`config.skipProcScan` into `scanSessions`. See [docker](../workflows/docker.md).

**Empty-session filter:** `/clear` (and opening a new session) starts a fresh UUID
transcript holding only `queue-operation`/`attachment`/meta records with no
user/assistant message yet. Its fresh mtime would read recent + `turnComplete`(default) =
`incomplete`, showing a phantom "pending" row beside the real session `/clear` abandoned —
and there's no on-disk link from the new session back to the cleared one to dedupe by. So
`scan.ts` drops any transcript whose `hasMessages` is false (`transcript.ts` =
`newestMessageSeen`, true once a `message.role` user/assistant record appears in the
tail). Nothing to show → not shown. The old session ages to `idle` on its own once stale.

**Signals** come from the **newest message record** (newest tail record with
`message.role` of `user`/`assistant`): `transcript.ts` exposes `turnComplete` (default
true; false unless that record is an assistant with `end_turn`), `waitingOnQuestion`, and
`lastMessageTs` (that record's timestamp — the recency signal). Records without a role
(usage-only, meta, last-prompt, queue-operation) are ignored for state.

## Expandable subagent detail

Click a row to expand it: the dashboard fetches `GET /api/sessions/:id` and lists the
subagents that session launched via the `Task` tool — type, description, running/done,
duration, tokens, tool-use count — under a `N running · N finished · N agents` summary.
Served by an incremental byte-offset cache (`agents.ts` / `agents-cache.ts`) so repeat
opens stay cheap.

`useSessionDetail` keeps polling that endpoint **every 3s for as long as the row stays
open** — not once on expand — because the panel is watching live work. It clears its state
when the selected id changes, so switching rows never flashes the previous session's
agents, and it keeps the last snapshot when a fetch fails rather than blanking the panel.

**The timeline.** Each agent gets a start→finish bar on **one shared time axis**: the
range runs from the earliest launch to the latest end, with `now` standing in for agents
still running (`timeRange` in `SessionDetail.tsx`). The sharing is the whole point —
overlapping bars are agents that ran in **parallel**, which is what you want to know about
a fan-out and what you cannot see if each bar is scaled to its own duration. `now` is read
per render, so the 3s poll makes running bars grow on their own. An agent with no parsable
start timestamp still gets a row, just no bar.

## Filter + sort toolbar

Client-side controls above the list: project, status, activity window, and sort
(recency / tokens / name / status, asc/desc). The selection is persisted to
`localStorage` (`dashboard.view`) so it survives refresh and tab-close — see
[view-persistence](view-persistence.md). Row expansion is deliberately not persisted
(session IDs churn).

<!-- docs-sync:
  sources:
    - server/lib/scan.ts
    - server/lib/transcript.ts
    - server/lib/config.ts
    - server/lib/agents.ts
    - server/lib/agents-cache.ts
    - server/lib/title-cache.ts
    - client/src/components/SessionsView.tsx
    - client/src/components/SessionList.tsx
    - client/src/components/SessionRow.tsx
    - client/src/components/SessionDetail.tsx
    - client/src/hooks/useSessions.ts
    - client/src/hooks/useSessionDetail.ts
    - client/src/lib/filterSort.ts
  kind: subsystem
  verified: 8326b88586603f5ad72061c686d3d33bd8f50f67
-->
