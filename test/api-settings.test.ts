/**
 * `GET/POST /api/settings`, driven through the real route table: the `ANSWER_TOKEN` gate on the write (#202) — every other settings test runs with the
 * token unset, so the 403 branch of `serveSettingsWrite` never ran — and the read's promise never to return the ntfy topic, which is both the address
 * and the credential.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { SETTINGS_FILE, getSettings, resetSettings } from '../server/lib/settings.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const TOKEN = 's3cret';
const GATED = ENV + `ANSWER_TOKEN=${TOKEN}\n`;

function post(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  return h.req('/api/settings', { method: 'POST', body: JSON.stringify(body), headers });
}

/** Each case starts from default settings and leaves them that way. */
async function withSettings(env: string, fn: (h: Harness) => Promise<void>): Promise<void> {
  await withServer(env, async h => {
    resetSettings();
    try { await fn(h); } finally { resetSettings(); }
  });
}

/** A LAN peer as a loopback proxy delivers one: the harness listens on loopback, and a loopback peer writes with no token at all. */
const LAN = { 'X-Forwarded-For': '192.168.1.5' };

export async function run(): Promise<number> {
  console.log('\n=== settings endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  for (const [label, headers] of [
    ['no Authorization header', LAN],
    ['a wrong bearer', { ...LAN, Authorization: 'Bearer nope' }],
    ['the token without the Bearer scheme', { ...LAN, Authorization: TOKEN }]
  ] as const) {
    check(await testAsync(`POST /api/settings with ANSWER_TOKEN set and ${label} is 403 and writes nothing`, async () => {
      await withSettings(GATED, async h => {
        const before = getSettings().idleSecs;
        const reply = await post(h, { idleSecs: before + 60 }, headers);
        assert.equal(reply.status, 403);
        assert.equal(reply.json?.error, 'bad token');
        assert.equal(getSettings().idleSecs, before);
        assert.ok(!fs.existsSync(path.join(h.home, SETTINGS_FILE)), 'nothing written to disk');
      });
    }));
  }

  check(await testAsync('POST /api/settings with ANSWER_TOKEN set and the right bearer is 200 and applies the patch', async () => {
    await withSettings(GATED, async h => {
      const next = getSettings().idleSecs + 60;
      const reply = await post(h, { idleSecs: next }, { ...LAN, Authorization: `Bearer ${TOKEN}` });
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.idleSecs, next);
      assert.equal(getSettings().idleSecs, next);
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.home, SETTINGS_FILE), 'utf8')) as { idleSecs: number };
      assert.equal(onDisk.idleSecs, next);
    });
  }));

  check(await testAsync('GET /api/settings never returns either ntfy topic, only whether one is configured', async () => {
    await withSettings(ENV + 'NTFY_TOPIC=topic-main-x1\nNTFY_TOPIC_DESK=topic-desk-x2\n', async h => {
      const reply = await h.req('/api/settings');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.notifyAvailable, true);
      assert.ok(!reply.raw.includes('topic-main-x1'), reply.raw);
      assert.ok(!reply.raw.includes('topic-desk-x2'), reply.raw);
    });
  }));

  check(await testAsync('GET /api/settings reports usageAvailable from SHOW_USAGE', async () => {
    await withSettings('SHOW_USAGE=true\nSKIP_PROC_SCAN=true\n', async h => {
      assert.equal((await h.req('/api/settings')).json?.usageAvailable, true);
    });
    await withSettings(ENV, async h => {
      assert.equal((await h.req('/api/settings')).json?.usageAvailable, false);
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
