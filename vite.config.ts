import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { loadConfig } from './server/lib/config';

// Reuse the backend config loader so the dev proxy targets the same PORT the
// API server actually listens on (.env / process.env / default 4173).
const { port } = loadConfig();

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
        const port = (server.config.server.port as number) ?? 5173;
        server.config.logger.info(`  ➜  Phone (LAN): http://${ip}:${port}/`);
      });
    }
  };
}

export default defineConfig({
  root: 'client',
  plugins: [react(), logHostLanIp()],
  server: {
    port: 5173,
    host: true,
    open: !inContainer,
    proxy: {
      '/api': `http://localhost:${port}`
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
