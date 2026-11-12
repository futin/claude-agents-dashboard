/**
 * Every id-scoped route in `server/index.ts`, sent a malformed percent-encoded id over a real socket.
 *
 * `decode-path.test.ts` proves `decodePath` itself returns null; this proves each route actually calls it. A site that went back to a bare
 * `decodeURIComponent` throws a `URIError` synchronously inside the request listener, and with no `uncaughtException` handler that takes the
 * dashboard down (see `decodePath`'s comment). Here the listener is wrapped so that throw comes back as a 500 and fails one case instead of the run.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { testAsync, withServer } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** One row per `decodePath` call site that takes an id or a name out of the URL. POST where the route refuses other methods before decoding. */
const ROUTES: [method: string, pathname: string][] = [
  ['POST', '/api/routines/%ZZ/run'],
  ['GET', '/api/routines/%ZZ'],
  ['POST', '/api/spawn/%ZZ/stop'],
  ['GET', '/api/sessions/%ZZ/row'],
  ['GET', '/api/sessions/%ZZ/question'],
  ['POST', '/api/sessions/%ZZ/answer'],
  ['GET', '/api/sessions/%ZZ/plan'],
  ['GET', '/api/sessions/%ZZ/pr'],
  ['POST', '/api/sessions/%ZZ/plan-answer'],
  ['POST', '/api/sessions/%ZZ/stop'],
  ['GET', '/api/sessions/%ZZ/message'],
  ['POST', '/api/sessions/%ZZ/message-answer'],
  ['GET', '/api/sessions/%ZZ/chat?after=0'],
  ['GET', '/api/sessions/%ZZ/spend'],
  ['GET', '/api/sessions/%ZZ']
];

export async function run(): Promise<number> {
  console.log('\n=== id-scoped routes × malformed encoding ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  // The table above is only complete while it has one row per site. A 16th route added with `decodePath` fails here until it gets its row.
  check(await testAsync('the table has one row per id-scoped decodePath site in server/index.ts', async () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.ts'), 'utf8');
    const sites = src.match(/const (?:id|name) = decodePath\(/g) ?? [];
    assert.strictEqual(sites.length, ROUTES.length);
  }));

  const threw: string[] = [];
  const guard = (listener: http.RequestListener): http.RequestListener => (req, res) => {
    try { listener(req, res); }
    catch (e) {
      threw.push(`${req.method} ${req.url}: ${(e as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'listener threw' }));
    }
  };

  for (const [method, pathname] of ROUTES) {
    check(await testAsync(`${method} ${pathname} answers 400 "bad path encoding" and the server keeps answering`, async () => {
      threw.length = 0;
      await withServer(ENV, async h => {
        const reply = await h.req(pathname, method === 'POST' ? { method, body: '' } : { method });
        assert.deepStrictEqual(threw, [], 'the listener threw instead of answering');
        assert.strictEqual(reply.status, 400);
        assert.strictEqual(reply.json?.error, 'bad path encoding');
        assert.strictEqual((await h.req('/api/sessions')).status, 200);
      }, guard);
    }));
  }

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
