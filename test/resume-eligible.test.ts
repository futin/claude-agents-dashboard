import assert from 'node:assert';

import { resumeEligible } from '../client/src/lib/resume.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const NO_HOLDS = { question: false, plan: false, message: false };

export function run(): number {
  console.log('\n=== client/lib/resume.ts ===\n');
  let p = 0, f = 0;

  if (test('an ended dashboard session with nothing pending is eligible', () => {
    assert.strictEqual(resumeEligible({ surface: 'dashboard', status: 'idle' }, NO_HOLDS, true), true);
  })) p++; else f++;

  if (test('an incomplete (interrupted) dashboard session is eligible too', () => {
    assert.strictEqual(resumeEligible({ surface: 'dashboard', status: 'incomplete' }, NO_HOLDS, true), true);
  })) p++; else f++;

  if (test('a working session is not — resuming would double-run it', () => {
    assert.strictEqual(resumeEligible({ surface: 'dashboard', status: 'working' }, NO_HOLDS, true), false);
  })) p++; else f++;

  if (test('a question-status session is not — it is alive and waiting', () => {
    assert.strictEqual(resumeEligible({ surface: 'dashboard', status: 'question' }, NO_HOLDS, true), false);
  })) p++; else f++;

  if (test('terminal and cloud sessions are never eligible — dashboard-only by design', () => {
    assert.strictEqual(resumeEligible({ surface: 'local', status: 'idle' }, NO_HOLDS, true), false);
    assert.strictEqual(resumeEligible({ surface: 'cloud', status: 'idle' }, NO_HOLDS, true), false);
  })) p++; else f++;

  if (test('any held panel (question/plan/reply window) suppresses the composer', () => {
    const s = { surface: 'dashboard', status: 'idle' } as const;
    assert.strictEqual(resumeEligible(s, { ...NO_HOLDS, question: true }, true), false);
    assert.strictEqual(resumeEligible(s, { ...NO_HOLDS, plan: true }, true), false);
    assert.strictEqual(resumeEligible(s, { ...NO_HOLDS, message: true }, true), false);
  })) p++; else f++;

  if (test('spawn unavailable (or unknown yet) hides it — strict true only', () => {
    const s = { surface: 'dashboard', status: 'idle' } as const;
    assert.strictEqual(resumeEligible(s, NO_HOLDS, false), false);
    assert.strictEqual(resumeEligible(s, NO_HOLDS, undefined), false);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
