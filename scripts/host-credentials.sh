#!/bin/sh
# Prints the CLI's stored OAuth credentials blob (macOS Keychain), for passing
# into the Docker container as CLAUDE_CREDENTIALS_JSON — the container has no
# `security` binary and can't reach the host Keychain itself. Best-effort:
# empty output (non-macOS, no Keychain item, access denied) is fine, usage.ts
# fails open and falls back to the ~/.claude/.credentials.json volume mount.

if command -v security >/dev/null 2>&1; then
  security find-generic-password -a "$(whoami)" -w -s "Claude Code-credentials" 2>/dev/null
fi
