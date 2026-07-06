#!/bin/sh
# Prints this machine's LAN IP (best-effort, cross-platform).
# Used to pass the *host's* real address into the dev container, since Vite
# running inside Docker only sees the container's own bridge interface.

if command -v ipconfig >/dev/null 2>&1; then
  # macOS. Resolve the interface backing the default route rather than
  # hardcoding en0/en1 — the active LAN interface can be ethernet, a dock,
  # or a USB adapter (en2/en5/…), and DHCP can reassign the address. Fall
  # back to the en0/en1 scan if the route lookup yields nothing.
  iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  { [ -n "$iface" ] && ipconfig getifaddr "$iface" 2>/dev/null; } \
    || ipconfig getifaddr en0 2>/dev/null \
    || ipconfig getifaddr en1 2>/dev/null
elif command -v ip >/dev/null 2>&1; then
  # Linux
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}'
else
  hostname -I 2>/dev/null | awk '{print $1}'
fi
