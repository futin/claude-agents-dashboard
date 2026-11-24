/** `questionDraftHeld` (QuestionPanel.tsx): when a held question's typed "Other" text keeps the chat drawer open (#519). */
import assert from 'node:assert';

import { questionDraftHeld } from '../../client/src/components/QuestionPanel.js';
import type { PendingQuestion } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const q = (n: number): PendingQuestion => ({
  questionId: 'q1',
  askedAt: '2026-11-24T00:00:00Z',
  questions: Array.from({ length: n }, (_, i) => ({ question: `Q${i}?`, header: `H${i}`, options: [{ label: 'A' }], multiSelect: false }))
}) as unknown as PendingQuestion;

export function run(): number {
  console.log('\n=== questionDraftHeld (QuestionPanel.tsx) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('typed Other text on an idle question is a draft', () => {
    assert.strictEqual(questionDraftHeld(q(1), 'idle', { 0: { picked: [], other: 'half' } }), true);
  });
  t('whitespace-only Other text is not a draft', () => {
    assert.strictEqual(questionDraftHeld(q(1), 'idle', { 0: { picked: [], other: '   ' } }), false);
  });
  t('a picked option without typed text is not a draft', () => {
    assert.strictEqual(questionDraftHeld(q(1), 'idle', { 0: { picked: ['A'], other: '' } }), false);
  });
  t('a submitted or gone question holds no draft, whatever its text', () => {
    assert.strictEqual(questionDraftHeld(q(1), 'submitted', { 0: { picked: [], other: 'half' } }), false);
    assert.strictEqual(questionDraftHeld(q(1), 'gone', { 0: { picked: [], other: 'half' } }), false);
  });
  t('no pending question holds no draft', () => {
    assert.strictEqual(questionDraftHeld(null, 'idle', { 0: { picked: [], other: 'half' } }), false);
  });
  t('a send in flight still holds the draft (a failed send leaves the text in the box)', () => {
    assert.strictEqual(questionDraftHeld(q(1), 'submitting', { 0: { picked: [], other: 'half' } }), true);
  });
  t('text in any one question of several is a draft', () => {
    assert.strictEqual(questionDraftHeld(q(2), 'idle', { 0: { picked: [], other: '' }, 1: { picked: [], other: 'x' } }), true);
  });
  t('an empty draft record (before the reset effect runs) is not a draft', () => {
    assert.strictEqual(questionDraftHeld(q(2), 'idle', {}), false);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
