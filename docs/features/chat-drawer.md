---
docs-sync:
  sources:
    - server/lib/chat.ts
    - client/src/components/ChatDrawer.tsx
    - client/src/components/Markdown.tsx
    - client/src/hooks/useSessionChat.ts
    - client/src/lib/chatFilter.ts
    - client/src/lib/markdown.ts
---

# Chat drawer

The `chat` pill on a session row opens a full-height drawer with that session's
conversation: the newest page on open, live-tailed every 3 seconds, and a **load older**
button walking backwards through the whole transcript. Read-only, like everything else.

## What you see

User and assistant text, plus one compact line per tool call. Two tools render their full
body instead, because their input *is* conversational content: `ExitPlanMode` (the plan
markdown) and `AskUserQuestion` (questions + options) appear as collapsible blocks.

Deliberately hidden: subagent traffic, thinking blocks, `tool_result` bodies (most of a
transcript's bytes, all noise here), system reminders, and meta records.

## The all / text / you filter

A transcript is mostly tool traffic, so a three-button filter under the header cuts it
down: **all** (everything), **text** (drops tool-only turns), **you** (only your
prompts). It filters client-side — switching is instant and keeps every loaded page — so
a filtered page can be sparse; the footer reports `4 of 47 shown` and *load older* is the
way to see more. The choice persists as `dashboard.chatFilter`.

## Markdown rendering

Message text is markdown, so a zero-dep parser (`client/src/lib/markdown.ts`) renders the
subset transcripts actually use — headings, bold/italic, inline + fenced code, GFM
tables, lists, blockquotes, links. No `dangerouslySetInnerHTML` anywhere, so transcript
content can't inject markup; unrecognized syntax stays literal text. Wide tables and code
blocks scroll inside their own box, never the drawer.

## How paging works (short version)

Transcripts are append-only, so paging currency is **byte offsets**: a cursor walks
forward for the 3s live tail (`O(new bytes)` per poll), a head offset walks backward for
older pages. No server-side cache needed. The full mechanics — UTF-8 boundary handling,
truncation resets, the route-order trap — live in
[.claude/rules/chat-tail.md](../../.claude/rules/chat-tail.md).

The drawer is also where [remote answers](remote-answers.md) surface: a pending question
renders as an action bar pinned above the footer.
