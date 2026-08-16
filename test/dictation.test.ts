import assert from 'node:assert';

import { appendTranscript, fmtElapsed, micErrorMessage, pickMimeType } from '../client/src/lib/dictation.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== dictation.ts (client) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('appends to existing text with a single space', () => {
    assert.equal(appendTranscript('first thought', 'second thought'), 'first thought second thought');
  }));

  check(test('an empty composer takes the transcript verbatim', () => {
    assert.equal(appendTranscript('', 'hello'), 'hello');
    assert.equal(appendTranscript('   ', 'hello'), 'hello');
  }));

  check(test('an empty transcript leaves the composer untouched', () => {
    assert.equal(appendTranscript('keep me', ''), 'keep me');
    assert.equal(appendTranscript('keep me', '   '), 'keep me');
  }));

  check(test('truncates to the cap rather than overflowing maxLength', () => {
    assert.equal(appendTranscript('abcd', 'efgh', 6), 'abcd e');
    assert.equal(appendTranscript('abcdef', 'ghi', 6), 'abcdef');
  }));

  check(test('fmtElapsed reads as a stopwatch', () => {
    assert.equal(fmtElapsed(0), '0:00');
    assert.equal(fmtElapsed(7), '0:07');
    assert.equal(fmtElapsed(83), '1:23');
    assert.equal(fmtElapsed(120), '2:00');
  }));

  check(test('pickMimeType prefers mp4, falls back to webm, then to nothing', () => {
    assert.equal(pickMimeType(t => t === 'audio/mp4'), 'audio/mp4');
    assert.equal(pickMimeType(t => t === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
    assert.equal(pickMimeType(() => false), '');
  }));

  check(test('a denied permission names the settings fix, not a missing device', () => {
    const msg = micErrorMessage({ name: 'NotAllowedError' });
    assert.equal(msg, 'mic blocked — allow it in browser + OS settings');
    assert.equal(micErrorMessage({ name: 'SecurityError' }), msg);
  }));

  check(test('separates no-device from busy-device', () => {
    assert.equal(micErrorMessage({ name: 'NotFoundError' }), 'no microphone found');
    assert.equal(micErrorMessage({ name: 'OverconstrainedError' }), 'no microphone found');
    assert.equal(micErrorMessage({ name: 'NotReadableError' }), 'mic busy in another app');
    assert.equal(micErrorMessage({ name: 'AbortError' }), 'mic busy in another app');
  }));

  check(test('an unmapped rejection still surfaces its DOMException name', () => {
    assert.equal(micErrorMessage({ name: 'TypeError' }), 'microphone unavailable (TypeError)');
  }));

  check(test('a nameless throw falls back to the plain wording', () => {
    assert.equal(micErrorMessage(undefined), 'microphone unavailable');
    assert.equal(micErrorMessage(null), 'microphone unavailable');
    assert.equal(micErrorMessage('boom'), 'microphone unavailable');
    assert.equal(micErrorMessage({}), 'microphone unavailable');
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
