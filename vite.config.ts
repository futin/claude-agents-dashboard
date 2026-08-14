import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { loadConfig } from './server/lib/config';

// Reuse the backend config loader so the dev proxy targets the same PORT the
// API server actually listens on (.env / process.env / default 4173), and the
// dev UI itself honours WEB_PORT (default 5173 — set it when another Vite
// project already sits there).
const { port, webPort } = loadConfig();

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
    // rather than disabling the check — see .claude/rules/remote-access.md.
    allowedHosts: ['.ts.net'],
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
