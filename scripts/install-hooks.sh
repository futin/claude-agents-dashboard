#!/bin/bash
# install-hooks.sh — wire this repo's six Claude Code hooks into the user's
# own ~/.claude, so a teammate gets remote answers, remote plans, remote
# replies, permission notices, the away-mode injection and the broad-kill guard
# with one command instead of six symlinks and eight settings entries copied out
# of five docs.
#
# Registration is USER-GLOBAL on purpose, and that is the whole reason this is
# an installer rather than a checked-in `.claude/settings.json`. The dashboard
# scans every project under ~/.claude/projects, so a session in any repo is
# worth a reply window; project-scoped hooks would fire only for sessions
# started in this one and silently drop the rest. kill-guard makes the same
# argument from the opposite end: the session that kills this repo's dev server
# is running somewhere else, so a guard installed only here guards nothing.
#
# Symlinks, never copies: `git pull` then updates the hooks in place, which is
# the property the five setup docs have always relied on.
#
# Usage:
#   scripts/install-hooks.sh              install (idempotent — safe to re-run)
#   scripts/install-hooks.sh --dry-run    print what would change, touch nothing
#   scripts/install-hooks.sh --uninstall  remove this repo's links + entries
#   scripts/install-hooks.sh --force      replace a real file sitting on a link
#                                         path, and a token file that disagrees
#                                         with .env (both are left alone without it)
#
# Requires: jq (the settings merge), curl (the hooks themselves), and a
# `pnpm install` — .env is read through node_modules/.bin/tsx, never by grep.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HOOK_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"
TOKEN_FILE="$HOOK_DIR/dashboard-token"

DRY=false
UNINSTALL=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=true ;;
    --uninstall) UNINSTALL=true ;;
    --force) FORCE=true ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;   # the header block above, through Requires
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v jq > /dev/null 2>&1 || { echo "jq is required (brew install jq)" >&2; exit 1; }

say()  { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------- the manifest
#
# One row per symlink: <repo script>|<installed name>. The installed names are
# the ones the five setup docs and every hook's own install comment already
# use; changing one orphans an existing install rather than upgrading it.
LINKS="
ask-remote-hook.sh|ask-remote.sh
plan-remote-hook.sh|plan-remote.sh
permission-notify-hook.sh|permission-notify.sh
stop-notify-hook.sh|stop-notify.sh
remote-decision-hook.sh|remote-decision.sh
kill-guard-hook.sh|kill-guard.sh
"

# One row per settings entry: <event>|<matcher>|<installed name>|<timeout>.
# The matcher may itself contain `|` (it is a regex alternation), so a row is
# split from both ends: event is the first field, name and timeout the last two,
# and the matcher is everything in between.
# The 630s timeouts are not arbitrary: they must exceed the dashboard's answer
# window (600s default), or the CLI kills the hook mid-hold. permission-notify appears
# twice because PermissionRequest is the live signal and Notification is the
# legacy fallback — both are wanted, and they are separate registrations.
#
# remote-decision appears twice too: UserPromptSubmit prints its banner once per
# session, and SessionStart re-prints it after compaction, resume or /clear, when
# the earlier copy may have left the context.
#
# kill-guard is the odd one out: every other hook here exists to get a question
# to the user's phone, while that one exists to keep this repo's own dev server
# alive when a session in some OTHER repo reaches for `pkill`. It is installed
# by the same command for the same reason all of them are user-global — the
# sessions it has to answer for are, by definition, not running here.
ENTRIES="
PreToolUse|AskUserQuestion|ask-remote.sh|630
PreToolUse|Bash|kill-guard.sh|5
PermissionRequest|ExitPlanMode|plan-remote.sh|630
PermissionRequest||permission-notify.sh|5
Notification||permission-notify.sh|5
Stop||stop-notify.sh|630
UserPromptSubmit||remote-decision.sh|5
SessionStart|compact|resume|clear|remote-decision.sh|5
"

# ------------------------------------------------------------------- symlinks

link_one() {
  src="$REPO/scripts/$1"
  dest="$HOOK_DIR/$2"
  [ -f "$src" ] || { step "MISSING in repo, skipped: scripts/$1"; return 1; }

  if [ -L "$dest" ]; then
    current="$(readlink "$dest")"
    if [ "$current" = "$src" ]; then step "ok        $2"; return 0; fi
    step "relink   $2  (was -> $current)"
  elif [ -e "$dest" ]; then
    # A real file, not a link: someone copied a hook here, possibly edited it.
    # Never silently discard that.
    if [ "$FORCE" != "true" ]; then
      step "SKIPPED  $2 — a real file is there, not a symlink. Re-run with --force to replace it."
      return 1
    fi
    step "replace  $2  (real file, --force)"
  else
    step "link     $2"
  fi

  [ "$DRY" = "true" ] && return 0
  ln -sfn "$src" "$dest"
}

unlink_one() {
  dest="$HOOK_DIR/$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$REPO/scripts/$1" ]; then
    step "remove   $2"
    [ "$DRY" = "true" ] || rm -f "$dest"
  else
    step "left     $2 (not ours)"
  fi
}

# ------------------------------------------------------------------- settings
#
# Idempotency key is the command string. An entry already present is left
# exactly as it is — including a timeout the user has tuned by hand, which is
# theirs to keep and not ours to reset on every re-run.

settings_json() {
  if [ -s "$SETTINGS" ]; then cat "$SETTINGS"; else echo '{}'; fi
}

# The script runs under `set -u` alone, so a failed jq stops nothing by itself: on a malformed file it used to print nothing, the empty string passed the
# old `jq empty` write guard, and settings.json was replaced by a newline — every user key gone, and every re-run wrote the newline again (#507). Hence
# three refusals, all before anything is written: the file is checked up front, every row's jq exit code is read, and the write guard wants one object.
#
# Slurped (`-s`), because plain `jq -e` reads a stream and judges only its last value: two concatenated objects (a snippet pasted after the original)
# would pass and be rewritten as two. A whitespace-only file slurps to `[]` and is refused too — it is what the old bug left behind, not an empty config.
ONE_OBJECT='length == 1 and (.[0] | type) == "object"'

refuse() {
  echo "REFUSED  $SETTINGS — $1" >&2
  echo "         settings.json was not written and no backup was made. Fix the file and re-run." >&2
  exit 1
}

# The token is a bearer secret, so it is never written where another local user could read it, not even for a moment. A plain `> "$TOKEN_FILE" && chmod
# 600` did exactly that (#569): a new file was born at the umask's 0644 until the chmod ran, `--force` truncated an existing 0644 inode and refilled it, and
# a failed chmod was silent. Instead: write into a temp file in the same directory (0600 from birth — mktemp's own default, and umask 077 so that does not
# rest on one tool), rename it over the target (a new inode, so an old file's mode goes with the old file), then check the result is exactly 0600. `find
# -perm 600` is an exact match on both BSD and GNU, where `stat`'s flags differ. Any failure stops the run with a FAILED line and leaves no readable file.
token_failed() {
  [ -n "${tok_tmp:-}" ] && rm -f "$tok_tmp"
  echo "FAILED   could not write $TOKEN_FILE privately — $1" >&2
  echo "         Earlier steps are idempotent: fix the cause and re-run." >&2
  exit 1
}

write_token() {
  tok_tmp="$( (umask 077; mktemp "$HOOK_DIR/.dashboard-token.XXXXXX") 2>/dev/null )" || { tok_tmp=""; token_failed "mktemp in $HOOK_DIR failed"; }
  printf '%s' "$1" > "$tok_tmp" || token_failed "writing the temp file failed"
  mv -f "$tok_tmp" "$TOKEN_FILE" || token_failed "renaming the temp file into place failed"
  tok_tmp=""
  if [ -z "$(find "$TOKEN_FILE" -prune -perm 600 2>/dev/null)" ]; then
    rm -f "$TOKEN_FILE"
    token_failed "it did not end up mode 0600, so it was removed"
  fi
}

check_settings() {
  [ -s "$SETTINGS" ] || return 0
  jq -s -e "$ONE_OBJECT" "$SETTINGS" > /dev/null 2>&1 \
    || refuse "it is not exactly one JSON object (a trailing comma from a hand edit, say). \`jq . \"$SETTINGS\"\` shows where."
}

# A valid object can still hold a hooks block jq cannot walk — `"Stop": "oops"`, or a string where a hook object belongs. jq then exits 5 with no output.
merge_failed() {
  refuse "jq could not read its hooks block while merging $1 (a value that is not the list or object Claude Code expects). \`jq .hooks \"$SETTINGS\"\` shows it."
}

# The literal `$HOME` (unexpanded — the CLI expands it) is what every existing
# install and all five docs already carry, so keeping the string byte-identical
# is what makes a re-run recognise an entry instead of adding a second one. A
# custom CLAUDE_CONFIG_DIR has no such history, so that case spells the path out.
entry_cmd() {
  if [ "$CLAUDE_DIR" = "$HOME/.claude" ]; then
    printf 'bash "$HOME/.claude/hooks/%s"' "$1"
  else
    printf 'bash "%s/%s"' "$HOOK_DIR" "$1"
  fi
}

add_entry() {
  ev="$1"; matcher="$2"; cmd="$3"; timeout="$4"
  jq --arg ev "$ev" --arg m "$matcher" --arg cmd "$cmd" --argjson to "$timeout" '
    .hooks //= {}
    | .hooks[$ev] //= []
    | if any(.hooks[$ev][]; (.matcher // "") == $m and any(.hooks[]?; .command == $cmd))
      then .
      elif any(.hooks[$ev][]; (.matcher // "") == $m)
      then .hooks[$ev] |= map(
             if (.matcher // "") == $m
             then .hooks += [{type: "command", command: $cmd, timeout: $to}]
             else . end)
      else .hooks[$ev] += [
             if $m == ""
             then {hooks: [{type: "command", command: $cmd, timeout: $to}]}
             else {matcher: $m, hooks: [{type: "command", command: $cmd, timeout: $to}]}
             end]
      end
  '
}

drop_entry() {
  cmd="$1"
  jq --arg cmd "$cmd" '
    if .hooks then
      .hooks |= with_entries(
        .value |= (map(.hooks |= map(select(.command != $cmd)))
                   | map(select((.hooks | length) > 0))))
      | .hooks |= with_entries(select((.value | length) > 0))
    else . end
  '
}

# Presence is per (event, matcher, command) — the same triple add_entry keys on,
# and NOT a search for the command anywhere in the file. permission-notify.sh is
# registered twice on purpose (PermissionRequest live, Notification legacy), so a
# command-only test finds the first one and silently skips the second.
#
# It and has_entry return jq's own exit code: 0 present, 1 absent, anything else an error the caller must not read as "absent".
entry_present() {
  jq -e --arg ev "$1" --arg m "$2" --arg cmd "$3" '
    any((.hooks[$ev] // [])[]; (.matcher // "") == $m and any(.hooks[]?; .command == $cmd))
  ' > /dev/null 2>&1
}

# Uninstall is command-scoped on purpose: it strips our command from wherever it
# was registered, including a hand-added extra event we never wrote.
has_entry() {
  settings_json | jq -e --arg cmd "$1" '
    [.hooks // {} | .[]? | .[]? | .hooks[]? | .command] | index($cmd) != null
  ' > /dev/null 2>&1
}

write_settings() {
  new="$1"
  printf '%s' "$new" | jq -s -e "$ONE_OBJECT" > /dev/null 2>&1 || refuse "the merged result is not one JSON object, so it was not written."
  if [ "$DRY" = "true" ]; then return 0; fi
  tmp="$SETTINGS.tmp.$$"
  # settings.json often carries tokens in its `env` block, so the rename must not loosen a 0600 file to the umask's 0644 (#599). The temp file starts as a
  # `cp -p` of the original, so the truncating write below keeps the original's mode; with no original it is born under umask 077, 0600. A read-only
  # original (0444, locked against edits) gets u+w for the write and loses it again before the rename, so the lock survives too.
  readonly_orig=false
  if [ -e "$SETTINGS" ]; then
    [ -w "$SETTINGS" ] || readonly_orig=true
    { cp -p "$SETTINGS" "$tmp" && chmod u+w "$tmp"; } || { rm -f "$tmp"; refuse "could not copy $SETTINGS to $tmp, so it was not written."; }
  else
    (umask 077; : > "$tmp") || { rm -f "$tmp"; refuse "could not create $tmp, so $SETTINGS was not written."; }
  fi
  if [ -s "$SETTINGS" ]; then cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"; fi
  if ! { printf '%s\n' "$new" > "$tmp" && { [ "$readonly_orig" = false ] || chmod u-w "$tmp"; } && mv "$tmp" "$SETTINGS"; }; then
    rm -f "$tmp"
    echo "FAILED   $SETTINGS — the merged file could not be written or renamed into place; settings.json is as it was." >&2
    exit 1
  fi
}

# ----------------------------------------------------------------------- main

say ""
if [ "$UNINSTALL" = "true" ]; then
  say "Removing this repo's hooks from $CLAUDE_DIR"
else
  say "Installing this repo's hooks into $CLAUDE_DIR"
fi
say "  repo: $REPO"
[ "$DRY" = "true" ] && say "  (dry run — nothing will be written)"
say ""

# The settings merge is worked out before any link is made, so every refusal above lands on an untouched install: a refused --uninstall that had already
# removed the links would leave entries pointing at nothing. Its lines are held in $plan and printed in their usual place, after hooks/.
check_settings
current="$(settings_json)"
changed=false
plan=""
plan_step() { plan="$plan  $*
"; }
while IFS= read -r row; do
  [ -n "${row:-}" ] || continue
  timeout="${row##*|}"; row="${row%|*}"
  name="${row##*|}";    row="${row%|*}"
  ev="${row%%|*}";      matcher="${row#*|}"
  cmd="$(entry_cmd "$name")"
  if [ "$UNINSTALL" = "true" ]; then
    has_entry "$cmd"; rc=$?
    if [ "$rc" -eq 0 ]; then
      plan_step "remove   $ev${matcher:+ ($matcher)} -> $name"
      current="$(printf '%s' "$current" | drop_entry "$cmd")" || merge_failed "$name"
      changed=true
    elif [ "$rc" -ne 1 ]; then
      merge_failed "$name"
    fi
  else
    printf '%s' "$current" | entry_present "$ev" "$matcher" "$cmd"; rc=$?
    if [ "$rc" -eq 0 ]; then
      plan_step "ok        $ev${matcher:+ ($matcher)} -> $name"
    elif [ "$rc" -eq 1 ]; then
      plan_step "add      $ev${matcher:+ ($matcher)} -> $name (timeout ${timeout}s)"
      current="$(printf '%s' "$current" | add_entry "$ev" "$matcher" "$cmd" "$timeout")" || merge_failed "$name"
      changed=true
    else
      merge_failed "$name"
    fi
  fi
done <<EOF
$ENTRIES
EOF

say "hooks/"
[ "$DRY" = "true" ] || mkdir -p "$HOOK_DIR"
echo "$LINKS" | while IFS='|' read -r src dest; do
  [ -n "${src:-}" ] || continue
  if [ "$UNINSTALL" = "true" ]; then unlink_one "$src" "$dest"; else link_one "$src" "$dest"; fi
done

say ""
say "settings.json"
printf '%s' "$plan"
if [ "$changed" = "true" ]; then
  write_settings "$current"
  [ "$DRY" = "true" ] || step "written (previous copy kept as settings.json.bak.<stamp>)"
else
  step "no changes needed"
fi

# ------------------------------------------------------ token + environment notes
#
# The token is per-person and must never be committed: it is the shared secret
# that gates every write endpoint. If this checkout has one in .env we offer to
# reuse it; otherwise the user is told where it goes rather than left to find
# out when a hook silently 401s.
#
# .env is read by scripts/env-value.ts, NOT by a grep here, and that is the
# point. This block used to run its own
# `grep -E '^ANSWER_TOKEN=' | head -1 | cut -d= -f2- | tr -d "\"' \r"`, which
# disagreed with the server's `parseEnv` on a leading space (saw nothing, and
# reported "no ANSWER_TOKEN in .env" for a token that was plainly there), on the
# spaces inside a quoted value, and on a duplicated key. Every disagreement
# wrote no token file or a wrong one, and the hooks then 403'd in silence for
# twelve hours (backlog bug-6). One reader, one answer.

say ""
if [ "$UNINSTALL" != "true" ]; then
  say "token"

  # tsx is the devDependency every pnpm script in this repo already runs
  # through, so this adds no dependency — but a checkout with no `pnpm install`
  # has no binary to call. Say that outright. Falling back to a grep, or letting
  # a missing binary re-enter the "no ANSWER_TOKEN" branch below, would recreate
  # the exact bug: reporting no token for a token that exists.
  #
  # env-value's stderr is CAPTURED, not discarded, and two separate things
  # depend on it:
  #
  #   1. Which source won. env-value mirrors loadConfig's precedence, so an
  #      exported ANSWER_TOKEN beats the file. Printing ".env" regardless would
  #      write the shell's token while claiming it came from the checkout, and
  #      send anyone reading the `warn` line to edit a .env that may already
  #      match byte for byte.
  #   2. Whether it ran at all. node exits 1 for an uncaught error and
  #      env-value exits 1 for "unset", so the CODE CANNOT SEPARATE THEM. Only
  #      the `unset` marker on stderr can. Without that check a half-installed
  #      node_modules — tsx present, so past the -x guard, but failing to
  #      import — prints "no ANSWER_TOKEN in .env" for a token that is plainly
  #      there, which is the sentence this whole bug is named after.
  #
  # See the stderr contract in scripts/env-value.ts.
  TSX="$REPO/node_modules/.bin/tsx"
  envtok=""; envsrc=""; envmsg=""; envrc=0
  envstate="notsx"
  if [ -x "$TSX" ]; then
    # stderr to a temp file so it can be read separately; the VALUE only ever
    # travels through the command substitution, never through the file.
    errfile="$(mktemp)"
    envtok="$("$TSX" "$REPO/scripts/env-value.ts" ANSWER_TOKEN --env "$REPO/.env" 2> "$errfile")"
    envrc=$?
    envmsg="$(cat "$errfile")"
    rm -f "$errfile"
    envsrc="$(printf '%s\n' "$envmsg" | sed -n 's/^env-value: ANSWER_TOKEN from //p' | tail -1)"
    if [ "$envrc" -eq 0 ] && [ -n "$envtok" ] && [ -n "$envsrc" ]; then
      envstate="ok"
    elif [ "$envrc" -eq 1 ] && printf '%s\n' "$envmsg" | grep -q '^env-value: ANSWER_TOKEN unset'; then
      envstate="unset"
      envtok=""
    else
      envstate="broken"
      envtok=""
    fi
  fi

  # Name the source that actually won, in every line below that mentions one.
  if [ "$envsrc" = "process.env" ]; then
    srclabel="the ANSWER_TOKEN exported in this shell"
  else
    srclabel="this checkout's .env ANSWER_TOKEN"
  fi

  if [ "$envstate" = "notsx" ]; then
    step "TODO     run pnpm install first, then re-run — .env cannot be read"
    step "         without $TSX, and guessing at it is what broke this before."
  elif [ "$envstate" = "broken" ]; then
    # Deliberately NOT the "no ANSWER_TOKEN" branch: the reader failed, so
    # nothing is known about whether a token exists, and saying "no token" here
    # is the original bug wearing a new hat.
    step "TODO     could not read ANSWER_TOKEN — scripts/env-value.ts exited $envrc"
    step "         without saying the key was unset. This is NOT \"no token set\":"
    step "         nothing is known either way, and $TOKEN_FILE is left as it is."
    if [ -n "$envmsg" ]; then
      step "         it said: $(printf '%s\n' "$envmsg" | head -1)"
    fi
    step "         Try: $TSX $REPO/scripts/env-value.ts ANSWER_TOKEN --env $REPO/.env"
  elif [ -L "$TOKEN_FILE" ] && [ ! -e "$TOKEN_FILE" ]; then
    # A link to a secret that is not there yet (a mount not attached). `-f` follows the link, so without this branch the first-install write below
    # would rename a regular file over the link — the same swap the --force branch refuses.
    step "warn     $TOKEN_FILE is a symlink to a missing file (-> $(readlink "$TOKEN_FILE"))."
    step "         Left alone: the hooks send no token until it resolves."
  elif [ ! -f "$TOKEN_FILE" ] && [ "$envstate" = "ok" ]; then
    step "write    $TOKEN_FILE from $srclabel"
    [ "$DRY" = "true" ] || write_token "$envtok"
  elif [ ! -f "$TOKEN_FILE" ]; then
    # No token anywhere is fine: the hooks reach the dashboard on loopback, which the write gate always trusts. A container or a non-loopback
    # CLAUDE_DASHBOARD_URL is the case that still needs one (docs/subsystems/remote-access.md).
    step "ok       no token file needed — hooks reach the dashboard on loopback (set ANSWER_TOKEN only for a container or a non-loopback CLAUDE_DASHBOARD_URL)"
  elif [ "$envstate" != "ok" ]; then
    step "ok       $TOKEN_FILE already exists (left alone)"
  else
    # The file exists AND .env has a value, so the two can be compared — which
    # is the other half of bug-6: presence alone used to be reported as `ok`
    # forever, so a token file that was wrong (copied from another machine, or
    # written by the old grep) was never once questioned by a re-run.
    #
    # Byte-wise: the `; printf x` / `%x` dance keeps the trailing bytes that
    # `$(cat …)` would strip, and a stray newline at the end of the file is a
    # real mismatch — the server compares the header string exactly.
    filetok="$(cat "$TOKEN_FILE"; printf x)"; filetok="${filetok%x}"
    if [ "$filetok" = "$envtok" ]; then
      step "ok       $TOKEN_FILE already exists and matches $srclabel"
    elif [ "$FORCE" = "true" ] && [ -L "$TOKEN_FILE" ]; then
      # Someone pointed the token file at a secret kept elsewhere (a mounted volume, say). Renaming over it would quietly swap that link for a
      # copy, so --force leaves it to whoever made it.
      step "warn     $TOKEN_FILE is a symlink (-> $(readlink "$TOKEN_FILE")) and differs from $srclabel."
      step "         Left alone even with --force: update the file it points at by hand."
    elif [ "$FORCE" = "true" ]; then
      step "write    $TOKEN_FILE replaced from $srclabel (--force)"
      [ "$DRY" = "true" ] || write_token "$envtok"
    else
      # Never overwritten without --force, and neither value is printed, not
      # even a prefix. A deliberately different per-machine token is legitimate
      # — clobbering one would be a worse bug than the one being fixed here.
      #
      # $srclabel, not a hardcoded ".env": if the value came from an exported
      # ANSWER_TOKEN, telling the user to go and edit .env is advice that
      # changes nothing, since .env may match this file exactly.
      step "warn     $TOKEN_FILE differs from $srclabel."
      step "         Left alone. If $srclabel is the one you want, re-run with --force,"
      step "         or: rm -f $TOKEN_FILE && (umask 077; printf '%s' \"\$ANSWER_TOKEN\" > $TOKEN_FILE)"
    fi
    unset filetok
  fi
  unset envtok envsrc envmsg envrc envstate srclabel

  say ""
  say "notes"
  case "$(uname -s)" in
    Darwin) : ;;
    *) step "$(uname -s): the at-desk gate reads idle time via ioreg, which is macOS-only."
       step "         Idle is unreadable here, which counts as \"at the desk\" — questions,"
       step "         plans and the turn-end reply window all stay in the terminal."
       step "         Set Settings › Away after to 0 (or CLAUDE_DASHBOARD_IDLE_SECS=0) to"
       step "         make questions and plans always wait for the dashboard — but then"
       step "         every turn end is also held for the Answer window (600s default),"
       step "         and coming back to the keyboard does not release it." ;;
  esac
  step "The hooks talk to \$CLAUDE_DASHBOARD_URL, default http://127.0.0.1:4173."
  step "Serving on another port (a dev 5174, say)? Export it, or they no-op."
  step "Remote answering has to be ON in the dashboard — on by default; REMOTE_ANSWER=false or the toggle turns it off."
fi

say ""
say "done."
