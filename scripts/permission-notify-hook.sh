#!/bin/bash
# permission-notify-hook.sh — tell the dashboard that this session is showing an
# interactive permission dialog ("allow Bash: pnpm dev?").
#
# The dialog is drawn by the UI and never written to the transcript, so without
# this the dashboard sees a session parked on a tool_use and reads it as green
# "working" — indistinguishable from a tool that is genuinely running. One POST
# is all the dashboard needs to show a blue dot + an `allow?` pill on the row.
#
# TWO EVENTS, ONE SCRIPT. Register it under both; it keys off hook_event_name:
#
#   PermissionRequest  fires on the ask path, immediately before the prompt is
#                      drawn, and carries tool_name + tool_input. Works in the
#                      desktop app. PREFERRED — register this one.
#   Notification       fires ~6s after a permission dialog opens (and is
#                      cancelled if you answer first), only on engines that emit
#                      it: CLI >= 2.1.233, and NOT the desktop app's bundled
#                      engine as of 2.1.229. Kept for older/terminal setups.
#
# Both are harmless together: the store keeps one entry per session, so whichever
# arrives first shows the pill and the second just re-arms it.
#
# DISPLAY-ONLY, unlike ask-remote-hook.sh. This hook never prints anything on
# stdout, which for PermissionRequest means "no decision" — the prompt renders
# exactly as it would have. Do not make it emit a decision: an `allow` reaching
# in over HTTP would turn the dashboard into a remote permission bypass.
#
# The flag clears itself: answering the dialog (allow OR deny) appends a record
# to the transcript, and the scan drops any flag older than the newest message.
#
# Install:
#   ln -s "$PWD/scripts/permission-notify-hook.sh" ~/.claude/hooks/permission-notify.sh
# then APPEND to the PermissionRequest (and optionally Notification) hooks arrays
# in ~/.claude/settings.json — keep whatever is already there:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/permission-notify.sh\"",
#     "timeout": 5 }
#
# Set CLAUDE_DASHBOARD_HOOK_LOG=1 to append every payload this hook sees to
# ~/.claude/hooks/last-permission.jsonl (debugging; unbounded, leave it off).
#
# Requires: curl, jq. See docs/subsystems/permission-notify.md in the dashboard repo.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0

# The API port, not Vite's: in dev the page is on :5173 but /api lives here.
DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"

command -v jq > /dev/null 2>&1 || exit 0

if [ "$CLAUDE_DASHBOARD_HOOK_LOG" = "1" ]; then
  printf '{"_at":"%s","payload":%s}\n' "$(date -u +%FT%TZ)" "$INPUT" \
    >> "$HOME/.claude/hooks/last-permission.jsonl" 2>/dev/null || true
fi

# stderr is silenced throughout: a payload jq can't parse is not this hook's
# problem to report, and anything printed here lands in the CLI's hook log.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$SESSION_ID" ] || exit 0

EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
case "$EVENT" in
  PermissionRequest)
    # Only ever fired when a decision is actually needed, so there is nothing to
    # filter — the event itself IS the signal.
    TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
    MSG="Claude needs your permission to use ${TOOL:-a tool}"
    ;;
  Notification | '')
    # Notification fires for several things (idle prompts, auth, elicitation).
    # Newer CLIs name the reason; older ones only carry the message, so fall back
    # to matching it. Anything else is not a permission dialog → nothing to report.
    KIND=$(printf '%s' "$INPUT" | jq -r '.notification_type // empty' 2>/dev/null)
    MSG=$(printf '%s' "$INPUT" | jq -r '.message // empty' 2>/dev/null)
    case "$KIND" in
      permission_prompt) ;;                                    # explicit — take it
      '') case "$MSG" in *permission*) ;; *) exit 0 ;; esac ;;  # old payload — sniff the text
      *) exit 0 ;;                                             # idle_prompt et al — not ours
    esac
    ;;
  *) exit 0 ;;                                                 # some other event — not ours
esac

# PermissionRequest payloads carry the mode; the legacy Notification fallback may
# not. Sent when present — an absent mode simply never satisfies requireAutoMode
# in the notifier (server/lib/notify.ts).
PERM_MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)

BODY=$(jq -cn --arg sid "$SESSION_ID" --arg m "$MSG" --arg pm "$PERM_MODE" \
  '{sessionId: $sid, message: $m, permissionMode: $pm}') || exit 0

AUTH=()
if [ -f "$TOKEN_FILE" ]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

# Best-effort. Dashboard down, wrong port, bad token → the dialog behaves exactly
# as it did before this hook existed. The 1s cap matters more here than on the
# Notification path: PermissionRequest runs INLINE, before the prompt is drawn.
curl -sf -m 1 -X POST -H 'Content-Type: application/json' "${AUTH[@]}" \
  -d "$BODY" "$DASH/api/permissions/notify" > /dev/null 2>&1 || true
exit 0
