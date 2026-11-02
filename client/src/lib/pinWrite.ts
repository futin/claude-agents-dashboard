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
