/**
 * transcript-listing.ts — one held listing of the transcript tree, shared by every request path that is not the sessions poll.
 *
 * The `/api/sessions` poll walks and stats the whole tree every 3 s on purpose (`docs/subsystems/sessions.md`); it hands its listing here with
 * {@link publishListing}. Session lookups, the pin and management lists and the routine pin checks then read that listing instead of each walking the
 * tree again — a pin toggle used to list it four times (43–55 ms warm here, 2026-11-15, 656 transcripts; 7.5–14 ms with one listing). With no poll
 * running, the first caller past {@link LISTING_MAX_AGE_MS} takes one fresh walk and the rest share it.
 *
 * `listTranscripts` in `scan.ts` stays the raw, uncached walk: the poll, analytics and the usage ledger need it fresh.
 */

import { findTranscript, listTranscripts, restatRef } from './scan.js';
import type { TranscriptRef } from './scan.js';

/** How old a held listing may be and still be served — the sessions poll interval, so a polling tab keeps it fresh. */
export const LISTING_MAX_AGE_MS = 3000;

/** One root only: the server lists nothing but `projectsRoot()`, so a call for another root replaces it. */
let held: { root: string; refs: readonly TranscriptRef[]; atMs: number } | null = null;

/** The held listing of `root` when it is at most {@link LISTING_MAX_AGE_MS} old, else a fresh walk, held and returned. */
export function sharedListing(root: string, nowMs: number = Date.now()): readonly TranscriptRef[] {
  if (held && held.root === root) {
    const age = nowMs - held.atMs;
    if (age >= 0 && age <= LISTING_MAX_AGE_MS) return held.refs;
  }
  const refs = listTranscripts(root);
  held = { root, refs, atMs: nowMs };
  return refs;
}

/** Hold a listing the caller already took — `scanSnapshot` publishes the poll's walk here. */
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
