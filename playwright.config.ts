/**
 * `pnpm test:visual` — screenshot regression suite over the built client, every `/api` call answered in the browser (docs/subsystems/visual-tests.md).
 * On-demand, macOS only, never part of `pnpm test`.
 */
import { defineConfig, devices } from '@playwright/test';

import { ORIGIN, PORT } from './test/visual/origin.js';
import { platformRefusal } from './test/visual/platform-guard.js';

// Refuse before Playwright starts anything, so a non-darwin `--update-snapshots` can never overwrite a darwin baseline.
const refusal = platformRefusal(process.platform);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

export default defineConfig({
  testDir: 'test/visual',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  snapshotPathTemplate: 'test/visual/__screenshots__/{arg}{ext}',
  expect: {
    // fullPage is not a valid default here; views.spec.ts passes it on every call.
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 0,
      threshold: 0
    }
  },
  use: {
    baseURL: ORIGIN,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    launchOptions: { args: ['--force-color-profile=srgb'] }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        deviceScaleFactor: 1
      }
    }
  ],
  webServer: {
    // --strictPort: a held port fails loudly instead of drifting to the next one and screenshotting whatever else answers.
    // The build is part of the server command, so a run straight after a CSS edit screenshots the edit, never a stale client/dist.
    command: `vite build && vite preview --port ${PORT} --strictPort --host localhost`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { BROWSER: 'none' }
  }
});
