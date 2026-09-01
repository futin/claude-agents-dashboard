#!/bin/bash
# remote-decision-hook.sh — UserPromptSubmit hook: when the dashboard is
# accepting phone answers AND this session runs in an auto-ish permission mode,
# tell the model to route every decision through AskUserQuestion.
#
# Why: a plain-text question ("should I proceed?") is invisible to someone away
# from the terminal — the dashboard can show it but not answer it. AskUserQuestion
# is the one decision surface the phone can answer (see remote-answer.md), so
# under these two conditions the model should prefer it for everything:
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

# Condition 3: if the server enforces ANSWER_TOKEN, the sibling hooks can only
# reach its write endpoints when the token file exists — and the banner below is
# a promise about exactly those write endpoints.
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
REMOTE DECISION MODE — the dashboard is accepting phone answers and this session
runs without permission prompts. The user may be away from the terminal: they can
answer the AskUserQuestion tool from their phone, but they cannot read a
plain-text question or approve a plan card. Therefore, for this session:
1. Put EVERY decision through the AskUserQuestion tool — approach choices,
   "should I proceed?", scope calls, and questions a skill tells you to ask
   (e.g. the brainstorming skill's session-mode pick). Never end a turn on a
   prose question.
2. Do not enter plan mode and do not call ExitPlanMode — its approval card can
   only be answered at the terminal. Present a plan as a concise summary (or a
   file) and then ask via AskUserQuestion: proceed, or revise (with an option to
   say what).
3. Permission dialogs remain terminal-only and will park the session until the
   user returns, so prefer tools and commands that are already allowed.
EOF
exit 0
