#!/bin/bash
# kill-guard-hook.sh — PreToolUse/Bash hook: refuse `pkill` and `killall` unless
# the pattern is anchored inside the session's own directory.
#
# Why this exists, precisely. On 2026-09-06 at 00:51:58 an unattended
# backlog-execute session, tearing down two preview servers it had itself
# started on ports 4399/5199, ran:
#
#   pkill -f "nest start --watch"; pkill -f "vite"
#
# `-f` matches the full argv of every process on the machine. The second one
# killed this repo's own `pnpm dev` — Vite on 5174, and the API on 4173 with it,
# since concurrently runs `-k`. The dashboard stayed down 6.5 hours. It was not
# collateral the run could shrug off: backlog-manager's orchestrator watchdog
# resumes a dead run by asking the dashboard's POST /api/spawn to fork a fresh
# controlling session, so the run had killed the one process that could have
# restarted it, and its 01:11 and 01:21 resume attempts both failed with
# "dashboard unreachable". One line later that same session killed its API
# correctly, `kill 78682`, by the pid it had recorded — so this is not a session
# that lacked the right idiom, it is a session that reached for the wrong one.
#
# Hence a hook rather than a rule in CLAUDE.md. A rule competes with whatever
# text happens to be in front of the session at the moment it writes the
# command, and loses often enough to matter; a PreToolUse deny does not.
#
# Registration is USER-GLOBAL like every other hook here, and that is the point:
# the process this protects is the dashboard, and the sessions that threaten it
# run in other repos. A project-scoped guard would have been installed in
# precisely the repo that was NOT running the offending command.
#
# What is refused:
#   pkill <anything>      — with or without -f, patterns match machine-wide
#   killall <anything>    — kills every process of that name, by definition
# What is allowed:
#   kill <pid>            — never matched here; killing a pid you hold is right
#   pkill -f "$PWD/…"     — a pattern anchored to an absolute path under the
#                           session's cwd can only match this session's own
#                           processes, which is the safe shape of the idiom
#
# Known false positive: a `pkill <pattern>` written at the start of a line
# inside a heredoc — documenting the thing rather than doing it — parses here as
# a command and is refused. Write such a file with the Write tool instead; the
# alternative is a shell parser in bash, which would be a worse trade. Prose
# that merely NAMES the tool is fine, however common the shape: see the bare-verb
# branch below for why that had to be handled rather than tolerated.
#
# Install:
#   ln -s "$PWD/scripts/kill-guard-hook.sh" ~/.claude/hooks/kill-guard.sh
# then APPEND to the PreToolUse hooks array for matcher "Bash" in
# ~/.claude/settings.json:
#   { "type": "command", "command": "bash \"$HOME/.claude/hooks/kill-guard.sh\"",
#     "timeout": 5 }
# `scripts/install-hooks.sh` does both.
#
# CLAUDE_KILL_GUARD=off disables it for one session. It is deliberately an env
# var and not a flag file: turning it off has to be a thing the human running
# the session did on purpose, not a thing a session can arrange for itself in a
# later turn and forget to undo.
#
# Requires: jq.

INPUT=$(cat)

# The argument scan below iterates an unquoted expansion, which the shell would
# otherwise glob against whatever happens to be in this hook's cwd — so a
# pattern containing `*` would be judged on filenames instead of on itself.
set -f

# Only inside Claude Code (mirrors the other hooks in ~/.claude/settings.json).
[ "$CLAUDECODE" = "1" ] || exit 0
[ "${CLAUDE_KILL_GUARD:-on}" = "off" ] && exit 0

command -v jq > /dev/null 2>&1 || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$CMD" ] || exit 0

# Cheap reject: no mention at all, nothing to parse. Everything below this line
# runs only on the small minority of commands that name one of the two.
printf '%s' "$CMD" | grep -qE '(pkill|killall)' || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)

# Approximate the shell's own notion of "start of a command" by breaking on the
# operators that begin one. Deliberately crude: this only ever decides whether
# to LOOK at a segment, and a `pkill` that lands mid-segment (an argument to
# grep, a string being echoed) keeps its first token and is passed over.
#
# `{` and `}` are NOT separators here even though a brace group starts a
# command, because `${PWD}` — half of the anchored form this hook exists to
# permit — would be torn in three by that, and the surviving `/node_modules/…`
# fragment reads as an unanchored pattern. A brace group's own commands are
# still reached: `{ pkill …; }` splits on its mandatory `;` and the leading
# brace is stripped as a wrapper below.
SEGMENTS=$(printf '%s\n' "$CMD" | sed -e 's/&&/\
/g' -e 's/||/\
/g' -e 's/[;|&()`]/\
/g')

# Words that can precede the real command without changing which command it is.
# `env` is handled by the VAR=value case below it, since `env FOO=1 pkill …` and
# `FOO=1 pkill …` are the same command wearing different clothes.
strip_wrappers() {
  seg="$1"
  while :; do
    first=$(printf '%s' "$seg" | awk '{print $1}')
    case "$first" in
      sudo|exec|nohup|time|command|builtin|env|xargs|then|do|else|!|'{')
        seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//') ;;
      *=*)
        seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//') ;;
      *) printf '%s' "$seg"; return ;;
    esac
    [ -n "$seg" ] || { printf '%s' ""; return; }
  done
}

# The arguments of a segment that are not flags — what `pkill` would actually
# match on. Both verbs need at least one; without it they print their usage and
# exit, killing nothing.
operands_of() {
  args=$(printf '%s' "$1" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//')
  for tok in $args; do
    case "$tok" in
      -*) continue ;;
      *) printf '%s\n' "$tok" ;;
    esac
  done
}

# True when every operand names an absolute path under the session's own cwd —
# literally, or through the $PWD the session would expand it to. A pattern of
# that shape cannot match a process outside this working tree.
#
# Iterated with `for`, not `read`: operands_of already split on whitespace, so
# none of them contains a space, and a `printf | while read` would both lose the
# last operand (an unterminated line runs zero iterations, which read as "every
# operand is anchored" — every deny case passed) and swallow the verdict in a
# pipeline subshell.
anchored_to_cwd() {
  for tok in $1; do
    clean=$(printf '%s' "$tok" | tr -d '"'\''')
    case "$clean" in
      '$PWD'/*|'${PWD}'/*) ;;
      /*)
        [ -n "$CWD" ] && [ "${clean#"$CWD"/}" != "$clean" ] || return 1 ;;
      *) return 1 ;;
    esac
  done
}

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

while IFS= read -r segment; do
  [ -n "$segment" ] || continue
  segment=$(strip_wrappers "$segment")
  verb=$(printf '%s' "$segment" | awk '{print $1}')
  case "$verb" in
    pkill|killall) ;;
    *) continue ;;
  esac

  # No operand, nothing to match on, nothing dies — both tools exit on their own
  # usage message. Passing those over is not leniency, it is what keeps prose
  # usable: backtick is a segment separator above (it opens a command
  # substitution), so every markdown sentence that mentions `pkill` or writes
  # `pkill -f` in inline code arrives here looking exactly like a command. This
  # change's own commit message and documentation both tripped the guard before
  # this branch existed.
  OPERANDS=$(operands_of "$segment")
  [ -n "$OPERANDS" ] || continue

  if [ "$verb" = "pkill" ] && anchored_to_cwd "$OPERANDS"; then
    continue
  fi

  deny "Blocked \`$verb\` — it matches processes machine-wide, not just the ones this session started.

The command was: $(printf '%s' "$segment" | sed -E 's/^[[:space:]]+//')

This guard exists because a \`pkill -f \"vite\"\` in an unattended worktree session
killed the user's own dashboard dev server on port 5174 for 6.5 hours, and the
watchdog that would have resumed the run needed that very server to do it.

Kill only what you started, by the pid you recorded:
  <your server> &  MYPID=\$!   …later…   kill \"\$MYPID\"
  # or, for a server on a port you chose yourself:
  lsof -nP -iTCP:<your port> -sTCP:LISTEN -t | xargs kill

If a pattern is genuinely the only way, anchor it to an absolute path inside
this session's own directory and it will be allowed through:
  pkill -f \"\$PWD/node_modules/.bin/vite\""
done <<EOF
$SEGMENTS
EOF

exit 0
