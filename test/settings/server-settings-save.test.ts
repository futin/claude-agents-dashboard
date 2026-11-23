/**
 * `client/src/lib/serverSettingsSave.ts`: what one `POST /api/settings` leaves on the Settings page — the failure line, the 403 flags, the settings to show —
 * and the in-flight multiset behind each row's `saving…`. `useServerSettings` only applies these. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { ServerSettings } from '../../shared/types.js';
import type { WriteResult } from '../../client/src/lib/postWrite.js';
import { addSavingKeys, removeSavingKeys, settingsSaveOutcome } from '../../client/src/lib/serverSettingsSave.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const result = (over: Partial<WriteResult>): WriteResult => ({ status: 200, ok: true, refusal: null, body: undefined, ...over });
const ECHO = { idleSecs: 120, answerSecs: 45 } as ServerSettings;

export function run(): number {
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };

  // The in-flight multiset
  check(test('saving keys: the first of two overlapping saves of one key finishing leaves the second still saving', () => {
    let inFlight = addSavingKeys([], ['idleSecs']);
    inFlight = addSavingKeys(inFlight, ['idleSecs']);
    inFlight = removeSavingKeys(inFlight, ['idleSecs']);
    assert.deepStrictEqual(inFlight, ['idleSecs']);
    assert.deepStrictEqual(removeSavingKeys(inFlight, ['idleSecs']), []);
  }));
  check(test('saving keys: a save of one key never clears another key in flight', () => {
    const inFlight = addSavingKeys(addSavingKeys([], ['notify']), ['answerSecs']);
    assert.deepStrictEqual(removeSavingKeys(inFlight, ['notify']), ['answerSecs']);
  }));
  check(test('saving keys: removing a key not in flight is a no-op, and the input is never mutated', () => {
    const inFlight = Object.freeze(['idleSecs']);
    assert.deepStrictEqual(removeSavingKeys(inFlight, ['answerSecs']), ['idleSecs']);
    assert.deepStrictEqual(addSavingKeys(inFlight, ['idleSecs', 'answerSecs']), ['idleSecs', 'idleSecs', 'answerSecs']);
  }));

  // settingsSaveOutcome: the 403 mapping, the 2xx clear, the echoed body
  check(test('outcome: a bad-token 403 sets needsToken, clears readOnly, and has no failure line', () => {
    assert.deepStrictEqual(settingsSaveOutcome(result({ status: 403, ok: false, refusal: 'token' })),
      { saveError: null, flags: { needsToken: true, readOnly: false }, state: null });
  }));
  check(test('outcome: a read-only 403 sets readOnly and clears needsToken', () => {
    assert.deepStrictEqual(settingsSaveOutcome(result({ status: 403, ok: false, refusal: 'read-only' })),
      { saveError: null, flags: { needsToken: false, readOnly: true }, state: null });
  }));
  check(test("outcome: a 2xx clears both flags and shows the server's echoed body, not the request", () => {
    assert.deepStrictEqual(settingsSaveOutcome(result({ body: ECHO })), { saveError: null, flags: { needsToken: false, readOnly: false }, state: ECHO });
  }));
  check(test('outcome: a 2xx whose body is not settings still clears both flags but shows nothing new', () => {
    assert.deepStrictEqual(settingsSaveOutcome(result({ body: { ok: true } })), { saveError: null, flags: { needsToken: false, readOnly: false }, state: null });
  }));
  check(test('outcome: a 400 or no answer leaves the flags alone and says why', () => {
    const bad = settingsSaveOutcome(result({ status: 400, ok: false, body: ECHO }));
    assert.deepStrictEqual([bad.flags, bad.state], [null, null]);
    assert.strictEqual(bad.saveError, 'The server refused that value — the setting was not saved.');
    const none = settingsSaveOutcome(result({ status: 0, ok: false }));
    assert.deepStrictEqual([none.flags, none.state], [null, null]);
    assert.strictEqual(none.saveError, "Couldn't reach the server — the setting was not saved.");
  }));

  console.log(`\nserver-settings-save: ${pass}/${total} passed`);
  return total - pass;
}
