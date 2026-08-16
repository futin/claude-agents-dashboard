#!/bin/bash
# stop-notify-hook.sh — Stop hook: tell the dashboard a turn finished, so it can
# decide whether that is worth a push.
#
# The decision is NOT made here. Whether a push goes out, and to which topic, is
# the dashboard's policy (Settings → Push notifications, server/lib/notify.ts).
# This hook only reports the event and the two things only it can see: the
# session's permission mode, and whether background work is still in flight.
#
# Replaces the old ~/.claude/hooks/stop-notify.sh, which held a hardcoded ntfy
# topic and a CLAUDE_NTFY env gate. Both are gone: the topic lives in the
# dashboard's .env and never leaves the server.
#
# Install:
#   ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
# then add to ~/.claude/settings.json under Stop:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"" }
#
# Requires: curl, jq. See docs/subsystems/push-notify.md in the dashboard repo.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0
command -v jq > /dev/null 2>&1 || exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

# Never re-trigger loop (we never block, but guard anyway).
[ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

# Count in-flight background work. Missing keys -> [] -> 0 (safe fallback: notify).
# Only the hook payload carries this, which is why the guard stays here rather
# than moving into the server's predicate with the rest of the policy.
bg=$(printf '%s' "$INPUT" | jq '((.background_tasks // []) | length) + ((.session_crons // []) | length)' 2>/dev/null || echo 0)
[ "${bg:-0}" -gt 0 ] 2>/dev/null && exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
[ -n "$SESSION_ID" ] || exit 0
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')

BODY=$(jq -cn --arg sid "$SESSION_ID" --arg pm "$PERM_MODE" \
  '{sessionId: $sid, event: "stop", permissionMode: $pm}') || exit 0

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# Best-effort, 1s cap. Dashboard down or pushes disabled → the turn ends exactly
# as it did before this hook existed.
curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/notify/event" > /dev/null 2>&1 || true
exit 0
