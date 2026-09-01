#!/bin/bash
# install-hooks.sh — wire this repo's five Claude Code hooks into the user's
# own ~/.claude, so a teammate gets remote answers, remote plans, remote
# replies, permission notices and the away-mode injection with one command
# instead of six symlinks and six settings entries copied out of five docs.
#
# Registration is USER-GLOBAL on purpose, and that is the whole reason this is
# an installer rather than a checked-in `.claude/settings.json`. The dashboard
# scans every project under ~/.claude/projects, so a session in any repo is
# worth a reply window; project-scoped hooks would fire only for sessions
# started in this one and silently drop the rest.
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
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;   # the header block above, through Requires
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
"

# One row per settings entry: <event>|<matcher>|<installed name>|<timeout>.
# The 630s timeouts are not arbitrary: they must exceed the dashboard's answer
# window (≤600s), or the CLI kills the hook mid-hold. permission-notify appears
# twice because PermissionRequest is the live signal and Notification is the
# legacy fallback — both are wanted, and they are separate registrations.
ENTRIES="
PreToolUse|AskUserQuestion|ask-remote.sh|630
PermissionRequest|ExitPlanMode|plan-remote.sh|630
PermissionRequest||permission-notify.sh|5
Notification||permission-notify.sh|5
Stop||stop-notify.sh|630
UserPromptSubmit||remote-decision.sh|5
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
  printf '%s' "$new" | jq empty 2>/dev/null || { echo "refusing to write malformed settings.json" >&2; exit 1; }
  if [ "$DRY" = "true" ]; then return 0; fi
  if [ -s "$SETTINGS" ]; then cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"; fi
  tmp="$SETTINGS.tmp.$$"
  printf '%s\n' "$new" > "$tmp" && mv "$tmp" "$SETTINGS"
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

say "hooks/"
[ "$DRY" = "true" ] || mkdir -p "$HOOK_DIR"
echo "$LINKS" | while IFS='|' read -r src dest; do
  [ -n "${src:-}" ] || continue
  if [ "$UNINSTALL" = "true" ]; then unlink_one "$src" "$dest"; else link_one "$src" "$dest"; fi
done

say ""
say "settings.json"
current="$(settings_json)"
changed=false
while IFS='|' read -r ev matcher name timeout; do
  [ -n "${ev:-}" ] || continue
  cmd="$(entry_cmd "$name")"
  if [ "$UNINSTALL" = "true" ]; then
    if has_entry "$cmd"; then
      step "remove   $ev${matcher:+ ($matcher)} -> $name"
      current="$(printf '%s' "$current" | drop_entry "$cmd")"
      changed=true
    fi
  else
    if printf '%s' "$current" | entry_present "$ev" "$matcher" "$cmd"; then
      step "ok        $ev${matcher:+ ($matcher)} -> $name"
    else
      step "add      $ev${matcher:+ ($matcher)} -> $name (timeout ${timeout}s)"
      current="$(printf '%s' "$current" | add_entry "$ev" "$matcher" "$cmd" "$timeout")"
      changed=true
    fi
  fi
done <<EOF
$ENTRIES
EOF

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
  TSX="$REPO/node_modules/.bin/tsx"
  envtok=""
  if [ -x "$TSX" ]; then
    envtok="$("$TSX" "$REPO/scripts/env-value.ts" ANSWER_TOKEN --env "$REPO/.env" 2> /dev/null)" || envtok=""
  fi

  if [ ! -x "$TSX" ]; then
    step "TODO     run pnpm install first, then re-run — .env cannot be read"
    step "         without $TSX, and guessing at it is what broke this before."
  elif [ ! -f "$TOKEN_FILE" ] && [ -n "$envtok" ]; then
    step "write    $TOKEN_FILE from this checkout's .env ANSWER_TOKEN"
    if [ "$DRY" != "true" ]; then
      printf '%s' "$envtok" > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE"
    fi
  elif [ ! -f "$TOKEN_FILE" ]; then
    step "TODO     no ANSWER_TOKEN in .env — set one, then:"
    step "         printf '%s' \"\$ANSWER_TOKEN\" > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
  elif [ -z "$envtok" ]; then
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
      step "ok       $TOKEN_FILE already exists and matches .env"
    elif [ "$FORCE" = "true" ]; then
      step "write    $TOKEN_FILE replaced from .env ANSWER_TOKEN (--force)"
      if [ "$DRY" != "true" ]; then
        printf '%s' "$envtok" > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE"
      fi
    else
      # Never overwritten without --force, and neither value is printed, not
      # even a prefix. A deliberately different per-machine token is legitimate
      # — clobbering one would be a worse bug than the one being fixed here.
      step "warn     $TOKEN_FILE differs from this checkout's .env ANSWER_TOKEN."
      step "         Left alone. If .env is the one you want, re-run with --force,"
      step "         or: printf '%s' \"\$ANSWER_TOKEN\" > $TOKEN_FILE && chmod 600 $TOKEN_FILE"
    fi
    unset filetok
  fi
  unset envtok

  say ""
  say "notes"
  case "$(uname -s)" in
    Darwin) : ;;
    *) step "$(uname -s): the at-desk gate reads idle time via ioreg, which is macOS-only."
       step "         Idle is unreadable here, which fails to \"at the desk\" — questions and"
       step "         plans still travel, but a turn-end reply window never opens." ;;
  esac
  step "The hooks talk to \$CLAUDE_DASHBOARD_URL, default http://127.0.0.1:4173."
  step "Serving on another port (a dev 5174, say)? Export it, or they no-op."
  step "Remote answering also has to be ON in the dashboard — it is off by default."
fi

say ""
say "done."
