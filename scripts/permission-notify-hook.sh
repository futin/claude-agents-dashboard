#!/bin/bash
# permission-notify-hook.sh — Notification hook: tell the dashboard that this
# session is showing an interactive permission dialog ("allow Bash: pnpm dev?").
#
# The dialog is drawn by the TUI and never written to the transcript, so without
# this the dashboard sees a session parked on a tool_use and reads it as green
# "working" — indistinguishable from a tool that is genuinely running. The
# Notification hook fires exactly when the dialog appears, so one POST is all the
# dashboard needs to show a blue dot + an `allow?` pill on the row.
#
# DISPLAY-ONLY, unlike ask-remote-hook.sh. Nothing outside the TUI can answer a
# permission dialog — the CLI's only injection point is PreToolUse
# deny-with-reason, which removes an option rather than adding one. So this hook
# has no gates, no wait, and no output: you still answer in the terminal.
# Notification hooks are fire-and-forget (stdout is ignored), and the curl is
# capped at 1s, so this can never delay or block the dialog you're looking at.
#
# The flag clears itself: answering the dialog (allow OR deny) appends a record
# to the transcript, and the scan drops any flag older than the newest message.
#
# Install:
#   ln -s "$PWD/scripts/permission-notify-hook.sh" ~/.claude/hooks/permission-notify.sh
# then APPEND to the existing Notification hooks array in ~/.claude/settings.json
# (keep any entry already there — this is an extra command, not a replacement):
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/permission-notify.sh\"",
#     "timeout": 5 }
#
# Requires: curl, jq. See docs/subsystems/permission-notify.md in the dashboard repo.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0

# The API port, not Vite's: in dev the page is on :5173 but /api lives here.
DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

command -v jq > /dev/null 2>&1 || exit 0

# stderr is silenced throughout: a payload jq can't parse is not this hook's
# problem to report, and anything printed here lands in the CLI's hook log.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$SESSION_ID" ] || exit 0

# Notification fires for several things (idle prompts, auth, elicitation). Newer
# CLIs name the reason; older ones only carry the message, so fall back to
# matching it. Anything else is not a permission dialog → nothing to report.
KIND=$(printf '%s' "$INPUT" | jq -r '.notification_type // empty' 2>/dev/null)
MSG=$(printf '%s' "$INPUT" | jq -r '.message // empty' 2>/dev/null)
case "$KIND" in
  permission_prompt) ;;                                  # explicit — take it
  '') case "$MSG" in *permission*) ;; *) exit 0 ;; esac ;;  # old payload — sniff the text
  *) exit 0 ;;                                           # idle_prompt et al — not ours
esac

BODY=$(jq -cn --arg sid "$SESSION_ID" --arg m "$MSG" '{sessionId: $sid, message: $m}') || exit 0

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# Best-effort. Dashboard down, wrong port, bad token → the dialog behaves exactly
# as it did before this hook existed.
curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/permissions/notify" > /dev/null 2>&1 || true
exit 0
