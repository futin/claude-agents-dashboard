// The dashboard's own release history, served at GET /api/releases (docs/subsystems/releases.md). release-kit reads the tags and owns the memo; this
// file only points it at the checkout and keeps the two test seams.
import { createReleasesReader, defaultGitPort } from 'release-kit';
import type { GitPort, ReleasesReader } from 'release-kit';

import type { ReleasesResponse } from '../../shared/types.js';
import { repoRoot } from './usage-history.js';

let rootOverride: string | null = null;
let reads = 0;

/** release-kit's own git port, counting the `for-each-ref` that lists the tags — one per read the memo did not answer. */
const own = defaultGitPort(10_000);
const countingPort: GitPort = (args, o) => {
  if (args[0] === 'for-each-ref') reads++;
  return own(args, o);
};

function makeReader(): ReleasesReader {
  return createReleasesReader({ root: () => rootOverride ?? repoRoot(), git: countingPort });
}

let reader = makeReader();

/** Point the reader at `dir` instead of the dashboard's own checkout; `null` restores it. Starts a fresh memo and clears the read count. Tests only. */
export function overrideReleasesRoot(dir: string | null): void {
  rootOverride = dir;
  reader = makeReader();
  reads = 0;
}

/** How many times the tags were actually read since the last {@link overrideReleasesRoot}. Tests only. */
export function releasesReadCount(): number {
  return reads;
}

/** The memoised read. Concurrent requests under one key share one read; release-kit never rejects, so neither does this. */
export function releasesPayload(): Promise<ReleasesResponse> {
  return reader.read();
}
