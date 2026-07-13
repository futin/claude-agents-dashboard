import assert from 'node:assert';

import type { AnalyticsReport, SessionAnalysis } from '../shared/types.js';
import {
  applyAnalyticsView,
  distinctProjects,
  distinctModels,
  DEFAULT_ANALYTICS_VIEW,
  type AnalyticsView
} from '../client/src/lib/analyticsFilterSort.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Fixed "now" = midnight UTC 2023-11-20, so day-window math is deterministic. */
const NOW = Date.parse('2023-11-20T00:00:00Z');

/** Minimal AnalyticsReport; only the fields the view logic touches carry meaning. */
function rep(p: {
  id?: string;
  project?: string;
  models?: string[];
  loggedAt?: string;
  billable?: number | null;
}): AnalyticsReport {
  const analysis =
    p.billable == null
      ? null
      : ({ totals: { billableApprox: p.billable } } as unknown as SessionAnalysis);
  return {
    sessionId: p.id ?? p.project ?? 'id',
    project: p.project ?? 'proj',
    cwd: null,
    models: p.models ?? ['claude-opus-4-8'],
    loggedAt: p.loggedAt ?? '2023-11-19',
    analysis,
    lesson: 'lesson'
  };
}

function view(patch: Partial<AnalyticsView>): AnalyticsView {
  return { ...DEFAULT_ANALYTICS_VIEW, ...patch };
}

export function run(): number {
  console.log('\n=== analyticsFilterSort.ts ===\n');
  let p = 0, f = 0;

  if (test('distinctProjects: unique + sorted', () => {
    assert.deepStrictEqual(
      distinctProjects([rep({ project: 'zeta' }), rep({ project: 'alpha' }), rep({ project: 'alpha' })]),
      ['alpha', 'zeta']
    );
  })) p++; else f++;

  if (test('distinctModels: flattened, unique + sorted', () => {
    assert.deepStrictEqual(
      distinctModels([
        rep({ id: '1', models: ['sonnet', 'opus'] }),
        rep({ id: '2', models: ['opus'] })
      ]),
      ['opus', 'sonnet']
    );
  })) p++; else f++;

  if (test('default view: recency desc, no filtering', () => {
    const out = applyAnalyticsView([
      rep({ project: 'old', loggedAt: '2023-11-01' }),
      rep({ project: 'new', loggedAt: '2023-11-19' })
    ], DEFAULT_ANALYTICS_VIEW, NOW);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].project, 'new'); // newest first
    assert.strictEqual(out[1].project, 'old');
  })) p++; else f++;

  if (test('project filter: keeps only matching', () => {
    const out = applyAnalyticsView([
      rep({ project: 'a' }), rep({ project: 'b' })
    ], view({ projects: ['b'] }), NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].project, 'b');
  })) p++; else f++;

  if (test('model filter: keeps report if any model matches', () => {
    const out = applyAnalyticsView([
      rep({ id: 'x', models: ['opus', 'haiku'] }),
      rep({ id: 'y', models: ['sonnet'] })
    ], view({ models: ['haiku'] }), NOW);
    assert.deepStrictEqual(out.map(r => r.sessionId), ['x']);
  })) p++; else f++;

  if (test('empty facet arrays = no filter (show all)', () => {
    const out = applyAnalyticsView([
      rep({ project: 'a' }), rep({ project: 'b' })
    ], view({ projects: [], models: [] }), NOW);
    assert.strictEqual(out.length, 2);
  })) p++; else f++;

  if (test('window 7d: keeps recent, drops older', () => {
    const out = applyAnalyticsView([
      rep({ project: 'recent', loggedAt: '2023-11-19' }), // 1 day → kept
      rep({ project: 'old', loggedAt: '2023-11-01' })     // 19 days → dropped
    ], view({ window: '7d' }), NOW);
    assert.deepStrictEqual(out.map(r => r.project), ['recent']);
  })) p++; else f++;

  if (test('window 30d: keeps 19-day-old, drops 90-day-old', () => {
    const out = applyAnalyticsView([
      rep({ project: 'mid', loggedAt: '2023-11-01' }),   // 19 days → kept
      rep({ project: 'ancient', loggedAt: '2023-08-01' }) // outside → dropped
    ], view({ window: '30d' }), NOW);
    assert.deepStrictEqual(out.map(r => r.project), ['mid']);
  })) p++; else f++;

  if (test('sort tokens desc / asc (null analysis = 0)', () => {
    const list = [
      rep({ project: 'lo', billable: 100 }),
      rep({ project: 'hi', billable: 900 }),
      rep({ project: 'none', billable: null })
    ];
    assert.strictEqual(applyAnalyticsView(list, view({ sortKey: 'tokens', sortDir: 'desc' }), NOW)[0].project, 'hi');
    assert.strictEqual(applyAnalyticsView(list, view({ sortKey: 'tokens', sortDir: 'asc' }), NOW)[0].project, 'none');
  })) p++; else f++;

  if (test('sort project asc (A→Z)', () => {
    const out = applyAnalyticsView([
      rep({ project: 'zebra' }), rep({ project: 'apple' })
    ], view({ sortKey: 'project', sortDir: 'asc' }), NOW);
    assert.strictEqual(out[0].project, 'apple');
  })) p++; else f++;

  if (test('combined filters AND together', () => {
    const out = applyAnalyticsView([
      rep({ id: '1', project: 'a', models: ['opus'], loggedAt: '2023-11-19' }),
      rep({ id: '2', project: 'a', models: ['sonnet'], loggedAt: '2023-11-19' }),
      rep({ id: '3', project: 'b', models: ['opus'], loggedAt: '2023-11-19' })
    ], view({ projects: ['a'], models: ['opus'] }), NOW);
    assert.deepStrictEqual(out.map(r => r.sessionId), ['1']);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
