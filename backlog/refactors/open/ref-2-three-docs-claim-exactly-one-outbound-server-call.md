---
id: ref-2
title: Three docs claim exactly one outbound server call
created: 2026-09-07
kind: chore
tags: docs
---

## What exists today

Three reconciled docs, plus the project CLAUDE.md's code rule, say the server
makes exactly one kind of outbound call — the ntfy push in `server/lib/notify.ts`:

- `README.md` — the intro
- `docs/overview.md:183`
- `docs/subsystems/dictation.md:13`
- `.claude/CLAUDE.md` — "It reads disk and makes exactly one kind of outbound
  call — the ntfy push in `lib/notify.ts`."

The server also calls `https://api.anthropic.com` for the usage bars:
`server/lib/usage.ts:64` (`baseUrl()`, overridable only by the test-only
`CLAUDE_USAGE_BASE_URL`), which `/api/oauth/usage` is fetched against. So the
sentence is false in all four places, and has been since the usage bars landed —
it predates the 2026-09-07 docs-sync baselines, which is why no stamp caught it.

## Why it should change

It is the load-bearing sentence behind the "keep new deps out of `server/`" rule
and behind the read-only charter readers use to judge what the server is allowed
to do. A reader auditing the network surface from the docs would miss an
outbound call to a third party carrying an OAuth token. It also cost review time
in the docs-sync pass: two separate agents flagged it and neither would change
it unilaterally, correctly, because the wording is repo-wide.

## Rough shape

Settle one phrasing and apply it to all four places in one commit, so they cannot
drift apart again. Candidates:

- "two kinds of outbound call — the ntfy push (`lib/notify.ts`) and the usage
  read (`lib/usage.ts`)", with the CLAUDE.md rule restated as "a third needs a
  reason";
- or keep the singular claim but scope it to what it was really about — pushes
  the server *originates* — and state the usage read separately as a fetch on
  behalf of the logged-in account.

Whichever wins, `token-refresh.ts` is worth naming as the near-miss: it makes no
HTTP call itself, it `execFile`s the CLI, and a reader will otherwise count it as
a third.
