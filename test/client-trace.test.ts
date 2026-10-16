import assert from 'node:assert';

import {
  REL_FWD_LABEL, REL_LABEL, TRACE_FILTERS, causesOf, clipText, ledTo, mergeTrace, passesFilter, subagentType, traceDuration,
  traceLayout, turnLabel, type TraceFolds, type TraceItem
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

  // ── traceLayout: the folded spine ──
  const NO_FOLDS: TraceFolds = { open: new Set(), closed: new Set() };
  const t0 = Date.parse('2026-10-16T10:00:00.000Z');
  const iso = (s: number): string => new Date(t0 + s * 1000).toISOString();
  /** A Task `A` with `n` children `c0..`, the Task at second 0 and each child a second apart. */
  function agentRun(n: number, over: Partial<TraceStep> = {}, kid: (i: number) => Partial<TraceStep> = () => ({})): TraceStep[] {
    const out = [step('p', { kind: 'prompt', tool: 'Prompt', detail: 'go', at: iso(0), status: null }),
      step('A', { kind: 'agent', tool: 'Agent · general-purpose', at: iso(1), ...over })];
    for (let i = 0; i < n; i++) out.push(step('c' + i, { agent: 'A', at: iso(2 + i), ...kid(i) }));
    return out;
  }
  const shape = (items: TraceItem[]): string[] => items.map(i =>
    i.t === 'step' ? `${i.step.id}@${i.depth}` : i.t === 'fold' ? `fold:${i.fold.key}${i.fold.open ? '+' : '-'}` : i.t === 'more' ? `more:${i.n}` : i.t);
  const layout = (steps: TraceStep[], o: Partial<Parameters<typeof traceLayout>[1]> = {}) =>
    traceLayout(steps, { filter: 'all', sel: null, folds: NO_FOLDS, ...o });

  if (test('traceLayout: a finished, closed fold shows its summary and 0 rows', () => {
    const items = layout(agentRun(5, {}, i => (i === 2 ? { status: 'error' } : {})));
    assert.deepStrictEqual(shape(items), ['turn', 'p@0', 'A@0', 'fold:A-']);
    const f = items.find(i => i.t === 'fold');
    assert.ok(f && f.t === 'fold');
    assert.strictEqual(f.fold.depth, 1);
    assert.deepStrictEqual([f.fold.ok, f.fold.failed, f.fold.running, f.fold.live], [4, 1, 0, false]);
    assert.strictEqual(f.fold.members.length, 5);
  })) p++; else f++;

  if (test('traceLayout: closed and running shows the last 3 under "N earlier"', () => {
    const items = layout(agentRun(6, { status: 'running' }, i => (i === 5 ? { status: 'running' } : {})));
    assert.deepStrictEqual(shape(items), ['turn', 'p@0', 'A@0', 'fold:A-', 'more:3', 'c3@1', 'c4@1', 'c5@1']);
    const short = layout(agentRun(2, { status: 'running' }));
    assert.deepStrictEqual(shape(short), ['turn', 'p@0', 'A@0', 'fold:A-', 'c0@1', 'c1@1'], 'no "0 earlier" line');
  })) p++; else f++;

  if (test('traceLayout: a fold opens by itself when it holds sel, not when sel is in the tail', () => {
    assert.deepStrictEqual(shape(layout(agentRun(5), { sel: 'c1' })).slice(3),
      ['fold:A+', 'c0@1', 'c1@1', 'c2@1', 'c3@1', 'c4@1']);
    const running = agentRun(6, { status: 'running' });
    assert.deepStrictEqual(shape(layout(running, { sel: 'c5' })).slice(3), ['fold:A-', 'more:3', 'c3@1', 'c4@1', 'c5@1']);
    assert.ok(shape(layout(running, { sel: 'c0' })).includes('fold:A+'));
  })) p++; else f++;

  if (test('traceLayout: an explicit close beats the auto-open; an explicit open needs no pick', () => {
    const closed = layout(agentRun(5), { sel: 'c1', folds: { open: new Set(), closed: new Set(['A']) } });
    assert.deepStrictEqual(shape(closed).slice(3), ['fold:A-']);
    const opened = layout(agentRun(5), { folds: { open: new Set(['A']), closed: new Set() } });
    assert.deepStrictEqual(shape(opened).slice(3), ['fold:A+', 'c0@1', 'c1@1', 'c2@1', 'c3@1', 'c4@1']);
  })) p++; else f++;

  if (test('traceLayout: 4 consecutive main calls of one tool in one turn fold; 3 do not', () => {
    const reads = (n: number, tool = 'Read') => [step('p', { kind: 'prompt', tool: 'Prompt', at: iso(0), status: null }),
      ...Array.from({ length: n }, (_, i) => step('r' + i, { tool, detail: 'src/f' + i + '.ts', at: iso(1 + i) })),
      step('e', { kind: 'edit', tool: 'Edit', at: iso(20) })];
    assert.deepStrictEqual(shape(layout(reads(4))), ['turn', 'p@0', 'fold:run:r0-', 'e@0']);
    assert.deepStrictEqual(shape(layout(reads(3))), ['turn', 'p@0', 'r0@0', 'r1@0', 'r2@0', 'e@0']);
    const run = layout(reads(4)).find(i => i.t === 'fold');
    assert.ok(run && run.t === 'fold');
    assert.strictEqual(run.fold.task, null);
    assert.strictEqual(run.fold.depth, 0);
    // a turn boundary splits the run, a subagent step between them does not
    const split = [...reads(2), ...[2, 3].map(i => step('r' + i, { turn: 2, detail: 'x', at: iso(30 + i) }))];
    assert.ok(!shape(layout(split)).some(x => x.startsWith('fold:run')));
    // prompts and agents never fold as a run
    const agents = Array.from({ length: 4 }, (_, i) => step('a' + i, { kind: 'agent', tool: 'Agent', at: iso(i) }));
    assert.ok(!shape(layout(agents)).some(x => x.startsWith('fold:')));
  })) p++; else f++;

  if (test('traceLayout: under a filter nothing folds, children sit at one depth, a Task with a passing child stays', () => {
    const steps = agentRun(5, {}, i => (i === 3 ? { kind: 'edit', tool: 'Edit' } : {}));
    assert.deepStrictEqual(shape(layout(steps, { filter: 'edits' })), ['turn', 'p@0', 'A@0', 'c3@1']);
    // the picked row always renders, under its own Task
    assert.deepStrictEqual(shape(layout(steps, { filter: 'edits', sel: 'c1' })), ['turn', 'p@0', 'A@0', 'c1@1', 'c3@1']);
    assert.deepStrictEqual(shape(layout(steps, { filter: 'fails' })), ['turn', 'p@0']);
  })) p++; else f++;

  if (test('traceLayout: nested agents walk `agent` up the chain for depth', () => {
    const steps = [
      step('A', { kind: 'agent', tool: 'Agent · outer', at: iso(0) }),
      step('B', { kind: 'agent', tool: 'Agent · inner', agent: 'A', at: iso(1) }),
      step('x', { agent: 'B', at: iso(2) }),
      step('y', { agent: 'B', kind: 'edit', tool: 'Edit', at: iso(3) }),
      step('orphan', { agent: 'gone', at: iso(4) })
    ];
    // sel `x` opens both folds: the outer one holds it two levels down
    const items = layout(steps, { sel: 'x' });
    assert.deepStrictEqual(shape(items), ['turn', 'A@0', 'fold:A+', 'B@1', 'fold:B+', 'x@2', 'y@2', 'orphan@0']);
    const inner = items.find(i => i.t === 'fold' && i.fold.key === 'B');
    assert.ok(inner && inner.t === 'fold');
    assert.strictEqual(inner.fold.depth, 2);
    const outer = items.find(i => i.t === 'fold' && i.fold.key === 'A');
    assert.ok(outer && outer.t === 'fold');
    assert.deepStrictEqual(outer.fold.ids.sort(), ['B', 'x', 'y']);
    assert.deepStrictEqual(shape(layout(steps, { filter: 'edits' })), ['turn', 'A@0', 'B@1', 'y@2']);
  })) p++; else f++;

  if (test('traceLayout: the not-loaded notice leads the spine', () => {
    assert.deepStrictEqual(shape(layout(agentRun(1), { dropped: 7 })).slice(0, 2), ['dropped', 'turn']);
    assert.ok(!shape(layout(agentRun(1), { dropped: 0 })).includes('dropped'));
  })) p++; else f++;

  if (test('traceDuration / subagentType / clipText', () => {
    assert.strictEqual(traceDuration(iso(0), iso(42)), '42s');
    assert.strictEqual(traceDuration(iso(0), iso(60)), '1m 00s');
    assert.strictEqual(traceDuration(iso(0), iso(125)), '2m 05s');
    assert.strictEqual(traceDuration(iso(10), iso(0)), '0s');
    assert.strictEqual(traceDuration('', iso(0)), '0s');
    assert.strictEqual(subagentType('Agent · general-purpose'), 'general-purpose');
    assert.strictEqual(subagentType('Task'), 'Task');
    assert.strictEqual(clipText('abcdef', 4), 'abc…');
    assert.strictEqual(clipText('abcd', 4), 'abcd');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
