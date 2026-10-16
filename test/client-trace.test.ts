import assert from 'node:assert';

import {
  REL_FWD_LABEL, REL_LABEL, TRACE_FILTERS, causesOf, ledTo, mergeTrace, passesFilter, turnLabel
} from '../client/src/lib/trace.js';
import type { TraceKind, TraceRel, TraceStep } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function step(id: string, over: Partial<TraceStep> = {}, why: [string, TraceRel][] = []): TraceStep {
  return {
    id, turn: 1, kind: 'read', tool: 'Read', detail: id, intent: null, intentFrom: null,
    at: '2026-10-16T10:00:00.000Z', status: 'ok', result: null,
    why: why.map(([wid, rel]) => ({ id: wid, rel })), thinking: null, ...over
  };
}

export function run(): number {
  console.log('\n=== client trace.ts ===\n');
  let p = 0, f = 0;

  if (test('mergeTrace: replaces by id in place, appends new ids', () => {
    const prev = [step('a', { at: '2026-10-16T10:00:01Z', status: 'running' }), step('b', { at: '2026-10-16T10:00:02Z' })];
    const out = mergeTrace(prev, [step('a', { at: '2026-10-16T10:00:01Z', status: 'ok' }), step('c', { at: '2026-10-16T10:00:03Z' })], false);
    assert.deepStrictEqual(out.map(s => s.id), ['a', 'b', 'c']);
    assert.strictEqual(out[0].status, 'ok');
  })) p++; else f++;

  if (test('mergeTrace: does not mutate prev', () => {
    const prev = [step('a', { status: 'running' })];
    mergeTrace(prev, [step('a', { status: 'ok' }), step('b')], false);
    assert.strictEqual(prev.length, 1);
    assert.strictEqual(prev[0].status, 'running');
  })) p++; else f++;

  if (test('mergeTrace: a late `at` sorts into place; equal `at` keeps arrival order', () => {
    const prev = [step('a', { at: '2026-10-16T10:00:01Z' }), step('c', { at: '2026-10-16T10:00:05Z' }), step('d', { at: '2026-10-16T10:00:05Z' })];
    const out = mergeTrace(prev, [step('b', { at: '2026-10-16T10:00:03Z' }), step('e', { at: '2026-10-16T10:00:05Z' })], false);
    assert.deepStrictEqual(out.map(s => s.id), ['a', 'b', 'c', 'd', 'e']);
  })) p++; else f++;

  if (test('mergeTrace: reset replaces everything with incoming', () => {
    const prev = [step('old1'), step('old2')];
    const incoming = [step('n1'), step('n2')];
    const out = mergeTrace(prev, incoming, true);
    assert.deepStrictEqual(out.map(s => s.id), ['n1', 'n2']);
  })) p++; else f++;

  const chain = [
    step('p', { kind: 'prompt', tool: 'Prompt' }),
    step('r', {}, [['p', 'asked']]),
    step('e', { kind: 'edit' }, [['r', 'informed'], ['p', 'asked']])
  ];

  if (test('causesOf: 2-hop chain, d 1 then 2, nearest first, first rel wins', () => {
    const m = causesOf(chain, 'e');
    assert.deepStrictEqual([...m.keys()], ['r', 'p']);
    assert.deepStrictEqual(m.get('r'), { d: 1, rel: 'informed', from: 'e' });
    // p is both a direct why of e (d 1) and of r (d 2): breadth-first reaches it at d 1 first
    assert.deepStrictEqual(m.get('p'), { d: 1, rel: 'asked', from: 'e' });
  })) p++; else f++;

  if (test('causesOf: real 2-hop gives d 1 and 2', () => {
    const steps = [step('a'), step('b', {}, [['a', 'informed']]), step('c', {}, [['b', 'retry']])];
    const m = causesOf(steps, 'c');
    assert.deepStrictEqual([...m.entries()].map(([k, v]) => [k, v.d]), [['b', 1], ['a', 2]]);
    assert.strictEqual(m.get('a')?.from, 'b');
  })) p++; else f++;

  if (test('causesOf: skips a why id not in steps, never throws, never loops', () => {
    const steps = [step('a', {}, [['ghost', 'asked']]), step('b', {}, [['a', 'informed'], ['ghost', 'plan']])];
    const m = causesOf(steps, 'b');
    assert.deepStrictEqual([...m.keys()], ['a']);
    assert.strictEqual(causesOf(steps, 'nope').size, 0);
    const cyc = [step('x', {}, [['y', 'retry']]), step('y', {}, [['x', 'retry']])];
    assert.deepStrictEqual([...causesOf(cyc, 'x').keys()], ['y']);
  })) p++; else f++;

  if (test('ledTo: steps whose why names the id, in order', () => {
    const steps = [step('a'), step('b', {}, [['a', 'informed']]), step('c'), step('d', {}, [['c', 'asked'], ['a', 'plan']])];
    assert.deepStrictEqual(ledTo(steps, 'a').map(s => s.id), ['b', 'd']);
    assert.deepStrictEqual(ledTo(steps, 'zzz'), []);
  })) p++; else f++;

  if (test('passesFilter: all, edits, fails, you; a prompt always passes', () => {
    const kinds: TraceKind[] = ['read', 'edit', 'bash', 'decide', 'agent'];
    const mk = (kind: TraceKind, status: TraceStep['status'] = 'ok') => step('x', { kind, status });
    for (const k of kinds) assert.strictEqual(passesFilter(mk(k), 'all'), true);
    assert.strictEqual(passesFilter(mk('edit'), 'edits'), true);
    assert.strictEqual(passesFilter(mk('read'), 'edits'), false);
    assert.strictEqual(passesFilter(mk('bash', 'error'), 'fails'), true);
    assert.strictEqual(passesFilter(mk('bash', 'ok'), 'fails'), false);
    assert.strictEqual(passesFilter(mk('decide'), 'you'), true);
    assert.strictEqual(passesFilter(mk('edit'), 'you'), false);
    const prompt = step('p', { kind: 'prompt', status: null });
    for (const f2 of ['all', 'edits', 'fails', 'you'] as const) assert.strictEqual(passesFilter(prompt, f2), true);
  })) p++; else f++;

  if (test('turnLabel: first line of the turn prompt; 48-char cap; \'\' with no prompt', () => {
    const steps = [
      step('p1', { turn: 1, kind: 'prompt', tool: 'Prompt', detail: 'Plan the five views\nand more' }),
      step('p2', { turn: 2, kind: 'prompt', tool: 'Prompt', detail: 'x'.repeat(80) }),
      step('t3', { turn: 3 })
    ];
    assert.strictEqual(turnLabel(steps, 1), 'Plan the five views');
    assert.strictEqual(turnLabel(steps, 2).length, 48);
    assert.ok(turnLabel(steps, 2).endsWith('…'));
    assert.strictEqual(turnLabel(steps, 3), '');
    assert.strictEqual(turnLabel(steps, 9), '');
    const exact = [step('p', { turn: 1, kind: 'prompt', detail: 'y'.repeat(48) })];
    assert.strictEqual(turnLabel(exact, 1), 'y'.repeat(48));
  })) p++; else f++;

  if (test('labels: every rel covered, copied from the mock; filters in order', () => {
    const rels: TraceRel[] = ['asked', 'answer', 'plan', 'informed', 'verifies', 'retry', 'delegated', 'commits'];
    for (const r of rels) { assert.ok(REL_LABEL[r]); assert.ok(REL_FWD_LABEL[r]); }
    assert.strictEqual(REL_LABEL.verifies, 'checks');
    assert.strictEqual(REL_FWD_LABEL.commits, 'committed in');
    assert.deepStrictEqual(TRACE_FILTERS.map(x => x.label), ['All', 'Edits', 'Fails', 'You']);
    assert.deepStrictEqual(TRACE_FILTERS.map(x => x.key), ['all', 'edits', 'fails', 'you']);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
