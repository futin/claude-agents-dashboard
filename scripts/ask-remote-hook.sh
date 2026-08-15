#!/bin/bash
# ask-remote-hook.sh — PreToolUse[AskUserQuestion] hook for remote answers.
#
# Offers the question to the dashboard and waits. If it is answered there, deny
# the tool call with a reason naming the choice (the only supported way to get an
# answer into a live session — the model reads the reason and carries on).
# ANY other outcome exits 0, which lets the normal terminal dialog appear.
#
# A question can't be live in the terminal AND answerable from the phone (the
# dialog only renders once this hook exits), so three gates decide who gets it:
#   1. REMOTE_ANSWER on the server — is the feature available at all?
#   2. the dashboard toggle        — am I accepting remote answers right now?
#   3. keyboard idle, below        — am I actually away from the desk?
# At the desk, gate 3 falls through instantly, so the terminal dialog behaves
# exactly as it did before this hook existed.
#
# Install:
#   ln -s "$PWD/scripts/ask-remote-hook.sh" ~/.claude/hooks/ask-remote.sh
# then add to ~/.claude/settings.json under PreToolUse matcher AskUserQuestion:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/ask-remote.sh\"",
#     "timeout": 630 }
# The timeout MUST exceed the wait window below, or the CLI kills the hook first.
#
# Requires: curl, jq. See docs/subsystems/remote-answer.md in the dashboard repo.

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

# 1. Reachability probe, hard 1s cap. Dashboard down, REMOTE_ANSWER=false, or the
#    toggle switched off → fall straight through, no added latency.
HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null) || exit 0
[ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false')" = "true" ] || exit 0

# 2. Are you at the keyboard? If so the terminal dialog wins — remote answering
#    only kicks in once you've stepped away. macOS reports idle nanoseconds via
#    IOHIDSystem (~40ms to read). If it can't be read (non-macOS, ioreg missing)
#    we assume you ARE at the desk: never hide the dialog on a guess.
if [ "$IDLE_MIN_S" != "0" ]; then
  IDLE_S=$(ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ {print int($NF / 1000000000); exit}')
  case "$IDLE_S" in
    ''|*[!0-9]*) exit 0 ;;                          # unreadable → treat as at-desk
    *) [ "$IDLE_S" -lt "$IDLE_MIN_S" ] && exit 0 ;; # at the desk → terminal dialog
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
#    (server restarted), or a timeout all mean: use the terminal dialog.
RESP=$(curl -sf -m "$((TIMEOUT_S + 15))" -X POST \
  -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/questions/wait" 2>/dev/null) || exit 0

[ "$(printf '%s' "$RESP" | jq -r '.status // empty')" = "answered" ] || exit 0
REASON=$(printf '%s' "$RESP" | jq -r '.reason // empty')
[ -n "$REASON" ] || exit 0

# 4. Inject. This block is the only mechanism-specific part of the feature —
#    swap it if a native "answer the tool call" path ever lands. The reason is
#    composed server-side (pending.ts composeReason), never here.
jq -cn --arg r "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
