---
id: bug-6
title: Installer skips dashboard-token when ANSWER_TOKEN is indented
created: 2026-08-28
tags: hooks, notify, remote-answer, install
updated: 2026-09-01T16:37:33Z
started: 2026-09-01T16:18:11Z
execute-elapsed: 1162
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
do not print the "dashboard is accepting remote answers" banner — print a one-line
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

### Pre-flight decisions (orchestrator, 2026-09-01)

- **Scope: all four parts.** Parts 3 and 4 are not deferred — the observability is what
  makes the next token mismatch visible, which is the whole reason this bug cost 12 silent
  hours. Ship 1–4 in one branch.
- **Never run a non-dry-run `pnpm hooks:install` from this session.** It writes into the
  user's global `~/.claude/hooks` and merges entries into their `~/.claude/settings.json`,
  which is outside this worktree and cannot be rolled back by discarding the branch. The
  manual checks in this item are `-- --dry-run` only; anything requiring a real install is
  left for the human and must be stated as unverified in the `## Outcome`.
- Likewise do not write, move or chmod `~/.claude/hooks/dashboard-token`. Exercise the
  installer's new comparison branch against a temporary `TOKEN_FILE`/`HOME` if the script
  allows it, or leave it manual and say so.

## Outcome

**2026-09-01 — fixed, all four parts. Verification passed; two things are explicitly
unverified and need a human (below).**

The diagnosis was re-confirmed against the code as it stands before anything was changed —
all three rows of the divergence table in `## Cause` reproduce exactly as written:

```
--- a: installer grep reads: []           --- a: server parseEnv reads: [abc]
--- b: installer grep reads: [ab]         --- b: server parseEnv reads: [a b]
--- c: installer grep reads: [one]        --- c: server parseEnv reads: [two]
```

### What changed

- **1 — one reader.** New `scripts/env-value.ts`: `tsx scripts/env-value.ts <KEY> [--env <path>]`,
  importing the server's own `parseEnv`. Value on stdout with no trailing newline, winning
  source on stderr, never the value. Exit 0 / 1 (unset or empty) / 2 (called wrong) — the
  third code exists so a caller can never again report "no token" for a token that is there.
  Values are trimmed, mirroring `loadConfig`. `scripts/install-hooks.sh:262`'s
  `grep | head -1 | cut | tr` is gone; a missing `node_modules/.bin/tsx` prints
  `TODO run pnpm install first`, and never falls back to a grep or to the "no ANSWER_TOKEN" branch.
- **2 — an existing token file is compared, not trusted.** Byte-wise (a trailing newline is a
  real mismatch, and the server would reject it), printing neither value nor any prefix.
  Identical → `ok … matches .env`; different → `warn`, file untouched, points at `--force`;
  `.env` empty → `ok … (left alone)`. `--force` overwrites; nothing else does.
- **3 — a rejected write is audible.** `tokenOk` (`server/api.ts`) now emits
  `[dashboard] rejected write: <METHOD> <path> (bad or missing token)`, throttled to one line
  per path per 60s, capped at 256 keys. Method and path only — no token, no header, no prefix
  of either, and the query string is stripped.
- **4 — health tells the truth, and the banner uses it.** `tokenRequired` added to `serveHealth`
  and to `HealthResponse` in `shared/types.ts`. `scripts/remote-decision-hook.sh` gained a third
  condition: `tokenRequired && !-f ~/.claude/hooks/dashboard-token` → print a one-line "NOT armed"
  notice naming the file, not the banner. `// false` keeps an older server on the old behaviour.
- `tsconfig.json` now includes `scripts/` — `env-value.ts` is load-bearing production code
  called by the installer, and it was outside `pnpm typecheck`. The whole directory
  (`session-analytics.ts` included) typechecks clean as-is.
- Docs corrected where the change contradicts them: `docs/subsystems/push-notify.md:139` (the
  "silent — nothing says so" row this bug *is*), `docs/subsystems/remote-plan.md` (two
  conditions → three), `docs/subsystems/remote-answer.md` (health shape),
  `docs/workflows/hooks-setup.md`, `docs/workflows/configuration.md`, `docs/overview.md`.

### Verification

`pnpm test` — 1032 cases, exit 0, zero `✗` across the whole suite:

```
$ pnpm test | tail -3

  10/10 passed
ALL PASS
$ pnpm test > /dev/null 2>&1; echo $?
0
$ pnpm test 2>&1 | grep -c "✗"
0
$ pnpm test 2>&1 | grep -c "✓"
1032
```

```
$ pnpm typecheck
> tsc --noEmit
$ echo $?
0
```

New: `test/env-value.test.ts` (10 cases) and `test/api-reject-log.test.ts` (7 cases), plus 2
`tokenRequired` cases in `test/api-remote-toggle.test.ts`. All were watched failing first —
`env-value` went 0/10 → 10/10, the health cases 9/11 → 11/11.

**Mutation check on part 3** (a log assertion that passes with the log deleted proves nothing).
Deleting the `logRejectedWrite(req)` call from `tokenOk`:

```
### with the log removed ###
  ✗ a 403 prints one line naming the method and path
  ✗ the line carries no part of the token, sent or expected
  ✗ repeats of the same path are throttled to one line
  ✗ a different path gets its own line — the throttle is per path
  ✗ a query string is not logged — only the path
  ✓ an accepted write says nothing
  ✓ with no ANSWER_TOKEN configured nothing is refused or logged
  2/7 passed
### restored ###
  7/7 passed
```

The two survivors are the negative cases, which *should* pass either way.

**Installer, `-- --dry-run`, against a throwaway `CLAUDE_CONFIG_DIR` and a copy of `scripts/`
in a scratch repo** — nothing under the real `~/.claude` was read or written:

```
───── row 1: ' ANSWER_TOKEN=abc', no token file
  write    …/hooks/dashboard-token from this checkout's .env ANSWER_TOKEN
───── row 2: ANSWER_TOKEN="a b", no token file
  write    …/hooks/dashboard-token from this checkout's .env ANSWER_TOKEN
───── row 3: duplicated key, no token file
  write    …/hooks/dashboard-token from this checkout's .env ANSWER_TOKEN
───── token file MATCHES .env
  ok       …/hooks/dashboard-token already exists and matches .env          [token file unchanged]
───── token file DIFFERS from .env
  warn     …/hooks/dashboard-token differs from this checkout's .env ANSWER_TOKEN.
           Left alone. If .env is the one you want, re-run with --force, …   [token file unchanged]
───── token file differs only by a trailing newline
  warn     … differs …                                                       [token file unchanged]
───── token file present, .env has no ANSWER_TOKEN
  ok       …/hooks/dashboard-token already exists (left alone)               [token file unchanged]
───── no .env at all, no token file
  TODO     no ANSWER_TOKEN in .env — set one, then: …
───── token file DIFFERS, with --force
  write    …/hooks/dashboard-token replaced from .env ANSWER_TOKEN (--force)
───── no node_modules (fresh checkout, no pnpm install)
  TODO     run pnpm install first, then re-run — .env cannot be read
           without …/node_modules/.bin/tsx, and guessing at it is what broke this before.
```

All three rows print `write`; none reaches the TODO branch. That was the bug.

**A real (non-dry) install, contained entirely in tmpdirs** (`CLAUDE_CONFIG_DIR` pointed at a
`mktemp -d`; every write target in the script is under it), byte-comparing what the installer
wrote against what `loadConfig` enforces:

```
leading space          installer wrote "abc"  | server enforces "abc"  | mode 600 | MATCH
quoted inner space     installer wrote "a b"  | server enforces "a b"  | mode 600 | MATCH
duplicate key          installer wrote "two"  | server enforces "two"  | mode 600 | MATCH
```

**Parts 3 and 4 against a live server** (`PORT=4273 ANSWER_TOKEN=e2e-secret`, isolated cwd):

```
$ curl -s http://127.0.0.1:4273/api/health | jq '{ok, remoteAnswer, tokenRequired}'
{ "ok": true, "remoteAnswer": true, "tokenRequired": true }
health response containing the token: 0 matches

hook WITHOUT the token file:
REMOTE DECISION MODE is NOT armed: the dashboard requires an auth token and
…/dashboard-token is missing, so every question, plan and turn-end
notification this session sends it will be refused. Ask at the terminal as
usual. To arm it: run `pnpm hooks:install` in the dashboard checkout.

hook WITH the token file:
REMOTE DECISION MODE — the dashboard is accepting phone answers and this session …

5 unauthenticated POSTs to /api/notify/test → 403 403 403 403 403
1 unauthenticated POST to /api/remote-answer → 403
1 authenticated POST to /api/remote-answer   → 200

server log:
[dashboard] rejected write: POST /api/notify/test (bad or missing token)
[dashboard] rejected write: POST /api/remote-answer (bad or missing token)
server log containing the token: 0 matches
```

Five identical refusals → one line (throttle holds); a second path → its own line; the
accepted write → nothing.

`grep` for a surviving `.env` grep in `scripts/`: two hits, both comments describing the
pipeline that was removed. No live code.

### NOT verified — needs a human

- **A real `pnpm hooks:install` against the user's own `~/.claude`.** Deliberately never run:
  it symlinks into `~/.claude/hooks` and merges `~/.claude/settings.json`, outside this
  worktree and not undoable by discarding the branch. Every branch above was exercised against
  a throwaway `CLAUDE_CONFIG_DIR` instead. The real `~/.claude/hooks/dashboard-token` was not
  read, written or chmod'd.
- **The end-to-end push.** "Correct token installed → trigger a `stop` → push lands on the ntfy
  topic, then corrupt one byte → it does not" was not run; it needs a real install and a real
  ntfy topic. The 403/log/banner halves of that scenario were each proven against the live
  server above, but not the ntfy delivery itself.
- The worktree had no `node_modules` and no `client/dist`; `pnpm install` and `pnpm build` were
  run to get a green suite. `test/api-usage-rates.test.ts`'s "a near-miss path is not the rates
  endpoint" case asserts the static handler serves `<!DOCTYPE html>`, so it fails in any
  checkout that has never been built — unrelated to this fix, but worth knowing.

### Review round 1 — two Important findings, both fixed (2026-09-01)

Both were the same call site, `scripts/install-hooks.sh:279`, and both were real. Confirmed
before changing anything.

**1. `2> /dev/null` threw away the one signal that says which source won.** `env-value.ts`
mirrors `loadConfig`, so an exported `ANSWER_TOKEN` beats `.env` — deliberate — but every
message downstream hardcoded the word `.env`. So the installer wrote the shell's token while
reporting it had copied the checkout's, and its `warn` line told the user to go and edit a
`.env` that could match the token file byte for byte.

Fixed: stderr is captured to a temp file (the *value* only ever travels through the command
substitution, never through the file), the source is parsed out of `env-value: ANSWER_TOKEN
from <source>`, and `$srclabel` — "the ANSWER_TOKEN exported in this shell" or "this checkout's
`.env` ANSWER_TOKEN" — is used in every `write`, `warn` and `ok … matches` line.

```
───── shell export set, token file matches .env byte for byte
token
  warn     …/dashboard-token differs from the ANSWER_TOKEN exported in this shell.
           Left alone. If the ANSWER_TOKEN exported in this shell is the one you want, re-run with --force,
           or: printf '%s' "$ANSWER_TOKEN" > …/dashboard-token && chmod 600 …/dashboard-token

───── shell export set, no token file
token
  write    …/dashboard-token from the ANSWER_TOKEN exported in this shell
```

**2. `|| envtok=""` collapsed a failed reader into "no token".** node exits 1 for an uncaught
error and `env-value.ts` exits 1 for "unset", so the exit code cannot separate them — a
half-installed `node_modules` (tsx present, hence past the `-x` guard, but failing to import)
printed `TODO no ANSWER_TOKEN in .env` for a token that was plainly there. That sentence is the
symptom this item is named after.

Fixed: the call site now resolves one of four states — `notsx`, `ok`, `unset`, `broken` — and
`unset` requires the `env-value: ANSWER_TOKEN unset` marker on stderr, not merely exit 1.
Anything else is `broken`, which gets its own step, judges nothing, and touches nothing. The
stderr contract is now written down as a contract in `scripts/env-value.ts`'s header rather than
being an accident of its output.

```
───── reader crashes (exit 1, same code as "unset"), token IS in .env
token
  TODO     could not read ANSWER_TOKEN — scripts/env-value.ts exited 1
           without saying the key was unset. This is NOT "no token set":
           nothing is known either way, and …/dashboard-token is left as it is.
           it said: …/scripts/env-value.ts:1
           Try: …/node_modules/.bin/tsx …/scripts/env-value.ts ANSWER_TOKEN --env …/.env

  [token file after: live-token]
```

#### The call site is now tested, not just demonstrated

The review asked for coverage "if it can be reached from test/". It can. New
`test/install-hooks-token.test.ts` (18 cases) spawns the **real** `install-hooks.sh` against a
scratch checkout — real `scripts/`, everything else symlinked — always `--dry-run`, always with
`CLAUDE_CONFIG_DIR` and `HOME` redirected into tmpdirs, asserting the token file's exact bytes
afterwards. It covers the three `## Cause` rows through the caller, both source-naming branches,
the compare/`--force`/left-alone branches, the missing-binary branch, four separately broken
readers (throws at import; exits 3; exits 0 silently; prints a value but no source line), and a
sweep proving no branch ever prints either token value. It skips loudly if `jq` is absent, since
the script exits before the token block without it.

```
=== install-hooks.sh: the token block (env-value.ts call site) ===
  ✓ a leading space in .env reaches the write branch, not the TODO branch
  ✓ a quoted inner space in .env reaches the write branch, not the TODO branch
  ✓ a duplicated key in .env reaches the write branch, not the TODO branch
  ✓ an exported ANSWER_TOKEN is named as the shell, never as .env
  ✓ the warn line names the shell too, so its advice is actionable
  ✓ with no export, the source named is .env
  ✓ a token file that differs is warned about and left alone
  ✓ a trailing newline is a real difference, not a match
  ✓ --force takes the write branch on a differing file
  ✓ a token file with nothing in .env to compare is left alone
  ✓ genuinely no token anywhere is the TODO branch
  ✓ a reader that throws at import (node exits 1, the same code as "unset") is a distinct failure, not "no ANSWER_TOKEN"
  ✓ a reader that exits nonzero without a marker is a distinct failure, not "no ANSWER_TOKEN"
  ✓ a reader that exits 0 but prints nothing at all is a distinct failure, not "no ANSWER_TOKEN"
  ✓ a reader that prints a value but no source line is a distinct failure, not "no ANSWER_TOKEN"
  ✓ a failing reader leaves an existing token file untouched and unjudged
  ✓ no node_modules at all says "run pnpm install", not "no ANSWER_TOKEN"
  ✓ no branch ever prints the token value
  18/18 passed
```

These tests were written after the fix, so each was proved mutation-sensitive by putting the
finding back. Finding 1 restored (hardcode `.env` in the `write`/`warn` lines) → **16/18**, the
two failures being exactly the two source-naming cases. Finding 2 restored (collapse every
nonzero into `unset`) → **13/18**, the five failures being exactly the broken-reader cases:

```
MUTATION A (finding 1 back)          MUTATION B (finding 2 back)
  ✗ an exported ANSWER_TOKEN is        ✗ …throws at import…
    named as the shell, never .env     ✗ …exits nonzero without a marker…
  ✗ the warn line names the shell      ✗ …exits 0 but prints nothing…
    too, so its advice is actionable   ✗ …prints a value but no source line…
  16/18 passed                         ✗ a failing reader leaves an existing
                                         token file untouched and unjudged
                                       13/18 passed
RESTORED: 18/18 passed
```

Neither mutation broke a case belonging to the other finding, so the two are independently
pinned.

#### Full suite after the fix

```
$ pnpm typecheck
> tsc --noEmit
$ echo $?
0
$ pnpm test > /dev/null 2>&1; echo $?
0
$ pnpm test 2>&1 | tail -3

  18/18 passed
ALL PASS
$ pnpm test 2>&1 | grep -c "✗"
0
$ pnpm test 2>&1 | grep -c "✓"
1050
```

1050 cases (was 1032; +18 for the new call-site file), zero failures.

`docs/workflows/hooks-setup.md` gained the two behaviours a reader would otherwise have to
infer: the precedence (an exported token wins, and every line names whichever source won) and
the fact that a reader which runs but fails is reported as a read failure, never as "no token".

**Still not verified, unchanged from above:** no non-dry-run `pnpm hooks:install` was run, and
the real `~/.claude/hooks/dashboard-token` was not written, moved or chmod'd — the new test
redirects both `CLAUDE_CONFIG_DIR` and `HOME`. The ntfy end-to-end push remains unrun.

**Left alone deliberately:** the review's three Minor findings. The `umask` window at
`install-hooks.sh:287` is pre-existing and carried unchanged, and the `rejectLogged` flush and
the `tokenRequired` disclosure were both weighed and accepted in the report itself.
