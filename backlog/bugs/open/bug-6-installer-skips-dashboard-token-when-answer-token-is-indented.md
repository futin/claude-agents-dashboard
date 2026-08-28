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
- server/lib/config.ts:116 — `parseEnv` does `rawLine.trim()`, so the server accepts the same line
- scripts/ask-remote-hook.sh:89 — `AUTH=()` stays empty when the token file is absent
- scripts/stop-notify-hook.sh:76 — same
- scripts/plan-remote-hook.sh:38, scripts/permission-notify-hook.sh:50 — same TOKEN_FILE lookup
- scripts/ask-remote-hook.sh:97, scripts/stop-notify-hook.sh:130 — `curl -sf` turns the 403 into a silent `exit 0`
- server/api.ts:641,714,789,867,901,926 — the `tokenOk` gates that reject

## Cause

Two readers of the same `.env` line disagree about leading whitespace. `parseEnv`
trims each raw line before splitting, so the server sees a token. The installer
greps with a `^`-anchor and no whitespace class, so it sees nothing and takes its
"no token configured" branch. The asymmetry means the token can be simultaneously
*enforced* by the server and *invisible* to the thing whose job is to distribute it.

Second, contributing: the failure is unobservable from every surface a user checks.
The hooks discard the 403 (`curl -sf` + `|| exit 0` / `|| true`), the server logs
nothing for a rejected hook POST, and the only status indicator anyone looks at —
the REMOTE DECISION banner — is fed by an endpoint that does not require the token.

## Fix

unknown — candidate directions, to be settled at groom:

1. Make the installer's reader match the server's: `grep -E '^[[:space:]]*ANSWER_TOKEN='`,
   trimming the captured value. Narrow, fixes this exact trap. Consider whether every
   other `grep '^KEY='` over `.env` in `scripts/` has the same hole.
2. Have the installer stop parsing `.env` itself and ask the running server / reuse
   `parseEnv`, so there is one reader rather than two. Removes the class, not just the case.
3. Make the silence loud, independently of 1 and 2: have the hooks distinguish a 403 from
   an unreachable server (they currently cannot), and/or have the server log a rejected
   hook POST once. A token misconfiguration should not look identical to "feature off".
4. Consider whether the REMOTE DECISION banner should reflect *write* reachability
   rather than `GET /api/health`, since that is the claim it actually makes.

Immediate workaround applied on this machine (not a fix):
`printf '%s' "$ANSWER_TOKEN" > ~/.claude/hooks/dashboard-token && chmod 600` plus
removing the leading space from the `.env` line. Verified by a real `stop` push
landing on the ntfy topic.
