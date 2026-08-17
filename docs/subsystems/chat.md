---
docs-sync:
  sources:
    - server/lib/chat.ts
    - server/api.ts
    - client/src/components/ChatDrawer.tsx
    - client/src/components/Markdown.tsx
    - client/src/hooks/useSessionChat.ts
    - client/src/lib/chatFilter.ts
    - client/src/lib/markdown.ts
  kind: subsystem
  verified: eeca21c754c09572be041a6806452abba4afe875
---

# Chat — history tail and the drawer

The `chat` tab down the right edge of a session row opens a **full-height drawer** with that session's
conversation: newest page on open, live-tailed at the configured refresh rate, "load older"
walking backwards through the whole transcript. Read-only, like everything else in the app.
This drawer is also where [remote answers](remote-answer.md) surface: a pending question
renders as an action bar pinned above the footer, a proposed plan does the same through
`PlanPanel` (see [remote-plan](remote-plan.md)), and a turn-end reply window through
`MessagePanel` (see [remote-message](remote-message.md)). All three stores hold one entry
per session and a session can only be parked on one thing at a time, so in practice at most
one of the three ever renders.

## What's shown

`parseChatRecord` (pure + unit-tested) keeps user text and assistant text, plus one
compact line per `tool_use` (`{ name, detail }`, detail from the **reused** `describeTool`
in `transcript.ts`). Exception: for `ExitPlanMode` and `AskUserQuestion` the input *is*
conversational content, so the full body (the plan markdown / questions+options composed
as markdown) rides along as `ChatToolCall.body` — capped at `TOOL_BODY_CAP` (20 KB by
default, `bodyTruncated` flag) — and renders as a collapsible `<details open>` block
(`.cmsg-plan`) instead of the one-liner; the `text` filter keeps body-bearing messages.

Dropped: records with no user/assistant `message.role` (`last-prompt`, `custom-title`,
`queue-operation`, `attachment`, `system`), `isSidechain` records (subagent traffic —
`SessionDetail`'s agent timeline already covers it), `isMeta` records, `thinking` blocks,
`tool_result` bodies (they're most of a transcript's bytes and all noise here),
`<system-reminder>` spans, and anything empty after that filtering. Text is capped at
`TEXT_CAP` (2000 chars) with a `textTruncated` flag.

**One `isMeta` exception: a [remote message](remote-message.md) sent from this drawer.**
A follow-up typed into `MessagePanel` comes back as a Stop-hook block, which the CLI
records as an `isMeta` user record whose content is `messages.ts` `composeReason` output
under a `Stop hook feedback:` line — so the plain meta filter made the message you just
sent invisible in the history you sent it from. `REMOTE_MESSAGE_RE` unwraps that one shape
and the record becomes an ordinary user message carrying only your typed text; the caps,
`<system-reminder>` strip and `text`/`you` filters then apply to it like any other. It is
**not** marked as remote — a message you sent is a message you sent. The pattern is
duplicated in `chat.ts` rather than imported, so the read path never pulls in the
reply-window store; `chat.test.ts` imports the real `composeReason` to pin the two
together. Both ends are anchored, so drift in that prose **fails closed** — back to a
dropped record, never a half-unwrapped one.

**Both caps are a request parameter, not a constant.** `parseChatRecord` takes a `ChatCaps`
(`{ text, toolBody }`) that defaults to `DEFAULT_CAPS`; `?full=1` swaps in `NO_CAPS`
(`Infinity` for both, so the compare/slice arithmetic is unchanged). It has to work this way
round: truncation happens here, server-side, so a "show me the whole message" toggle in the
drawer could not undo it after the fact — the bytes were never sent. See
[settings](settings.md) for the switch that sets it. The uncapped page is still bounded: a
page never reads more than one `CHAT_WINDOW_BYTES` window, so lifting the caps raises the
worst case to the window size, not to the transcript size.

## Mechanism

- **Endpoint:** `GET /api/sessions/:id/chat` (`SessionChat`). Three modes, one handler
  (`serveSessionChat` in `api.ts`), reader in `lib/chat.ts`:
  - no query → **tail**: newest `CHAT_PAGE_MESSAGES` (100) in the last
    `CHAT_WINDOW_BYTES` (512 KB) of the file,
  - `?after=<cursor>` → **live tail**: only the bytes appended since (`O(new bytes)`),
  - `?before=<headOffset>` → **older page**: the 512 KB window ending at that offset.

  `?full=1` composes with all three (`chatQuery` in `client/src/lib/settings.ts` builds the
  string, so the tail, the poll and "load older" can never disagree about it) and lifts the
  per-message caps. Any other value, or its absence, is the capped default.
- **Paging currency is byte offsets** (transcripts are append-only): `cursor` walks
  forward, `headOffset` (the byte offset of `messages[0]`'s line) walks backward,
  `hasMore` is just `headOffset > 0`. Backward pages return `cursor: 0` — they must never
  move the live cursor. `?after=` past EOF (truncation/rotation) returns `reset: true`
  and the client refetches the tail. Bad/negative/non-integer offsets → 400.
- **No cache.** Unlike `agents-cache.ts` there's no accumulated reducer state to keep, so
  every call is already `O(window)` or `O(appended bytes)`. Measured on an 805 KB
  transcript: tail page ≈ 10 KB, idle poll ≈ 110 bytes.
- **Filter (`lib/chatFilter.ts`, pure + unit-tested):** a row of three buttons under the
  drawer header — `all` / `text` / `you`. A transcript is mostly tool traffic (dozens of
  near-identical `Edit <path>` lines), so `text` drops messages with no text at all
  (tool-only turns) and `you` keeps only user prompts. **Client-side on purpose:**
  switching is instant and keeps every page already loaded — a server-side `?text=` param
  would mean refetching and losing the loaded history. Consequence to accept: a filtered
  page is sparse (a 47-message page can show 4), so the footer reports `4 of 47 shown`
  and "load older" stays the way to see more. Persisted as `dashboard.chatFilter` and
  re-validated with `isChatFilter` on read. Switching filters re-anchors to the live tail
  rather than being mistaken for a prepend (the layout effect compares a `prevMode` ref
  before the first-uuid check).
- **Markdown:** message text *is* markdown, so `lib/markdown.ts` (pure, unit-tested, zero
  deps) parses the subset transcripts actually use — headings, `**bold**`, `*italic*`,
  inline code, fenced code, GFM tables, bullet/numbered lists, blockquotes, rules, links —
  into a block/inline tree that `components/Markdown.tsx` turns into elements. **No
  `dangerouslySetInnerHTML` anywhere**, so transcript content can't inject markup; only
  `http(s)`/`mailto`/`#` become `<a>`, and any other target (repo-relative paths like
  `[api.ts](server/api.ts)`) renders as the label with the path on hover. Unrecognised
  syntax stays literal text, so the worst case is the raw text we showed before.
  Deliberately omitted: `_underscore_` emphasis (would fire inside `snake_case` /
  `__init__`), nested blockquotes, reference links, inline HTML. Emphasis honours
  CommonMark flanking, so `2 * 3 * 4` stays literal. Paragraphs keep hard line breaks via
  `white-space:pre-wrap` on `.md-p`; wide tables and code blocks scroll inside their own
  box so the drawer never scrolls sideways.
- **Client:** `ChatDrawer` is a `React.lazy` default export (own chunk; the sessions
  bundle is unchanged), keyed by session id in `SessionsView` so switching sessions
  remounts the tail. `useSessionChat` keeps `cursor`/`headOffset` in refs (the poll
  always sees the latest without re-arming) and a `ready` ref so the poll can't fire
  before the first page lands — `?after=0` would ship the whole file. Scroll: an append
  auto-scrolls only when the reader was already within 40px of the bottom; a prepend
  restores position by the height the new page added (`scrollHeight` captured at click
  time, prepend detected by a changed first-message uuid). `chatId` is **not** persisted —
  session ids churn (same reasoning as row expansion in
  [view-persistence](view-persistence.md)).
- The `chat` tab (`.row-chat`) is a **sibling** of the clickable card face (`.row-main`),
  not a child of it — so opening the drawer never has to out-shout the row's own toggle.
  It also carries the row's held states: `answer` / `plan?` / `reply?` / `allow?` are the
  same one control with a different label and tone, since all four open this drawer.

## Invariants

- **Offsets are BYTES, lines split on `0x0A` before decoding** — a multibyte UTF-8
  sequence can straddle a window boundary, so string lengths must never drive an offset.
  That's why `chat.ts` reads `Buffer`s itself instead of `transcript.ts` `readTail`
  (which returns decoded text). A window that doesn't start at byte 0 begins mid-line;
  that fragment is dropped. A newline-less final line that parses as JSON *is* a complete
  record and is consumed; if it doesn't parse, `cursor` stops before it and the next poll
  re-reads it. Same rules — and same oracle-equivalence test style — as `agents-cache.ts`.
- **⚠️ Path safety:** the id is validated with `ID_RE` and resolved against
  `listTranscripts(projectsRoot())` — **never joined into a path** (same philosophy as
  `serveSessionDetail` / the management file endpoint).
- **⚠️ Route order:** the detail regex `/^\/api\/sessions\/([^/?]+)/` in `index.ts` also
  matches `/api/sessions/:id/chat` and would answer it with agents — the chat match
  **must** stay above it.
