---
id: idea-8
title: Share the remote-message prose between chat.ts and messages.ts
created: 2026-08-27
tags: server, maintainability
---

## Problem

`server/lib/chat.ts:69-83` defines `REMOTE_MESSAGE_RE`, which hardcodes the exact prose that
`server/lib/messages.ts:61` `composeReason` generates. The pattern is duplicated rather than
imported, so editing the wording in one file silently stops the other from matching. The
code comment already acknowledges this and notes the drift "fails closed"; the only thing
holding the two in sync is a pinning test in `test/chat.test.ts`.

Fails-closed and test-pinned makes this survivable, which is why it is an idea and not a
bug — nothing is broken today.

## Rough shape

Export the prose from one owner and derive the other from it: `messages.ts` owns the string
(it generates it), `chat.ts` imports and builds its matcher from that single source. A
shared template constant with the variable parts as placeholders would let both the composer
and the matcher be generated from one definition, making drift impossible rather than merely
detected.

## Open questions

- Does anything else parse this prose (a hook script, the client) that would also need to
  read from the shared source?
- Is the pinning test in `test/chat.test.ts` sufficient insurance to just leave this alone?
  Reasonable answer: yes, until someone edits the wording and has to discover the coupling.
