import type { SpawnResponse } from '../../../shared/types';

/**
 * Reads a `POST /api/spawn` 200 body into the {@link SpawnResponse} union, or null when it is neither branch.
 *
 * A desktop answer carries no session id and is still a success: reading it as a missing id would show `Launch failed` for a launch that worked. A body
 * with a session id and no `surface` is an older server's headless answer, so it reads as `dashboard`.
 */
export function parseSpawnResponse(body: unknown): SpawnResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.surface === 'desktop') return { surface: 'desktop' };
  if ((b.surface === 'dashboard' || b.surface === undefined) && typeof b.sessionId === 'string' && b.sessionId !== '') {
    return { surface: 'dashboard', sessionId: b.sessionId };
  }
  return null;
}
