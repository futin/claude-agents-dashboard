/**
 * `POST /api/remote-answer` — the app's only runtime kill switch, driven
 * through the real route table.
 *
 * Three things here are the whole reason the endpoint exists, and none of them
 * is visible from `remoteState.ts`'s own tests:
 *
 *   1. **403 without the token.** This flips a security-relevant switch for
 *      every session on the host, from anywhere the listener is reachable —
 *      and the listener binds all interfaces.
 *   2. **409 when `REMOTE_ANSWER=false`.** A UI toggle must not be able to
 *      override the config kill switch, and it must say so rather than
 *      pretending to have worked.
 *   3. **`released` is the real count.** Switching off releases the waits
 *      already held, across all three stores, so their terminal dialogs appear
 *      within a second instead of sitting out a ten-minute deadline. If
 *      `released` under-counts, a hook is stranded; the number is the only
 *      observable proof the release happened.
 */

import assert from 'node:assert';

import { testAsync, until, withServer } from './api-harness.js';
import { messageSessionIds } from '../server/lib/messages.js';
import { pendingSessionIds } from '../server/lib/pending.js';
import { planSessionIds } from '../server/lib/plans.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

const QUESTION_INPUT = {
  questions: [{ header: 'Pick', question: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] }]
};
const PLAN_INPUT = { plan: '## Plan\n\nDo the thing.' };

export async function run(): Promise<number> {
  console.log('\n=== remote-answer toggle (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('POST /api/remote-answer without a valid token is 403', async () => {
    await withServer(`${ENV}ANSWER_TOKEN=s3cret\n`, async h => {
      // No header at all, the wrong secret, and the right secret without the
      // `Bearer ` prefix — `tokenOk` compares the whole header string.
      const attempts: Array<Record<string, string>> = [
        {}, { Authorization: 'Bearer wrong' }, { Authorization: 's3cret' }
      ];
      for (const headers of attempts) {
        const reply = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false }), headers
        });
        assert.equal(reply.status, 403, `headers ${JSON.stringify(headers)} must be refused`);
        assert.equal(reply.json?.error, 'bad token');
      }
      // And the switch is genuinely untouched, not merely reported as refused
      // — `/api/health` spreads the live `getState` result.
      const state = await h.req('/api/health');
      assert.equal(state.json?.enabled, true, 'a refused flip must not have flipped anything');
    });
  }));

  check(await testAsync('POST /api/remote-answer with the right token is 200', async () => {
    await withServer(`${ENV}ANSWER_TOKEN=s3cret\n`, async h => {
      const reply = await h.req('/api/remote-answer', {
        method: 'POST', body: JSON.stringify({ enabled: false }),
        headers: { Authorization: 'Bearer s3cret' }
      });
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.enabled, false);
      assert.equal(reply.json?.available, true);
      assert.equal(reply.json?.remoteAnswer, false);
    });
  }));

  check(await testAsync('REMOTE_ANSWER=false: the toggle is 409, and cannot re-enable the feature', async () => {
    await withServer(`${ENV}REMOTE_ANSWER=false\n`, async h => {
      const reply = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      assert.equal(reply.status, 409);
      assert.equal(reply.json?.error, 'disabled by REMOTE_ANSWER=false');
      // The point of the 409: the env gate still holds afterwards.
      const wait = await h.req('/api/questions/wait', {
        method: 'POST', body: JSON.stringify({ sessionId: ID_A, toolInput: QUESTION_INPUT })
      });
      assert.equal(wait.status, 404);
      assert.equal(wait.json?.error, 'remote answers disabled');
    });
  }));

  check(await testAsync('a body without a boolean `enabled` is 400', async () => {
    await withServer(ENV, async h => {
      for (const body of ['{not json', '{}', '{"enabled":"false"}', '{"enabled":1}', 'null']) {
        const reply = await h.req('/api/remote-answer', { method: 'POST', body });
        assert.equal(reply.status, 400, `body ${body} must be refused`);
        assert.equal(reply.json?.error, 'expected {enabled: boolean}');
      }
    });
  }));

  check(await testAsync('GET /api/remote-answer is 405 — the switch is POST-only', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/remote-answer');
      assert.equal(reply.status, 405);
      assert.equal(reply.json?.error, 'method not allowed');
    });
  }));

  check(await testAsync('switching off releases every held wait and reports the count', async () => {
    await withServer(ENV, async h => {
      h.plant(ID_A);
      h.plant(ID_B);
      // One of each kind, across two sessions: the stores are keyed by session,
      // so a single session could not hold a question and a plan at once.
      const question = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID_A, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      const plan = h.open('/api/plans/wait', {
        body: JSON.stringify({ sessionId: ID_B, toolInput: PLAN_INPUT, timeoutMs: 600_000 })
      });
      const message = h.open('/api/messages/wait', {
        body: JSON.stringify({ sessionId: ID_A, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().size === 1, 'the question wait registers');
      await until(() => planSessionIds().size === 1, 'the plan wait registers');
      await until(() => messageSessionIds().size === 1, 'the message wait registers');

      const reply = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.enabled, false);
      // Three stores, three holds. A count of 1 or 2 here means one kind of
      // hook is being left to sit out its deadline.
      assert.equal(reply.json?.released, 3, 'all three stores are dismissed by one switch');

      // Every hook's held response actually completed, with the status that
      // sends it back to its terminal dialog.
      for (const [label, held] of [['question', question], ['plan', plan], ['message', message]] as const) {
        const result = await held.reply;
        assert.equal(result.status, 200, `${label} hook must be answered`);
        assert.equal(result.json?.status, 'dismissed', `${label} hook falls back to the terminal`);
      }
      assert.equal(pendingSessionIds().size, 0);
      assert.equal(planSessionIds().size, 0);
      assert.equal(messageSessionIds().size, 0);
    });
  }));

  check(await testAsync('switching ON releases nothing — released is 0', async () => {
    await withServer(ENV, async h => {
      h.plant(ID_A);
      const question = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID_A, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID_A), 'the question wait registers');

      const reply = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.enabled, true);
      assert.equal(reply.json?.released, 0, 'turning the feature on must not dismiss live waits');
      assert.ok(pendingSessionIds().has(ID_A), 'the wait is still held');
      question.abort();
    });
  }));

  check(await testAsync('once off, a new wait is refused — the switch is not cosmetic', async () => {
    await withServer(ENV, async h => {
      h.plant(ID_A);
      const off = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      assert.equal(off.status, 200);

      const wait = await h.req('/api/questions/wait', {
        method: 'POST', body: JSON.stringify({ sessionId: ID_A, toolInput: QUESTION_INPUT })
      });
      assert.equal(wait.status, 404);
      assert.equal(wait.json?.error, 'remote answers disabled');
      assert.equal(pendingSessionIds().size, 0);

      // …and back on again, so the off state is not a one-way door.
      const on = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      assert.equal(on.status, 200);
      const again = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID_A, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID_A), 'waits are accepted again');
      again.abort();
    });
  }));

  check(await testAsync('the flip is persisted to .remote-answer.json in cwd', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.persisted, true);
      const { default: fs } = await import('node:fs');
      const { default: path } = await import('node:path');
      const raw = fs.readFileSync(path.join(h.home, '.remote-answer.json'), 'utf8');
      assert.deepEqual(JSON.parse(raw), { enabled: false });
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
