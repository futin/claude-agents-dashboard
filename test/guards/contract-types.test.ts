/**
 * The client's ties to `shared/types.ts`. Most of this file is checked by `pnpm typecheck`, not at run time: each `@ts-expect-error` fails the typecheck
 * once the line under it starts compiling. The one run-time case is the fetch interval list, which exists twice because no runtime constant crosses `shared/`.
 */
import assert from 'node:assert';

import { GIT_FETCH_OPTIONS } from '../../client/src/lib/gitClock.js';
import type { PendingPollPath, PendingReplyOptions } from '../../client/src/hooks/usePendingReply.js';
import { GIT_FETCH_SECS } from '../../server/lib/settings.js';
import type { ReleasesResponse, ServerSettingsPatch } from '../../shared/types.js';
import type { ReleasesResponse as KitReleasesResponse } from 'ui-kit';

type IdOf<P extends PendingPollPath> = PendingReplyOptions<P, 'sent'>['idOf'];

const pendingIds = {
  plan: (p => p.planId) satisfies IdOf<'plan'>,
  // @ts-expect-error a pending plan has no questionId
  planNotQuestion: (p => p.questionId) satisfies IdOf<'plan'>,
  question: (q => q.questionId) satisfies IdOf<'question'>,
  message: (m => m.messageId) satisfies IdOf<'message'>,
};

const pollPaths: PendingPollPath[] = [
  'question', 'plan', 'message',
  // @ts-expect-error no such poll route
  'plans',
  // @ts-expect-error a real answer path, but no poll path
  'answer',
];

const patches: ServerSettingsPatch[] = [
  { gitFetchSecs: 300 },
  // @ts-expect-error off the list: the server would refuse it
  { gitFetchSecs: 45 },
];

/**
 * What `GET /api/releases` sends is what ui-kit's `useWhatsNew` accepts: the client never sees `shared`'s type at run time, since ui-kit fetches the route
 * itself, so this assignability check is the tie.
 */
const releases = {
  served: (r: ReleasesResponse): KitReleasesResponse => r,
  // @ts-expect-error a `current.ahead` that is not a number is not what ui-kit reads
  aheadAsText: (r: Omit<ReleasesResponse, 'current'> & { current: { version: string; ahead: string } | null }): KitReleasesResponse => r,
};

export function run(): number {
  console.log('\ncontract-types.test.ts');
  try {
    assert.deepStrictEqual(GIT_FETCH_OPTIONS.map(o => o.value), [...GIT_FETCH_SECS]);
    console.log('  ✓ GIT_FETCH_OPTIONS and GIT_FETCH_SECS hold the same values in the same order');
    console.log('\n  1 passed, 0 failed');
    return 0;
  } catch (err) {
    console.log(`  ✗ GIT_FETCH_OPTIONS and GIT_FETCH_SECS hold the same values in the same order\n    ${(err as Error).message}`);
    console.log('\n  0 passed, 1 failed');
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
