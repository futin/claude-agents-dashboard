/**
 * The transcript `entrypoint` values this app reads meaning into. A leaf module: `scan.ts` decides surfaces from them, while `spawn.ts` and
 * `routine-config.ts` decide which one a child stamps, and neither of those should import the scanner to learn a string.
 */

/** What a headless `claude -p` run stamps when nothing in its environment says otherwise. */
export const HEADLESS_ENTRYPOINT = 'sdk-cli';

/**
 * What a dashboard-launched child stamps instead when `SPAWN_OWN_ENTRYPOINT` is on: this tool's own name, never another client's (`cli`,
 * `claude-desktop`, `claude-vscode`). Fixed rather than configurable, so no `.env` value can make a child pass itself off as one of those, and the scanner
 * knows the one extra label to read as `dashboard` — including in transcripts written while the switch was on, after it is turned off again.
 *
 * Why the switch exists: anthropics/claude-code#97074, `sdk-*` labels draw on the 5-hour window ~1.7–2.9× faster per token than interactive ones, and a
 * label of a tool's own reportedly bills at the interactive rate. Unsupported and undocumented by Anthropic; see `docs/subsystems/spawn.md`.
 */
export const DASHBOARD_ENTRYPOINT = 'claude-agents-dashboard';
