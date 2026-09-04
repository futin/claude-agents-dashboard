/**
 * origin.ts — classify how a client reached the dashboard: loopback, the local
 * network, a Tailscale tailnet, or somewhere off-network.
 *
 * Display-only. The result rides along on `GET /api/health` and renders as a
 * badge in the toolbar; **nothing in the app makes an access decision from it**.
 * That is what makes the `X-Forwarded-For` branch below acceptable — see
 * `classifyOrigin`.
 *
 * ⚠️ If you ever gate access on this module, gate on `classifyAddress`, never on
 * `classifyOrigin`. The latter consults the left-most forwarded entry, which a
 * peer behind a loopback-terminating proxy writes itself — so as a guard it
 * returns whichever verdict the caller asks for, refusing an honest proxied
 * client and admitting one that prepends `127.0.0.1`. `classifyAddress` reads the
 * socket and nothing else. (`GET /api/focus` used this; it was removed with the
 * deep link.)
 *
 * Pure and zero-dep, like the rest of `server/lib`: no `tailscale` binary, no
 * network, no config. With Tailscale absent the tailnet branches simply never
 * match and every client reads `local` or `lan`.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type { ConnectionOrigin } from '../../shared/types.js';

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
 * Classify a request by its socket address, falling back to `X-Forwarded-For`
 * **only when the socket is loopback**.
 *
 * That fallback is what makes `pnpm tunnel` (`tailscale serve --bg 4173`) report
 * `tailnet` instead of `local`: the serve proxy runs on the host, so the socket
 * is 127.0.0.1 and the peer's real tailnet address survives only in the header.
 * The Vite dev proxy (`xfwd: true`) is the same shape.
 *
 * Spoofing is a non-issue here by construction: a forwarded header is honoured
 * only from loopback — i.e. only from something already on the machine — and the
 * result drives a badge with no policy attached, so the worst a caller can do is
 * mislabel their own badge.
 */
export function classifyOrigin(
  remoteAddress: string | undefined,
  headers?: IncomingHttpHeaders
): ConnectionOrigin {
  const socket = classifyAddress(remoteAddress);
  if (socket !== 'local') return socket;

  const raw = headers?.['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return 'local';
  const hop = header.split(',')[0]?.trim();
  if (!isIpish(hop)) return 'local';
  return classifyAddress(hop);
}
