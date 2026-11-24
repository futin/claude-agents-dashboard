# hook-common.sh — the preamble the five dashboard hooks share. Sourced, never executed, and never linked by install-hooks.sh: each hook finds it beside
# its own real path. kill-guard-hook.sh does not source it on purpose — it is safety-critical and stays self-contained.
#
# Defines DASH, TOKEN_FILE, dash_curl and autopilot_running. The two exits every hook starts with (CLAUDECODE, the routine marker) stay literal lines in
# each hook, because a sourced file that exits is harder to follow than the one line it would save.

# The API port, not Vite's: in dev the page is on :5174 but /api lives here.
DASH="${CLAUDE_DASHBOARD_URL:-http://127.0.0.1:4173}"
TOKEN_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/dashboard-token"

# curl, plus the dashboard token when there is one. The header goes in through a file descriptor (`-H @/dev/fd/N`), never argv, which any local `ps` can
# read for the whole hold. The substitution is expanded inside the curl command itself so its fd is still open when curl reads it, and `printf` is a
# builtin, so the token is no process's argv at all. No token file → no Authorization header, as before.
dash_curl() {
  if [ -f "$TOKEN_FILE" ]; then
    curl -H @<(printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$TOKEN_FILE")") "$@"
  else
    curl "$@"
  fi
}

# autopilot_running <session_id> [--blocked-unasked]
#
# Autopilot opt-out. While an `autopilot` run is `running` (state file ~/.claude/autopilot/<session_id>.json, field `status`, written by the autopilot CLI)
# the run must not ask, and the CLI applies a deny/block only after EVERY hook on the event has returned — so a hold would idle the run for up to
# `answerSecs` and push a question to the phone for a session that must not ask. Reads only `status` (and `blockPasses`); any other status, a missing or
# malformed file or a jq failure is "not running" and leaves the hook's behaviour untouched. Never writes the file. The id is checked against the CLI's own
# grammar first so a crafted session_id cannot walk the path out of the state directory.
#
# `--blocked-unasked` also counts `blocked` with `blockPasses == 0` as running, because the CLI's Stop guard blocks in that state too (a blocked run whose
# one question is already asked). Only stop-notify passes it: nothing writes state on Stop, so there is no race. The PreToolUse/PermissionRequest hooks must
# NOT: there it would race the gate's own blockPasses 1→0 write on the same event and could hide the one blocker question from the phone.
autopilot_running() {
  local LC_ALL=C sid="$1" test='.status == "running"'
  [ "$2" = "--blocked-unasked" ] && test='.status == "running" or (.status == "blocked" and .blockPasses == 0)'
  case "$sid" in ''|*[!A-Za-z0-9-]*) return 1 ;; esac
  local f="$HOME/.claude/autopilot/$sid.json"
  [ -f "$f" ] || return 1
  [ "$(jq -r "if $test then \"yes\" else \"no\" end" "$f" 2>/dev/null)" = "yes" ]
}
