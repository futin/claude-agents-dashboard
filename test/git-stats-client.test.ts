/**
 * Client domain logic of the Git sub-view (`client/src/lib/gitLayouts.ts`, `gitTriage.ts`, `gitStatsText.ts`, `gitBar.ts`, `gitPoll.ts`, `gitClock.ts`): the layout switcher's
 * rules, the Triage grouping precedence, every string of spec §6's copy table, the divergence bar's scale and the poll schedule. All pure, so no React and no
 * DOM.
 */
import assert from 'node:assert';

import type { GitBranch, RepoGitStats } from '../shared/types.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';
import { DEFAULT_GIT_LAYOUT, GIT_LAYOUTS, WIDE_ONLY_GIT_LAYOUTS, drawableGitLayout, gitLayoutsFor, isGitLayout } from '../client/src/lib/gitLayouts.js';
import { triageGitRepos } from '../client/src/lib/gitTriage.js';
import {
  GIT_LOAD_FAILED, GIT_LOADING, GIT_NO_OPEN_BRANCHES, GIT_NO_PINS, GIT_UPDATE_FAILED,
  gitBranchChipText, gitFirstLoadText, gitBranchCounts, gitFetchedText, gitMergedText, gitMoreText, gitNotShownText, gitStateSentence, gitTrunkVsOriginText,
  gitUncommittedText, gitVisibleBranches,
} from '../client/src/lib/gitStatsText.js';
import { GIT_BAR_HALF_PX, GIT_BAR_MIN_PX, gitBarMax, gitBarWidth } from '../client/src/lib/gitBar.js';
import { GIT_POLL_MS, startGitPoll } from '../client/src/lib/gitPoll.js';
import { GIT_FETCH_OPTIONS } from '../client/src/lib/gitClock.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

/** A clean, level, no-branch repo on main with an origin: the quiet baseline every case overrides one field of. */
function okRepo(name: string, over: Partial<Ok> = {}): Ok {
  return {
    dirName: name, name, path: `/p/${name}`, state: 'ok', toplevel: `/p/${name}`,
    branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
    trunk: 'main', hasOrigin: true, trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true },
    fetchedAtMs: null, lastFetch: null, branches: [], unmergedTotal: 0, mergedCount: 0,
    ...over,
  };
}

function branch(name: string, over: Partial<GitBranch> = {}): GitBranch {
  return { name, ahead: 1, behind: 0, lastCommitMs: 0, worktreePath: null, ...over };
}

const names = (rs: RepoGitStats[]) => rs.map(r => r.name);

export function run(): number {
  let p = 0, f = 0;
  console.log('\ngit stats client logic');

  // ── layouts ────────────────────────────────────────────────────────────────
  if (test('GIT_LAYOUTS lists Cards, Table, Triage in that order; cards is the default; table is wide-only', () => {
    assert.deepStrictEqual(GIT_LAYOUTS, [
      { key: 'cards', label: 'Cards' }, { key: 'table', label: 'Table' }, { key: 'triage', label: 'Triage' },
    ]);
    assert.strictEqual(DEFAULT_GIT_LAYOUT, 'cards');
    assert.deepStrictEqual([...WIDE_ONLY_GIT_LAYOUTS], ['table']);
  })) p++; else f++;

  if (test('drawableGitLayout: table on a phone draws cards, on a laptop table; cards and triage are never coerced', () => {
    assert.strictEqual(drawableGitLayout('table', true), 'cards');
    assert.strictEqual(drawableGitLayout('table', false), 'table');
    assert.strictEqual(drawableGitLayout('triage', true), 'triage');
    assert.strictEqual(drawableGitLayout('cards', true), 'cards');
  })) p++; else f++;

  if (test('gitLayoutsFor: narrow drops table, wide keeps all three', () => {
    assert.deepStrictEqual(gitLayoutsFor(true).map(l => l.key), ['cards', 'triage']);
    assert.deepStrictEqual(gitLayoutsFor(false).map(l => l.key), ['cards', 'table', 'triage']);
  })) p++; else f++;

  if (test('isGitLayout accepts the three keys and rejects anything else', () => {
    assert.strictEqual(isGitLayout('grid'), false);
    assert.strictEqual(isGitLayout(undefined), false);
    assert.strictEqual(isGitLayout('table'), true);
  })) p++; else f++;

  if (test('OWNED_KEYS contains management.gitLayout, so Reset clears the choice', () => {
    assert.ok(OWNED_KEYS.includes('management.gitLayout'));
  })) p++; else f++;

  // ── triage ─────────────────────────────────────────────────────────────────
  const group = (r: RepoGitStats) => {
    const g = triageGitRepos([r]);
    return (Object.keys(g) as (keyof typeof g)[]).find(k => g[k].length === 1);
  };

  if (test('triage: dirty repo with branches → needs (uncommitted beats in-flight)', () => {
    assert.strictEqual(group(okRepo('a', { uncommitted: 2, branches: [branch('x')], unmergedTotal: 1 })), 'needs');
  })) p++; else f++;

  if (test('triage: clean, trunk 0 ahead 1 behind origin → needs; 1 ahead 0 behind → needs', () => {
    assert.strictEqual(group(okRepo('a', { trunkVsOrigin: { ahead: 0, behind: 1 } })), 'needs');
    assert.strictEqual(group(okRepo('a', { trunkVsOrigin: { ahead: 1, behind: 0 } })), 'needs');
  })) p++; else f++;

  if (test('triage: clean, trunkVsOrigin null, 1 unmerged → flight', () => {
    assert.strictEqual(group(okRepo('a', { trunkVsOrigin: null, branches: [branch('x')], unmergedTotal: 1 })), 'flight');
  })) p++; else f++;

  if (test('triage: no trunk with 2 branches → flight', () => {
    const r = okRepo('a', {
      trunk: null, trunkRefs: null, trunkVsOrigin: null, onTrunk: false,
      branches: [branch('x', { ahead: null, behind: null }), branch('y', { ahead: null, behind: null })], unmergedTotal: 2,
    });
    assert.strictEqual(group(r), 'flight');
  })) p++; else f++;

  if (test('triage: clean, no remote, no branches → quiet', () => {
    assert.strictEqual(group(okRepo('a', { hasOrigin: false, trunkVsOrigin: null, trunkRefs: { local: true, origin: false } })), 'quiet');
  })) p++; else f++;

  if (test('triage: level with origin and no branches → quiet', () => {
    assert.strictEqual(group(okRepo('a')), 'quiet');
  })) p++; else f++;

  if (test('triage: missing, not-git and error → unreadable', () => {
    assert.strictEqual(group({ dirName: 'a', name: 'a', path: null, state: 'missing' }), 'unreadable');
    assert.strictEqual(group({ dirName: 'a', name: 'a', path: '/x', state: 'not-git' }), 'unreadable');
    assert.strictEqual(group({ dirName: 'a', name: 'a', path: '/x', state: 'error', message: 'timed out' }), 'unreadable');
  })) p++; else f++;

  if (test('triage: unreadable wins over every other rule (rule 1 is first)', () => {
    // An `error` repo carries none of the ok fields, so the only way to prove precedence is that the other rules never get to read them.
    const g = triageGitRepos([{ dirName: 'a', name: 'a', path: '/x', state: 'error', message: 'boom' }]);
    assert.deepStrictEqual({ n: g.needs.length, f: g.flight.length, q: g.quiet.length, u: g.unreadable.length }, { n: 0, f: 0, q: 0, u: 1 });
  })) p++; else f++;

  if (test('triage: input order [C, A, B], all quiet → output order [C, A, B]', () => {
    const g = triageGitRepos([okRepo('C'), okRepo('A'), okRepo('B')]);
    assert.deepStrictEqual(names(g.quiet), ['C', 'A', 'B']);
  })) p++; else f++;

  if (test('triage: pin order is kept within each group across a mixed list', () => {
    const g = triageGitRepos([
      okRepo('q1'), okRepo('n1', { uncommitted: 1 }), okRepo('f1', { trunkVsOrigin: null, unmergedTotal: 1, branches: [branch('x')] }),
      { dirName: 'u1', name: 'u1', path: null, state: 'missing' }, okRepo('n2', { uncommitted: 3 }), okRepo('q2'),
    ]);
    assert.deepStrictEqual(
      { needs: names(g.needs), flight: names(g.flight), quiet: names(g.quiet), unreadable: names(g.unreadable) },
      { needs: ['n1', 'n2'], flight: ['f1'], quiet: ['q1', 'q2'], unreadable: ['u1'] },
    );
  })) p++; else f++;

  // ── copy ───────────────────────────────────────────────────────────────────
  if (test('trunk vs origin: {0,0} / {0,2} / {3,0} / {3,2}', () => {
    const t = (a: number, b: number) => gitTrunkVsOriginText(okRepo('a', { trunkVsOrigin: { ahead: a, behind: b } }));
    assert.strictEqual(t(0, 0), 'main = origin');
    assert.strictEqual(t(0, 2), 'main 2 behind origin');
    assert.strictEqual(t(3, 0), 'main 3 ahead of origin');
    assert.strictEqual(t(3, 2), 'main 3 ahead, 2 behind origin');
  })) p++; else f++;

  if (test('trunk vs origin: no remote / not on origin / only on origin / no trunk', () => {
    assert.strictEqual(
      gitTrunkVsOriginText(okRepo('a', { hasOrigin: false, trunkVsOrigin: null, trunkRefs: { local: true, origin: false } })), 'no remote');
    assert.strictEqual(
      gitTrunkVsOriginText(okRepo('a', { trunkVsOrigin: null, trunkRefs: { local: true, origin: false } })), 'main not on origin');
    assert.strictEqual(
      gitTrunkVsOriginText(okRepo('a', { trunk: 'develop', trunkVsOrigin: null, trunkRefs: { local: false, origin: true } })), 'develop only on origin');
    assert.strictEqual(
      gitTrunkVsOriginText(okRepo('a', { trunk: null, trunkVsOrigin: null, trunkRefs: null })), 'no main branch');
  })) p++; else f++;

  if (test('trunk vs origin: no trunk wins over no remote; a trunk-less repo with an origin still says "no main branch"', () => {
    assert.strictEqual(gitTrunkVsOriginText(okRepo('a', { trunk: null, hasOrigin: false, trunkVsOrigin: null, trunkRefs: null })), 'no main branch');
    assert.strictEqual(gitTrunkVsOriginText(okRepo('a', { trunk: null, hasOrigin: true, trunkVsOrigin: null, trunkRefs: null })), 'no main branch');
  })) p++; else f++;

  if (test('branch chip: the branch name, or "detached at <sha>"', () => {
    assert.strictEqual(gitBranchChipText(okRepo('a', { branch: 'feat/x' })), 'feat/x');
    assert.strictEqual(gitBranchChipText(okRepo('a', { branch: null, detachedSha: 'a1b2c3d', onTrunk: false })), 'detached at a1b2c3d');
  })) p++; else f++;

  if (test('uncommitted: 4 → "4 uncommitted", 0 → "clean"', () => {
    assert.strictEqual(gitUncommittedText(4), '4 uncommitted');
    assert.strictEqual(gitUncommittedText(0), 'clean');
  })) p++; else f++;

  if (test('fetched: null → never fetched, 2h ago → "fetched 2h ago", a future mtime clamps to "fetched 0s ago"', () => {
    assert.strictEqual(gitFetchedText(null), 'never fetched');
    assert.strictEqual(gitFetchedText(Date.now() - 2 * 3_600_000), 'fetched 2h ago');
    assert.strictEqual(gitFetchedText(Date.now() + 5 * 60_000), 'fetched 0s ago');
  })) p++; else f++;

  if (test('more / not shown / merged counters', () => {
    assert.strictEqual(gitMoreText(8), '+3 more');
    assert.strictEqual(gitNotShownText(60), '10 more not shown (over 50)');
    assert.strictEqual(gitMergedText(7), '7 merged branches hidden');
  })) p++; else f++;

  if (test('non-ok states: missing with a path, missing without, not-git, error', () => {
    assert.strictEqual(gitStateSentence({ dirName: 'a', name: 'a', path: '/x/y', state: 'missing' }), 'Folder is gone — /x/y. Unpin it under Pinned.');
    assert.strictEqual(gitStateSentence({ dirName: 'a', name: 'a', path: null, state: 'missing' }), 'Folder is gone. Unpin it under Pinned.');
    assert.strictEqual(gitStateSentence({ dirName: 'a', name: 'a', path: '/x', state: 'not-git' }), 'Not a git repository.');
    assert.strictEqual(gitStateSentence({ dirName: 'a', name: 'a', path: '/x', state: 'error', message: 'timed out' }), "Couldn't read: timed out");
  })) p++; else f++;

  if (test('page-level copy: no open branches, no pins, first fetch failed, later fetch failed', () => {
    assert.strictEqual(GIT_NO_OPEN_BRANCHES, 'no open branches');
    assert.strictEqual(GIT_NO_PINS, 'No pinned projects yet. Pin one under Pinned.');
    assert.strictEqual(GIT_LOAD_FAILED, "Couldn't load git stats. Retrying every 30s.");
    assert.strictEqual(GIT_UPDATE_FAILED, "couldn't update");
  })) p++; else f++;

  if (test('before the first payload: "Loading…" while waiting, the failure sentence once the first fetch failed', () => {
    assert.strictEqual(GIT_LOADING, 'Loading…');
    assert.strictEqual(gitFirstLoadText(false), 'Loading…');
    assert.strictEqual(gitFirstLoadText(true), "Couldn't load git stats. Retrying every 30s.");
  })) p++; else f++;

  // ── branch helpers ─────────────────────────────────────────────────────────
  if (test('gitBranchCounts: numbers when ahead and behind are known, null when either is null (trunk named but no base ref, or no trunk)', () => {
    assert.deepStrictEqual(gitBranchCounts(branch('x', { ahead: 3, behind: 2 })), { ahead: 3, behind: 2 });
    assert.deepStrictEqual(gitBranchCounts(branch('x', { ahead: 0, behind: 0 })), { ahead: 0, behind: 0 });
    assert.strictEqual(gitBranchCounts(branch('x', { ahead: null, behind: null })), null);
  })) p++; else f++;

  if (test('gitVisibleBranches: newest 5 collapsed, all when expanded', () => {
    const bs = Array.from({ length: 8 }, (_, i) => branch('b' + i));
    assert.strictEqual(gitVisibleBranches(bs, false).length, 5);
    assert.strictEqual(gitVisibleBranches(bs, true).length, 8);
    assert.strictEqual(gitVisibleBranches(bs.slice(0, 5), false).length, 5);
    assert.deepStrictEqual(gitVisibleBranches(bs, false).map(b => b.name), ['b0', 'b1', 'b2', 'b3', 'b4']);
  })) p++; else f++;

  // ── divergence bar ─────────────────────────────────────────────────────────
  if (test('gitBarMax: the largest ahead or behind over every listed branch; count-less branches ignored; 0 when none carry counts', () => {
    assert.strictEqual(gitBarMax([branch('a', { ahead: 3, behind: 0 }), branch('b', { ahead: 1, behind: 12 }), branch('c', { ahead: 2, behind: 88 })]), 88);
    assert.strictEqual(gitBarMax([branch('a', { ahead: 9, behind: 2 }), branch('b', { ahead: null, behind: null })]), 9);
    assert.strictEqual(gitBarMax([branch('a', { ahead: null, behind: null })]), 0);
    assert.strictEqual(gitBarMax([]), 0);
  })) p++; else f++;

  if (test('gitBarWidth: the largest fills its half, the rest proportional, a non-zero count at least the minimum, zero draws nothing', () => {
    assert.strictEqual(GIT_BAR_HALF_PX, 44);
    assert.strictEqual(gitBarWidth(88, 88), 44);
    assert.strictEqual(gitBarWidth(44, 88), 22);
    assert.strictEqual(gitBarWidth(12, 88), 6);
    assert.strictEqual(gitBarWidth(1, 88), GIT_BAR_MIN_PX);
    assert.strictEqual(gitBarWidth(0, 88), 0);
    assert.strictEqual(gitBarWidth(0, 0), 0);
    assert.strictEqual(gitBarWidth(500, 88), 44, 'never wider than its half');
  })) p++; else f++;

  // ── poll schedule ──────────────────────────────────────────────────────────
  /** Fake clock + visibility: timers are recorded, never run on their own; `fire` runs every live one. */
  function fakePoll(visible: boolean) {
    const s = { visible, polls: 0, timers: new Map<number, { fn: () => void; ms: number }>(), next: 1, listeners: new Set<() => void>() };
    const deps = {
      poll: () => { s.polls++; },
      isVisible: () => s.visible,
      onVisibilityChange: (cb: () => void) => { s.listeners.add(cb); return () => { s.listeners.delete(cb); }; },
      setTimer: (fn: () => void, ms: number) => { const id = s.next++; s.timers.set(id, { fn, ms }); return id; },
      clearTimer: (id: unknown) => { s.timers.delete(id as number); },
    };
    const setVisible = (v: boolean) => { s.visible = v; for (const l of [...s.listeners]) l(); };
    const fire = () => { for (const t of [...s.timers.values()]) t.fn(); };
    return { s, deps, setVisible, fire };
  }

  if (test('poll: one fetch on start, then one 30s timer while visible; each tick polls', () => {
    const { s, deps, fire } = fakePoll(true);
    startGitPoll(deps);
    assert.strictEqual(s.polls, 1);
    assert.strictEqual(s.timers.size, 1);
    assert.strictEqual([...s.timers.values()][0].ms, GIT_POLL_MS);
    assert.strictEqual(GIT_POLL_MS, 30_000);
    fire(); fire();
    assert.strictEqual(s.polls, 3);
  })) p++; else f++;

  if (test('poll: started hidden fetches once and arms no timer', () => {
    const { s, deps } = fakePoll(false);
    startGitPoll(deps);
    assert.strictEqual(s.polls, 1);
    assert.strictEqual(s.timers.size, 0);
  })) p++; else f++;

  if (test('poll: going hidden drops the timer; going visible polls at once and re-arms exactly one timer', () => {
    const { s, deps, setVisible } = fakePoll(true);
    startGitPoll(deps);
    setVisible(false);
    assert.strictEqual(s.timers.size, 0);
    assert.strictEqual(s.polls, 1, 'hiding does not poll');
    setVisible(true);
    assert.strictEqual(s.polls, 2);
    assert.strictEqual(s.timers.size, 1);
    setVisible(true);
    assert.strictEqual(s.timers.size, 1, 'a repeated visible event never stacks timers');
  })) p++; else f++;

  if (test('poll: stop clears the timer and the listener, so nothing polls after unmount', () => {
    const { s, deps, setVisible, fire } = fakePoll(true);
    const stop = startGitPoll(deps);
    stop();
    assert.strictEqual(s.timers.size, 0);
    assert.strictEqual(s.listeners.size, 0);
    setVisible(true); fire();
    assert.strictEqual(s.polls, 1);
  })) p++; else f++;

  if (test('fetch options: the six intervals and their segment labels', () => {
    assert.deepStrictEqual(GIT_FETCH_OPTIONS.map(o => o.value), [0, 30, 60, 120, 300, 600]);
    assert.deepStrictEqual(GIT_FETCH_OPTIONS.map(o => o.label), ['Off', '30s', '1m', '2m', '5m', '10m']);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
