/**
 * Where the kaizen analyzer sits, beside this module in the same plugin. Imports nothing — no `claude-code`, no `node:` — because the mod runs with no
 * Node and a Node test imports this file too (test/plugin-manifest.test.ts), so a moved skill breaks a test rather than a live session.
 */
export function kaizenScriptPath(): string {
  return decodeURIComponent(new URL('../skills/kaizen/kaizen.mjs', (import.meta as ImportMeta & { url: string }).url).pathname)
}
