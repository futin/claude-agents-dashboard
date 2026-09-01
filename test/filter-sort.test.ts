import assert from 'node:assert';

import type { Session } from '../shared/types.js';
import {
  applyView,
  clearFilters,
  describeEmpty,
  distinctProjects,
  hasActiveFilters,
  pruneProjects,
  DEFAULT_VIEW,
  type View
} from '../client/src/lib/filterSort.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const NOW = 1_700_000_000_000;

/** Minimal Session; only fields the view logic touches carry meaning. */
function sess(p: Partial<Session>): Session {
  return {
    id: p.id ?? p.project ?? 'id',
    project: p.project ?? 'proj',
    projectPath: null,
    sessionName: p.sessionName ?? null,
    gitBranch: null,
    model: 'claude-opus-4-8',
    tokens: p.tokens ?? 0,
    contextWindow: 200_000,
    contextWindowLabel: '200k',
    contextPct: 0,
    status: p.status ?? 'idle',
    surface: p.surface ?? 'local',
    remoteQuestion: p.remoteQuestion ?? false,
    remotePlan: p.remotePlan ?? false,
    remoteReply: p.remoteReply ?? false,
    permissionWait: p.permissionWait ?? false,
    activity: null,
    lastTimestamp: null,
    updatedMs: p.updatedMs ?? NOW,
    version: null,
    kaizenLesson: p.kaizenLesson ?? null
  };
}

function view(patch: Partial<View>): View {
  return { ...DEFAULT_VIEW, ...patch };
}

export function run(): number {
  console.log('\n=== filterSort.ts ===\n');
  let p = 0, f = 0;

  const projects = () => distinctProjects([
    sess({ project: 'zeta' }), sess({ project: 'alpha' }), sess({ project: 'alpha' })
  ]);

  if (test('distinctProjects: unique + sorted', () => {
    assert.deepStrictEqual(projects(), ['alpha', 'zeta']);
  })) p++; else f++;

  if (test('default view: recency desc, no filtering', () => {
    const out = applyView([
      sess({ project: 'old', updatedMs: NOW - 5000 }),
      sess({ project: 'new', updatedMs: NOW - 1000 })
    ], DEFAULT_VIEW, NOW);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].project, 'new'); // newest first
    assert.strictEqual(out[1].project, 'old');
  })) p++; else f++;

  if (test('status filter: keeps only matching', () => {
    const out = applyView([
      sess({ project: 'a', status: 'working' }),
      sess({ project: 'b', status: 'idle' })
    ], view({ statuses: ['working'] }), NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].project, 'a');
  })) p++; else f++;

  if (test('status filter: multiple values keep any matching', () => {
    const out = applyView([
      sess({ project: 'w', status: 'working' }),
      sess({ project: 'i', status: 'idle' }),
      sess({ project: 'q', status: 'question' })
    ], view({ statuses: ['working', 'idle'] }), NOW);
    assert.deepStrictEqual(out.map(s => s.project).sort(), ['i', 'w']);
  })) p++; else f++;

  if (test('project filter: keeps only matching', () => {
    const out = applyView([
      sess({ project: 'a' }), sess({ project: 'b' })
    ], view({ projects: ['b'] }), NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].project, 'b');
  })) p++; else f++;

  if (test('empty facet arrays = no filter (show all)', () => {
    const out = applyView([
      sess({ project: 'a', status: 'working' }),
      sess({ project: 'b', status: 'idle' })
    ], view({ projects: [], statuses: [] }), NOW);
    assert.strictEqual(out.length, 2);
  })) p++; else f++;

  if (test('activity window: boundary (inclusive) keeps, older drops', () => {
    const out = applyView([
      sess({ project: 'edge', updatedMs: NOW - 15 * 60_000 }),      // exactly 15m → kept
      sess({ project: 'stale', updatedMs: NOW - 15 * 60_000 - 1 })  // just over → dropped
    ], view({ window: '15m' }), NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].project, 'edge');
  })) p++; else f++;

  if (test('sort tokens desc / asc', () => {
    const list = [sess({ project: 'lo', tokens: 100 }), sess({ project: 'hi', tokens: 900 })];
    assert.strictEqual(applyView(list, view({ sortKey: 'tokens', sortDir: 'desc' }), NOW)[0].project, 'hi');
    assert.strictEqual(applyView(list, view({ sortKey: 'tokens', sortDir: 'asc' }), NOW)[0].project, 'lo');
  })) p++; else f++;

  if (test('sort name asc (A→Z)', () => {
    const out = applyView([
      sess({ project: 'zebra' }), sess({ project: 'apple' })
    ], view({ sortKey: 'name', sortDir: 'asc' }), NOW);
    assert.strictEqual(out[0].project, 'apple');
  })) p++; else f++;

  if (test('sort status: urgency order question→working→incomplete→idle', () => {
    const out = applyView([
      sess({ project: 'i', status: 'idle' }),
      sess({ project: 'w', status: 'working' }),
      sess({ project: 'q', status: 'question' }),
      sess({ project: 'p', status: 'incomplete' })
    ], view({ sortKey: 'status', sortDir: 'desc' }), NOW);
    assert.deepStrictEqual(out.map(s => s.project), ['q', 'w', 'p', 'i']);
  })) p++; else f++;

  if (test('combined filters AND together', () => {
    const out = applyView([
      sess({ project: 'a', status: 'working', updatedMs: NOW - 1000 }),
      sess({ project: 'a', status: 'idle', updatedMs: NOW - 1000 }),
      sess({ project: 'b', status: 'working', updatedMs: NOW - 1000 })
    ], view({ projects: ['a'], statuses: ['working'] }), NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].project, 'a');
    assert.strictEqual(out[0].status, 'working');
  })) p++; else f++;

  if (test('pruneProjects: a name absent from the payload resets to all projects', () => {
    const out = pruneProjects(['gone'], [sess({ project: 'a' }), sess({ project: 'b' })]);
    assert.deepStrictEqual(out, []);
  })) p++; else f++;

  if (test('pruneProjects: drops only the absent names, keeps the present ones', () => {
    const out = pruneProjects(['a', 'gone'], [sess({ project: 'a' }), sess({ project: 'b' })]);
    assert.deepStrictEqual(out, ['a']);
  })) p++; else f++;

  if (test('pruneProjects: nothing to prune returns the same array reference', () => {
    const selected = ['a', 'b'];
    assert.strictEqual(
      pruneProjects(selected, [sess({ project: 'a' }), sess({ project: 'b' })]),
      selected
    );
  })) p++; else f++;

  if (test('pruneProjects: an empty payload prunes nothing (no evidence of absence)', () => {
    const selected = ['a'];
    assert.strictEqual(pruneProjects(selected, []), selected);
  })) p++; else f++;

  if (test('pruneProjects: an empty selection is left alone', () => {
    const selected: string[] = [];
    assert.strictEqual(pruneProjects(selected, [sess({ project: 'a' })]), selected);
  })) p++; else f++;

  if (test('pruneProjects result unhides the rows applyView was dropping', () => {
    const list = [sess({ project: 'a' }), sess({ project: 'b' })];
    const stale = view({ projects: ['gone'] });
    assert.strictEqual(applyView(list, stale, NOW).length, 0);
    const healed = view({ projects: pruneProjects(stale.projects, list) });
    assert.strictEqual(applyView(list, healed, NOW).length, 2);
  })) p++; else f++;

  const TWO_HOURS = 2 * 60 * 60_000;

  if (test('describeEmpty: an empty payload is the payload, never a filter', () => {
    assert.deepStrictEqual(describeEmpty([], DEFAULT_VIEW, NOW), {
      payloadEmpty: true, total: 0, culprits: []
    });
  })) p++; else f++;

  if (test('describeEmpty: an empty payload blames no filter even with filters set', () => {
    const v = view({ projects: ['a'], window: '15m' });
    assert.deepStrictEqual(describeEmpty([], v, NOW), {
      payloadEmpty: true, total: 0, culprits: []
    });
  })) p++; else f++;

  if (test('describeEmpty: a project filter that rejects every row is named', () => {
    const list = [sess({ project: 'a' }), sess({ project: 'a' }), sess({ project: 'a' })];
    assert.deepStrictEqual(describeEmpty(list, view({ projects: ['b'] }), NOW), {
      payloadEmpty: false, total: 3, culprits: ['projects']
    });
  })) p++; else f++;

  if (test('describeEmpty: a status filter that rejects every row is named', () => {
    const list = [sess({ status: 'idle' }), sess({ status: 'idle' })];
    assert.deepStrictEqual(describeEmpty(list, view({ statuses: ['working'] }), NOW).culprits, ['statuses']);
  })) p++; else f++;

  if (test('describeEmpty: an activity window that rejects every row is named', () => {
    const list = [sess({ updatedMs: NOW - TWO_HOURS })];
    assert.deepStrictEqual(describeEmpty(list, view({ window: '15m' }), NOW).culprits, ['window']);
  })) p++; else f++;

  if (test('describeEmpty: culprits keep a fixed order, not view-key order', () => {
    const list = [sess({ project: 'a', updatedMs: NOW - TWO_HOURS })];
    const v = view({ window: '15m', projects: ['b'] });
    assert.deepStrictEqual(describeEmpty(list, v, NOW).culprits, ['projects', 'window']);
  })) p++; else f++;

  if (test('describeEmpty: a predicate that rejects nothing is never named', () => {
    const list = [sess({ project: 'a', status: 'idle' }), sess({ project: 'a', status: 'idle' })];
    const v = view({ projects: ['a'], statuses: ['working'] });
    assert.deepStrictEqual(describeEmpty(list, v, NOW).culprits, ['statuses']);
  })) p++; else f++;

  if (test('hasActiveFilters: only the three filter facets count, not sort', () => {
    assert.strictEqual(hasActiveFilters(DEFAULT_VIEW), false);
    assert.strictEqual(hasActiveFilters(view({ window: '1h' })), true);
    assert.strictEqual(hasActiveFilters(view({ projects: ['a'] })), true);
    assert.strictEqual(hasActiveFilters(view({ statuses: ['idle'] })), true);
    assert.strictEqual(hasActiveFilters(view({ sortKey: 'tokens', sortDir: 'asc' })), false);
  })) p++; else f++;

  if (test('clearFilters: resets the three facets and preserves sort', () => {
    const v = view({ projects: ['a'], statuses: ['idle'], window: '1h', sortKey: 'tokens', sortDir: 'asc' });
    assert.deepStrictEqual(clearFilters(v), {
      projects: [], statuses: [], window: 'all', sortKey: 'tokens', sortDir: 'asc'
    });
  })) p++; else f++;

  if (test('clearFilters: nothing active returns the same view by reference', () => {
    assert.strictEqual(clearFilters(DEFAULT_VIEW), DEFAULT_VIEW);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
