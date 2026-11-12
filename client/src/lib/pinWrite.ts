/**
 * pinWrite.ts — what one pin write's reply means, apart from React so a node test can drive it. `usePins` holds the state; this decides what happens to it.
 */

import { replyError } from './postWrite';
import type { WriteResult } from './postWrite';
import { READ_ONLY_TEXT } from './writeRefusal';
import type { PinsResponse, PinsSavedError } from '../../../shared/types';

export const TOKEN_TEXT = 'The server refused the request — set the Answer token under Settings › Local › Connection.';
export const NETWORK_TEXT = 'Could not reach the server.';

export type PinWriteOutcome =
  /** Stored, and the reply is the fresh list. */
  | { kind: 'fresh'; pins: PinsResponse }
  /** Stored, but the server could not rebuild the list: the rows must not go back to what they were. */
  | { kind: 'saved'; text: string }
  /** A 409. The text is `setPin`'s; `reorder` reloads the list instead of showing it. */
  | { kind: 'conflict'; text: string }
  /** Nothing is known to be stored. */
  | { kind: 'failed'; text: string };

/** A 403's note: the token prompt, or `READ_ONLY_TEXT` when no token could help. */
function refusalText(result: WriteResult): string {
  return result.refusal === 'read-only' ? READ_ONLY_TEXT : TOKEN_TEXT;
}

/** A refused write's note: the 403 text, else the server's own message. */
function failureText(result: WriteResult): string {
  if (result.refusal) return refusalText(result);
  return replyError(result.body) ?? `Failed (${result.status}).`;
}

/** The fresh payload a successful pin write answers with, or null when the reply is not one. */
function pinsOf(result: WriteResult): PinsResponse | null {
  const body = result.body as PinsResponse | undefined;
  return Array.isArray(body?.pinned) ? body : null;
}

export function pinWriteOutcome(result: WriteResult): PinWriteOutcome {
  const pins = result.ok ? pinsOf(result) : null;
  if (pins) return { kind: 'fresh', pins };
  if (result.status === 0 || result.ok) return { kind: 'failed', text: NETWORK_TEXT };
  if (result.status === 409) return { kind: 'conflict', text: failureText(result) };
  if ((result.body as Partial<PinsSavedError> | undefined)?.saved === true) return { kind: 'saved', text: failureText(result) };
  return { kind: 'failed', text: failureText(result) };
}

export const RELOADED_TEXT = 'Pins changed in another tab — reloaded.';

/** `GET /api/pins` as `fetch` answers it; `usePins` passes `() => fetch('/api/pins')`. */
export type PinsReader = () => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * What a reorder's reply leaves on screen. `pins` present is what the rows become; absent, the optimistic rows already hold the stored order and stay.
 * `text` is the note to show, null on success. A 409 means the stored set changed under this tab, so the pre-drag rows are stale too: it re-reads the list,
 * and only when that fails rolls back to `before` with the network note.
 */
export async function settleReorder(
  outcome: PinWriteOutcome,
  before: PinsResponse | null,
  read: PinsReader
): Promise<{ pins?: PinsResponse | null; text: string | null }> {
  if (outcome.kind === 'fresh') return { pins: outcome.pins, text: null };
  if (outcome.kind === 'saved') return { text: outcome.text };
  if (outcome.kind === 'failed') return { pins: before, text: outcome.text };
  try {
    const fresh = await read();
    const body = fresh.ok ? await fresh.json() as PinsResponse | null : null;
    if (Array.isArray(body?.pinned)) return { pins: body, text: RELOADED_TEXT };
  } catch { /* fall through to the rollback */ }
  return { pins: before, text: NETWORK_TEXT };
}
