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
# either is false this prints nothing: zero tokens, zero behavior change.
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
# then APPEND to the UserPromptSubmit hooks array in ~/.claude/settings.json:
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

# Condition 1: an auto-ish permission mode. Every hook payload carries
# permission_mode; absent/unknown → stay silent (fail toward default behavior).
MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty' 2>/dev/null)
[ -n "$MODE" ] || exit 0
case " $MODES " in
  *" $MODE "*) ;;
  *) exit 0 ;;
esac

# Condition 2: the dashboard is up and accepting remote answers (the same
# `remoteAnswer` field the ask-remote hook gates on — env switch AND toggle).
HEALTH=$(curl -sf -m 1 "$DASH/api/health" 2>/dev/null) || exit 0
[ "$(printf '%s' "$HEALTH" | jq -r '.remoteAnswer // false')" = "true" ] || exit 0

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
TOKEN_FILE="$HOME/.claude/hooks/dashboard-token"
if [ "$(printf '%s' "$HEALTH" | jq -r '.tokenRequired // false')" = "true" ] && [ ! -f "$TOKEN_FILE" ]; then
  cat <<EOF
REMOTE DECISION MODE is NOT armed: the dashboard requires an auth token and
$TOKEN_FILE is missing, so every question, plan and turn-end
notification this session sends it will be refused. Ask at the terminal as
usual. To arm it: run \`pnpm hooks:install\` in the dashboard checkout.
EOF
  exit 0
fi

# Injected as context for this turn (UserPromptSubmit stdout on exit 0).
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
