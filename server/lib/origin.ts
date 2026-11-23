/**
 * origin.ts — classify how a client reached the dashboard: loopback, the local
 * network, a Tailscale tailnet, or somewhere off-network.
 *
 * Two consumers read the same answer: the toolbar badge (`GET /api/health`
 * `origin`) and the write gate in `server/api.ts`, which trusts `local` and,
 * behind the `trustTailnet` setting, `tailnet` (docs/subsystems/remote-access.md).
 * Because the gate depends on it, {@link resolvePeer} trusts only what a remote
 * client cannot author: the socket address, and the `X-Forwarded-For` entries
 * that loopback proxies on this machine appended, walked from the right. The
 * `Host` header is read too, but it can only take `local` away, never grant it.
 *
 * ⚠️ Never take the left-most forwarded entry. The client writes that one itself,
 * and a proxy only appends — so a left-to-right reader returns whatever verdict the
 * caller asks for.
 *
 * Pure and zero-dep, like the rest of `server/lib`: no `tailscale` binary, no
 * network, no config; the one read of the machine is `os.hostname()` at load. With Tailscale absent the tailnet branches simply never
 * match and every client reads `local` or `lan`.
 */

import type { IncomingHttpHeaders } from 'node:http';
import os from 'node:os';

import type { ConnectionOrigin } from '../../shared/types.js';
import { hostname as hostOf } from './request-guard.js';

/** Tailscale's IPv6 ULA range is fd7a:115c:a1e0::/48 — the first three hextets. */
const TAILSCALE_V6 = ['fd7a', '115c', 'a1e0'];

/**
 * Lower-case, unbracket, drop any `%zone` suffix, and unwrap IPv4-mapped IPv6
 * (`::ffff:192.168.1.9` → `192.168.1.9`), which is the form Node reports on a
 * dual-stack socket. Returns '' for anything unusable.
 */
export function normalizeAddress(addr: string | undefined): string {
  if (typeof addr !== 'string') return '';
  let s = addr.trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('[')) s = s.slice(1);
  const close = s.indexOf(']');
  if (close >= 0) s = s.slice(0, close);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) s = mapped[1];
  return s;
}

/** Four dotted octets, each 0-255. */
function ipv4Parts(s: string): number[] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every(n => n >= 0 && n <= 255) ? parts : null;
}

/** Rough IPv6 shape — hex groups and colons, at least one `:`. */
function isIpv6(s: string): boolean {
  return s.includes(':') && /^[0-9a-f:]+$/.test(s) && !s.includes(':::');
}

/** True when `addr` looks like an address we could classify at all. */
export function isIpish(addr: string | undefined): boolean {
  const s = normalizeAddress(addr);
  return !!s && (ipv4Parts(s) !== null || isIpv6(s));
}

/**
 * Expand an IPv6 address to its full 8 hextets so prefix comparisons are exact
 * (`fd7a:115c:a1e0::1` and `fd7a:115c:a1e0:ab12::4` must both match the /48).
 * Returns null when the address isn't IPv6-shaped.
 */
function hextets(s: string): string[] | null {
  if (!isIpv6(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const gap = 8 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...Array(gap).fill('0'), ...tail];
}

/**
 * Classify a single address.
 *
 * ⚠️ Order is load-bearing: Tailscale's IPv6 range sits *inside* the generic
 * ULA space (fc00::/7), so the tailnet check must run before the LAN check or
 * every tailnet client would be reported as `lan`.
 */
export function classifyAddress(addr: string | undefined): ConnectionOrigin {
  const s = normalizeAddress(addr);
  if (!s) return 'unknown';

  const v4 = ipv4Parts(s);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'local';
    // Tailscale hands out from the CGNAT range 100.64.0.0/10.
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
    if (a === 10) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    if (a === 169 && b === 254) return 'lan';
    return 'unknown';
  }

  const v6 = hextets(s);
  if (!v6) return 'unknown';
  if (v6.every((h, i) => (i < 7 ? Number.parseInt(h, 16) === 0 : Number.parseInt(h, 16) === 1))) {
    return 'local';
  }
  if (TAILSCALE_V6.every((h, i) => Number.parseInt(v6[i], 16) === Number.parseInt(h, 16))) {
    return 'tailnet';
  }
  const first = Number.parseInt(v6[0], 16);
  if (Number.isNaN(first)) return 'unknown';
  // fe80::/10 link-local, then the rest of the ULA space fc00::/7.
  if (first >= 0xfe80 && first <= 0xfebf) return 'lan';
  if (first >= 0xfc00 && first <= 0xfdff) return 'lan';
  return 'unknown';
}

/**
 * The peer a request came from, as far as this machine can vouch for it.
 *
 * A non-loopback socket is the answer outright; nothing it sends is consulted.
 * A loopback socket is some process on this machine, often a proxy: Vite's dev
 * proxy (`xfwd: true`, which appends with a bare `,`) or `tailscale serve`
 * (`pnpm tailnet`). Each appends the address of the socket *it* accepted, so the
 * `X-Forwarded-For` list is walked from the right, skipping loopback entries
 * (one local proxy fronting another — serve → Vite), and the first other entry
 * is the peer. A LAN client that forges `100.64.0.1` through Vite arrives as
 * `100.64.0.1,192.168.1.5` and resolves to `lan`.
 *
 * An entry that is not an address, empty ones included, is `unknown` rather than
 * skipped: the gate fails closed. No header at all, or only loopback entries,
 * is `local` — unless the `Host` header is a name a LAN peer can answer for
 * ({@link rebindableHost}), which is `unknown` too.
 */
export function resolvePeer(
  remoteAddress: string | undefined,
  headers?: IncomingHttpHeaders,
  ownNames: readonly string[] = OWN_NAMES
): ConnectionOrigin {
  const socket = classifyAddress(remoteAddress);
  if (socket !== 'local') return socket;

  const raw = headers?.['x-forwarded-for'];
  if (raw !== undefined) {
    const hops = (Array.isArray(raw) ? raw.join(',') : raw).split(',');
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i].trim();
      if (!isIpish(hop)) return 'unknown';
      const kind = classifyAddress(hop);
      if (kind !== 'local') return kind;
    }
  }
  return rebindableHost(headers?.host, ownNames) ? 'unknown' : 'local';
}

/** This machine's own name, bare and short: the OS resolves it locally (`/etc/hosts`, nss-myhostname, mDNSResponder), so no LAN peer can answer for it. */
const OWN_NAMES: readonly string[] = (() => {
  const full = os.hostname().toLowerCase();
  return [full, full.split('.')[0]].filter(Boolean);
})();

/**
 * Whether a loopback request's `Host` is a name a LAN peer could have re-pointed at 127.0.0.1: a `*.local` name (mDNS) or a single-label one
 * (LLMNR/NetBIOS, which the Windows side of WSL2 consults), other than `localhost` and this machine's own name. `hostAllowed`
 * (request-guard.ts) lets both through so LAN readers can browse by them, which is safe on a LAN socket; on a loopback socket it would hand a
 * rebound page the token-free write `local` gets (audit 2026-11-23).
 */
export function rebindableHost(header: string | undefined, ownNames: readonly string[] = OWN_NAMES): boolean {
  if (!header) return false;
  const name = hostOf(header);
  if (!name || name.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false;
  if (name === 'localhost' || ownNames.includes(name)) return false;
  return name.endsWith('.local') || !name.includes('.');
}

/** The badge's name for {@link resolvePeer}, kept so the badge and the gate can never disagree. */
export function classifyOrigin(
  remoteAddress: string | undefined,
  headers?: IncomingHttpHeaders
): ConnectionOrigin {
  return resolvePeer(remoteAddress, headers);
}
