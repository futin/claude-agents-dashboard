/**
 * `GET /api/account` — the header chip's endpoint, over the real route table.
 *
 * The profile mapping itself is `account.test.ts`'s job. What is checked here
 * is the layer above it: the route exists, the body is the shape
 * `AccountResponse` promises, `SHOW_USAGE` gates the two usage fields exactly
 * as it does on `/api/sessions`, and an absent profile is `null` rather than a
 * 404 or a 500 — the chip has a signed-out state, not an error state.
 *
 * `SHOW_USAGE` stays **false** in every case but the one that is about it:
 * `getCachedUsageState()` reaches the developer's own keychain and the network,
 * and no test may pass or fail on whether their token happens to be valid.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { clearAccountCache } from '../server/lib/account.js';
import { testAsync, withServer } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

const RECORD = {
  emailAddress: 'someone@example.com',
  fullName: 'Sam Rivers',
  organizationName: 'Example Co',
  seatTier: 'team_tier_1',
  userRateLimitTier: 'default_claude_max_5x',
  hasExtraUsageEnabled: true
};

/** Plant `~/.claude.json` in the harness's throwaway home. */
function plantAccount(home: string, record: unknown): void {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {}, oauthAccount: record }));
  // The reader memoises on mtime+size and this home is new every time, but the
  // module is shared across cases — drop it so nothing leaks between them.
  clearAccountCache();
}

export async function run(): Promise<number> {
  console.log('\n=== GET /api/account ===\n');
  let p = 0, f = 0;
  const check = (ok: boolean): void => { ok ? p++ : f++; };

  check(await testAsync('serves the signed-in profile as display strings', async () => {
    await withServer(ENV, async h => {
      plantAccount(h.home, RECORD);
      const reply = await h.req('/api/account');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json?.profile, {
        name: 'Sam Rivers',
        email: 'someone@example.com',
        organization: 'Example Co',
        plan: 'Max 5×',
        seat: 'Team tier 1',
        extraUsage: true
      });
    });
  }));

  check(await testAsync('SHOW_USAGE=false omits usage and usageStatus, as on /api/sessions', async () => {
    await withServer(ENV, async h => {
      plantAccount(h.home, RECORD);
      const reply = await h.req('/api/account');
      assert.equal(reply.status, 200);
      assert.ok(!('usage' in (reply.json as object)), 'usage must be absent, not null');
      assert.ok(!('usageStatus' in (reply.json as object)), 'usageStatus must be absent');
    });
  }));

  check(await testAsync('no ~/.claude.json is profile:null and still a 200', async () => {
    await withServer(ENV, async h => {
      clearAccountCache();
      const reply = await h.req('/api/account');
      assert.equal(reply.status, 200, 'the chip has a signed-out state, not an error state');
      assert.equal(reply.json?.profile, null);
    });
  }));

  check(await testAsync('a record identifying nobody is profile:null', async () => {
    await withServer(ENV, async h => {
      plantAccount(h.home, { seatTier: 'team_tier_1' });
      const reply = await h.req('/api/account');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.profile, null);
    });
  }));

  check(await testAsync('a torn ~/.claude.json fails open rather than 500-ing', async () => {
    await withServer(ENV, async h => {
      fs.writeFileSync(path.join(h.home, '.claude.json'), '{"oauthAccount":{"emailAdd');
      clearAccountCache();
      const reply = await h.req('/api/account');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.profile, null);
    });
  }));

  console.log(`\nGET /api/account: ${p} passed, ${f} failed`);
  return f;
}
