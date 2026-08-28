---
id: bug-6
title: Installer skips dashboard-token when ANSWER_TOKEN is indented
created: 2026-08-28
tags: hooks, notify, remote-answer, install
---

## Symptom

With `ANSWER_TOKEN` set in `.env`, `pnpm hooks:install` reported
`TODO     no ANSWER_TOKEN in .env` and wrote no `~/.claude/hooks/dashboard-token`.
The server still parsed the token, so every token-gated route began answering
`403 {"error":"bad token"}` to hooks that could not build an auth header.

Both features that depend on those POSTs died **silently and simultaneously**:

- **No push notifications.** `maybeSend` never ran; the ntfy topic showed zero
  published messages over 12h while the Settings UI showed every switch on and
  `notifyAvailable: true`.
- **No remote answers.** `ask-remote.sh` / `plan-remote.sh` got 403, `curl -sf`
  swallowed it, hook `exit 0`, question fell back to the terminal dialog.

Worse, the session banner kept claiming remote answering was armed:
`remote-decision-hook.sh` only does `GET /api/health`, which is untokened, so it
succeeds while every write path is rejected. The one visible signal was wrong.

## Repro

1. Put `ANSWER_TOKEN=<value>` in `.env` with **one leading space**: ` ANSWER_TOKEN=abc`.
2. Run `pnpm hooks:install`. It prints the "no ANSWER_TOKEN in .env" TODO branch
   and writes no token file.
3. Start the server. `curl -s -X POST localhost:4173/api/notify/test -d '{}'`
   → `403 {"error":"bad token"}` — proving the server *did* read the token.
4. Trigger any AFK-routed event. Nothing arrives; nothing logs.

## Affects

- scripts/install-hooks.sh:262 — `grep -E '^ANSWER_TOKEN='`, anchored, no `[[:space:]]*`
- server/lib/config.ts:112 — `parseEnv` does `rawLine.trim()`, so the server accepts the same line
- scripts/install-hooks.sh:258 — an existing token file is "left alone" and never compared to `.env`
- scripts/ask-remote-hook.sh:89 — `AUTH=()` stays empty when the token file is absent
- scripts/stop-notify-hook.sh:76 — same
- scripts/plan-remote-hook.sh:38, scripts/permission-notify-hook.sh:50 — same TOKEN_FILE lookup
- scripts/ask-remote-hook.sh:97, scripts/stop-notify-hook.sh:130 — `curl -sf` turns the 403 into a silent `exit 0`
- scripts/remote-decision-hook.sh:56 — arms the banner off an untokened `GET /api/health`
- server/api.ts:426 — `tokenOk`, the gate; 15 call sites reject with no log line
- server/api.ts:447 — `serveHealth`, which never says a token is required

## Cause

**Two independent parsers read the same `.env` key and disagree.** `parseEnv`
(server/lib/config.ts:112) trims each raw line, splits on the first `=`, trims the
value, and strips one *matched* surrounding quote pair; later keys overwrite earlier
ones. The installer (scripts/install-hooks.sh:262) instead runs
`grep -E '^ANSWER_TOKEN=' | head -1 | cut -d= -f2- | tr -d "\"' \r"`. The reported
leading-space case is one of at least three divergences, all measured on this repo:

| `.env` line | server reads | installer reads | result |
|---|---|---|---|
| ` ANSWER_TOKEN=abc` | `abc` | *(nothing — takes the TODO branch)* | no token file |
| `ANSWER_TOKEN="a b"` | `a b` | `ab` (`tr -d` strips **every** space/quote, not just the wrapping pair) | wrong token file |
| two `ANSWER_TOKEN=` lines | last wins | first wins (`head -1`) | wrong token file |

All three land in the same place: the server *enforces* a token that the component
whose only job is to distribute it either cannot see or copies wrongly. Patching the
grep anchor fixes row 1 and leaves rows 2 and 3 — the anchor is the instance, the
second parser is the defect.

**Contributing — the installer never re-checks an existing token file.** Line 258
prints `ok  … already exists (left alone)` on presence alone. Once a wrong token file
exists (rows 2–3 above, or a hand-copied one from another machine), every subsequent
`pnpm hooks:install` reports success forever and no run ever compares it to `.env`.

**Contributing — the failure is unobservable from every surface a user checks.**
The hooks discard the 403 (`curl -sf` + `|| exit 0` / `|| true`), the server logs
nothing for a rejected POST, `GET /api/health` never mentions that a token is
required, and the one status indicator anyone reads — the REMOTE DECISION banner —
is fed by that same untokened endpoint. A misconfigured token is pixel-identical to
"feature switched off". This is already documented as a known blind spot in
docs/subsystems/push-notify.md:139; this bug is that blind spot being hit for real.

## Fix

Four parts. **1 and 2 are the fix**; 3 and 4 are the observability the incident
proved missing and are what stops the *next* token mismatch costing 12 silent hours.
They are independent — 1 and 2 are worth shipping alone if 3–4 get deferred.

**1. One reader, not two (root cause).**
Add `scripts/env-value.ts`, a small tsx entry that imports `parseEnv` from
`server/lib/config.ts` and prints one key's value:
`tsx scripts/env-value.ts <KEY> [--env <path>]` → value on stdout, exit 0; nothing on
stdout, exit 1 when unset or empty. Mirror `loadConfig`'s precedence — `process.env`
over the file — and name the winning source on **stderr**, so the shell that exported
a token falls into the same answer the server would give. Never print the value
anywhere but stdout, so the installer can capture it without it reaching the console.

Replace scripts/install-hooks.sh:262 with a call to it via `"$REPO/node_modules/.bin/tsx"`
(no new dependency: tsx is already the devDependency every `pnpm` script runs through).
If that binary is missing — a checkout with no `pnpm install` — print an explicit
`TODO run pnpm install first, then re-run` step. **Do not fall back to the grep**, and
do not let a missing binary re-enter the "no ANSWER_TOKEN in .env" branch: silently
reporting "no token" for a token that exists is the entire bug.

**2. Stop trusting an existing token file (the other half).**
At scripts/install-hooks.sh:258, when `$TOKEN_FILE` exists *and* `.env` yields a value,
compare them and branch three ways: identical → `ok` as today; different → a `warn`
step saying they differ and how to fix it; `.env` empty → `ok … (left alone)`. Compare
byte-wise without printing either value or any prefix of them. Do not overwrite
without `--force` — a deliberately different per-machine token is legitimate, and
clobbering it would be a worse bug than the one being fixed.

**3. Server logs a rejected write (make the 403 audible).**
In `tokenOk` (server/api.ts:426), on the false branch emit one
`console.error('[dashboard] rejected write: <METHOD> <path> (bad or missing token)')`,
following the existing `[dashboard] …` convention. Throttle it — one line per path per
process, or per 60s — because a held `stop` hook can retry in a loop. **Never log the
expected token, the received header, or any prefix of either**; the path and method are
the whole diagnostic.

**4. Health tells the truth about the token, and the banner uses it.**
Add `tokenRequired: config.answerToken !== ''` to `serveHealth` (server/api.ts:447) and
to the `/api/health` shape in `shared/types.ts`. This leaks nothing a 403 does not
already announce. Then in scripts/remote-decision-hook.sh, after the health probe at
line 56: if `.tokenRequired` is true and `~/.claude/hooks/dashboard-token` is absent,
do not print the "dashboard is accepting phone answers" banner — print a one-line
notice that the token file is missing instead. The banner's claim then matches the
write path it is actually describing.

**Considered and declined: teaching the hooks to distinguish 403 from unreachable**
(candidate 3 in the original capture). It means replacing `curl -sf` with
`-o body -w '%{http_code}'` in five hooks whose fail-open behaviour is load-bearing —
`permission-notify-hook.sh` runs *inline* before the permission prompt is drawn. Parts
3 and 4 surface the same information from the server and the banner at a fraction of
the risk. Revisit only if a mismatch survives 1–4.

### Test cases

`scripts/` is shell and nothing in `test/` can reach it. That is a reason to put the
parsing in a TS entry rather than a reason to skip coverage — part 1 makes the one
piece that matters testable, and the rest is honestly manual:

- `test/env-value.test.ts` (new), spawning `scripts/env-value.ts --env <tmpdir .env>`:
  - ` ANSWER_TOKEN=abc` → stdout `abc`, exit 0
  - `ANSWER_TOKEN="a b"` → stdout `a b`, exit 0 (inner space survives)
  - `ANSWER_TOKEN=one` then `ANSWER_TOKEN=two` → stdout `two`, exit 0 (last wins)
  - `# ANSWER_TOKEN=abc` → empty stdout, exit 1
  - no `.env` at the path at all → empty stdout, exit 1
  - `ANSWER_TOKEN` in `process.env` and a different value in the file → env value wins
  - each of the first three asserted **equal to `parseEnv(<same text>).ANSWER_TOKEN`**,
    so the test fails if the two readers ever diverge again
- `test/api-remote-toggle.test.ts` (where `/api/health` is exercised today): health
  reports `tokenRequired: true` with `ANSWER_TOKEN` set and `false` without it.
- Mutation check on part 3: delete the `tokenOk` false-branch log and the new 403 test
  must fail. A log assertion that passes with the log removed proves nothing.

Manual, and **must be stated as manual in the PR** — nothing here automates them:

- `pnpm hooks:install -- --dry-run` against each of the three `.env` rows above, with
  no `~/.claude/hooks/dashboard-token` present: all three must print the `write` step,
  none may print the TODO branch.
- Token file present and *differing* from `.env` → the new `warn` step, file untouched.
- Token file present and matching → `ok`, file untouched.
- End to end: correct token installed, trigger a `stop` → push lands on the ntfy topic.
  Then corrupt one byte of the token file → push does not land **and** the server prints
  the new rejected-write line **and** the REMOTE DECISION banner does not appear.

### Done when

- The three `.env` rows in ## Cause produce a token file identical to what the server
  enforces, proven by the parity assertions in `test/env-value.test.ts`.
- No `grep -E '^KEY='` over `.env` remains anywhere in `scripts/` (line 262 was the only one).
- A wrong token file is reported by `pnpm hooks:install` instead of being left alone.
- A rejected hook POST leaves a trace on the server, and the banner stops claiming
  remote answering is armed when the token file is missing.
- `pnpm test` and `pnpm typecheck` pass, with the output pasted in the PR.

### Workaround

Applied on this machine, not a fix: `printf '%s' "$ANSWER_TOKEN" > ~/.claude/hooks/dashboard-token
&& chmod 600 ~/.claude/hooks/dashboard-token`, plus removing the leading space from the
`.env` line. Verified by a real `stop` push landing on the ntfy topic.
