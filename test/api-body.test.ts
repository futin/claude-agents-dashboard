import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { readJsonBody, serveSettingsWrite } from '../server/api.js';
import { loadConfig } from '../server/lib/config.js';
import { resetSettings } from '../server/lib/settings.js';

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; json: any };

/**
 * POST `body` to a one-shot server running `handler`, and return the reply.
 *
 * `settle` guarantees the server closes exactly once and the promise resolves
 * exactly once — an over-cap body is answered while the client is still
 * uploading, so the client's *request* stream can legitimately error (EPIPE /
 * ECONNRESET) after the response has already been read in full. Without this,
 * a bare `http.request` has no default `'error'` listener and that late error
 * becomes an unhandled throw that kills the whole `pnpm test` process instead
 * of failing one case.
 */
function post(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, body: Buffer
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      srv.close();
      fn();
    };
    srv.on('error', e => settle(() => reject(e)));
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      const req = http.request(
        { port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } },
        res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            const json = (() => { try { return JSON.parse(raw); } catch { return null; } })();
            settle(() => resolve({ status: res.statusCode || 0, headers: res.headers, json }));
          });
          res.on('error', e => settle(() => reject(e)));
        }
      );
      req.on('error', e => settle(() => reject(e)));
      req.end(body);
    });
  });
}

/** Config lives in a throwaway .env, so a developer's real one can't leak in. */
function withEnvFile(body: string, fn: (cfg: ReturnType<typeof loadConfig>) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-body-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, body);
  return fn(loadConfig({ envPath })).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** The settings file is resolved from cwd, so the endpoint test runs in a tmpdir. */
async function inTmpCwd(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-body-cwd-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    resetSettings();
    await fn();
  } finally {
    process.chdir(prev);
    resetSettings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(): Promise<number> {
  console.log('\n=== api body readers ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('an over-cap body still lets the handler answer', async () => {
    // The regression: `readJsonBody` used to `req.destroy()` on overflow. `req`
    // and `res` share one socket, so that killed the connection before the
    // handler's reply could go out and the client saw a bare ECONNRESET.
    const reply = await post((req, res) => {
      void readJsonBody(req, 8).then(body => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad body', body }));
      });
    }, Buffer.from(JSON.stringify({ pad: 'x'.repeat(64) })));
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.json, { error: 'bad body', body: null });
  }));

  check(await testAsync('an under-cap body still parses', async () => {
    const reply = await post((req, res) => {
      void readJsonBody(req, 1024).then(body => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ body }));
      });
    }, Buffer.from(JSON.stringify({ idleSecs: 42 })));
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json, { body: { idleSecs: 42 } });
  }));

  check(await testAsync('POST /api/settings answers 400 to an over-cap body', async () => {
    await inTmpCwd(async () => {
      await withEnvFile('', async cfg => {
        // 64KB + slack: big enough to still be uploading when the reply goes
        // out, which is exactly the window the old `req.destroy()` broke.
        const body = Buffer.from(JSON.stringify({ pad: 'x'.repeat(70 * 1024) }));
        const reply = await post((req, res) => void serveSettingsWrite(cfg, req, res), body);
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error?.startsWith('expected'), true);
        // The other half of the fix: the socket does close, just *after* the
        // response has been flushed, so an over-cap client can't hold the
        // connection while it finishes uploading a body we already refused.
        assert.equal(reply.headers.connection, 'close');
      });
    });
  }));

  check(await testAsync('POST /api/settings still answers 400 to malformed JSON', async () => {
    await inTmpCwd(async () => {
      await withEnvFile('', async cfg => {
        const reply = await post(
          (req, res) => void serveSettingsWrite(cfg, req, res), Buffer.from('{not json')
        );
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error?.startsWith('expected'), true);
      });
    });
  }));

  check(await testAsync('POST /api/settings still accepts a valid body', async () => {
    await inTmpCwd(async () => {
      await withEnvFile('', async cfg => {
        const reply = await post(
          (req, res) => void serveSettingsWrite(cfg, req, res), Buffer.from(JSON.stringify({ idleSecs: 90 }))
        );
        assert.equal(reply.status, 200);
        assert.equal(reply.json?.idleSecs, 90);
      });
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
