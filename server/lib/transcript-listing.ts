/**
 * transcript-listing.ts — one held listing of the transcript tree, shared by every request path, the sessions poll included.
 *
 * The `/api/sessions` poll reads it with a 1 s max age (`POLL_LISTING_MAX_AGE_MS`), so each tab's poll still lists fresh while a second tab and the hub
 * tile inside the same second share one walk (`docs/subsystems/sessions.md`). Session lookups, the pin and management lists and the routine pin checks
 * read it with the default {@link LISTING_MAX_AGE_MS} instead of each walking the tree again — a pin toggle used to list it four times (43–55 ms warm
 * here, 2026-11-15, 656 transcripts; 7.5–14 ms with one listing). The first caller past its max age takes one fresh walk and the rest share it.
 *
 * `listTranscripts` in `scan.ts` stays the fresh walk behind every held listing, and the one analytics and the usage ledger take directly: its readdirs
 * are gated by directory mtime (`dir-cache.ts`), but it stats every file on every call, so no listing it returns is ever stale.
 */

import { findTranscript, listTranscripts, restatRef } from './scan.js';
import type { TranscriptRef } from './scan.js';

/** How old a held listing may be and still be served — the sessions poll interval, so a polling tab keeps it fresh. */
export const LISTING_MAX_AGE_MS = 3000;

/** One root only: the server lists nothing but `projectsRoot()`, so a call for another root replaces it. */
let held: { root: string; refs: readonly TranscriptRef[]; atMs: number } | null = null;

/** The held listing of `root` when it is at most `maxAgeMs` old, else a fresh walk, held and returned. */
export function sharedListing(root: string, nowMs: number = Date.now(), maxAgeMs: number = LISTING_MAX_AGE_MS): readonly TranscriptRef[] {
  if (held && held.root === root) {
    const age = nowMs - held.atMs;
    if (age >= 0 && age <= maxAgeMs) return held.refs;
  }
  const refs = listTranscripts(root);
  held = { root, refs, atMs: nowMs };
  return refs;
}

/** Hold a listing the caller already took. */
export function publishListing(root: string, refs: readonly TranscriptRef[], atMs: number = Date.now()): void {
  held = { root, refs, atMs };
}

/** Test seam: forget the held listing. */
export function resetListingCache(): void {
  held = null;
}

/**
 * {@link findTranscript} answered from the held listing: the refs it holds for `id`, each stat-ed again so size and mtime are current, newest half
 * per id. An id the listing does not hold, or whose files have all gone, falls back to `findTranscript`'s name walk, so a session created after the
 * listing is still found on its first request. The path always comes from an enumeration and is never joined from the id.
 *
 * Accepted lag: a split session whose second half starts in a new dir resolves to the old half until the next listing, at most 3 s.
 */
export function resolveTranscript(root: string, id: string, nowMs?: number): TranscriptRef | undefined {
  const fresh: TranscriptRef[] = [];
  for (const ref of sharedListing(root, nowMs)) {
    if (ref.id !== id) continue;
    const now = restatRef(ref);
    if (now) fresh.push(now);
  }
  return fresh.length > 0 ? findTranscript(root, id, fresh) : findTranscript(root, id);
}
