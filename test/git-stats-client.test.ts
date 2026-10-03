/**
 * Client domain logic of the Git sub-view (`client/src/lib/gitLayouts.ts`, `gitTriage.ts`, `gitStatsText.ts`, `gitBar.ts`, `gitPoll.ts`, `gitClock.ts`): the layout switcher's
 * rules, the Triage grouping precedence, every string of spec §6's copy table, the divergence bar's scale and the poll schedule. All pure, so no React and no
 * DOM.
 */
import assert from 'node:assert';

import type { FetchClock, GitBranch, RepoGitStats } from '../shared/types.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';
import { DEFAULT_GIT_LAYOUT, GIT_LAYOUTS, WIDE_ONLY_GIT_LAYOUTS, drawableGitLayout, gitLayoutsFor, isGitLayout } from '../client/src/lib/gitLayouts.js';
import { triageGitRepos } from '../client/src/lib/gitTriage.js';
import {
  FETCH_NEEDS_TOKEN, GIT_BAND_SUB, GIT_CLOCK_NAME, GIT_LOAD_FAILED, GIT_LOADING, GIT_NO_OPEN_BRANCHES, GIT_NO_PINS, GIT_POP_LABEL, GIT_UPDATE_FAILED,
  KEY_NOW, METER_FETCH, METER_NEXT, METER_SYNC, READ_FAILED, READ_FETCHING, READ_OFF, READ_OVERDUE, READ_PENDING, READ_SYNCING, ROW_FETCH_ALL, ROW_LOCAL_SYNC,
  SYNC_ROW_FAILED_SUB, SYNC_ROW_SUB,
  fetchPeriodText, fetchRowSub, fetchTroubleWord,
  gitBranchChipText, gitFirstLoadText, gitBranchCounts, gitFetchedAgeText, gitFetchedText, gitMergedText, gitMoreText, gitNotShownText, gitStateSentence,
  gitTroubleLines, gitTrunkVsOriginText, gitUncommittedText, gitUpstreamText, gitVisibleBranches,
} from '../client/src/lib/gitStatsText.js';
import { GIT_BAR_HALF_PX, GIT_BAR_MIN_PX, gitBarMax, gitBarWidth } from '../client/src/lib/gitBar.js';
import { GIT_POLL_MS, startGitPoll } from '../client/src/lib/gitPoll.js';
import {
  FETCH_FOLLOW_MS, GIT_FETCH_OPTIONS, countdownText, createFollowTracker, createPollGate, fetchFailureOf, fetchKeyState, fetchReading, followUp, skewOf,
  syncReading,
} from '../client/src/lib/gitClock.js';
import { SYNC_NEEDS_TOKEN } from '../client/src/lib/gitSync.js';

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
    trunk: 'main', hasOrigin: true, trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true }, currentVsUpstream: null,
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
    assert.strictEqual(gitFetchedAgeText(null), 'never fetched');
    assert.strictEqual(gitFetchedAgeText(Date.now() - 2 * 3_600_000), 'fetched 2h ago');
    assert.strictEqual(gitFetchedAgeText(Date.now() + 5 * 60_000), 'fetched 0s ago');
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

  // ── fetch clock: readings, follow-ups, key state, copy ─────────────────────
  const NOW = 1_000_000;
  const clockOf = (over: Partial<FetchClock> = {}): FetchClock => ({ intervalSecs: 300, nextAtMs: null, runningSinceMs: null, lastEndedMs: null, ...over });
  const fread = (over: Partial<FetchClock>, extra: { ownPost?: boolean; skewMs?: number; now?: number } = {}) =>
    fetchReading({ clock: clockOf(over), ownPost: extra.ownPost ?? false, skewMs: extra.skewMs ?? 0, now: extra.now ?? NOW });

  if (test('fetchReading: countdown, fraction and tone off the next-fetch time', () => {
    const a = fread({ intervalSecs: 300, nextAtMs: NOW + 192_000 });
    assert.strictEqual(a.value, '3:12'); assert.ok(Math.abs(a.fraction - 0.36) < 0.01); assert.strictEqual(a.tone, 'green');
    assert.deepStrictEqual(fread({ intervalSecs: 30, nextAtMs: NOW + 12_000 }), { value: '12s', fraction: 0.6, tone: 'green' });
    assert.deepStrictEqual(fread({ intervalSecs: 300, nextAtMs: NOW }), { value: '0s', fraction: 1, tone: 'green' });
  })) p++; else f++;

  if (test('fetchReading: overdue only past one whole interval; a hair inside it still reads 0s', () => {
    assert.deepStrictEqual(fread({ intervalSecs: 300, nextAtMs: NOW - 300_001 }), { value: 'overdue', fraction: 1, tone: 'amber' });
    assert.strictEqual(fread({ intervalSecs: 300, nextAtMs: NOW - 299_999 }).value, '0s');
  })) p++; else f++;

  if (test('fetchReading: off, running, own POST (beats off), pending, undefined clock — and never "overdue" off a null next time', () => {
    assert.deepStrictEqual(fread({ intervalSecs: 0 }), { value: 'off', fraction: 0, tone: 'amber' });
    assert.deepStrictEqual(fread({ intervalSecs: 300, runningSinceMs: NOW - 500 }), { value: 'fetching…', fraction: 1, tone: 'live' });
    assert.strictEqual(fread({ intervalSecs: 0 }, { ownPost: true }).value, 'fetching…');
    assert.deepStrictEqual(fread({ intervalSecs: 60, nextAtMs: null }), { value: '…', fraction: 0, tone: 'green' });
    assert.strictEqual(fread({ intervalSecs: 60, nextAtMs: null }, { now: 9_000_000_000_000 }).value, '…');
    assert.deepStrictEqual(fetchReading({ clock: undefined, ownPost: false, skewMs: 0, now: NOW }), { value: '…', fraction: 0, tone: 'green' });
    assert.strictEqual(fetchReading({ clock: undefined, ownPost: true, skewMs: 0, now: NOW }).value, 'fetching…');
  })) p++; else f++;

  if (test('skew: a client clock behind the server reads the same countdown once corrected', () => {
    const S = 5_000_000;
    const skew = skewOf(S, S - 5_000);
    assert.strictEqual(skew, -5_000);
    assert.strictEqual(fetchReading({ clock: clockOf({ intervalSecs: 60, nextAtMs: S + 10_000 }), ownPost: false, skewMs: skew, now: S - 5_000 }).value, '10s');
    assert.strictEqual(fetchReading({ clock: clockOf({ intervalSecs: 60, nextAtMs: S + 10_000 }), ownPost: false, skewMs: 0, now: S - 5_000 }).value, '15s');
  })) p++; else f++;

  if (test('countdownText: ceils to whole seconds, m:ss from a minute up, floors at 0s', () => {
    const c = countdownText;
    assert.deepStrictEqual([c(60_000), c(59_400), c(58_900), c(600_000), c(0), c(-5), c(3_599_000)], ['1:00', '1:00', '59s', '10:00', '0s', '0s', '59:59']);
  })) p++; else f++;

  if (test('syncReading: syncing beats failed beats pending; a countdown fills with elapsed time', () => {
    const s = (over: Partial<Parameters<typeof syncReading>[0]>) => syncReading({ polling: false, error: false, nextPollAtMs: null, now: NOW, ...over });
    assert.deepStrictEqual(s({ polling: true, error: true }), { value: 'syncing…', fraction: 1, tone: 'live' });
    assert.deepStrictEqual(s({ error: true }), { value: 'failed', fraction: 1, tone: 'amber' });
    assert.deepStrictEqual(s({ nextPollAtMs: NOW + 12_000 }), { value: '12s', fraction: 0.6, tone: 'green' });
    assert.deepStrictEqual(s({}), { value: '…', fraction: 0, tone: 'green' });
    assert.strictEqual(s({ nextPollAtMs: NOW - 2_000 }).fraction, 1, 'a late timer clamps to full');
  })) p++; else f++;

  if (test('followUp: hidden is always null; running re-keys on each payload; due keys on the next time; the rest is null', () => {
    const fu = (over: Partial<FetchClock> | undefined, extra: { generatedAt?: number; skewMs?: number; visible?: boolean } = {}) =>
      followUp({ clock: over === undefined ? undefined : clockOf(over), generatedAt: extra.generatedAt ?? 7, skewMs: extra.skewMs ?? 0, now: NOW, visible: extra.visible ?? true });
    for (const over of [{ runningSinceMs: NOW - 1 }, { nextAtMs: NOW - 1 }, { intervalSecs: 0 }, undefined]) assert.strictEqual(fu(over, { visible: false }), null);
    assert.deepStrictEqual(fu({ runningSinceMs: 42 }, { generatedAt: 9 }), { key: 'run:42:9', delayMs: 3_000 });
    assert.notStrictEqual(fu({ runningSinceMs: 42 }, { generatedAt: 9 })!.key, fu({ runningSinceMs: 42 }, { generatedAt: 10 })!.key);
    assert.deepStrictEqual(fu({ nextAtMs: NOW - 10 }), { key: `due:${NOW - 10}`, delayMs: 3_000 });
    assert.deepStrictEqual(fu({ nextAtMs: NOW - 10 }, { generatedAt: 1 }), fu({ nextAtMs: NOW - 10 }, { generatedAt: 2 }));
    assert.strictEqual(fu({ nextAtMs: NOW + 1 }), null);
    assert.strictEqual(fu({ intervalSecs: 0, nextAtMs: NOW - 10 }), null);
    assert.strictEqual(fu({ nextAtMs: null }), null);
    assert.strictEqual(fu(undefined), null);
    assert.notStrictEqual(fu({ nextAtMs: NOW + 1_000 }, { skewMs: -2_000 }), null, 'the skew moves a time that looks future into the past');
    assert.strictEqual(FETCH_FOLLOW_MS, 3_000);
  })) p++; else f++;

  if (test('createFollowTracker: a key fires once per prefix until a different one arrives; prefixes are independent', () => {
    const t = createFollowTracker();
    assert.deepStrictEqual([t.arm('due:1'), t.arm('due:1'), t.arm('due:2'), t.arm('due:1')], [true, false, true, true]);
    assert.strictEqual(t.arm('run:1:9'), true, 'independent of the due: state');
    assert.strictEqual(t.arm('due:1'), false);
    assert.strictEqual(t.arm('run:1:9'), false);
  })) p++; else f++;

  if (test('createPollGate: one in flight, one queued, the rest dropped; end() says whether to start the queued one', () => {
    const g = createPollGate();
    assert.deepStrictEqual([g.request(), g.request(), g.request()], ['run', 'queued', 'dropped']);
    assert.strictEqual(g.end(), true);
    assert.strictEqual(g.request(), 'run');
    assert.strictEqual(g.end(), false);
  })) p++; else f++;

  if (test('fetchKeyState: the five states, against the literal copy', () => {
    const k = (over: Partial<Parameters<typeof fetchKeyState>[0]>) =>
      fetchKeyState({ tokenRequired: false, tokenStored: false, failure: null, pending: false, running: false, intervalSecs: 300, ...over });
    assert.deepStrictEqual(k({ tokenRequired: true }), { disabled: true, label: 'now', sub: 'Fetch all needs the Answer token — set it under Settings › Local › Connection.', subTone: 'amber' });
    assert.deepStrictEqual(k({ tokenRequired: true, tokenStored: true }), { disabled: false, label: 'now', sub: 'git fetch origin · every 5 min', subTone: null });
    assert.deepStrictEqual(k({ failure: 'refused' }), { disabled: true, label: 'now', sub: 'fetch refused: bad token — check it under Settings › Local › Connection.', subTone: 'amber' });
    assert.deepStrictEqual(k({ running: true }), { disabled: true, label: 'fetching…', sub: 'git fetch origin · every 5 min', subTone: null });
    assert.deepStrictEqual(k({ pending: true, intervalSecs: 0 }), { disabled: true, label: 'fetching…', sub: 'auto-fetch off · Settings › Shared', subTone: 'amber' });
    assert.deepStrictEqual(k({ failure: 'failed' }), { disabled: false, label: 'now', sub: "couldn't start the fetch", subTone: 'amber' });
    assert.deepStrictEqual(k({}), { disabled: false, label: 'now', sub: 'git fetch origin · every 5 min', subTone: null });
    assert.deepStrictEqual(k({ intervalSecs: 0 }), { disabled: false, label: 'now', sub: 'auto-fetch off · Settings › Shared', subTone: 'amber' });
    assert.deepStrictEqual(k({ intervalSecs: undefined }), { disabled: false, label: 'now', sub: 'git fetch origin', subTone: null });
    assert.deepStrictEqual(k({ tokenRequired: undefined, tokenStored: false }), { disabled: false, label: 'now', sub: 'git fetch origin · every 5 min', subTone: null });
    assert.strictEqual(k({ tokenRequired: true, failure: 'refused' }).sub, 'Fetch all needs the Answer token — set it under Settings › Local › Connection.', 'no token outranks a refusal');
    assert.deepStrictEqual([fetchFailureOf(403), fetchFailureOf(500), fetchFailureOf('network')], ['refused', 'failed', 'failed']);
  })) p++; else f++;

  if (test('gitFetchedText: trouble word with the age, lock and old payloads read plain, running + origin reads fetching…', () => {
    const clock = clockOf();
    const day2 = Date.now() - 2 * 86_400_000;
    const err = (error: 'auth' | 'offline' | 'timeout' | 'other' | 'lock', fetchedAtMs: number | null = day2) => okRepo('a', { fetchedAtMs, lastFetch: { atMs: 1, error } });
    assert.deepStrictEqual(gitFetchedText(err('auth'), clock), { text: 'needs auth · fetched 2d ago', tone: 'warn' });
    assert.deepStrictEqual(gitFetchedText(err('auth', null), clock), { text: 'needs auth · never fetched', tone: 'warn' });
    assert.strictEqual(gitFetchedText(err('offline'), clock).text, 'offline · fetched 2d ago');
    assert.strictEqual(gitFetchedText(err('timeout'), clock).text, 'fetch timed out · fetched 2d ago');
    assert.strictEqual(gitFetchedText(err('other'), clock).text, 'fetch failed · fetched 2d ago');
    assert.deepStrictEqual(gitFetchedText(err('lock'), clock), { text: 'fetched 2d ago', tone: null });
    const running = clockOf({ runningSinceMs: NOW });
    assert.deepStrictEqual(gitFetchedText(err('auth'), running), { text: 'fetching…', tone: 'live' }, 'running outranks trouble');
    assert.deepStrictEqual(gitFetchedText(okRepo('a', { fetchedAtMs: day2 }), running), { text: 'fetching…', tone: 'live' });
    assert.deepStrictEqual(gitFetchedText(okRepo('a', { fetchedAtMs: day2, hasOrigin: false }), running), { text: 'fetched 2d ago', tone: null });
    assert.deepStrictEqual(gitFetchedText(okRepo('a', { fetchedAtMs: day2, lastFetch: { atMs: 1, error: null } }), clock), { text: 'fetched 2d ago', tone: null });
    // Review Focus 5: an older server's payload has neither `lastFetch` nor a clock.
    const old = okRepo('a', { fetchedAtMs: day2 }) as Partial<Ok>; delete old.lastFetch;
    assert.deepStrictEqual(gitFetchedText(old as Ok, undefined), { text: 'fetched 2d ago', tone: null });
    assert.deepStrictEqual(gitTroubleLines([old as Ok], undefined), []);
  })) p++; else f++;

  if (test('fetchTroubleWord and gitTroubleLines: skips lock and non-ok repos, keeps pin order', () => {
    assert.deepStrictEqual((['auth', 'offline', 'timeout', 'other', 'lock'] as const).map(fetchTroubleWord), ['needs auth', 'offline', 'fetch timed out', 'fetch failed', '']);
    const gone: RepoGitStats = { dirName: 'g', name: 'g', path: null, state: 'missing' };
    const lines = gitTroubleLines([
      okRepo('z', { lastFetch: { atMs: 1, error: 'offline' }, fetchedAtMs: null }), gone, okRepo('lk', { lastFetch: { atMs: 1, error: 'lock' } }),
      okRepo('fine', { lastFetch: { atMs: 1, error: null } }), okRepo('a', { lastFetch: { atMs: 1, error: 'auth' }, fetchedAtMs: Date.now() - 3_600_000 }),
    ], clockOf());
    assert.deepStrictEqual(lines, [
      { dirName: 'z', name: 'z', word: 'offline', age: 'never fetched' },
      { dirName: 'a', name: 'a', word: 'needs auth', age: 'fetched 1h ago' },
    ]);
  })) p++; else f++;

  if (test('fetchRowSub and fetchPeriodText: exact strings; the two token sentences share their tail', () => {
    assert.deepStrictEqual([30, 60, 120, 300, 600].map(fetchPeriodText), ['every 30s', 'every 1 min', 'every 2 min', 'every 5 min', 'every 10 min']);
    assert.deepStrictEqual([undefined, 0, 30, 60, 600].map(fetchRowSub),
      ['git fetch origin', 'auto-fetch off · Settings › Shared', 'git fetch origin · every 30s', 'git fetch origin · every 1 min', 'git fetch origin · every 10 min']);
    assert.ok(FETCH_NEEDS_TOKEN.endsWith('Settings › Local › Connection.') && SYNC_NEEDS_TOKEN.endsWith('Settings › Local › Connection.'));
  })) p++; else f++;

  if (test('chip copy table: meter words, labels, row names, band sub', () => {
    assert.deepStrictEqual([READ_SYNCING, READ_FETCHING, READ_FAILED, READ_OFF, READ_OVERDUE, READ_PENDING], ['syncing…', 'fetching…', 'failed', 'off', 'overdue', '…']);
    assert.deepStrictEqual([METER_SYNC, METER_FETCH, METER_NEXT, ROW_LOCAL_SYNC, ROW_FETCH_ALL, KEY_NOW], ['SYNC', 'FETCH', 'next', 'Local sync', 'Fetch all', 'now']);
    assert.deepStrictEqual([GIT_CLOCK_NAME, GIT_POP_LABEL], ['Sync and fetch clocks', 'Sync and fetch']);
    assert.deepStrictEqual([SYNC_ROW_SUB, SYNC_ROW_FAILED_SUB], ['re-reads the repos on disk · every 30s', "couldn't update · retrying every 30s"]);
    assert.strictEqual(GIT_BAND_SUB, 'Local state of your pinned repos. Fetches from origin on the timer set in Settings; nothing here pulls or pushes.');
  })) p++; else f++;

  if (test('poll schedule report: arm, every fire, hide, show and stop say when the next poll is — and null only when a timer was cleared', () => {
    const { s, deps, setVisible, fire } = fakePoll(true);
    let t = 500;
    const seen: (number | null)[] = [];
    const stop = startGitPoll({ ...deps, now: () => t, onSchedule: n => { seen.push(n); } });
    assert.deepStrictEqual(seen, [30_500]);
    t = 30_500; fire();
    assert.deepStrictEqual(seen, [30_500, 60_500], 'a repeating timer reports again on each fire');
    assert.strictEqual(s.polls, 2);
    setVisible(false);
    assert.deepStrictEqual(seen, [30_500, 60_500, null]);
    t = 40_000; setVisible(true);
    assert.deepStrictEqual(seen, [30_500, 60_500, null, 70_000], 'the show-side disarm found no timer, so no second null');
    stop();
    assert.deepStrictEqual(seen, [30_500, 60_500, null, 70_000, null]);
    stop();
    assert.strictEqual(seen.length, 5, 'a second stop clears nothing, so says nothing');
  })) p++; else f++;

  if (test('poll schedule report: both hooks are optional, and started hidden reports nothing', () => {
    const { deps } = fakePoll(true);
    startGitPoll(deps);
    const seen: (number | null)[] = [];
    startGitPoll({ ...fakePoll(false).deps, onSchedule: n => { seen.push(n); } });
    assert.deepStrictEqual(seen, []);
  })) p++; else f++;

  // ── current branch vs its upstream ─────────────────────────────────────────
  const onFeat = (up: Ok['currentVsUpstream'], over: Partial<Ok> = {}) =>
    okRepo('a', { branch: 'feat', onTrunk: false, currentVsUpstream: up, ...over });
  const featUp = (ahead: number, behind: number): Ok['currentVsUpstream'] => ({ upstream: 'origin/feat', counts: { ahead, behind } });

  if (test('gitUpstreamText: behind, ahead, both, gone; level, absent and origin/<trunk> hide; origin/main shown when there is no trunk', () => {
    assert.strictEqual(gitUpstreamText(onFeat(featUp(0, 2))), '2 behind origin/feat');
    assert.strictEqual(gitUpstreamText(onFeat(featUp(1, 0))), '1 ahead of origin/feat');
    assert.strictEqual(gitUpstreamText(onFeat(featUp(1, 2))), '1 ahead, 2 behind origin/feat');
    assert.strictEqual(gitUpstreamText(onFeat({ upstream: 'origin/feat', counts: null })), 'origin/feat gone');
    assert.strictEqual(gitUpstreamText(onFeat(featUp(0, 0))), null);
    assert.strictEqual(gitUpstreamText(onFeat(null)), null);
    const older = onFeat(null) as Partial<Ok>;
    delete older.currentVsUpstream; // a payload from a server that predates the field
    assert.strictEqual(gitUpstreamText(older as Ok), null);
    const onMain = { upstream: 'origin/main', counts: { ahead: 0, behind: 3 } };
    assert.strictEqual(gitUpstreamText(onFeat(onMain, { trunk: 'main' })), null);
    assert.strictEqual(gitUpstreamText(onFeat(onMain, { trunk: null, trunkVsOrigin: null, trunkRefs: null })), '3 behind origin/main');
  })) p++; else f++;

  if (test('triage: behind its upstream → needs; ahead-only, gone and origin/<trunk> → flight', () => {
    const one = [branch('feat')];
    assert.deepStrictEqual(names(triageGitRepos([onFeat(featUp(0, 1))]).needs), ['a']);
    assert.deepStrictEqual(names(triageGitRepos([onFeat(featUp(2, 0), { branches: one, unmergedTotal: 1 })]).flight), ['a']);
    assert.deepStrictEqual(names(triageGitRepos([onFeat({ upstream: 'origin/feat', counts: null }, { branches: one, unmergedTotal: 1 })]).flight), ['a']);
    const onMain = { upstream: 'origin/main', counts: { ahead: 0, behind: 3 } };
    assert.deepStrictEqual(names(triageGitRepos([onFeat(onMain, { branches: one, unmergedTotal: 1 })]).flight), ['a']);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
