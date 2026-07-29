import assert from 'node:assert';

import {
  DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, SELECTED_CAP,
  answer, cancel, clampTimeout, composeReason, getPending, pendingSessionIds,
  register, resetStore, sanitizeQuestions, validateAnswer
} from '../server/lib/pending.js';
import type { PendingQuestionItem, WaitResult } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A collector standing in for the hook's held HTTP response. */
function waiter(): { results: WaitResult[]; resolve: (r: WaitResult) => void } {
  const results: WaitResult[] = [];
  return { results, resolve: r => { results.push(r); } };
}

const AUTH: PendingQuestionItem = {
  header: 'Auth', question: 'Which auth method?', multiSelect: false,
  options: [{ label: 'OAuth', description: 'redirect flow' }, { label: 'JWT' }]
};
const LANGS: PendingQuestionItem = {
  header: 'Langs', question: 'Which languages?', multiSelect: true,
  options: [{ label: 'TypeScript' }, { label: 'Python' }]
};

export async function run(): Promise<number> {
  console.log('\n=== pending.ts ===\n');
  let p = 0, f = 0;
  resetStore();

  /* ---------------------------------------------- sanitizeQuestions (pure) */

  if (test('sanitizes a well-formed tool input', () => {
    const out = sanitizeQuestions({
      questions: [{
        question: 'Which auth method?', header: 'Auth', multiSelect: false,
        options: [{ label: 'OAuth', description: 'redirect flow' }, { label: 'JWT' }]
      }]
    });
    assert.deepStrictEqual(out, [AUTH]);
  })) p++; else f++;

  if (test('defaults header to empty and multiSelect to false', () => {
    const out = sanitizeQuestions({ questions: [{ question: 'Deploy now?' }] });
    assert.deepStrictEqual(out, [{ header: '', question: 'Deploy now?', multiSelect: false, options: [] }]);
  })) p++; else f++;

  if (test('clips to 4 questions and 4 options', () => {
    const out = sanitizeQuestions({
      questions: Array.from({ length: 7 }, (_, i) => ({
        question: 'q' + i,
        options: Array.from({ length: 9 }, (_, j) => ({ label: 'o' + j }))
      }))
    });
    assert.strictEqual(out.length, 4);
    assert.strictEqual(out[0].options.length, 4);
  })) p++; else f++;

  if (test('drops malformed questions and options', () => {
    const out = sanitizeQuestions({
      questions: [
        null, 'nope', { header: 'no question here' }, { question: 42 },
        { question: 'real', options: [{ label: '' }, { label: 7 }, 'x', null, { label: 'keep' }] }
      ]
    });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].options, [{ label: 'keep' }]);
  })) p++; else f++;

  if (test('nothing usable yields an empty list', () => {
    for (const input of [undefined, null, 42, {}, { questions: 'x' }, { questions: [] }, { questions: [{ header: 'H' }] }]) {
      assert.deepStrictEqual(sanitizeQuestions(input), [], JSON.stringify(input));
    }
  })) p++; else f++;

  if (test('applies length caps', () => {
    const out = sanitizeQuestions({
      questions: [{
        question: 'q'.repeat(5000), header: 'h'.repeat(500),
        options: [{ label: 'l'.repeat(500), description: 'd'.repeat(2000) }]
      }]
    });
    assert.strictEqual(out[0].question.length, 2000);
    assert.strictEqual(out[0].header.length, 200);
    assert.strictEqual(out[0].options[0].label.length, 200);
    assert.strictEqual(out[0].options[0].description!.length, 500);
  })) p++; else f++;

  /* ---------------------------------------------- clampTimeout (pure) */

  if (test('clamps the wait window into range', () => {
    assert.strictEqual(clampTimeout(60_000), 60_000);
    assert.strictEqual(clampTimeout(10), MIN_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(99_999_999), MAX_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout('nope'), DEFAULT_TIMEOUT_MS);
  })) p++; else f++;

  /* ---------------------------------------------- validateAnswer (pure) */

  if (test('accepts one selection per single-select question', () => {
    assert.strictEqual(validateAnswer([AUTH], [{ index: 0, selected: ['OAuth'] }]), 'ok');
  })) p++; else f++;

  if (test('accepts several selections for multiSelect', () => {
    assert.strictEqual(validateAnswer([LANGS], [{ index: 0, selected: ['TypeScript', 'Python'] }]), 'ok');
  })) p++; else f++;

  if (test('accepts free text that matches no option ("Other")', () => {
    assert.strictEqual(validateAnswer([AUTH], [{ index: 0, selected: ['mTLS, actually'] }]), 'ok');
  })) p++; else f++;

  if (test('rejects malformed answer shapes', () => {
    const cases: Array<[string, unknown]> = [
      ['not an array', { index: 0, selected: ['OAuth'] }],
      ['wrong length', [] as unknown],
      ['missing index', [{ selected: ['OAuth'] }]],
      ['out-of-range index', [{ index: 5, selected: ['OAuth'] }]],
      ['non-integer index', [{ index: 0.5, selected: ['OAuth'] }]],
      ['empty selected', [{ index: 0, selected: [] }]],
      ['blank string', [{ index: 0, selected: ['   '] }]],
      ['non-string value', [{ index: 0, selected: [7] }]],
      ['over-cap value', [{ index: 0, selected: ['x'.repeat(SELECTED_CAP + 1)] }]],
      ['multi on single-select', [{ index: 0, selected: ['OAuth', 'JWT'] }]]
    ];
    for (const [label, answers] of cases) {
      assert.strictEqual(validateAnswer([AUTH], answers), 'malformed', label);
    }
  })) p++; else f++;

  if (test('rejects a duplicated index instead of a missing one', () => {
    assert.strictEqual(
      validateAnswer([AUTH, LANGS], [{ index: 0, selected: ['OAuth'] }, { index: 0, selected: ['JWT'] }]),
      'malformed'
    );
  })) p++; else f++;

  /* ---------------------------------------------- composeReason (pure) */

  if (test('single question reads as one sentence', () => {
    const reason = composeReason([AUTH], [{ index: 0, selected: ['OAuth'] }]);
    assert.ok(reason.includes('Auth: OAuth'), reason);
    assert.ok(reason.includes('do not ask again'), reason);
    assert.ok(!reason.includes('\n'), 'single-question reason should stay on one line');
  })) p++; else f++;

  if (test('several questions read as bullets, multiSelect joined', () => {
    const reason = composeReason([AUTH, LANGS], [
      { index: 0, selected: ['OAuth'] },
      { index: 1, selected: ['TypeScript', 'Python'] }
    ]);
    assert.ok(reason.includes('- Auth: OAuth'), reason);
    assert.ok(reason.includes('- Langs: TypeScript, Python'), reason);
  })) p++; else f++;

  if (test('a header-less question falls back to its text', () => {
    const q: PendingQuestionItem = { header: '', question: 'Deploy now?', multiSelect: false, options: [] };
    assert.ok(composeReason([q], [{ index: 0, selected: ['Yes'] }]).includes('Deploy now?: Yes'));
  })) p++; else f++;

  if (test('free text is carried verbatim', () => {
    const reason = composeReason([AUTH], [{ index: 0, selected: ['use mTLS via the mesh'] }]);
    assert.ok(reason.includes('Auth: use mTLS via the mesh'), reason);
  })) p++; else f++;

  /* ---------------------------------------------- store state machine */

  if (test('register exposes the question and returns a fresh id', () => {
    resetStore();
    const w = waiter();
    const id = register('s1', [AUTH], 20_000, w.resolve);
    const pending = getPending('s1')!;
    assert.strictEqual(pending.questionId, id);
    assert.deepStrictEqual(pending.questions, [AUTH]);
    assert.ok(Date.parse(pending.askedAt) > 0);
    assert.strictEqual(w.results.length, 0, 'must still be waiting');
    assert.strictEqual(getPending('other-session'), null);
    resetStore();
  })) p++; else f++;

  if (test('pendingSessionIds lists every held wait and drops resolved ones', () => {
    resetStore();
    assert.deepStrictEqual([...pendingSessionIds()], []);
    const w1 = waiter(), w2 = waiter();
    const id1 = register('s1', [AUTH], 20_000, w1.resolve);
    register('s2', [LANGS], 20_000, w2.resolve);
    assert.deepStrictEqual([...pendingSessionIds()].sort(), ['s1', 's2']);
    // Answering s1 clears it; s2 is still held.
    assert.strictEqual(answer('s1', { questionId: id1, answers: [{ index: 0, selected: ['OAuth'] }] }), 'ok');
    assert.deepStrictEqual([...pendingSessionIds()], ['s2']);
    // The returned Set is a copy — mutating it must not touch the store.
    const snapshot = pendingSessionIds();
    snapshot.delete('s2');
    assert.deepStrictEqual([...pendingSessionIds()], ['s2']);
    resetStore();
    assert.deepStrictEqual([...pendingSessionIds()], []);
  })) p++; else f++;

  if (test('answering resolves once, composes the reason, and clears the entry', () => {
    resetStore();
    const w = waiter();
    const id = register('s1', [AUTH], 20_000, w.resolve);
    assert.strictEqual(answer('s1', { questionId: id, answers: [{ index: 0, selected: ['OAuth'] }] }), 'ok');
    assert.strictEqual(w.results.length, 1);
    assert.strictEqual(w.results[0].status, 'answered');
    assert.ok(w.results[0].reason!.includes('Auth: OAuth'));
    assert.deepStrictEqual(w.results[0].answers, [{ index: 0, selected: ['OAuth'] }]);
    assert.strictEqual(getPending('s1'), null);
    // The second tab's submit finds nothing — no double resolve.
    assert.strictEqual(answer('s1', { questionId: id, answers: [{ index: 0, selected: ['JWT'] }] }), 'not-found');
    assert.strictEqual(w.results.length, 1);
    resetStore();
  })) p++; else f++;

  if (test('a stale questionId is a mismatch and leaves the entry intact', () => {
    resetStore();
    const w = waiter();
    register('s1', [AUTH], 20_000, w.resolve);
    assert.strictEqual(answer('s1', { questionId: 'from-an-old-question', answers: [{ index: 0, selected: ['OAuth'] }] }), 'mismatch');
    assert.strictEqual(w.results.length, 0);
    assert.ok(getPending('s1'));
    resetStore();
  })) p++; else f++;

  if (test('a malformed body is rejected without resolving', () => {
    resetStore();
    const w = waiter();
    const id = register('s1', [AUTH], 20_000, w.resolve);
    assert.strictEqual(answer('s1', null), 'malformed');
    assert.strictEqual(answer('s1', { answers: [] }), 'malformed');
    assert.strictEqual(answer('s1', { questionId: id, answers: [{ index: 0, selected: [] }] }), 'malformed');
    assert.strictEqual(w.results.length, 0);
    assert.ok(getPending('s1'));
    resetStore();
  })) p++; else f++;

  if (test('dismiss releases the waiter for the terminal dialog', () => {
    resetStore();
    const w = waiter();
    const id = register('s1', [AUTH], 20_000, w.resolve);
    assert.strictEqual(answer('s1', { questionId: id, dismiss: true }), 'ok');
    assert.deepStrictEqual(w.results, [{ status: 'dismissed' }]);
    assert.strictEqual(getPending('s1'), null);
    resetStore();
  })) p++; else f++;

  if (test('re-registering supersedes the previous wait', () => {
    resetStore();
    const first = waiter();
    const second = waiter();
    const id1 = register('s1', [AUTH], 20_000, first.resolve);
    const id2 = register('s1', [LANGS], 20_000, second.resolve);
    assert.deepStrictEqual(first.results, [{ status: 'superseded' }]);
    assert.strictEqual(second.results.length, 0);
    assert.notStrictEqual(id1, id2);
    assert.deepStrictEqual(getPending('s1')!.questions, [LANGS]);
    resetStore();
  })) p++; else f++;

  if (test('cancel drops the entry without resolving', () => {
    resetStore();
    const w = waiter();
    const id = register('s1', [AUTH], 20_000, w.resolve);
    cancel('s1', id);
    assert.strictEqual(getPending('s1'), null);
    assert.strictEqual(w.results.length, 0, 'nobody is listening — must not resolve');
    resetStore();
  })) p++; else f++;

  if (test('a stale cancel cannot evict a newer wait', () => {
    resetStore();
    const first = waiter();
    const second = waiter();
    const id1 = register('s1', [AUTH], 20_000, first.resolve);
    register('s1', [LANGS], 20_000, second.resolve);
    cancel('s1', id1); // the superseded hook's socket closing, late
    assert.ok(getPending('s1'), 'the newer wait must survive');
    assert.deepStrictEqual(getPending('s1')!.questions, [LANGS]);
    resetStore();
  })) p++; else f++;

  if (test('sessions are independent', () => {
    resetStore();
    const a = waiter();
    const b = waiter();
    const idA = register('s1', [AUTH], 20_000, a.resolve);
    register('s2', [LANGS], 20_000, b.resolve);
    answer('s1', { questionId: idA, answers: [{ index: 0, selected: ['OAuth'] }] });
    assert.strictEqual(a.results.length, 1);
    assert.strictEqual(b.results.length, 0);
    assert.ok(getPending('s2'));
    resetStore();
  })) p++; else f++;

  if (await testAsync('the deadline resolves as a timeout and reaps the entry', async () => {
    resetStore();
    // register() takes the raw window (the handler is what clamps), so a real
    // timer can be waited out in milliseconds.
    const result = await new Promise<WaitResult>(res => register('s1', [AUTH], 20, res));
    assert.deepStrictEqual(result, { status: 'timeout' });
    assert.strictEqual(getPending('s1'), null);
    // A submit racing the expiry loses cleanly.
    assert.strictEqual(answer('s1', { questionId: 'whatever', answers: [{ index: 0, selected: ['OAuth'] }] }), 'not-found');
    resetStore();
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
