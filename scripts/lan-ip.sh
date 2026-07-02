#!/bin/sh
# Prints this machine's LAN IP (best-effort, cross-platform).
# Used to pass the *host's* real address into the dev container, since Vite
# running inside Docker only sees the container's own bridge interface.

if command -v ipconfig >/dev/null 2>&1; then
  # macOS
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null
elif command -v ip >/dev/null 2>&1; then
  # Linux
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}'
else
  hostname -I 2>/dev/null | awk '{print $1}'
fi
