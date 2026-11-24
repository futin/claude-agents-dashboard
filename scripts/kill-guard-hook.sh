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
#   …under any spelling of the name: `/usr/bin/pkill`, `\pkill`, `'pkill'`
#   …behind a wrapper, its own options and operands included: `sudo -u root`,
#     `doas`, `exec`, `env -i`, `nohup`, `time`, `timeout -s KILL 5`,
#     `nice -n 5`, `ionice -c3`, `setsid`, `stdbuf -oL`, `chrt`, `taskset`,
#     `eval`, `xargs -r`, stacked or not (`sudo timeout 5 /usr/bin/pkill …`)
#   …inside a shell's command string: `sh -c '…'`, `bash -lc "…"`, likewise
#     `zsh`, `dash`, `ksh` with any flag carrying `c`
#   xargs pkill -f        — with no operand: the pattern comes from stdin
# What is allowed:
#   kill <pid>            — never matched here; killing a pid you hold is right
#   pkill -f "$PWD/…"     — a pattern anchored to an absolute path under the
#                           session's cwd can only match this session's own
#                           processes, which is the safe shape of the idiom.
#                           `$PWD/…` only when no `cd`, `pushd` or `popd` comes
#                           earlier in the same command (it would expand under
#                           that directory instead); a literal path under the
#                           cwd is allowed either way. Never with a `|` inside
#                           the pattern: `-f` reads an extended regex, so
#                           "$PWD/x|vite" also matches every vite on the machine
#
# Known false positive: a `pkill <pattern>` written at the start of a line
# inside a heredoc — documenting the thing rather than doing it — parses here as
# a command and is refused. Write such a file with the Write tool instead; the
# alternative is a shell parser in bash, which would be a worse trade. Prose
# that merely NAMES the tool is fine, however common the shape: see the bare-verb
# branch below for why that had to be handled rather than tolerated.
#
# Known limits — what still gets through by design, because judging it would
# take a shell parser: a command held in a variable (`$K -f vite`), one run
# from a script file (`bash kill.sh`), `find … -exec pkill …`, and a wrapper
# option that takes its value as the next word but is not on that wrapper's
# list in `strip_wrappers` (its value is then read as the command). In the other
# direction, an anchored pattern inside `sh -c '…'` may be refused: the outer
# quote tears the operand, which then never reads as anchored — the safe side.
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

# The program a command word names, as the shell resolves it: `/usr/bin/pkill`,
# `\pkill` (the backslash only skips aliases) and `'pkill'` are all `pkill`, and
# so is the `'pkill` a shell's quoted command string leaves once the shell is
# stripped below. Sets NORM rather than printing, so a caller in a loop pays no
# subshell per word.
norm() {
  NORM=${1#\\}
  NORM=${NORM//\'/}
  NORM=${NORM//\"/}
  NORM=${NORM##*/}
}

# Words that can precede the real command without changing which command it is,
# together with their own options and operands: `sudo -u root pkill` runs
# `pkill`, not `-u`. Leaves the rest of the segment in STRIPPED, and sets
# VIA_XARGS when an `xargs` was among them (the operand then comes from stdin).
#
# The control keywords are on the list because `if cd /Users; then …` and
# `if pkill …; then …` are a `cd` and a `pkill` all the same. `env FOO=1 pkill`
# and `FOO=1 pkill` are the same command wearing different clothes, so a
# VAR=value word is skipped wherever it stands in the run. A shell is a wrapper
# only with a `-c` flag (alone or combined, `-lc`): `bash script.sh` runs a file
# this hook cannot read, and is judged as `bash`. `command -v` looks a name up
# instead of running it, so nothing after it is a command.
#
# Value-taking flags, short and long, are listed per wrapper so their value is
# skipped with them (`timeout -s KILL`, `sudo --user root`, `bash -o pipefail`);
# a value attached to its flag (`-oL`, `-c3`,
# `--signal=KILL`) is one word and needs no entry. `timeout` then takes a
# duration, and `chrt` a priority and `taskset` a mask, before the command.
strip_wrappers() {
  local -a w
  local n i vflags skip j found
  read -ra w <<< "$1"
  n=${#w[@]}
  i=0
  while [ "$i" -lt "$n" ]; do
    norm "${w[$i]}"
    vflags=
    skip=
    case "$NORM" in
      if|elif|while|until|then|do|else|'!'|'{'|eval|nohup|builtin)
        i=$((i + 1)); continue ;;
      command)
        case "${w[$((i + 1))]}" in -v|-V) STRIPPED=; return ;; esac ;;
      sudo)    vflags=' -u -g -C -D -h -p -r -t -U -R -T --user --group --close-from --chdir --host --prompt --role --type '
               vflags="$vflags--other-user --chroot --command-timeout " ;;
      doas)    vflags=' -u -C ' ;;
      exec)    vflags=' -a ' ;;
      env)     vflags=' -u -C -S --unset --chdir --split-string ' ;;
      nice)    vflags=' -n --adjustment ' ;;
      ionice)  vflags=' -c -n -p --class --classdata --pid ' ;;
      stdbuf)  vflags=' -i -o -e --input --output --error ' ;;
      timeout) vflags=' -s -k --signal --kill-after '; skip=duration ;;
      chrt|taskset) skip=operand ;;
      xargs)   vflags=' -I -L -n -P -s -d -E -a -J -R -S --replace --max-lines --max-args --max-procs --max-chars --delimiter '
               vflags="$vflags--arg-file --eof "; VIA_XARGS=1 ;;
      time|setsid) ;;
      sh|bash|zsh|dash|ksh)
        # `-o`/`-O` (and `+o`/`+O`) name an option in the next word, combined
        # or not (`-eo pipefail`), so that word is skipped with them.
        j=$((i + 1)); found=
        while [ "$j" -lt "$n" ]; do
          case "${w[$j]}" in
            --rcfile|--init-file) j=$((j + 2)) ;;
            --*) j=$((j + 1)) ;;
            [-+]*[oO])
              case "${w[$j]}" in -*c*) found=1 ;; esac
              j=$((j + 2)) ;;
            -*c*) found=1; j=$((j + 1)) ;;
            [-+]*) j=$((j + 1)) ;;
            *) break ;;
          esac
        done
        [ -n "$found" ] || break
        i=$j; continue ;;
      *)
        case "${w[$i]}" in
          -*) break ;;
          *=*) i=$((i + 1)); continue ;;
          *) break ;;
        esac ;;
    esac
    i=$((i + 1))
    while [ "$i" -lt "$n" ]; do
      case "${w[$i]}" in
        -*) case "$vflags" in *" ${w[$i]} "*) i=$((i + 2)) ;; *) i=$((i + 1)) ;; esac ;;
        *) break ;;
      esac
    done
    if [ "$i" -lt "$n" ]; then
      case "$skip" in
        duration) case "${w[$i]}" in [0-9]*|.[0-9]*) i=$((i + 1)) ;; esac ;;
        operand) i=$((i + 1)) ;;
      esac
    fi
  done
  STRIPPED=
  [ "$i" -lt "$n" ] && STRIPPED="${w[*]:$i}"
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
#
# An operand with an odd count of `"` or of `'` is a quoted pattern the splitter
# above tore at a `|`, `(`, `)`, `;` or `&` inside it — `"$PWD/x|vite"` arrives
# as `"$PWD/x` — so the text judged here is not the regex pkill would get. That
# is never anchored. A pattern with a space was already refused (its second
# word is not `/…`), so the count costs no allowed case. An operand with a
# backslash is refused for the same reason: `\|` and `\"` reach the same
# alternation with every quote count even, and an absolute path under the cwd
# has no reason to carry one.
#
# `$PWD` stands for the session's cwd only while nothing earlier in the same
# command moved directory: `cd /Users && pkill -f "$PWD/"` is `pkill -f
# "/Users/"`. MOVED is set by the main loop on a `cd`/`pushd`/`popd` segment.
anchored_to_cwd() {
  for tok in $1; do
    dq=$(printf '%s' "$tok" | tr -cd '"' | wc -c)
    sq=$(printf '%s' "$tok" | tr -cd "'" | wc -c)
    [ $((dq % 2)) -eq 0 ] && [ $((sq % 2)) -eq 0 ] || return 1
    case "$tok" in *\\*) return 1 ;; esac
    clean=$(printf '%s' "$tok" | tr -d '"'\''')
    case "$clean" in
      '$PWD'/*|'${PWD}'/*) [ -z "$MOVED" ] || return 1 ;;
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

MOVED=
while IFS= read -r segment; do
  [ -n "$segment" ] || continue
  VIA_XARGS=
  strip_wrappers "$segment"
  segment=$STRIPPED
  norm "$(printf '%s' "$segment" | awk '{print $1}')"
  verb=$NORM
  case "$verb" in
    pkill|killall) ;;
    cd|pushd|popd) MOVED=1; continue ;;
    *) continue ;;
  esac

  # No operand, nothing to match on, nothing dies — both tools exit on their own
  # usage message. Passing those over is not leniency, it is what keeps prose
  # usable: backtick is a segment separator above (it opens a command
  # substitution), so every markdown sentence that mentions `pkill` or writes
  # `pkill -f` in inline code arrives here looking exactly like a command. This
  # change's own commit message and documentation both tripped the guard before
  # this branch existed. Behind `xargs` the pass does not apply: the pattern
  # arrives on stdin, so `… | xargs pkill -f` is a real kill with no operand.
  OPERANDS=$(operands_of "$segment")
  [ -n "$OPERANDS" ] || [ -n "$VIA_XARGS" ] || continue

  if [ "$verb" = "pkill" ] && [ -n "$OPERANDS" ] && anchored_to_cwd "$OPERANDS"; then
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
  pkill -f \"\$PWD/node_modules/.bin/vite\"
\$PWD is not accepted after a \`cd\` (or \`pushd\`/\`popd\`) earlier in the same command —
write the literal path under $CWD instead — and the pattern must not contain a \`|\`."
done <<EOF
$SEGMENTS
EOF

exit 0
