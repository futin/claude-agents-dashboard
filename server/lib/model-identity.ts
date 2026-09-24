/**
 * model-identity.ts — the exact model a session runs on, window grant included.
 *
 * `message.model` on usage records never carries a `[1m]` grant, and on a
 * `/model` switch it lags the switch by a turn. Claude Code also writes an
 * attachment record naming the model with its marker, and re-emits it on a
 * switch — newest wins, and it is checked first:
 *
 *   {"type":"attachment","attachment":{"type":"model","identity":{"modelId":"claude-opus-5[1m]",…},…}}
 *
 * It is written near the session's start (first one ends by byte 32k median,
 * up to 231k), so on a long session it sinks below the tail window — found and
 * remembered the same way as the custom title (see `record-cache.ts`).
 */

import { createRecordCache } from './record-cache.js';

export const MODEL_MARKER = '"type":"model"';

/** `identity.modelId` out of a parsed model attachment, or null for anything else. */
export function modelIdFromRecord(rec: any): string | null {
  if (!rec || rec.type !== 'attachment') return null;
  const a = rec.attachment;
  if (!a || a.type !== 'model' || !a.identity || typeof a.identity.modelId !== 'string') return null;
  return a.identity.modelId || null;
}

const identities = createRecordCache(MODEL_MARKER, modelIdFromRecord);

/** Newest model id in the tail window's lines. */
export function findModelIdentity(lines: string[], first: number): string | null {
  return identities.findInLines(lines, first);
}

/** Resolve a session's model id given what its tail window already yielded. */
export function resolveModelIdentity(
  filePath: string,
  tailId: string | null,
  tailStart: number,
  size: number
): string | null {
  return identities.resolve(filePath, tailId, tailStart, size);
}

/** Test seam: drop all remembered identities. */
export function resetModelIdentityCache(): void {
  identities.reset();
}

/** Test seam: how many times we went to disk below the tail window. */
export function modelIdentityCacheStats(): { entries: number; fullScans: number } {
  return identities.stats();
}
