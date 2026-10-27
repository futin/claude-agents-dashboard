import assert from 'node:assert';

import { openFolderNote } from '../client/src/lib/openFolder.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const TOKEN_NOTE = 'Open folder needs the Answer token — set it under Settings › Local › Connection.';
const NOT_PINNED = 'That folder is no longer pinned.';
const FAILED = "Couldn't open the folder.";

export function run(): number {
  console.log('\n=== openFolder.ts (client) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('a 200 leaves no note', () => {
    assert.equal(openFolderNote(200, null), null);
  }));

  check(test('a bad-token 403 asks for the Answer token', () => {
    assert.equal(openFolderNote(403, { error: 'bad token' }), TOKEN_NOTE);
  }));

  check(test('a read-only 403 says so instead of asking for a token', () => {
    assert.equal(openFolderNote(403, { error: 'read-only from this network' }), READ_ONLY_TEXT);
  }));

  check(test('any other 403 is a folder the pin list no longer shows', () => {
    assert.equal(openFolderNote(403, null), NOT_PINNED);
    assert.equal(openFolderNote(403, { error: 'not pinned' }), NOT_PINNED);
  }));

  check(test('a 501 is a server not running on macOS', () => {
    assert.equal(openFolderNote(501, null), 'Open folder works only when the dashboard server runs on macOS.');
  }));

  check(test('every other status is a generic failure', () => {
    assert.equal(openFolderNote(500, null), FAILED);
    assert.equal(openFolderNote(404, null), FAILED);
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
