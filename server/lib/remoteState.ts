/**
 * remoteState.ts — the runtime on/off switch for remote answers.
 *
 * Three gates decide whether a question waits for a phone answer, each with a
 * distinct job:
 *
 *   1. `REMOTE_ANSWER` (env)  — is the feature available at all? A hard kill
 *                               switch; when false the toggle can't turn it on.
 *   2. this toggle (UI)       — am I accepting remote answers right now?
 *   3. keyboard idle (hook)   — am I actually away from the desk? Checked by
 *                               `ask-remote-hook.sh`, so a question at your desk
 *                               always goes straight to the terminal dialog.
 *
 * The toggle is persisted because `tsx watch` restarts the server on every edit
 * and a switch you flipped before walking away must survive that. It is the only
 * thing this app writes to disk, and it fails open: an unwritable path keeps the
 * in-memory value and reports `persisted: false` so the UI can say so.
 *
 * See `.claude/rules/remote-answer.md`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.js';
import type { RemoteAnswerState } from '../../shared/types.js';

/** Gitignored, repo-local — never inside `~/.claude` (read-only under Docker). */
export const STATE_FILE = '.remote-answer.json';

let cached: boolean | null = null;
let persisted = true;

function statePath(): string {
  return path.join(process.cwd(), STATE_FILE);
}

/** The stored toggle, or null when there's nothing usable on disk. */
function readStored(): boolean | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return raw && typeof raw === 'object' && typeof raw.enabled === 'boolean' ? raw.enabled : null;
  } catch {
    return null; // absent / unreadable / malformed — fall back to the env default
  }
}

/**
 * Current state. `available` is the env gate, `enabled` the toggle — the hook is
 * told `remoteAnswer: available && enabled`, which is the only thing it acts on.
 */
export function getState(config: Config): RemoteAnswerState {
  if (cached === null) cached = readStored() ?? config.remoteAnswer;
  return {
    available: config.remoteAnswer,
    enabled: cached,
    remoteAnswer: config.remoteAnswer && cached,
    persisted
  };
}

/** Flip the toggle. Rejected (null) when the env gate is off. */
export function setEnabled(config: Config, enabled: boolean): RemoteAnswerState | null {
  if (!config.remoteAnswer) return null;
  cached = enabled;
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ enabled }) + '\n', 'utf8');
    persisted = true;
  } catch {
    persisted = false; // read-only fs / container — the toggle still works this run
  }
  return getState(config);
}

/** Test seam: forget the cached value so the next read re-resolves it. */
export function resetState(): void {
  cached = null;
  persisted = true;
}
