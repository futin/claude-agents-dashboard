#!/bin/bash
# plan-remote-hook.sh — PermissionRequest[ExitPlanMode] hook for remote plan
# verdicts.
#
# Offers a proposed plan to the dashboard and waits. If you send it back from
# there, deny the tool call with your feedback as the message — the model reads
# it, revises, and calls ExitPlanMode again. ANY other outcome exits 0, which
# lets the normal plan card appear.
#
# ⚠️ REJECT ONLY, and not by choice: the CLI discards a hook `allow` for any tool
# whose requiresUserInteraction() is true ("the tool's approval card IS the
# user-interaction surface"), and ExitPlanMode is one. So a plan can be sent back
# from your phone but never approved from it. Do not try to route around that by
# returning updatedInput — the guard is deliberate.
#
# A plan can't be live on the card AND answerable from the phone (the card only
# renders once this hook exits), so the same three gates as ask-remote-hook.sh
# decide who gets it: the server's REMOTE_ANSWER, the dashboard toggle, and
# keyboard idle. At the desk this falls through instantly.
#
# Install:
#   ln -s "$PWD/scripts/plan-remote-hook.sh" ~/.claude/hooks/plan-remote.sh
# then add to ~/.claude/settings.json under PermissionRequest matcher ExitPlanMode:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/plan-remote.sh\"",
#     "timeout": 630 }
# The timeout MUST exceed the wait window below, or the CLI kills the hook first.
#
# Requires: curl, jq. See docs/subsystems/remote-plan.md in the dashboard repo.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TIMEOUT_S="${CLAUDE_DASHBOARD_ANSWER_TIMEOUT:-600}"
# Seconds without keyboard/mouse input before you count as away. 0 disables the
# check (always wait — the pre-idle-arbiter behaviour).
IDLE_MIN_S="${CLAUDE_DASHBOARD_IDLE_SECS:-60}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

command -v jq > /dev/null 2>&1 || exit 0

# A matcher is configuration, so never trust it alone: this hook must be inert
# for anything but a plan, whatever it ends up registered against.
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL" = "ExitPlanMode" ] || exit 0

# 1. Reachability probe, hard 1s cap. Dashboard down, REMOTE_ANSWER=false, or the
#    toggle switched off → fall straight through, no added latency.
HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null) || exit 0
[ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false')" = "true" ] || exit 0

# 2. Are you at the keyboard? If so the plan card wins. Unreadable idle counts as
#    at-desk: never hide the card on a guess.
if [ "$IDLE_MIN_S" != "0" ]; then
  IDLE_S=$(ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ {print int($NF / 1000000000); exit}')
  case "$IDLE_S" in
    ''|*[!0-9]*) exit 0 ;;                          # unreadable → treat as at-desk
    *) [ "$IDLE_S" -lt "$IDLE_MIN_S" ] && exit 0 ;; # at the desk → plan card
  esac
fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0

TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // empty')
[ -n "$TOOL_INPUT" ] || exit 0

BODY=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --argjson ti "$TOOL_INPUT" \
  --argjson t "$((TIMEOUT_S * 1000))" \
  '{sessionId: $sid, toolInput: $ti, timeoutMs: $t}') || exit 0

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# 3. Register and wait. The server resolves this itself at the deadline, so
#    curl's own cap is only a backstop for a hung server. A non-2xx, a reset
#    (server restarted), or a timeout all mean: use the plan card.
RESP=$(curl -sf -m "$((TIMEOUT_S + 15))" -X POST \
  -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/plans/wait" 2>/dev/null) || exit 0

[ "$(printf '%s' "$RESP" | jq -r '.status // empty')" = "rejected" ] || exit 0
REASON=$(printf '%s' "$RESP" | jq -r '.reason // empty')
[ -n "$REASON" ] || exit 0

# 4. Inject. Note the PermissionRequest output shape: a `decision` object, NOT
#    PreToolUse's flat `permissionDecision` string. The reason is composed
#    server-side (plans.ts composeReason), never here.
jq -cn --arg r "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: $r }
  }
}'
exit 0
