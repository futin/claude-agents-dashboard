/**
 * Two checks the request listener runs before any route, both aimed at the user's own browser rather than at other machines — the LAN/tailnet trust
 * model in docs/subsystems/remote-access.md is unchanged by either.
 *
 * - {@link hostAllowed} — DNS rebinding. A page on `evil.example` can re-point its own name at 127.0.0.1 and then read every open GET route as
 *   same-origin. The browser still sends `Host: evil.example`, so refusing names that public DNS could have handed out closes it. This is the prod
 *   twin of Vite's `allowedHosts` guard; `ALLOWED_HOSTS` feeds both.
 * - {@link crossSiteWrite} — CSRF. The write gate trusts loopback and the tailnet with no token, and `readJsonBody` parses any Content-Type, so a
 *   `no-cors` `text/plain` POST from any site the user's own browser visits would reach them without a preflight. The hooks and curl send neither header checked here,
 *   so they are unaffected.
 *
 * Pure: headers in, verdict out. The listener owns the 403s.
 */

/**
 * Suffixes no public DNS answer can rebind: `.localhost` is loopback by spec, `.local` is mDNS (LAN-only), and `.ts.net` names are served by Tailscale's
 * own DNS, which an attacker cannot point at 127.0.0.1.
 */
const SAFE_SUFFIXES = ['.localhost', '.local', '.ts.net'];

/** An IPv4 dotted quad or an IPv6 literal (only those carry a `:` once {@link hostname} has dropped the port). Not `node:net` — that import would
 * count as network surface in test/outbound.test.ts for a check that never touches a socket. */
const isIpLiteral = (name: string): boolean => name.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);

/** `Host` header → bare lower-cased hostname: port, IPv6 brackets and a trailing root dot removed. */
export function hostname(header: string): string {
  let h = header.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/**
 * Whether a request's `Host` header names this machine by a route that cannot be a rebound public name.
 *
 * Always allowed: a missing header (no browser omits it), an IP literal, a single-label name (`localhost`, a tailnet short name, a LAN hostname — none is
 * resolvable through public DNS), and the {@link SAFE_SUFFIXES}. `extra` is `ALLOWED_HOSTS`: an exact name, a `.suffix`, or `*` to switch the check off —
 * what a public tunnel (ngrok, Cloudflare) needs, since its hostname is public by definition.
 */
export function hostAllowed(header: string | undefined, extra: readonly string[] = []): boolean {
  if (!header) return true;
  const name = hostname(header);
  if (!name || isIpLiteral(name) || !name.includes('.')) return true;
  if (SAFE_SUFFIXES.some(s => name.endsWith(s))) return true;
  return extra.some(e => {
    const rule = e.trim().toLowerCase();
    if (rule === '*') return true;
    if (rule.startsWith('.')) return name.endsWith(rule) || name === rule.slice(1);
    return rule !== '' && name === rule;
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a state-changing request was sent by a browser on behalf of a different site.
 *
 * `Sec-Fetch-Site` decides when present (every current browser sends it): only `same-origin` and `none` (typed into the address bar) pass, so another
 * port on localhost (`same-site`) is refused too. Without it, an `Origin` whose host differs from `Host` is refused — `Origin: null` (sandboxed frame,
 * `file://`) included. Neither header → not a browser → allowed, which is how the hooks and curl reach the write routes.
 */
export function crossSiteWrite(method: string | undefined, headers: Record<string, string | string[] | undefined>): boolean {
  if (SAFE_METHODS.has((method || 'GET').toUpperCase())) return false;
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') return site !== 'same-origin' && site !== 'none';
  const origin = headers['origin'];
  if (typeof origin !== 'string' || origin === '') return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = headers['host'];
  return typeof host !== 'string' || originHost.toLowerCase() !== host.trim().toLowerCase();
}
