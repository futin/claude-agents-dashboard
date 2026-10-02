import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeReason } from '../server/lib/messages.js';
import {
  REMOTE_MESSAGE_HEAD, REMOTE_MESSAGE_TAIL, unwrapRemoteMessage, wrapRemoteMessage
} from '../server/lib/remote-message-prose.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'server', 'lib', 'remote-message-prose.ts');

function tsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFilesUnder(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

export function run(): number {
  console.log('\nremote-message-prose');
  let p = 0, f = 0;

  if (test('wrap produces the exact prose already on disk in transcripts', () => {
    assert.strictEqual(
      wrapRemoteMessage('hi'),
      'The user is away from the terminal and sent this follow-up from the dashboard; treat it as their next message:\nhi\n\n'
      + 'Continue working on it now. The user is still away: put any decision through the AskUserQuestion tool, never end the turn on a prose '
      + 'question, and prefer already-permitted tools — a permission dialog would park the session until they return.'
    );
  })) p++; else f++;

  if (test('composeReason delegates to wrapRemoteMessage', () => {
    assert.strictEqual(composeReason('hi'), wrapRemoteMessage('hi'));
    assert.strictEqual(composeReason('  padded  '), wrapRemoteMessage('  padded  '));
  })) p++; else f++;

  if (test('round trip survives regex metacharacters in the text', () => {
    const text = 'a.b*c+d? (e) [f] {g} ^h$ i|j \\k /l/';
    assert.strictEqual(unwrapRemoteMessage(wrapRemoteMessage(text)), text);
  })) p++; else f++;

  if (test('round trip keeps inner line breaks', () => {
    const text = 'first line\n\nthird line';
    assert.strictEqual(unwrapRemoteMessage(wrapRemoteMessage(text)), text);
  })) p++; else f++;

  if (test('both directions trim the text', () => {
    const wrapped = wrapRemoteMessage('  x  ');
    assert.ok(wrapped.includes('\nx\n\n'), 'wrap trims');
    assert.strictEqual(unwrapRemoteMessage(wrapped), 'x');
    assert.strictEqual(unwrapRemoteMessage(REMOTE_MESSAGE_HEAD + '  x  ' + REMOTE_MESSAGE_TAIL), 'x', 'unwrap trims');
  })) p++; else f++;

  if (test('the CLI prefix line and trailing whitespace are both optional', () => {
    assert.strictEqual(unwrapRemoteMessage('Stop hook feedback:\n' + wrapRemoteMessage('hi')), 'hi');
    assert.strictEqual(unwrapRemoteMessage(wrapRemoteMessage('hi')), 'hi');
    assert.strictEqual(unwrapRemoteMessage(wrapRemoteMessage('hi') + '\n  '), 'hi');
  })) p++; else f++;

  if (test('anything that is not exactly the prose fails closed', () => {
    const head = wrapRemoteMessage('MARK').split('MARK')[0];
    const cases: unknown[] = [
      undefined,
      42,
      [wrapRemoteMessage('hi')],
      wrapRemoteMessage('   '),
      head + 'truncated',
      wrapRemoteMessage('x') + '\nextra',
      'Stop hook feedback:\nsome other hook blocked the stop',
      wrapRemoteMessage('x').replace('Continue', 'Resume'),
      // A `.` in the prose is a literal dot, not any character: pins the escaping.
      wrapRemoteMessage('x').replace('it now.', 'it nowX')
    ];
    for (const c of cases) assert.strictEqual(unwrapRemoteMessage(c), null, JSON.stringify(c));
  })) p++; else f++;

  if (test('the prose module imports nothing, so the read path stays store-free', () => {
    const imports = fs.readFileSync(MODULE, 'utf8').split('\n').filter(l => /^\s*import\b/.test(l));
    assert.deepStrictEqual(imports, []);
  })) p++; else f++;

  if (test('exactly one server file owns the prose', () => {
    const owners = tsFilesUnder(path.join(ROOT, 'server'))
      .filter(file => fs.readFileSync(file, 'utf8').includes('sent this follow-up from the dashboard'))
      .map(file => path.relative(ROOT, file));
    assert.deepStrictEqual(owners, [path.join('server', 'lib', 'remote-message-prose.ts')]);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
