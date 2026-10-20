import assert from 'node:assert';

import { createDeepLink, readRunParam, readSessionParam, readViewParam } from '../client/src/lib/deepLink.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== deepLink.ts ===\n');
  let p = 0, f = 0;

  if (test('reads a session id', () => {
    assert.strictEqual(
      readSessionParam('?session=abc12345-0000-0000-0000-000000000000'),
      'abc12345-0000-0000-0000-000000000000'
    );
  })) p++; else f++;

  if (test('reads it alongside other params', () => {
    assert.strictEqual(readSessionParam('?x=1&session=abc12345&y=2'), 'abc12345');
  })) p++; else f++;

  if (test('no param yields null', () => {
    assert.strictEqual(readSessionParam(''), null);
    assert.strictEqual(readSessionParam('?other=1'), null);
    assert.strictEqual(readSessionParam('?session='), null);
  })) p++; else f++;

  if (test('rejects anything not shaped like a session id', () => {
    // The value reaches a find() over the poll's list, never a path — but a
    // shape check keeps junk out of the drawer key and out of any future use.
    assert.strictEqual(readSessionParam('?session=../../etc/passwd'), null);
    assert.strictEqual(readSessionParam('?session=<script>'), null);
    assert.strictEqual(readSessionParam('?session=' + 'a'.repeat(200)), null);
  })) p++; else f++;

  if (test('survives a malformed query string', () => {
    assert.strictEqual(readSessionParam('?%'), null);
  })) p++; else f++;

  if (test('reads view=git, alone or beside a session', () => {
    assert.strictEqual(readViewParam('?view=git'), 'git');
    assert.strictEqual(readViewParam('?session=abc12345&view=git'), 'git');
  })) p++; else f++;

  if (test('any other view, or none, yields null', () => {
    assert.strictEqual(readViewParam(''), null);
    assert.strictEqual(readViewParam('?view='), null);
    assert.strictEqual(readViewParam('?view=pinned'), null);
    assert.strictEqual(readViewParam('?view=GIT'), null);
    assert.strictEqual(readViewParam('?%'), null);
  })) p++; else f++;

  const UUID = '0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
  const fake = (search: string) => {
    const strips: string[] = [];
    const where = { location: { search, pathname: '/app' }, history: { replaceState: (_s: unknown, _t: string, url?: string | URL | null) => { strips.push(String(url)); } } };
    return { link: createDeepLink(where), strips };
  };

  if (test('both params are read in one pass, whichever accessor runs first, and the URL is stripped once', () => {
    const { link, strips } = fake(`?session=${UUID}&view=git`);
    assert.strictEqual(link.view(), 'git');
    assert.strictEqual(link.session(), UUID);
    assert.strictEqual(link.view(), 'git');
    assert.deepStrictEqual(strips, ['/app']);
  })) p++; else f++;

  if (test('a URL with neither param is left alone', () => {
    const { link, strips } = fake('?other=1');
    assert.strictEqual(link.session(), null);
    assert.strictEqual(link.view(), null);
    assert.deepStrictEqual(strips, []);
  })) p++; else f++;

  if (test('view=git hands out the git tab once, then null', () => {
    const { link } = fake('?view=git');
    assert.strictEqual(link.takeTab(), 'git');
    assert.strictEqual(link.takeTab(), null);
    assert.strictEqual(link.view(), 'git');
  })) p++; else f++;

  if (test('a session param outranks view=git: no tab is handed out', () => {
    const { link } = fake(`?session=${UUID}&view=git`);
    assert.strictEqual(link.takeTab(), null);
  })) p++; else f++;

  if (test('reads view=schedules beside git; other casings and views stay null', () => {
    assert.strictEqual(readViewParam('?view=schedules'), 'schedules');
    assert.strictEqual(readViewParam('?view=schedules&run=abc'), 'schedules');
    assert.strictEqual(readViewParam('?view=Schedules'), null);
    assert.strictEqual(readViewParam('?view=schedule'), null);
  })) p++; else f++;

  if (test('reads a run id of either shape and refuses anything else', () => {
    assert.strictEqual(readRunParam('?run=abc'), 'abc');
    assert.strictEqual(readRunParam(`?view=schedules&run=${UUID}`), UUID);
    assert.strictEqual(readRunParam('?run=refused-mac-pull-pins-1760000000000'), 'refused-mac-pull-pins-1760000000000');
    assert.strictEqual(readRunParam(''), null);
    assert.strictEqual(readRunParam('?run='), null);
    assert.strictEqual(readRunParam('?run=../../etc/passwd'), null);
    assert.strictEqual(readRunParam('?run=<script>'), null);
    assert.strictEqual(readRunParam('?run=' + 'a'.repeat(200)), null);
    assert.strictEqual(readRunParam('?%'), null);
  })) p++; else f++;

  if (test('view=schedules&run=<id> answers both, and both still answer after the URL was stripped', () => {
    const { link, strips } = fake('?view=schedules&run=abc');
    assert.strictEqual(link.view(), 'schedules');
    assert.strictEqual(link.run(), 'abc');
    assert.deepStrictEqual(strips, ['/app'], 'stripped once, in the same pass that read both');
    assert.strictEqual(link.run(), 'abc', 'a later call is the memo, not the (now clean) URL');
    assert.strictEqual(link.view(), 'schedules');
  })) p++; else f++;

  if (test('run() answers first too: asking for it before view() cannot lose the view', () => {
    const { link } = fake('?view=schedules&run=abc');
    assert.strictEqual(link.run(), 'abc');
    assert.strictEqual(link.view(), 'schedules');
  })) p++; else f++;

  if (test('view=git has no run; a link with no run param answers null', () => {
    assert.strictEqual(fake('?view=git').link.run(), null);
    assert.strictEqual(fake('?other=1').link.run(), null);
  })) p++; else f++;

  if (test('view=schedules hands out the schedules tab once; a session param outranks it', () => {
    const { link } = fake('?view=schedules&run=abc');
    assert.strictEqual(link.takeTab(), 'schedules');
    assert.strictEqual(link.takeTab(), null);
    assert.strictEqual(link.run(), 'abc', 'taking the tab does not spend the run');
    assert.strictEqual(fake(`?session=${UUID}&view=schedules`).link.takeTab(), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
