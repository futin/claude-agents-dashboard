# Chat history tail (the drawer)

The `chat` pill on a session row opens a **full-height drawer** with that session's
conversation: newest page on open, live-tailed every 3s, "load older" walking backwards
through the whole transcript. Read-only, like everything else in the app.

- **Endpoint:** `GET /api/sessions/:id/chat` (`SessionChat`). Three modes, one handler
  (`serveSessionChat` in `api.ts`), reader in `lib/chat.ts`:
  - no query → **tail**: newest `CHAT_PAGE_MESSAGES` (100) in the last `CHAT_WINDOW_BYTES`
    (512 KB) of the file,
  - `?after=<cursor>` → **live tail**: only the bytes appended since (`O(new bytes)`),
  - `?before=<headOffset>` → **older page**: the 512 KB window ending at that offset.
- **Paging currency is byte offsets** (transcripts are append-only): `cursor` walks forward,
  `headOffset` (the byte offset of `messages[0]`'s line) walks backward, `hasMore` is just
  `headOffset > 0`. Backward pages return `cursor: 0` — they must never move the live cursor.
  `?after=` past EOF (truncation/rotation) returns `reset: true` and the client refetches the
  tail. Bad/negative/non-integer offsets → 400.
- **Offsets are BYTES, lines split on `0x0A` before decoding** — a multibyte UTF-8 sequence can
  straddle a window boundary, so string lengths must never drive an offset. That's why
  `chat.ts` reads `Buffer`s itself instead of `transcript.ts` `readTail` (which returns decoded
  text). A window that doesn't start at byte 0 begins mid-line; that fragment is dropped. A
  newline-less final line that parses as JSON *is* a complete record and is consumed; if it
  doesn't parse, `cursor` stops before it and the next poll re-reads it. Same rules — and same
  oracle-equivalence test style — as `agents-cache.ts`.
- **No cache.** Unlike `agents-cache.ts` there's no accumulated reducer state to keep, so every
  call is already `O(window)` or `O(appended bytes)`. Measured on an 805 KB transcript: tail
  page ≈ 10 KB, idle poll ≈ 110 bytes.
- **What's shown (`parseChatRecord`, pure + unit-tested):** user text and assistant text, plus
  one compact line per `tool_use` (`{ name, detail }`, detail from the **reused**
  `describeTool` in `transcript.ts`). Dropped: records with no user/assistant `message.role`
  (`last-prompt`, `custom-title`, `queue-operation`, `attachment`, `system`), `isSidechain`
  records (subagent traffic — `SessionDetail`'s agent timeline already covers it), `isMeta`
  records, `thinking` blocks, `tool_result` bodies (they're most of a transcript's bytes and
  all noise here), `<system-reminder>` spans, and anything empty after that filtering. Text is
  capped at `TEXT_CAP` (2000 chars) with a `textTruncated` flag.
- **⚠️ Path safety:** the id is validated with `ID_RE` and resolved against
  `listTranscripts(projectsRoot())` — **never joined into a path** (same philosophy as
  `serveSessionDetail` / the management file endpoint).
- **⚠️ Route order:** the detail regex `/^\/api\/sessions\/([^/?]+)/` in `index.ts` also
  matches `/api/sessions/:id/chat` and would answer it with agents — the chat match **must**
  stay above it.
- **Client:** `ChatDrawer` is a `React.lazy` default export (own chunk; the sessions bundle is
  unchanged), keyed by session id in `SessionsView` so switching sessions remounts the tail.
  `useSessionChat` keeps `cursor`/`headOffset` in refs (the 3s poll always sees the latest
  without re-arming) and a `ready` ref so the poll can't fire before the first page lands —
  `?after=0` would ship the whole file. Scroll: an append auto-scrolls only when the reader was
  already within 40px of the bottom; a prepend restores position by the height the new page
  added (`scrollHeight` captured at click time, prepend detected by a changed first-message
  uuid). `chatId` is **not** persisted — session ids churn (same reasoning as row expansion in
  `view-persistence.md`).
- The `chat` pill stops click propagation; the row's own click still toggles the agents panel.
