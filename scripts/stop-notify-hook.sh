#!/bin/bash
# stop-notify-hook.sh — Stop hook: report a finished turn, and, when you are
# away, hold the turn open so a follow-up typed in the dashboard can continue
# the model (docs/subsystems/remote-message.md).
#
# Two paths out of every run:
#   at the desk / feature off → POST /api/notify/event (the old fire-and-forget
#     push trigger) and exit 0 — byte-for-byte the pre-feature behaviour;
#     ("at the desk" is skipped for headless sessions — see HEADLESS below:
#     a dashboard-spawned `claude -p` has no terminal, so the desk gives you
#     no other way to reply and the hold must open regardless of idle);
#   away + remote answers on  → POST /api/messages/wait, held. A reply becomes
#     {"decision":"block","reason":…} on stdout — the ONLY output shape the CLI
#     accepts for a Stop block (verified against 2.1.233; reason is fed to the
#     model). ANY other outcome exits 0 and the session stops normally.
#
# The CLI caps consecutive Stop blocks at 8 (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP),
# then force-ends the turn — so a phone conversation is at most 8 replies per
# stretch. stop_hook_active no longer short-circuits: mid-conversation stops
# must re-hold (that IS the chat loop); it rides in the POST body instead so the
# server skips the push you would not want mid-chat.
#
# Install:
#   ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
# then in ~/.claude/settings.json under Stop:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"",
#     "timeout": 630 }
# The timeout MUST exceed the wait window (Settings → Answer window, ≤600s) or
# the CLI kills the hook mid-hold — which only degrades to a normal stop.
#
# Requires: curl, jq.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0
command -v jq > /dev/null 2>&1 || exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

SHA=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')

# Count in-flight background work. Missing keys -> [] -> 0 (safe fallback).
# Only the hook payload carries this, which is why the guard stays here.
bg=$(printf '%s' "$INPUT" | jq '((.background_tasks // []) | length) + ((.session_crons // []) | length)' 2>/dev/null || echo 0)
[ "${bg:-0}" -gt 0 ] 2>/dev/null && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')

# Headless detection. This hook inherits the `claude` process's controlling
# terminal: a dashboard-spawned `claude -p` runs detached with none, so
# `ps -o tty=` prints `??` (macOS; `?` on Linux), while a terminal session
# prints its tty name. Verified both ways against this host's `ps`. Unreadable
# output fails to "terminal" — never exempt a session on a guess; the worst
# case is today's behaviour (the desk gate closes the window).
TTY_NAME=$(ps -o tty= -p $$ 2>/dev/null | tr -d '[:space:]')
HEADLESS=false
case "$TTY_NAME" in '??'|'?') HEADLESS=true ;; esac

# ...but a missing TTY is not the same thing as a missing place to type. The
# desktop app runs the CLI with no pty (measured: `ps -o tty=` prints `??`,
# CLAUDE_CODE_ENTRYPOINT=claude-desktop, CLI 2.1.237) and still puts a composer
# in front of you — so on the TTY test alone every desktop turn parks on the
# dashboard, ignores your idle time, and is then skipped by the idle sweep,
# which exempts headless holds by design. The entrypoint separates the two
# cases: `sdk-cli` is what a dashboard-spawned `-p` child stamps (scan.ts:77;
# spawn.ts deletes the inherited value so it cannot stamp anything else), while
# an interactive front-end names itself. Only values measured to be interactive
# are listed, so an unfamiliar entrypoint leaves the TTY verdict standing and a
# new headless front-end still fails closed.
case "$CLAUDE_CODE_ENTRYPOINT" in claude-desktop) HEADLESS=false ;; esac

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# The pre-feature behaviour: tell the dashboard a turn finished (it decides
# whether that is worth a push) and end the turn. Mid-conversation stops
# (SHA=true) skip it — the old script exited before notifying there too.
notify_fallback() {
  [ "$SHA" = "true" ] && exit 0
  BODY=$(jq -cn --arg sid "$SESSION_ID" --arg pm "$PERM_MODE" \
    '{sessionId: $sid, event: "stop", permissionMode: $pm}') || exit 0
  curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
    -d "$BODY" "$DASH/api/notify/event" > /dev/null 2>&1 || true
  exit 0
}

# Reachability probe, hard 1s cap. Dashboard down → nothing to notify or hold.
HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null) || exit 0
[ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false')" = "true" ] || notify_fallback

# Same three-way resolution as ask-remote-hook.sh: explicit env var wins, then
# the dashboard's Settings (carried on the probe), then the default.
IDLE_MIN_S="${CLAUDE_DASHBOARD_IDLE_SECS:-$(printf '%s' "$HEALTH" | jq -r '.idleSecs // 60')}"
case "$IDLE_MIN_S" in ''|*[!0-9]*) IDLE_MIN_S=60 ;; esac

# At the keyboard → no hold (you can just type in the terminal). Unreadable
# idle counts as at-desk — never park a session on a guess. Headless sessions
# skip this gate entirely: there is no terminal to type into, so the dashboard
# window is the only channel whether you are at the desk or not.
if [ "$HEADLESS" != "true" ] && [ "$IDLE_MIN_S" != "0" ]; then
  IDLE_S=$(ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ {print int($NF / 1000000000); exit}')
  case "$IDLE_S" in
    ''|*[!0-9]*) notify_fallback ;;
    *) [ "$IDLE_S" -lt "$IDLE_MIN_S" ] && notify_fallback ;;
  esac
fi

TIMEOUT_S="${CLAUDE_DASHBOARD_ANSWER_TIMEOUT:-$(printf '%s' "$HEALTH" | jq -r '.answerSecs // 600')}"
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S=600 ;; esac

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg pm "$PERM_MODE" \
  --argjson sha "$SHA" \
  --argjson hl "$HEADLESS" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, timeoutMs: $t, permissionMode: $pm, stopHookActive: $sha, headless: $hl}') || notify_fallback

# Register and hold. The server resolves this at the deadline (or the moment
# you touch the keyboard — the idle sweep); curl's cap is only a backstop. A
# non-2xx (feature flipped off mid-flight, restart) falls back to the plain
# notify so the "task finished" push never regresses.
RESP=$(curl -sf -m "$((TIMEOUT_S + 15))" -X POST \
  -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/messages/wait" 2>/dev/null) || notify_fallback

[ "$(printf '%s' "$RESP" | jq -r '.status // empty')" = "answered" ] || exit 0
REASON=$(printf '%s' "$RESP" | jq -r '.reason // empty')
[ -n "$REASON" ] || exit 0

# Block the stop. Top-level decision/reason — the one shape the CLI parses for
# Stop hooks; the reason is composed server-side (messages.ts composeReason).
jq -cn --arg r "$REASON" '{decision: "block", reason: $r}'
exit 0
