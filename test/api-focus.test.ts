/**
 * `GET /api/focus`, driven through the real route table.
 *
 * The store beneath it (`lib/focus.ts`) is unit-tested on its own. What is
 * covered here is the handler: the loopback guard, the id shape check, and which
 * of the two branches — record-and-close vs redirect — a request lands in. The
 * guard case cannot go over a socket at all (a test client on loopback cannot
 * produce a non-loopback socket address), so it calls `serveFocus` directly with
 * a stub request.
 */

import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { testAsync, withServer } from './api-harness.js';
import { serveFocus } from '../server/api.js';
import { dashboardOpen, notePoll, resetFocus, takeFocus } from '../server/lib/focus.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** What `serveFocus` reads off a request: the socket address and nothing else. */
function stubReq(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

/** Captures what a handler wrote, without a socket. */
function stubRes(): { res: ServerResponse; status: () => number; headers: () => Record<string, string> } {
  let status = 0;
  let headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, h?: Record<string, string>) { status = code; headers = h || {}; return res; },
    end() { return res; }
  } as unknown as ServerResponse;
  return { res, status: () => status, headers: () => headers };
}

export async function run(): Promise<number> {
  console.log('\n=== /api/focus (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* ------------------------------------------------- the two branches */

  check(await testAsync('a tap with a dashboard polling is recorded and answered with the closing page', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      // One real poll, so `dashboardOpen()` is true the way it is in life.
      await h.req('/api/focus/pending');
      assert.equal(dashboardOpen(), true, 'the poll above must have registered');

      const reply = await h.req(`/api/focus?session=${ID}`);
      assert.equal(reply.status, 200);
      assert.match(String(reply.headers['content-type']), /^text\/html/);
      assert.match(reply.raw, /window\.close\(\)/);
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(takeFocus(), ID, 'the tap must be claimable by the next poll');
    });
  }));

  check(await testAsync('a tap with nothing polling redirects instead of recording', async () => {
    await withServer(ENV, async h => {
      // Never poll — a fresh store is "no dashboard open" by construction.
      resetFocus();
      const reply = await h.req(`/api/focus?session=${ID}`);
      assert.equal(reply.status, 302);
      assert.equal(reply.headers['location'], `/?session=${ID}`);
      assert.equal(
        takeFocus(), null,
        'the redirect branch must record nothing — a stored tap would only expire unread'
      );
    });
  }));

  /* ------------------------------------------------- the poll payload */

  check(await testAsync('focusSession is absent from a pending poll with nothing tapped', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      const reply = await h.req('/api/focus/pending');
      assert.equal(reply.status, 200);
      assert.ok(
        !('focusSession' in (reply.json ?? {})),
        'nothing pending must leave the key absent, not present-and-empty'
      );
    });
  }));

  check(await testAsync('focusSession rides exactly one pending poll after a tap', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      await h.req('/api/focus/pending');
      await h.req(`/api/focus?session=${ID}`);

      const first = await h.req('/api/focus/pending');
      assert.equal(first.json?.focusSession, ID);

      const second = await h.req('/api/focus/pending');
      assert.ok(
        !('focusSession' in (second.json ?? {})),
        'consume-once — a second poll must not reopen the drawer'
      );
    });
  }));

  // The regression this endpoint exists for: `/api/sessions` stops the moment
  // another section is opened, so it must not be what keeps `dashboardOpen()`
  // true, and it must not carry the claim either.
  check(await testAsync('the session poll no longer carries or consumes the tap', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      await h.req('/api/focus/pending');
      await h.req(`/api/focus?session=${ID}`);

      const sessions = await h.req('/api/sessions');
      assert.ok(
        !('focusSession' in (sessions.json ?? {})),
        'two consumers in one browser would race each other'
      );
      assert.equal(
        (await h.req('/api/focus/pending')).json?.focusSession, ID,
        'the session poll must not have eaten it'
      );
    });
  }));

  check(await testAsync('the pending poll alone keeps a dashboard counted as open', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      assert.equal(dashboardOpen(), false, 'a fresh store must start closed');
      await h.req('/api/focus/pending');
      assert.equal(
        dashboardOpen(), true,
        'polling only this endpoint — as the shell does on Settings — must count'
      );
      assert.equal((await h.req(`/api/focus?session=${ID}`)).status, 200, 'so /api/focus records rather than redirects');
    });
  }));

  /* ------------------------------------------------- id validation */

  check(await testAsync('a missing session id is a 400', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      assert.equal((await h.req('/api/focus')).status, 400);
    });
  }));

  check(await testAsync('a path-traversal session id is a 400', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      const reply = await h.req('/api/focus?session=' + encodeURIComponent('../../etc/passwd'));
      assert.equal(reply.status, 400);
    });
  }));

  check(await testAsync('the id length boundary is 64, not 65', async () => {
    await withServer(ENV, async h => {
      resetFocus();
      await h.req('/api/focus/pending');
      assert.equal((await h.req(`/api/focus?session=${'a'.repeat(64)}`)).status, 200);
      resetFocus();
      await h.req('/api/focus/pending');
      assert.equal((await h.req(`/api/focus?session=${'a'.repeat(65)}`)).status, 400);
    });
  }));

  /* ------------------------------------------------- the loopback guard
   *
   * Mutation-proof: delete the guard in `serveFocus` and the first case here
   * stops returning 403. The two `X-Forwarded-For` cases are the ones that fail
   * if `classifyAddress` is ever swapped for `classifyOrigin` — that function
   * trusts the left-most forwarded entry, which a remote peer supplies itself.
   */

  check(await testAsync('a non-loopback socket is refused', async () => {
    resetFocus();
    notePoll();
    const { res, status } = stubRes();
    serveFocus(stubReq('100.101.102.103'), res, new URLSearchParams(`session=${ID}`));
    assert.equal(status(), 403);
    assert.equal(takeFocus(), null, 'a refused request must record nothing');
  }));

  check(await testAsync('a tailnet socket claiming to be loopback is still refused', async () => {
    resetFocus();
    notePoll();
    const { res, status } = stubRes();
    serveFocus(
      stubReq('100.101.102.103', { 'x-forwarded-for': '127.0.0.1' }),
      res,
      new URLSearchParams(`session=${ID}`)
    );
    assert.equal(status(), 403, 'the forwarded header must not be able to buy `local`');
    assert.equal(takeFocus(), null);
  }));

  check(await testAsync('a loopback socket is accepted despite a remote forwarded-for', async () => {
    resetFocus();
    notePoll();
    const { res, status } = stubRes();
    serveFocus(
      stubReq('127.0.0.1', { 'x-forwarded-for': '100.101.102.103' }),
      res,
      new URLSearchParams(`session=${ID}`)
    );
    assert.equal(status(), 200, 'the header is ignored in both directions — the socket decides');
    assert.equal(takeFocus(), ID);
  }));

  check(await testAsync('an IPv6 loopback socket is accepted', async () => {
    resetFocus();
    notePoll();
    const { res, status } = stubRes();
    serveFocus(stubReq('::1'), res, new URLSearchParams(`session=${ID}`));
    assert.equal(status(), 200);
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
