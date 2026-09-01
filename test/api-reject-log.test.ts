/**
 * A refused write leaves a trace on the server — the observability half of
 * backlog bug-6.
 *
 * The incident that motivates this file: the installer never wrote
 * `~/.claude/hooks/dashboard-token`, so every hook POST arrived without an auth
 * header and every one came back 403. Nothing anywhere said so. The hooks use
 * `curl -sf` and exit 0 on failure, `GET /api/health` is untokened and answered
 * fine, and the server printed nothing at all for a rejected write. Push
 * notifications and remote answers were both dead for twelve hours while every
 * surface a person checks looked healthy.
 *
 * One line on stderr per rejected path is the whole remedy, and the two
 * properties below are what make it worth having:
 *
 *   - **It is throttled.** A held `stop` hook retries; an unthrottled line would
 *     scroll the real output away and teach people to ignore it.
 *   - **It never carries the token.** Not the expected one, not the received
 *     header, not a prefix of either. The method and path are the diagnostic;
 *     anything more turns a log file into a credential store.
 */

import assert from 'node:assert';

import { resetRejectedWriteLog } from '../server/api.js';
import { testAsync, withServer } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const TOKEN = 'super-secret-token';

/** Collect everything `console.error` is handed while `fn` runs. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.error = real; }
  return lines;
}

/** Only the rejected-write lines — anything else the server says is not ours. */
function rejectLines(lines: string[]): string[] {
  return lines.filter(l => l.includes('rejected write'));
}

export async function run(): Promise<number> {
  console.log('\n=== rejected writes are audible (api.ts tokenOk) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('a 403 prints one line naming the method and path', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        const reply = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false })
        });
        assert.equal(reply.status, 403, 'precondition: the write is refused');
      });
    });
    const ours = rejectLines(lines);
    assert.equal(ours.length, 1, `exactly one line, got ${JSON.stringify(ours)}`);
    assert.match(ours[0], /^\[dashboard] rejected write: POST \/api\/remote-answer \(bad or missing token\)$/);
  }));

  check(await testAsync('the line carries no part of the token, sent or expected', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        const reply = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false }),
          headers: { Authorization: 'Bearer wrong-token-9f2b' }
        });
        assert.equal(reply.status, 403);
      });
    });
    const joined = rejectLines(lines).join('\n');
    assert.equal(rejectLines(lines).length, 1);
    // Both directions: the configured secret and whatever the caller sent.
    for (const secret of [TOKEN, 'super', 'wrong-token-9f2b', 'wrong', 'Bearer']) {
      assert.ok(!joined.includes(secret), `"${secret}" must not appear in: ${joined}`);
    }
  }));

  check(await testAsync('repeats of the same path are throttled to one line', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        for (let i = 0; i < 5; i++) {
          const reply = await h.req('/api/remote-answer', {
            method: 'POST', body: JSON.stringify({ enabled: false })
          });
          assert.equal(reply.status, 403);
        }
      });
    });
    assert.equal(rejectLines(lines).length, 1, 'a retrying hook must not flood the log');
  }));

  check(await testAsync('a different path gets its own line — the throttle is per path', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        const a = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false })
        });
        assert.equal(a.status, 403);
        const b = await h.req('/api/notify/test', { method: 'POST', body: '{}' });
        assert.equal(b.status, 403);
      });
    });
    const ours = rejectLines(lines);
    assert.equal(ours.length, 2, `one per path, got ${JSON.stringify(ours)}`);
    assert.ok(ours.some(l => l.includes('POST /api/remote-answer')));
    assert.ok(ours.some(l => l.includes('POST /api/notify/test')));
  }));

  check(await testAsync('a query string is not logged — only the path', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        const reply = await h.req('/api/remote-answer?token=leaked-in-a-url', {
          method: 'POST', body: JSON.stringify({ enabled: false })
        });
        assert.equal(reply.status, 403);
      });
    });
    const ours = rejectLines(lines);
    assert.equal(ours.length, 1);
    assert.ok(!ours[0].includes('leaked-in-a-url'), `query must be stripped: ${ours[0]}`);
  }));

  check(await testAsync('an accepted write says nothing', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(`${ENV}ANSWER_TOKEN=${TOKEN}\n`, async h => {
        const reply = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false }),
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        assert.equal(reply.status, 200);
      });
    });
    assert.deepEqual(rejectLines(lines), [], 'the log is for refusals only');
  }));

  check(await testAsync('with no ANSWER_TOKEN configured nothing is refused or logged', async () => {
    resetRejectedWriteLog();
    const lines = await captureErrors(async () => {
      await withServer(ENV, async h => {
        const reply = await h.req('/api/remote-answer', {
          method: 'POST', body: JSON.stringify({ enabled: false })
        });
        assert.equal(reply.status, 200, 'an unset token leaves the writes open, as before');
      });
    });
    assert.deepEqual(rejectLines(lines), []);
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
