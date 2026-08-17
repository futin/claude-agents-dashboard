/**
 * spawn.ts — pure, security-critical core for launching a headless `claude -p`
 * session from the dashboard.
 *
 * Nothing in this module touches the filesystem or a child process — that is
 * Task 2. This file only decides three things, synchronously and without side
 * effects:
 *
 *   1. `clampPermission` — the permission mode a launch actually runs under,
 *      never higher than the server-configured ceiling.
 *   2. `parseSpawnRequest` — whether an untrusted POST body is safe to act on,
 *      and the sanitized `SpawnInput` if so.
 *   3. `buildSpawnArgs` — the exact argv Task 2 hands to `child_process.spawn`.
 *
 * Two rules `buildSpawnArgs` never breaks:
 *
 *  - The prompt is never an argv element. `claude -p` parses argv the way
 *    almost every CLI does: a value starting with `-`/`--` is read as a flag,
 *    not as data, regardless of what flag it happens to follow. A prompt is
 *    untrusted free text a user typed — `--dangerously-skip-permissions` is a
 *    perfectly ordinary-looking sentence to start a prompt with — so the only
 *    safe place for it is somewhere the CLI's flag parser never looks: stdin.
 *    Task 2 pipes `input.prompt` in over stdin; this module just makes sure
 *    nothing here ever puts it in the array by mistake.
 *  - `child_process.spawn` is always called in array form, never with
 *    `shell: true`. `shell: true` hands the whole command line to `/bin/sh`,
 *    which re-tokenizes it — the exact step that turns a value into code if
 *    it contains a quote, `;`, `$(...)`, or a stray space. Array-form `spawn`
 *    hands the child each argv element directly, with no shell in between to
 *    reinterpret any of them.
 */

import type { PermissionMode } from '../../shared/types.js';

/** The permission ladder, lowest to highest. Array index order IS the ordering. */
export const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'bypassPermissions'] as const;

/** Models the launch form may request. */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Effort levels the launch form may request. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Prompt length cap, in characters. Inclusive — exactly this many is fine. */
export const PROMPT_CAP = 4000;

/** Display-name length cap, in characters. Inclusive — exactly this many is fine. */
export const NAME_CAP = 60;

/**
 * Allowed charset for a session's display name: letters, digits, spaces,
 * hyphens, underscores. Nothing here is a shell metacharacter or a path
 * separator — the name ends up as a single argv element (never shell-parsed,
 * see the module doc comment above), but it also flows into UI and, later,
 * onto disk, so it is sanitized on its own merits rather than piggy-backing on
 * argv safety.
 */
const NAME_RE = /^[A-Za-z0-9 _-]+$/;

/** `PERMISSION_MODES` index of `value`, or of `'auto'` when `value` isn't one of them. */
function modeIndex(value: unknown): number {
  const idx = (PERMISSION_MODES as readonly string[]).indexOf(value as string);
  return idx === -1 ? PERMISSION_MODES.indexOf('auto') : idx;
}

/**
 * The permission mode a launch actually runs under: never higher on the
 * ladder than `ceiling`, no matter what was requested. An unrecognized
 * `requested` or `ceiling` — including `undefined` — is treated as `'auto'`,
 * never as the top of the ladder, so a malformed value can only ever make the
 * result *less* permissive.
 */
export function clampPermission(requested: unknown, ceiling: unknown): PermissionMode {
  return PERMISSION_MODES[Math.min(modeIndex(requested), modeIndex(ceiling))];
}

/** Untrusted input for a new headless launch, once a `sessionId` has been assigned. */
export interface SpawnInput {
  sessionId: string;
  prompt: string;
  permissionMode: PermissionMode;
  name?: string;
  model?: string;
  effort?: string;
}

/** Result of validating an untrusted POST body against {@link SpawnInput}. */
export type ParseResult =
  | { ok: true; input: Omit<SpawnInput, 'sessionId'> }
  | { ok: false; error: string };

/**
 * Turn an untrusted POST body into a safe {@link SpawnInput}, or a reason it
 * can't launch. Deliberately ignores `body.project`: resolving a project
 * needs config and the filesystem, which a pure function doesn't have — the
 * handler (Task 3) resolves it separately.
 *
 * Only the prompt can fail the request outright. Everything else fails soft —
 * an unrecognized `model`, `effort` or `name`, or a `permissionMode` outside
 * the enum, is dropped or clamped rather than rejected, so a client sending a
 * field this server doesn't recognize (an old build, a future one) can still
 * launch with the rest of the request honored.
 */
export function parseSpawnRequest(body: unknown, ceiling: PermissionMode): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== 'string') {
    return { ok: false, error: 'prompt is required' };
  }
  const prompt = b.prompt.trim();
  if (prompt === '') {
    return { ok: false, error: 'prompt must not be empty' };
  }
  if (prompt.length > PROMPT_CAP) {
    return { ok: false, error: `prompt must be at most ${PROMPT_CAP} characters` };
  }

  const permissionMode = clampPermission(b.permissionMode, ceiling);
  const model = typeof b.model === 'string' && (MODELS as readonly string[]).includes(b.model)
    ? b.model
    : undefined;
  const effort = typeof b.effort === 'string' && (EFFORTS as readonly string[]).includes(b.effort)
    ? b.effort
    : undefined;
  const name = typeof b.name === 'string' && b.name.length <= NAME_CAP && NAME_RE.test(b.name)
    ? b.name
    : undefined;

  return { ok: true, input: { prompt, permissionMode, name, model, effort } };
}

/**
 * The exact argv `child_process.spawn('claude', ...)` receives (Task 2).
 * Fixed element order, built the same way on every call: required flags
 * first, then each optional flag appended in the same declared order when
 * present. No branch ever reorders a flag already emitted — a later diff that
 * adds a new optional flag only ever appends to the end of this function.
 *
 * The prompt is deliberately absent: see the module doc comment.
 */
export function buildSpawnArgs(input: SpawnInput): string[] {
  const args = ['-p', '--session-id', input.sessionId, '--permission-mode', input.permissionMode];
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.name) args.push('-n', input.name);
  return args;
}
