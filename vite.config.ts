import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { loadConfig } from './server/lib/config';
import { findCli } from './scripts/tailnet.js';

// Reuse the backend config loader so the dev proxy targets the same PORT the
// API server actually listens on (.env / process.env / default 4173), and the
// dev UI itself honours WEB_PORT (default 5174, not Vite's stock 5173, which
// another project usually holds — set it if 5174 is taken too).
const { port, webPort } = loadConfig();

/**
 * This node's MagicDNS *short* name, if it has one.
 *
 * `allowedHosts: ['.ts.net']` below covers the fully-qualified MagicDNS name,
 * but that is not the only name the tailnet answers on: `tailscale serve
 * --http` advertises the bare single-label form first — `http://<host>:<port>`
 * — and a single label has no dot for a `.ts.net` suffix rule to match. Vite
 * then answers that URL with `Blocked request. This host (...) is not allowed.`
 * on a socket that is otherwise healthy, which reads as a broken proxy target
 * rather than as a Host-header check, and sends you looking at the serve
 * registration instead. So ask Tailscale for the name and allow its first label.
 *
 * Best-effort by design: no Tailscale, no MagicDNS, a logged-out node or a
 * hung CLI all return nothing, and dev then behaves exactly as before. The
 * short name cannot be derived from `os.hostname()` — a node's tailnet name is
 * set in the admin console and routinely differs from the machine's.
 */
function magicDnsShortName(): string | undefined {
  const cli = findCli();
  if (!cli) return undefined;
  const { status, stdout } = spawnSync(cli, ['status', '--json'], {
    encoding: 'utf8',
    timeout: 2_000
  });
  if (status !== 0 || !stdout) return undefined;
  try {
    const dnsName = String(JSON.parse(stdout).Self?.DNSName ?? '');
    const label = dnsName.split('.')[0];
    return label || undefined;
  } catch {
    return undefined;
  }
}

// No browser to open inside a container — skip, avoids a noisy spawn ENOENT.
const inContainer = fs.existsSync('/.dockerenv');

// Inside a container Vite only sees its own bridge interface (e.g. 172.19.0.2),
// not the host's real LAN IP — so its own "Network:" line is useless for phone
// access. HOST_LAN_IP is passed in from the host (see docker-compose.dev.yml /
// `pnpm dev:docker`); print the address a phone should actually use.
function logHostLanIp() {
  return {
    name: 'log-host-lan-ip',
    configureServer(server: import('vite').ViteDevServer) {
      const ip = process.env.HOST_LAN_IP;
      if (!inContainer || !ip) return;
      server.httpServer?.once('listening', () => {
        const port = (server.config.server.port as number) ?? webPort;
        server.config.logger.info(`  ➜  Phone (LAN): http://${ip}:${port}/`);
      });
    }
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), logHostLanIp()],
  server: {
    port: webPort,
    host: true,
    open: !inContainer,
    // Vite ≥5.4.12 rejects any Host header that isn't localhost or a bare IP
    // (DNS-rebinding guard), so a tailnet MagicDNS name 403s without this. The
    // leading dot allows subdomains, scoping the exemption to tailnet hosts
    // rather than disabling the check — see docs/subsystems/remote-access.md.
    // The second entry is this node's bare short name, which `tailscale serve`
    // prints and `.ts.net` cannot match; absent when there is no tailnet.
    allowedHosts: ['.ts.net', magicDnsShortName()].filter(
      (host): host is string => host !== undefined
    ),
    proxy: {
      // xfwd adds X-Forwarded-For. The dev proxy reaches the API over loopback,
      // so without it every dev client — including a phone on the LAN — would
      // be classified `local` by server/lib/origin.ts.
      '/api': { target: `http://localhost:${port}`, xfwd: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
