---
id: task-29
title: Correct the one-outbound-call claim to two, and pin it with a test
created: 2026-09-23
from: ref-2
---

## Goal

Every doc that describes the server's network surface says the true thing: the backend opens **two** kinds of outbound connection, both over `node:https` —
the ntfy push (`server/lib/notify.ts`) and the account-usage read against `https://api.anthropic.com/api/oauth/usage` (`server/lib/usage.ts`), which carries
the CLI's OAuth token. The "keep new deps out of `server/`" rule in `.claude/CLAUDE.md` becomes "a third needs a reason". A test pins the code side, so the next
outbound call added to `server/` fails `pnpm test` until someone updates the allowlist — and with it, by the allowlist's own comment, these docs.

Phrasing decision (settled at groom, 2026-09-23): ref-2 offered two candidates. Take the first — "two kinds of outbound call" — not the second ("keep the
singular claim, scoped to pushes the server originates"). The second is technically defensible but reads as the same reassurance with a footnote, and the whole
point of the sentence is that a reader auditing the network surface from the docs finds the call that carries an OAuth token to a third party. The executor may
disagree, but must then apply the alternative to every site below, not a mix.

## Plan

Verified at groom time (`grep -rnE "node:https?|fetch\(" server/`): `node:https` is imported only by `lib/notify.ts` and `lib/usage.ts`; `lib/usage.ts` also
imports `node:http`, used only when the test-only `CLAUDE_USAGE_BASE_URL` is an `http:` URL; `server/index.ts` imports `node:http` for the listener, which is
inbound. There is no `fetch(` anywhere in `server/`. Re-run that grep first — if it now shows a third outbound module, stop and report it rather than writing
"two".

1. **Docs — one wording, every site, one commit.** Replace the false sentence at each site below. Match each file's existing wrap width and voice; do not reflow
   surrounding prose.
   - `README.md:15` — the intro's "exactly one outbound call — the ntfy push" becomes two: the ntfy push and the usage-bar read from Anthropic's API.
   - `README.md:70` (Dictation bullet) — "keeping the ntfy push the only outbound call" is false for the same reason. Reword so the point survives without a
     count: dictation adds no outbound call — no audio leaves the box.
   - `.claude/CLAUDE.md:61-62` — "makes exactly one kind of outbound call — the ntfy push in `lib/notify.ts`. A second needs a reason." becomes two kinds (ntfy
     push in `lib/notify.ts`, usage read in `lib/usage.ts`), "A third needs a reason." Add one clause for the near-miss: `lib/token-refresh.ts` and
     `lib/spawn.ts` launch the `claude` CLI, which makes its own network calls — the server does not, and they are not a third kind.
   - `docs/overview.md:190` — the `lib/notify.ts` map entry's "the one outbound call the backend makes" becomes "one of the backend's two outbound calls (the
     other is `lib/usage.ts`)". Optionally add "— the other outbound call" to the `lib/usage.ts` entry at `:153`; keep the column alignment of that map.
   - `docs/subsystems/dictation.md:13` — "makes exactly one outbound call by design — the ntfy push" becomes two (ntfy push, usage read), keeping the paragraph's
     argument intact: routing dictated audio through a third party would still be the loudest thing the app does, and local whisper still adds no outbound call.
   - `docs/subsystems/session-surfaces.md:102` — "Adding it to this backend means a **second outbound call**" becomes "a **third outbound call**". That
     paragraph also says it would mean "reading an OAuth token the CLI keeps in the macOS keychain" as if new — `lib/usage.ts` already reads that token. Reword
     so the cost reads as "another call on the same OAuth token `lib/usage.ts` already reads", not a new credential surface.

   Do not touch the `<!-- docs-sync: ... verified: <sha> -->` stamps at the foot of these files — re-baselining is `/docs-sync`'s job, and a hand-edited sha
   lies about what was verified. Do not edit `docs/superpowers/`, `docs/guides/` or `docs/learning-notes/` — those are records of a moment, not reference.
   `backlog/` items that say "no new outbound call" (idea-4, bug-12) are fine as written.

2. **Guard test — `test/outbound.test.ts`**, registered in `test/run-all.ts` beside the other `run as runX` imports. Two parts:
   - **A pure scanner**, exported from the test file (or a small helper beside it — executor's call; it must not live in `server/`, which has no business
     scanning itself): given a map of `relative path → source text`, return, per file, the network modules it imports at runtime. Modules that count:
     `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram`, their bare-specifier forms (`'https'`, `'net'`, …), and any call to the
     global `fetch(`. `import type` lines do not count (`server/api.ts` and `server/lib/origin.ts` import types from `node:http` and must not register).
   - **A live assertion** over every `server/**/*.ts` file on disk: the scanner's result must deep-equal an allowlist of exactly `server/index.ts → [node:http]`
     (the inbound listener), `server/lib/notify.ts → [node:https]` and `server/lib/usage.ts → [node:http, node:https]`. The allowlist carries a comment saying
     that adding an entry means updating the sites in step 1 — that sentence is how the docs stay honest.
   - **A doc-text assertion:** none of `README.md`, `.claude/CLAUDE.md`, `docs/overview.md`, `docs/subsystems/*.md` matches
     `/exactly one (kind of )?outbound|only outbound call|the one outbound call/i`. Scope it to exactly those paths — records under `docs/superpowers/` may
     legitimately quote the old sentence.

   Follow `test/tailnet.test.ts` for shape: node-assert, a `run()` export, the file's own header comment stating the defect it exists to prevent (in one short
   paragraph — this repo comments why-only).

## Test cases

Scanner, on synthetic inputs (no disk):

- `import https from 'node:https';` → `['node:https']`.
- `import * as net from 'net';` (bare specifier) → `['node:net']` — normalise bare specifiers to the `node:` form so the allowlist has one spelling.
- `import type { IncomingMessage } from 'node:http';` → `[]`.
- `import { type IncomingHttpHeaders } from 'node:http';` → `[]` when every named import is type-only. If handling the inline-`type` form cleanly costs more
  than a few lines, instead assert the live tree contains no such line and say so in the test — do not silently leave it unhandled.
- `const r = await fetch(url);` → `['fetch']`; `prefetch(x)` and a comment `// fetch( later` → `[]` (word boundary; strip `//` line comments before matching).
- A file importing both `node:http` and `node:https` → both, sorted.
- A file with none → absent from the result (not an empty array), so the live deep-equal lists only allowlisted files.

Live tree:

- The scanner over `server/**/*.ts` deep-equals the three-entry allowlist above.
- The doc-text regex matches none of the scoped docs after step 1, and matched at least `README.md` and `.claude/CLAUDE.md` before it (red proof — run the
  new test once against the unedited docs and record that it failed).

Mutation proof (per repo memory: a guard test that stays green with the guard deleted proves nothing):

- Temporarily add `await fetch('https://example.com')` to a scratch `server/lib/*.ts` file, or remove `lib/notify.ts` from the allowlist: `pnpm test` must fail
  naming the file. Revert, and record both reds in the Outcome.

## Done when

- `grep -rniE "exactly one (kind of )?outbound|only outbound call|the one outbound call" README.md .claude/CLAUDE.md docs/overview.md docs/subsystems/` prints
  nothing.
- `.claude/CLAUDE.md` names both `lib/notify.ts` and `lib/usage.ts`, says "A third needs a reason", and names `token-refresh.ts`/`spawn.ts` as CLI launches
  rather than server calls.
- `pnpm test` passes with the new `outbound` cases counted (case count up from the pre-change run), and `pnpm typecheck` is clean — both outputs quoted in the
  Outcome.
- The red proof (doc regex against unedited docs) and both mutation reds are recorded in the Outcome with the failing line.
- No `docs-sync` stamp's `verified:` sha changed (`git diff -U0 | grep 'verified:'` prints nothing).
