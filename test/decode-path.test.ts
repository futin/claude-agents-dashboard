import assert from 'node:assert';

import { decodePath } from '../server/index.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Every spelling of broken percent-encoding a request line can carry. */
const MALFORMED = ['%ZZ', '%', '%2', 'abc%', '%FF', '%C0%80', '%E0%A4%A'];

export function run(): number {
  console.log('\n=== index.ts decodePath ===\n');
  let p = 0, f = 0;

  if (test('valid encodings decode as decodeURIComponent would', () => {
    assert.strictEqual(decodePath('7f3c1e2a-0000-4aaa-8bbb-000000000001'), '7f3c1e2a-0000-4aaa-8bbb-000000000001');
    assert.strictEqual(decodePath('a%20b'), 'a b');
    assert.strictEqual(decodePath('caf%C3%A9'), 'café');
    assert.strictEqual(decodePath('%25'), '%');
    assert.strictEqual(decodePath('a+b'), 'a+b'); // `+` is not a space in a path segment
    assert.strictEqual(decodePath(''), '');
  })) p++; else f++;

  if (test('malformed encodings return null instead of throwing URIError', () => {
    for (const raw of MALFORMED) {
      // The bug this guards: an unguarded decodeURIComponent throws here,
      // synchronously inside the request listener, killing the process.
      assert.throws(() => decodeURIComponent(raw), URIError, `${raw} should throw undecoded`);
      assert.strictEqual(decodePath(raw), null, `${raw} → null`);
    }
  })) p++; else f++;

  if (test('the URL parse leaves bad encoding in place, so the id-scoped routes see it', () => {
    // `new URL` neither normalises nor rejects `%ZZ` — the route regex matches
    // and hands the raw segment to decodePath, which is where it must stop.
    const pathname = new URL('/api/sessions/%ZZ/question', 'http://local').pathname;
    assert.strictEqual(pathname, '/api/sessions/%ZZ/question');
    const question = pathname.match(/^\/api\/sessions\/([^/]+)\/question$/);
    assert.ok(question, 'question route still matches');
    assert.strictEqual(decodePath(question[1]), null);
  })) p++; else f++;

  if (test('the chat route matches the raw request line, and stops there too', () => {
    // chat/detail match `req.url`, not `u.pathname` — same guard, different input.
    const chat = '/api/sessions/%ZZ/chat?after=0'.match(/^\/api\/sessions\/([^/?]+)\/chat(?:[?#]|$)/);
    assert.ok(chat, 'chat route still matches');
    assert.strictEqual(decodePath(chat[1]), null);
    const detail = '/api/sessions/%ZZ'.match(/^\/api\/sessions\/([^/?]+)/);
    assert.ok(detail, 'detail route still matches');
    assert.strictEqual(decodePath(detail[1]), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
