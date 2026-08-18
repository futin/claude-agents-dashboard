import assert from 'node:assert';

import {
  FEEDBACK_CAP, PLAN_CAP,
  answer, cancel, composeReason, dismissAll, getPendingPlan, planSessionIds,
  register, resetStore, sanitizePlan, sweepDecided
} from '../server/lib/plans.js';
import type { PlanWaitResult } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A collector standing in for the hook's held HTTP response. */
function waiter(): { results: PlanWaitResult[]; resolve: (r: PlanWaitResult) => void } {
  const results: PlanWaitResult[] = [];
  return { results, resolve: r => { results.push(r); } };
}

const PLAN = '## Steps\n1. Wire the store\n2. Ship it';

export async function run(): Promise<number> {
  console.log('\n=== plans.ts ===\n');
  let p = 0, f = 0;
  resetStore();

  /* ------------------------------------------------------ sanitizePlan (pure) */

  if (test('takes the plan string and trims it', () => {
    assert.strictEqual(sanitizePlan({ plan: `\n${PLAN}\n  ` }), PLAN);
  })) p++; else f++;

  if (test('returns empty for anything unusable — the hook then falls back to the card', () => {
    assert.strictEqual(sanitizePlan(null), '');
    assert.strictEqual(sanitizePlan({}), '');
    assert.strictEqual(sanitizePlan({ plan: 42 }), '');
    assert.strictEqual(sanitizePlan({ plan: '   ' }), '');
    assert.strictEqual(sanitizePlan('a plan'), '');
  })) p++; else f++;

  if (test('caps a runaway plan', () => {
    assert.strictEqual(sanitizePlan({ plan: 'x'.repeat(PLAN_CAP + 500) }).length, PLAN_CAP);
  })) p++; else f++;

  /* ----------------------------------------------------- composeReason (pure) */

  if (test('reason carries the feedback and says to stay in plan mode', () => {
    const reason = composeReason('  use the existing store  ');
    assert.ok(reason.includes('use the existing store'));
    assert.ok(reason.includes('ExitPlanMode again'));
    assert.ok(reason.includes('do not start implementing'));
  })) p++; else f++;

  /* ------------------------------------------------------------ state machine */

  if (test('register exposes the plan and flags the session', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    const pending = getPendingPlan('s1')!;
    assert.strictEqual(pending.planId, planId);
    assert.strictEqual(pending.plan, PLAN);
    assert.deepStrictEqual([...planSessionIds()], ['s1']);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('reject resolves the waiter with a composed reason and clears the entry', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(answer('s1', { planId, verdict: 'reject', feedback: 'add tests' }), 'ok');
    assert.strictEqual(w.results.length, 1);
    assert.strictEqual(w.results[0].status, 'rejected');
    assert.ok(w.results[0].reason!.includes('add tests'));
    assert.strictEqual(getPendingPlan('s1'), null);
  })) p++; else f++;

  if (test('dismiss hands the plan back to the card, with no reason', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(answer('s1', { planId, verdict: 'dismiss' }), 'ok');
    assert.deepStrictEqual(w.results, [{ status: 'dismissed' }]);
  })) p++; else f++;

  if (test('a reject with no usable feedback is malformed — a bare no belongs on the card', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(answer('s1', { planId, verdict: 'reject' }), 'malformed');
    assert.strictEqual(answer('s1', { planId, verdict: 'reject', feedback: '   ' }), 'malformed');
    assert.strictEqual(w.results.length, 0);
    assert.ok(getPendingPlan('s1'));
  })) p++; else f++;

  if (test('accept is not a verdict this store knows', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(answer('s1', { planId, verdict: 'accept' }), 'malformed');
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('feedback is capped before it reaches the model', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    answer('s1', { planId, verdict: 'reject', feedback: 'y'.repeat(FEEDBACK_CAP + 400) });
    assert.ok(w.results[0].reason!.includes('y'.repeat(FEEDBACK_CAP)));
    assert.ok(!w.results[0].reason!.includes('y'.repeat(FEEDBACK_CAP + 1)));
  })) p++; else f++;

  if (test('a stale planId mismatches instead of answering the current plan', () => {
    resetStore();
    const first = waiter();
    const stale = register('s1', PLAN, 60_000, first.resolve);
    const second = waiter();
    register('s1', 'newer plan', 60_000, second.resolve);
    assert.deepStrictEqual(first.results, [{ status: 'superseded' }]);
    assert.strictEqual(answer('s1', { planId: stale, verdict: 'reject', feedback: 'no' }), 'mismatch');
    assert.strictEqual(second.results.length, 0);
  })) p++; else f++;

  if (test('answering an unknown session is not-found, and a malformed body is malformed', () => {
    resetStore();
    assert.strictEqual(answer('nobody', { planId: 'x', verdict: 'dismiss' }), 'not-found');
    const w = waiter();
    register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(answer('s1', null), 'malformed');
    assert.strictEqual(answer('s1', { verdict: 'dismiss' }), 'malformed');
  })) p++; else f++;

  if (test('cancel drops the entry without resolving; a stale id is a no-op', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    cancel('s1', 'some-other-id');
    assert.ok(getPendingPlan('s1'));
    cancel('s1', planId);
    assert.strictEqual(getPendingPlan('s1'), null);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('dismissAll releases every held plan and reports the count', () => {
    resetStore();
    const a = waiter(), b = waiter();
    register('s1', PLAN, 60_000, a.resolve);
    register('s2', PLAN, 60_000, b.resolve);
    assert.strictEqual(dismissAll(), 2);
    assert.deepStrictEqual(a.results, [{ status: 'dismissed' }]);
    assert.deepStrictEqual(b.results, [{ status: 'dismissed' }]);
    assert.strictEqual(planSessionIds().size, 0);
  })) p++; else f++;

  if (await testAsync('the deadline reaps the entry, and a late verdict then 404s', async () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 10, w.resolve);
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(w.results, [{ status: 'timeout' }]);
    assert.strictEqual(answer('s1', { planId, verdict: 'dismiss' }), 'not-found');
  })) p++; else f++;


  /* ------------------------------------------------ sweepDecided (the terminal won) */

  if (test('sweepDecided releases a plan whose session moved on — the card decided it', () => {
    resetStore();
    const w = waiter();
    register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(sweepDecided(() => true), 1);
    assert.deepStrictEqual(w.results, [{ status: 'dismissed' }]);
    assert.strictEqual(getPendingPlan('s1'), null);
    assert.strictEqual(planSessionIds().size, 0);
  })) p++; else f++;

  if (test('sweepDecided leaves a plan that is still genuinely waiting', () => {
    resetStore();
    const w = waiter();
    register('s1', PLAN, 60_000, w.resolve);
    assert.strictEqual(sweepDecided(() => false), 0);
    assert.strictEqual(w.results.length, 0);
    assert.ok(getPendingPlan('s1'));
  })) p++; else f++;

  if (test('sweepDecided hands the predicate the sessionId and askedAt in ms', () => {
    resetStore();
    const w = waiter();
    register('s7', PLAN, 60_000, w.resolve);
    const asked = getPendingPlan('s7')!.askedAt;
    const seen: Array<[string, number]> = [];
    sweepDecided((sessionId, askedAtMs) => { seen.push([sessionId, askedAtMs]); return false; });
    assert.deepStrictEqual(seen, [['s7', Date.parse(asked)]]);
  })) p++; else f++;

  if (test('sweepDecided with nothing held is free — the predicate never runs', () => {
    resetStore();
    let calls = 0;
    assert.strictEqual(sweepDecided(() => { calls++; return true; }), 0);
    assert.strictEqual(calls, 0);
  })) p++; else f++;

  if (test('a verdict sent after the sweep 404s instead of feeding an orphaned hook', () => {
    resetStore();
    const w = waiter();
    const planId = register('s1', PLAN, 60_000, w.resolve);
    sweepDecided(() => true);
    assert.strictEqual(answer('s1', { planId, verdict: 'reject', feedback: 'too big' }), 'not-found');
  })) p++; else f++;

  if (test('sweepDecided sweeps only the sessions the predicate names', () => {
    resetStore();
    const a = waiter(), b = waiter();
    register('gone', PLAN, 60_000, a.resolve);
    register('live', PLAN, 60_000, b.resolve);
    assert.strictEqual(sweepDecided(sessionId => sessionId === 'gone'), 1);
    assert.deepStrictEqual(a.results, [{ status: 'dismissed' }]);
    assert.strictEqual(b.results.length, 0);
    assert.deepStrictEqual([...planSessionIds()], ['live']);
  })) p++; else f++;

  resetStore();
  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(f => process.exit(f > 0 ? 1 : 0));
