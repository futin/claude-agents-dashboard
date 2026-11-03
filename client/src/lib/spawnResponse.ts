import { replyError } from './postWrite';
import type { WriteResult } from './postWrite';
import { READ_ONLY_TEXT, refusalFlags } from './writeRefusal';
import type { SpawnResponse } from '../../../shared/types';

/**
 * Reads a `POST /api/spawn` 200 body into the {@link SpawnResponse} union, or null when it is neither branch.
 *
 * A desktop answer may carry no session id (a hand-over, or an older server's fresh launch) and is still a success: reading it as a missing id would show
 * `Launch failed` for a launch that worked. A body with a session id and no `surface` is an older server's headless answer, so it reads as `dashboard`.
 */
export function parseSpawnResponse(body: unknown): SpawnResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.surface === 'desktop') {
    return typeof b.sessionId === 'string' && b.sessionId !== '' ? { surface: 'desktop', sessionId: b.sessionId } : { surface: 'desktop' };
  }
  if ((b.surface === 'dashboard' || b.surface === undefined) && typeof b.sessionId === 'string' && b.sessionId !== '') {
    return { surface: 'dashboard', sessionId: b.sessionId };
  }
  return null;
}

/** What one launch POST means to `useSpawn`. A flag key left out means "leave as is". */
export interface SpawnOutcome {
  response: SpawnResponse | null;
  error: string | null;
  needsToken?: boolean;
  readOnly?: boolean;
}

/**
 * Reads a `POST /api/spawn` result into what `useSpawn.launch` applies.
 *
 * A 200 whose body cannot be read never says "failed": the server answers 200 only after the launch returned, so the session may well be running, and a person
 * told it failed retries and starts a second one.
 */
export function spawnOutcome(result: WriteResult): SpawnOutcome {
  if (result.status === 0) return { response: null, error: 'Could not reach the server.' };
  if (result.refusal) {
    return { response: null, error: result.refusal === 'read-only' ? READ_ONLY_TEXT : null, ...refusalFlags(result.refusal) };
  }
  const flags = { needsToken: false, readOnly: false };
  if (result.ok) {
    const response = parseSpawnResponse(result.body);
    return { response, error: response ? null : 'The launch reply could not be read — check Sessions before trying again.', ...flags };
  }
  return { response: null, error: replyError(result.body) ?? `Launch failed (${result.status}).`, ...flags };
}
