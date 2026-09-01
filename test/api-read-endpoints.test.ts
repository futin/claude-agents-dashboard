/**
 * The three read endpoints, driven through the real route table:
 * `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/chat`.
 *
 * Their readers (`scan.ts`, `agents-cache.ts`, `chat.ts`) are well covered on
 * their own. What is covered *here* is the handler layer above them and the
 * routing below them: the scan-knob query params and their caps, the `ID_RE`
 * shape check, the not-found path staying a 404 rather than a 500, the
 * cursor validation, and — the reason these go over a socket at all — the
 * route-order rule that `:id/chat` must be matched before `:id`, which no unit
 * test of either handler can see.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import { appSessionsRoot, resetArchivedCache } from '../server/lib/archived.js';

/** A session id that satisfies `ID_RE` and looks like a real transcript name. */
const ID = '11111111-1111-4111-8111-111111111111';

/** No usage cache, no `ps`, no push — see `api-harness.ts`. */
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/**
 * Write one desktop-app session record under the throwaway `$HOME`, as the app
 * does when you archive ("delete") a session from its list.
 */
function plantAppRecord(home: string, cliSessionId: string, isArchived: boolean): void {
  const dir = path.join(appSessionsRoot(home), 'install-1', 'account-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `local_${cliSessionId}.json`),
    JSON.stringify({ sessionId: `local_${cliSessionId}`, cliSessionId, isArchived, name: 'a session' })
  );
}

export async function run(): Promise<number> {
  console.log('\n=== read endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* --------------------------------------------------------- /api/sessions */

  check(await testAsync('GET /api/sessions with no params is 200 with a sessions array', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/sessions');
      assert.equal(reply.status, 200);
      assert.ok(Array.isArray(reply.json?.sessions), 'sessions must be an array');
      assert.equal(reply.json?.error, undefined, 'a healthy scan sets no error flag');
      assert.ok(reply.json?.totals, 'totals is part of the contract');
    });
  }));

  check(await testAsync('GET /api/sessions omits a session the desktop app archived', async () => {
    await withServer(ENV, async h => {
      resetArchivedCache();
      h.plant(ID);
      plantAppRecord(h.home, ID, true);
      const reply = await h.req('/api/sessions');
      assert.equal(reply.status, 200);
      const ids = (reply.json?.sessions as { id: string }[]).map(s => s.id);
      assert.deepEqual(ids, [], 'the archived session must not be listed');
    });
  }));

  check(await testAsync('GET /api/sessions still lists a session whose app record is not archived', async () => {
    await withServer(ENV, async h => {
      resetArchivedCache();
      h.plant(ID);
      plantAppRecord(h.home, ID, false);
      const reply = await h.req('/api/sessions');
      assert.equal(reply.status, 200);
      const ids = (reply.json?.sessions as { id: string }[]).map(s => s.id);
      assert.deepEqual(ids, [ID]);
    });
  }));

  check(await testAsync('GET /api/sessions lists a session with no app record at all (a terminal run)', async () => {
    await withServer(ENV, async h => {
      resetArchivedCache();
      h.plant(ID);
      const reply = await h.req('/api/sessions');
      assert.equal(reply.status, 200);
      const ids = (reply.json?.sessions as { id: string }[]).map(s => s.id);
      assert.deepEqual(ids, [ID], 'no record to mirror ⇒ nothing to hide');
    });
  }));

  check(await testAsync('GET /api/sessions honours the ?limit= scan knob', async () => {
    await withServer('SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nMAX_SESSIONS=12\n', async h => {
      assert.equal(h.cfg.maxSessions, 12, 'the .env default the override must beat');
      const reply = await h.req('/api/sessions?limit=3');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.maxSessions, 3);
    });
  }));

  check(await testAsync('GET /api/sessions clamps ?limit= to the SCAN_CAPS ceiling', async () => {
    await withServer(ENV, async h => {
      // Unclamped this would tail-read thousands of transcripts every 3s poll.
      const reply = await h.req('/api/sessions?limit=99999');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.maxSessions, 50);
    });
  }));

  check(await testAsync('GET /api/sessions falls back to the configured default on an unusable ?limit=', async () => {
    await withServer('SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nMAX_SESSIONS=12\n', async h => {
      const reply = await h.req('/api/sessions?limit=not-a-number');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.maxSessions, 12, 'a junk knob must not zero the list');
    });
  }));

  /* ----------------------------------------------------- /api/sessions/:id */

  check(await testAsync('GET /api/sessions/:id is 200 with the session detail shape', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req(`/api/sessions/${ID}`);
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.id, ID);
      assert.ok(Array.isArray(reply.json?.agents), 'detail carries agents, not sessions');
      assert.equal(reply.json?.error, undefined);
    });
  }));

  check(await testAsync('GET /api/sessions/:id for an unknown id is 404 — never a 500', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/sessions/99999999-9999-4999-8999-999999999999');
      assert.equal(reply.status, 404, 'an id nobody has is a miss, not a server fault');
      assert.equal(reply.json?.error, true);
      assert.deepEqual(reply.json?.agents, [], 'the empty payload is still well-formed');
    });
  }));

  check(await testAsync('GET /api/sessions/:id with an id that fails ID_RE is 400', async () => {
    await withServer(ENV, async h => {
      // `/` would re-route, so this uses the other characters ID_RE excludes.
      const reply = await h.req('/api/sessions/not$a$valid$id');
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, true);
    });
  }));

  check(await testAsync('GET /api/sessions/%ZZ is 400 "bad path encoding", not a dead process', async () => {
    await withServer(ENV, async h => {
      // A bare `decodeURIComponent` here throws synchronously in the request
      // listener, with no uncaughtException handler — see `decodePath`.
      const reply = await h.req('/api/sessions/%ZZ');
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'bad path encoding');
      // Still serving afterwards is the actual claim being made.
      assert.equal((await h.req('/api/sessions')).status, 200);
    });
  }));

  /* ------------------------------------------------ /api/sessions/:id/chat */

  check(await testAsync('the chat route wins over the detail route for /api/sessions/:id/chat', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req(`/api/sessions/${ID}/chat`);
      assert.equal(reply.status, 200);
      assert.ok(Array.isArray(reply.json?.messages), 'a chat page, not a detail payload');
      assert.equal(reply.json?.agents, undefined, "the detail regex must not have swallowed '/chat'");
    });
  }));

  check(await testAsync('GET /api/sessions/:id/chat for an unknown id is 404', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req('/api/sessions/99999999-9999-4999-8999-999999999999/chat');
      assert.equal(reply.status, 404);
      assert.equal(reply.json?.error, true);
      assert.deepEqual(reply.json?.messages, []);
    });
  }));

  check(await testAsync('GET /api/sessions/:id/chat with a malformed ?before= cursor is 400', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      for (const cursor of ['abc', '-1', '1.5', 'NaN', '1e3x']) {
        const reply = await h.req(`/api/sessions/${ID}/chat?before=${cursor}`);
        assert.equal(reply.status, 400, `before=${JSON.stringify(cursor)} must be refused`);
        assert.equal(reply.json?.error, true);
      }
    });
  }));

  check(await testAsync('an empty ?before= is offset 0, not a refusal — pinning the Number("") edge', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      // `Number('') === 0`, so the guard reads a present-but-empty cursor as
      // "the very start of the file" rather than as junk. Harmless (offset 0
      // is an empty page by definition), but it is a real branch, and pinning
      // it here means a future tightening of the guard is a deliberate change
      // rather than an accident.
      const reply = await h.req(`/api/sessions/${ID}/chat?before=`);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json?.messages, []);
      assert.equal(reply.json?.hasMore, false);
    });
  }));

  check(await testAsync('GET /api/sessions/:id/chat with a malformed ?after= cursor is 400', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const reply = await h.req(`/api/sessions/${ID}/chat?after=nope`);
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, true);
    });
  }));

  check(await testAsync('?before= pages the window above the tail, contiguously', async () => {
    await withServer(ENV, async h => {
      // 120 messages against a 100-message page: the tail is msg-020..msg-119
      // and the page above it is msg-000..msg-019.
      const records = Array.from({ length: 120 }, (_, i) =>
        userRecord(`u-${String(i).padStart(3, '0')}`, `msg-${String(i).padStart(3, '0')}`, h.home));
      h.plant(ID, records);

      const tail = await h.req(`/api/sessions/${ID}/chat`);
      assert.equal(tail.status, 200);
      const tailMsgs = tail.json?.messages as Array<{ uuid: string }>;
      assert.equal(tailMsgs.length, 100, 'CHAT_PAGE_MESSAGES bounds the tail');
      assert.equal(tailMsgs[0].uuid, 'u-020');
      assert.equal(tail.json?.hasMore, true);
      const headOffset = tail.json?.headOffset as number;
      assert.ok(headOffset > 0, 'there is a window above this one');

      const above = await h.req(`/api/sessions/${ID}/chat?before=${headOffset}`);
      assert.equal(above.status, 200);
      const aboveMsgs = above.json?.messages as Array<{ uuid: string }>;
      assert.equal(aboveMsgs.length, 20);
      assert.equal(aboveMsgs[0].uuid, 'u-000');
      assert.equal(aboveMsgs[19].uuid, 'u-019', 'the page above ends where the tail begins');
      assert.equal(above.json?.hasMore, false, 'nothing left above the first record');
    });
  }));

  check(await testAsync('?after= returns only what was appended since the cursor', async () => {
    await withServer(ENV, async h => {
      const first = [userRecord('u-000', 'msg-000', h.home)];
      h.plant(ID, first);
      const tail = await h.req(`/api/sessions/${ID}/chat`);
      const cursor = tail.json?.cursor as number;

      h.plant(ID, [...first, userRecord('u-001', 'msg-001', h.home)]);
      const after = await h.req(`/api/sessions/${ID}/chat?after=${cursor}`);
      assert.equal(after.status, 200);
      const msgs = after.json?.messages as Array<{ uuid: string }>;
      assert.deepEqual(msgs.map(m => m.uuid), ['u-001'], 'the live tail is incremental');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
