/**
 * `lib/request-guard.ts` and the three refusals the request listener makes before routing: a `//` target that would throw out of `new URL`, a `Host`
 * that could be a rebound public name, and a browser write from another site. The pure cases pin the rules; the router cases pin that the listener
 * actually runs them first, and that a bad target no longer kills the process.
 */

import assert from 'node:assert';

import { testAsync, withServer } from './api-harness.js';
import { parseRequestUrl } from '../server/index.js';
import { crossSiteWrite, hostAllowed, hostname } from '../server/lib/request-guard.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== request guard (host / cross-site / url parse) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('hostname strips port, IPv6 brackets and a trailing root dot', () => {
    assert.equal(hostname('LocalHost:4173'), 'localhost');
    assert.equal(hostname('[::1]:4173'), '::1');
    assert.equal(hostname('evil.example.'), 'evil.example');
  }));

  check(test('loopback, IP literals, single labels and the safe suffixes are always allowed', () => {
    for (const h of [undefined, '', 'localhost:4173', '127.0.0.1:4173', '[::1]:5174', '192.168.1.5', 'mybox:5174',
      'mac.tail1234.ts.net', 'app.localhost', 'box.local:4173']) {
      assert.equal(hostAllowed(h), true, String(h));
    }
  }));

  check(test('a public name is refused, including ones that merely contain a safe word', () => {
    for (const h of ['evil.example', 'evil.example:4173', 'evil.example.', 'localhost.evil.example', 'ts.net.evil.example', 'local.evil.example']) {
      assert.equal(hostAllowed(h), false, h);
    }
  }));

  check(test('ALLOWED_HOSTS admits exact names, .suffix rules (and their apex), and * for anything', () => {
    assert.equal(hostAllowed('abc.ngrok.app', ['abc.ngrok.app']), true);
    assert.equal(hostAllowed('abd.ngrok.app', ['abc.ngrok.app']), false);
    assert.equal(hostAllowed('abc.ngrok.app:443', ['.ngrok.app']), true);
    assert.equal(hostAllowed('ngrok.app', ['.ngrok.app']), true);
    assert.equal(hostAllowed('evilngrok.app', ['.ngrok.app']), false);
    assert.equal(hostAllowed('anything.example', ['*']), true);
    assert.equal(hostAllowed('evil.example', ['', ' ']), false);
  }));

  check(test('safe methods are never a cross-site write, whatever the headers', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', undefined]) {
      assert.equal(crossSiteWrite(m, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: 'localhost:4173' }), false, String(m));
    }
  }));

  check(test('Sec-Fetch-Site decides a write: only same-origin and none pass', () => {
    assert.equal(crossSiteWrite('POST', { 'sec-fetch-site': 'cross-site' }), true);
    assert.equal(crossSiteWrite('post', { 'sec-fetch-site': 'same-site' }), true);
    assert.equal(crossSiteWrite('DELETE', { 'sec-fetch-site': 'cross-site' }), true);
    assert.equal(crossSiteWrite('POST', { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example', host: 'localhost' }), false);
    assert.equal(crossSiteWrite('POST', { 'sec-fetch-site': 'none' }), false);
  }));

  check(test('without Sec-Fetch-Site, Origin must match Host; no browser headers at all passes (hooks, curl)', () => {
    assert.equal(crossSiteWrite('POST', {}), false);
    assert.equal(crossSiteWrite('POST', { host: 'localhost:4173' }), false);
    assert.equal(crossSiteWrite('POST', { origin: 'http://localhost:4173', host: 'localhost:4173' }), false);
    assert.equal(crossSiteWrite('POST', { origin: 'http://evil.example', host: 'localhost:4173' }), true);
    assert.equal(crossSiteWrite('POST', { origin: 'http://localhost:5174', host: 'localhost:4173' }), true);
    assert.equal(crossSiteWrite('POST', { origin: 'null', host: 'localhost:4173' }), true);
    assert.equal(crossSiteWrite('POST', { origin: 'http://localhost:4173' }), true);
  }));

  check(test('parseRequestUrl returns null exactly where new URL would throw', () => {
    for (const t of ['//', '//%zz', '//[', '//:99999']) assert.equal(parseRequestUrl(t), null, t);
    assert.equal(parseRequestUrl(undefined)?.pathname, '/');
    assert.equal(parseRequestUrl('/api/sessions?limit=3')?.searchParams.get('limit'), '3');
  }));

  check(await testAsync('a // target is a 400 and the server keeps serving', async () => {
    await withServer(ENV, async h => {
      for (const t of ['//', '//%zz', '//[']) {
        const reply = await h.req(t);
        assert.equal(reply.status, 400, t);
      }
      assert.equal((await h.req('/api/health')).status, 200);
    });
  }));

  check(await testAsync('a rebound Host is refused before routing; ALLOWED_HOSTS lets a tunnel name through', async () => {
    await withServer(ENV, async h => {
      const refused = await h.req('/api/health', { headers: { Host: 'evil.example' } });
      assert.equal(refused.status, 403);
      assert.match(String(refused.json?.error), /ALLOWED_HOSTS/);
      assert.equal((await h.req('/api/health', { headers: { Host: 'localhost:4173' } })).status, 200);
    });
    await withServer(ENV + 'ALLOWED_HOSTS=evil.example\n', async h => {
      assert.equal((await h.req('/api/health', { headers: { Host: 'evil.example' } })).status, 200);
    });
  }));

  check(await testAsync('a cross-site browser POST is refused with ANSWER_TOKEN empty; same-origin and header-less still reach the route', async () => {
    await withServer(ENV, async h => {
      const body = JSON.stringify({ dirName: 'nope', pinned: true });
      const cross = await h.req('/api/pins', { method: 'POST', body, headers: { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(cross.status, 403);
      assert.equal(cross.json?.error, 'cross-site request refused');
      // Both reach the handler, which rejects the unknown dir on its own terms — anything but the guard's refusal proves the guard let them by.
      const same = await h.req('/api/pins', { method: 'POST', body, headers: { 'Sec-Fetch-Site': 'same-origin' } });
      assert.notEqual(same.json?.error, 'cross-site request refused');
      const bare = await h.req('/api/pins', { method: 'POST', body });
      assert.notEqual(bare.json?.error, 'cross-site request refused');
    });
  }));

  console.log(`\nrequest guard: ${ok}/${total} passed`);
  return total - ok;
}
