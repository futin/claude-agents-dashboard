/**
 * latest-session.ts — the resolver behind `pnpm session-analytics --latest`, the TS twin of kaizen.mjs's `resolveLatest`.
 *
 * A transcript matches when its first record carrying a `cwd` equals the given cwd (both through `normCwd`) — the `cwd` `analyzeSession` reports.
 * That first `cwd` comes from the head window `launchCwd` reads, which is a prefix of the file, so a `cwd` found there is the file's first. Only a file
 * larger than the window whose head yields no `cwd` is parsed in full; `fullParses` counts those, so a no-match run costs head reads, not the corpus.
 */

import { analyzeSession } from '../../server/lib/analyze.js';
import { listTranscripts, type TranscriptRef } from '../../server/lib/scan.js';
import { HEAD_BYTES, launchCwd } from '../../server/lib/transcript.js';

/** Strip one trailing `/`, except from `/` itself. */
export function normCwd(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** The newest transcript under `root` launched in `cwd`, and how many candidates it had to parse in full to decide. */
export function resolveLatest({ root, cwd }: { root: string; cwd: string }): { match: TranscriptRef | null; fullParses: number } {
  const here = normCwd(cwd);
  let fullParses = 0;
  for (const ref of listTranscripts(root).sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    let first = launchCwd(ref.file, ref.size);
    // analyzeSession skips an empty-string cwd and keeps looking, so an empty one from the head is not an answer either.
    if (!first && (first === '' || ref.size > HEAD_BYTES)) {
      fullParses++;
      first = analyzeSession(ref.file, ref.id)?.cwd ?? null;
    }
    if (first && normCwd(first) === here) return { match: ref, fullParses };
  }
  return { match: null, fullParses };
}
