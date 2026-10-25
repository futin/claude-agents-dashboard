import assert from 'node:assert';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { resolveStaticPath, serveStatic } from '../server/index.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Just enough of a ServerResponse for serveStatic: the status it wrote and the body it ended with. */
function fakeResponse(): { res: http.ServerResponse; done: Promise<{ status: number; body: string }> } {
  let status = 0;
  let resolve!: (v: { status: number; body: string }) => void;
  const done = new Promise<{ status: number; body: string }>((r) => { resolve = r; });
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(buf?: Buffer | string) { resolve({ status, body: buf === undefined ? '' : buf.toString() }); return res; },
  } as unknown as http.ServerResponse;
  return { res, done };
}

/** A dist root that is not the real one, so these cases never depend on cwd. */
const ROOT = path.join(path.sep, 'srv', 'app', 'client', 'dist');
const INDEX = path.join(ROOT, 'index.html');

export async function run(): Promise<number> {
  console.log('\n=== index.ts resolveStaticPath ===\n');
  let p = 0, f = 0;

  if (await test('ordinary asset paths resolve inside the dist root', () => {
    assert.strictEqual(resolveStaticPath('/assets/app.js', ROOT), path.join(ROOT, 'assets', 'app.js'));
    assert.strictEqual(resolveStaticPath('/favicon.ico', ROOT), path.join(ROOT, 'favicon.ico'));
    assert.strictEqual(resolveStaticPath('///assets/app.js', ROOT), path.join(ROOT, 'assets', 'app.js'));
  })) p++; else f++;

  if (await test('the SPA fallback covers the root and the query string is stripped', () => {
    assert.strictEqual(resolveStaticPath('/', ROOT), INDEX);
    assert.strictEqual(resolveStaticPath('', ROOT), INDEX);
    assert.strictEqual(resolveStaticPath('/assets/app.js?v=abc123', ROOT), path.join(ROOT, 'assets', 'app.js'));
  })) p++; else f++;

  // The bug: `startsWith(clientDist)` with no trailing separator is a bare
  // string-prefix test, so a *sibling* directory whose name merely begins with
  // `dist` reads as "inside the dist root" and gets served.
  if (await test('a dist-prefixed sibling directory is refused, not served', () => {
    const siblings = ['dist-secret', 'dist-old', 'dist.bak', 'dist-ssr'];
    for (const sib of siblings) {
      assert.strictEqual(
        resolveStaticPath(`/../${sib}/passwd`, ROOT), INDEX,
        `../${sib}/passwd must fall back to index.html`
      );
      // Prove the sibling really is a bare-prefix match of the root, i.e. that
      // this case is the one the old guard let through.
      assert.ok(path.join(ROOT, '..', sib, 'passwd').startsWith(ROOT), `${sib} is a prefix match`);
    }
  })) p++; else f++;

  if (await test('percent-encoded traversal is decoded and then refused', () => {
    assert.strictEqual(resolveStaticPath('/%2e%2e/dist-secret/passwd', ROOT), INDEX);
    assert.strictEqual(resolveStaticPath('/%2E%2E%2Fdist-secret%2Fpasswd', ROOT), INDEX);
    assert.strictEqual(resolveStaticPath('/..%2f..%2f..%2fetc%2fpasswd', ROOT), INDEX);
  })) p++; else f++;

  if (await test('plain traversal well outside the root still falls back', () => {
    assert.strictEqual(resolveStaticPath('/../../../etc/passwd', ROOT), INDEX);
    assert.strictEqual(resolveStaticPath('/..', ROOT), INDEX);
  })) p++; else f++;

  if (await test('a percent-encoded name inside the root decodes to the real file', () => {
    // The other half of decoding: without it these are served as the literal
    // `%20` / `%C3%A9` spelling, which is not the file on disk.
    assert.strictEqual(resolveStaticPath('/assets/my%20app.css', ROOT), path.join(ROOT, 'assets', 'my app.css'));
    assert.strictEqual(resolveStaticPath('/caf%C3%A9.png', ROOT), path.join(ROOT, 'café.png'));
  })) p++; else f++;

  if (await test('malformed percent-encoding falls back instead of throwing URIError', () => {
    // decodeURIComponent throws synchronously inside the request listener;
    // resolveStaticPath must go through decodePath, which returns null.
    for (const raw of ['/%ZZ', '/%', '/a%', '/assets/%E0%A4%A']) {
      assert.throws(() => decodeURIComponent(raw.slice(1)), URIError, `${raw} throws undecoded`);
      assert.strictEqual(resolveStaticPath(raw, ROOT), INDEX, `${raw} → index.html`);
    }
  })) p++; else f++;

  // `pnpm build` while `pnpm start` serves: an asset that existed a moment ago is gone by the time it is stat'ed. A stat that throws
  // inside the request listener is synchronous, and this process has no uncaughtException handler (server/index.ts), so it must answer
  // instead. The race is forced by having the existence probe report a file that is not there.
  if (await test('a file deleted between the existence check and the stat falls back instead of throwing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-race-'));
    const realExists = fs.existsSync;
    const probe = fs as { existsSync: typeof fs.existsSync };
    try {
      fs.writeFileSync(path.join(root, 'index.html'), 'INDEX');
      probe.existsSync = (() => true) as typeof fs.existsSync;
      const { res, done } = fakeResponse();
      assert.doesNotThrow(() => serveStatic('/assets/vanished.js', res, root));
      probe.existsSync = realExists;
      assert.deepStrictEqual(await done, { status: 200, body: 'INDEX' });
    } finally {
      probe.existsSync = realExists;
      fs.rmSync(root, { recursive: true, force: true });
    }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
