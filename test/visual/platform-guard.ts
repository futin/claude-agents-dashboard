/**
 * The visual baselines are rendered on macOS and only ever compared there: a Linux or Windows Chromium rasterises text differently, so every shot would fail
 * — or, under `--update-snapshots`, silently overwrite a darwin baseline. `playwright.config.ts` calls this at load, before Playwright starts anything.
 */
export function platformRefusal(platform: string): string | null {
  if (platform === 'darwin') return null;
  return `visual baselines exist for macOS only (platform: ${platform}); run pnpm test:visual on a Mac`;
}
