#!/bin/bash
# remote-decision-hook.sh — UserPromptSubmit hook: when the dashboard is
# accepting remote answers AND this session runs in an auto-ish permission mode,
# tell the model to route each decision that is the user's through AskUserQuestion.
#
# Why: a plain-text question ("should I proceed?") is invisible to someone away
# from the terminal — the dashboard can show it but not answer it. AskUserQuestion
# is the one decision surface the phone can answer (see remote-answer.md), so
# under these two conditions the model should prefer it for every such ask:
# brainstorm-skill mode picks, "write the plan file?", "proceed with the plan?",
# any option choice. It should also skip plan mode — ExitPlanMode's approval
# card is terminal-only (see remote-plan.md), while a plan presented through
# AskUserQuestion is answerable from anywhere.
#
# Both conditions are re-checked on every user prompt, so flipping the dashboard
# toggle (or changing permission mode) takes effect on the next message. When
# either is false this prints nothing — zero tokens, zero behavior change — unless
# an earlier banner has to be retracted (the OFF line below).
#
# Once per session, not once per prompt. The banner is ~2 KB and every copy stays in the transcript, so printing it on each prompt cost a 15-prompt session
# ~10k tokens of identical text (context-floor audit, 2026-11-13). A per-session marker under $HOME/.claude/hooks/.remote-decision/ records what the model
# was last told (ARMED, NOTARMED or OFF, plus the permission mode), and the hook prints only when that changes:
#   - first armed prompt → the full banner; later prompts in the same state → nothing. No one-line "still active" reminder: the full copy is already in
#     context, the one place it can leave is compaction (handled below), and a reminder per prompt would rebuild the very cost this removes.
#   - armed → off (toggle off, health probe failing, or a non-auto mode) → one OFF line, because the earlier banner is still in context and would
#     otherwise keep steering the session after the phone can no longer answer. Off → armed again → the full banner.
#   - SessionStart with source compact, resume or clear → re-print whatever the current state calls for, since compaction drops old messages and a
#     resumed or cleared session may not carry the earlier copy. That needs a second registration (installer row `SessionStart|compact|resume|clear`).
# Fail safe: a marker that cannot be read, parsed or written reads as "never told", so the full banner prints — the old behaviour — never nothing.
#
# This is an INSTRUCTION, not a gate — the model follows it like any other
# context. Nothing here blocks a tool call; the hard gates (permission dialogs,
# the plan card) stay exactly where they were.
#
# Rule 1 is CONDITIONAL on the tool actually existing, and the condition is not
# decoration. The two gates above test the permission mode and the dashboard —
# neither of which implies AskUserQuestion is in the session's tool list. A
# headless `claude -p` matches both gates and has no such tool, so the
# unconditional wording handed those sessions a contradiction: route every
# decision through a tool you do not have, and never end a turn on a prose
# question. They resolved it the only way left, by deciding silently and
# saying so — observed across four worktree sessions in two projects, none of
# which had any instruction to that effect in CLAUDE.md, a skill or a memory.
# The banner was the whole cause.
#
# The final clause is as load-bearing as the condition. Without it a session
# that lacks the tool is left with no instruction at all, which is the state
# that produced the silent deciding in the first place — so the fallback is
# named explicitly: defer to the running skill's own no-channel path, and
# absent one, ask in prose. A prose question ends the turn, which is the right
# outcome for a session with a human behind it and an acceptable one for a
# session without.
#
# Rule 5 exists because the model's own reach-the-user tool points at the wrong channel. PushNotification shows a desktop banner and, only when Claude's
# Remote Control is connected, sends a phone push. This dashboard exists for setups where Remote Control is not available (some company plans disallow it),
# so that tool answers "Mobile push not sent (Remote Control inactive)" and the user hears nothing. Ending the turn is the path that works: the Stop hook
# (stop-notify-hook.sh) opens the reply window and the server pushes "finished — reply window open" with a deep link to the session. Observed 2026-10-21:
# a session asked to test the deep link called PushNotification three times before anyone traced the silence here.
#
# Install:
#   ln -s "$PWD/scripts/remote-decision-hook.sh" ~/.claude/hooks/remote-decision.sh
# then APPEND to the UserPromptSubmit hooks array in ~/.claude/settings.json, and
# add a SessionStart entry with matcher "compact|resume|clear" running the same command
# (`pnpm hooks:install` writes both):
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/remote-decision.sh\"",
#     "timeout": 5 }
#
# CLAUDE_DASHBOARD_DECISION_MODES overrides which permission modes count as
# "auto-ish" (space-separated; default below). Add acceptEdits if you want the
# rule there too.
#
# Requires: curl, jq. See docs/subsystems/remote-plan.md in the dashboard repo.

INPUT=$(cat)

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0
# A routine run (plugin/lib/run-routine.mjs) stamps this on its child: unattended, so no hold, no push, no advice.
# `CLAUDE_DASHBOARD_SCHEDULE` is the same marker as stamped by a wrapper installed before Schedules became Routines.
[ -n "$CLAUDE_DASHBOARD_ROUTINE$CLAUDE_DASHBOARD_SCHEDULE" ] && exit 0

DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
MODES="${CLAUDE_DASHBOARD_DECISION_MODES:-auto bypassPermissions dontAsk}"

command -v jq > /dev/null 2>&1 || exit 0

EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)

# The marker. A session id that is not a plain token is never used as a path; with no marker file every armed prompt prints the full banner.
STATE_DIR="$HOME/.claude/hooks/.remote-decision"
STATE_FILE=""
case "$SID" in
  ''|*[!A-Za-z0-9_-]*) ;;
  *) STATE_FILE="$STATE_DIR/$SID" ;;
esac
LAST=""
LAST_MODE=""
[ -n "$STATE_FILE" ] && [ -r "$STATE_FILE" ] && read -r LAST LAST_MODE < "$STATE_FILE" 2>/dev/null

# Write the marker atomically (tmp + mv, so a half-written file never reads as a state), and prune markers untouched for 7 days: a session idle that long
# that comes back does so through a resume, which re-prints anyway. Any failure here is ignored on purpose — LAST stays unset next time, so the banner prints.
record() {
  [ -n "$STATE_FILE" ] || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  printf '%s %s\n' "$1" "$MODE" > "$STATE_FILE.$$" 2>/dev/null && mv -f "$STATE_FILE.$$" "$STATE_FILE" 2>/dev/null
  rm -f "$STATE_FILE.$$" 2>/dev/null
  find "$STATE_DIR" -type f -mtime +7 -delete 2>/dev/null
  return 0
}

FORCE=""
if [ "$EVENT" = "SessionStart" ]; then
  case "$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)" in
    compact|resume|clear) FORCE=1 ;;
    *) exit 0 ;;  # startup: the first prompt does the printing, with a permission_mode in hand
  esac
  # SessionStart may not carry permission_mode; the mode the last prompt saw is the best reading of it until the next prompt re-checks.
  [ -n "$MODE" ] || MODE="$LAST_MODE"
fi

# Decide the current state. Condition 1: an auto-ish permission mode; absent or unknown reads as off (fail toward default behavior).
STATE=OFF
case " $MODES " in
  *" ${MODE:-none} "*)
    # Condition 2: the dashboard is up and accepting remote answers (the same `remoteAnswer` field the ask-remote hook gates on — env switch AND toggle).
    HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null)
    if [ -n "$HEALTH" ] && [ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false' 2>/dev/null)" = "true" ]; then
      STATE=ARMED
      # Condition 3: if the server wants ANSWER_TOKEN from this caller (tokenRequired
      # means "this caller would need it": never on loopback, the usual hook path), the
      # sibling hooks can only reach its write endpoints when the token file exists —
      # and the banner below is a promise about exactly those write endpoints.
      #
      # This condition exists because the banner was once the *only* visible signal
      # and it was wrong: /api/health is untokened, so it answered cheerfully while
      # every ask/plan/stop POST came back 403 and got swallowed by `curl -sf`. The
      # session was told remote answering was armed for twelve hours in which not one
      # question ever reached a phone (backlog bug-6). A banner that cannot be checked
      # against the path it describes is worse than no banner.
      #
      # `// false` matters: an older server has no tokenRequired field, and warning on
      # a server that never said it needs a token would be the same mistake inverted.
      TOKEN_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/dashboard-token"
      if [ "$(printf '%s' "$HEALTH" | jq -r '.tokenRequired // false' 2>/dev/null)" = "true" ] && [ ! -f "$TOKEN_FILE" ]; then
        STATE=NOTARMED
      fi
    fi
    ;;
esac

if [ "$STATE" = OFF ]; then
  # Only an ARMED banner needs retracting: NOTARMED already said "ask at the terminal", and a session never told anything gets nothing and no marker.
  [ "$LAST" = ARMED ] || exit 0
  echo "REMOTE DECISION MODE is OFF now — remote answers are off, the dashboard is unreachable, or this session left an auto permission mode. The earlier REMOTE DECISION MODE rules no longer apply: ask at the terminal as usual."
  record OFF
  exit 0
fi

[ -z "$FORCE" ] && [ "$LAST" = "$STATE" ] && exit 0
record "$STATE"

if [ "$STATE" = NOTARMED ]; then
  cat <<EOF
REMOTE DECISION MODE is NOT armed: the dashboard requires an auth token and
$TOKEN_FILE is missing, so every question, plan and turn-end
notification this session sends it will be refused. Ask at the terminal as
usual. To arm it: run \`pnpm hooks:install\` in the dashboard checkout.
EOF
  exit 0
fi

# Injected as context (UserPromptSubmit and SessionStart stdout on exit 0 both are).
cat <<'EOF'
REMOTE DECISION MODE — the dashboard is accepting remote answers and this session
runs without permission prompts. The user may be away from the terminal: they can
answer the AskUserQuestion tool from their phone, but they cannot read a
plain-text question or approve a plan card. Therefore, for this session:
1. Put each decision that is the user's to make through the AskUserQuestion
   tool — approach choices, "should I proceed?", scope calls, and questions a
   skill tells you to ask (e.g. the brainstorming skill's session-mode pick).
   A skill or task that says to proceed on stated assumptions still does: this
   rule changes how you ask, not whether. While that tool is available, never
   end a turn on a prose question.
   If AskUserQuestion is not available in this session, this rule does not
   apply: follow whatever the running skill says to do without a channel,
   and if it says nothing, ask in prose rather than deciding silently.
2. Do not enter plan mode and do not call ExitPlanMode — its approval card can
   only be answered at the terminal. Present a plan as a concise summary (or a
   file) and then ask via AskUserQuestion: proceed, or revise (with an option to
   say what).
3. Permission dialogs remain terminal-only and will park the session until the
   user returns, so prefer tools and commands that are already allowed.
4. Starting a new session (start_session) needs the user's own typed words in
   chat — an AskUserQuestion answer does not count, and a proposal card cannot
   carry another folder. When the user picks "start it" there, ask them once
   to type the request (e.g. "start the backend session"); do not retry.
5. To get the user's attention while they are away, end your turn: the Stop hook
   pushes to their phone and the tap opens this session. Do not use the
   PushNotification tool — it rides on Claude's Remote Control, which this
   dashboard replaces, so it never reaches the phone.
EOF
exit 0
