import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { loadConfig } from './server/lib/config';

// Reuse the backend config loader so the dev proxy targets the same PORT the
// API server actually listens on (.env / process.env / default 4173).
const { port } = loadConfig();

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    open: true,
    proxy: {
      '/api': `http://localhost:${port}`
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
