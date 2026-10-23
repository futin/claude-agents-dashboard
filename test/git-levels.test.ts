/**
 * `client/src/lib/gitLevels.ts`: the Git view's problems → level rule and the session join that softens uncommitted work under a working agent. Pure, so no
 * React and no DOM.
 */
import assert from 'node:assert';

import type { FetchError, GitBranch, RepoGitStats, Session } from '../shared/types.js';
import {
  GIT_LEVELS, GIT_LEVEL_DOT, GIT_LEVEL_RANK, GIT_LEVEL_STATUS, STALE_BEHIND, STALE_IDLE_MS,
  agentOn, assessGitRepo, gitLevelOf, gitPlural, gitProblems, gitSentence, gitSyncVerbs, isStaleBranch, rankGitRepos,
} from '../client/src/lib/gitLevels.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

const NOW = Date.now();
const DAY = 86_400_000;

/** A clean, level repo on main with an origin: the quiet baseline every case overrides one field of. */
function okRepo(name: string, over: Partial<Ok> = {}): Ok {
  return {
    dirName: name, name, path: `/p/${name}`, state: 'ok', toplevel: `/p/${name}`,
    branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
    trunk: 'main', hasOrigin: true, originUrl: null,
    trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true }, trunkCheckedOutElsewhere: false, currentVsUpstream: null,
    fetchedAtMs: null, lastFetch: null, branches: [], unmergedTotal: 0, mergedCount: 0,
    ...over,
  };
}

function branch(name: string, over: Partial<GitBranch> = {}): GitBranch {
  return { name, ahead: 1, behind: 0, lastCommitMs: NOW, worktreePath: null, ...over };
}

function sess(over: Partial<Session> = {}): Session {
  return {
    id: 's1', project: 'a', projectPath: '/p/a', repo: null, sessionName: null, gitBranch: 'feat', model: 'claude-opus-5', tokens: 0, contextWindow: 200_000,
    contextWindowLabel: '200k', contextPct: 0, status: 'working', surface: 'local', remoteQuestion: false, remotePlan: false, remoteReply: false,
    permissionWait: false, activity: null, lastTimestamp: null, updatedMs: Date.now(), version: null, kaizenLesson: null, tasks: null, taskPlan: null,
    ...over,
  };
}

const fetchErr = (error: FetchError, atMs = NOW) => ({ atMs, error });
const keys = (r: RepoGitStats, ss: Session[] = []) => gitProblems(r, ss, NOW).map(p => p.k);
const only = (r: RepoGitStats, k: string, ss: Session[] = []) => gitProblems(r, ss, NOW).find(p => p.k === k);

export function run(): number {
  let p = 0, f = 0;
  console.log('\ngit levels');

  // ── problems ───────────────────────────────────────────────────────────────
  if (test('problems: clean level repo → [] and level quiet', () => {
    const r = okRepo('a');
    const ps = gitProblems(r, [], NOW);
    assert.deepStrictEqual(ps, []);
    assert.strictEqual(gitLevelOf(r, ps), 'quiet');
  })) p++; else f++;

  if (test('problems: missing → one gone sev 2, level dead; not-git → notgit sev 1; error → error sev 1 "couldn\'t read"', () => {
    const missing: RepoGitStats = { dirName: 'm', name: 'm', path: '/p/m', state: 'missing' };
    const pm = gitProblems(missing, [], NOW);
    assert.deepStrictEqual(pm, [{ sev: 2, k: 'gone', short: 'folder gone', text: 'Folder is gone — /p/m. Unpin it under Projects.' }]);
    assert.strictEqual(gitLevelOf(missing, pm), 'dead');

    const notGit: RepoGitStats = { dirName: 'n', name: 'n', path: '/p/n', state: 'not-git' };
    const pn = gitProblems(notGit, [], NOW);
    assert.deepStrictEqual(pn, [{ sev: 1, k: 'notgit', short: 'not a repository', text: 'Not a git repository.' }]);
    assert.strictEqual(gitLevelOf(notGit, pn), 'dead');

    const err: RepoGitStats = { dirName: 'e', name: 'e', path: '/p/e', state: 'error', message: 'boom' };
    const pe = gitProblems(err, [], NOW);
    assert.deepStrictEqual(pe, [{ sev: 1, k: 'error', short: "couldn't read", text: "Couldn't read: boom" }]);
    assert.strictEqual(gitLevelOf(err, pe), 'dead');
  })) p++; else f++;

  if (test('problems: auth fetch error, fetched 3h ago → fetch sev 3, short "needs auth", text "Fetch needs auth, so the origin numbers are 3h old"', () => {
    const r = okRepo('a', { lastFetch: fetchErr('auth'), fetchedAtMs: Date.now() - 3 * 3_600_000 });
    const pr = only(r, 'fetch');
    assert.deepStrictEqual(pr, { sev: 3, k: 'fetch', short: 'needs auth', text: 'Fetch needs auth, so the origin numbers are 3h old' });
    assert.strictEqual(gitLevelOf(r, gitProblems(r, [], NOW)), 'needs');
  })) p++; else f++;

  if (test('problems: timeout fetch error never fetched → text "Fetch timed out, and origin has never been fetched"', () => {
    const r = okRepo('a', { lastFetch: fetchErr('timeout'), fetchedAtMs: null });
    const pr = only(r, 'fetch');
    assert.strictEqual(pr?.short, 'fetch timed out');
    assert.strictEqual(pr?.text, 'Fetch timed out, and origin has never been fetched');
  })) p++; else f++;

  if (test('problems: lock fetch error → no fetch problem', () => {
    assert.deepStrictEqual(keys(okRepo('a', { lastFetch: fetchErr('lock') })), []);
  })) p++; else f++;

  if (test('problems: 3 uncommitted on feat, no session → dirty sev 3, text "3 uncommitted changes on feat", level needs', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, uncommitted: 3 });
    const ps = gitProblems(r, [], NOW);
    assert.deepStrictEqual(ps, [{ sev: 3, k: 'dirty', short: '3 uncommitted', text: '3 uncommitted changes on feat' }]);
    assert.strictEqual(gitLevelOf(r, ps), 'needs');
  })) p++; else f++;

  if (test('problems: 1 uncommitted → "1 uncommitted change on feat"; detached → "on the detached HEAD"', () => {
    assert.strictEqual(only(okRepo('a', { branch: 'feat', uncommitted: 1 }), 'dirty')?.text, '1 uncommitted change on feat');
    assert.strictEqual(only(okRepo('a', { branch: null, detachedSha: 'abc1234', uncommitted: 2 }), 'dirty')?.text, '2 uncommitted changes on the detached HEAD');
  })) p++; else f++;

  if (test('problems: 3 uncommitted under a working session on feat → dirty sev 1 calm, level quiet', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, uncommitted: 3 });
    const ps = gitProblems(r, [sess()], NOW);
    assert.deepStrictEqual(ps, [{ sev: 1, k: 'dirty', calm: true, short: '3 uncommitted', text: '3 uncommitted changes, and an agent is working on this branch' }]);
    assert.strictEqual(gitLevelOf(r, ps), 'quiet');
  })) p++; else f++;

  if (test('problems: question, idle and incomplete sessions leave dirty at sev 3', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, uncommitted: 3 });
    for (const status of ['question', 'idle', 'incomplete'] as const) {
      const d = only(r, 'dirty', [sess({ status })]);
      assert.strictEqual(d?.sev, 3, status);
      assert.strictEqual(d?.calm, undefined, status);
    }
  })) p++; else f++;

  if (test('problems: working session on another branch → dirty sev 3', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, uncommitted: 3 });
    assert.strictEqual(only(r, 'dirty', [sess({ gitBranch: 'other' })])?.sev, 3);
  })) p++; else f++;

  if (test('problems: upstream origin/feat 2 behind 1 ahead → pull sev 3 "2 to pull" then push sev 2 "1 unpushed"', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, currentVsUpstream: { upstream: 'origin/feat', counts: { ahead: 1, behind: 2 } } });
    const ps = gitProblems(r, [], NOW);
    assert.deepStrictEqual(ps, [
      { sev: 3, k: 'pull', short: '2 to pull', text: 'feat is 2 behind origin/feat' },
      { sev: 2, k: 'push', short: '1 unpushed', text: '1 commit on feat not pushed yet' },
    ]);
  })) p++; else f++;

  if (test('problems: upstream origin/feat gone → upstream sev 1 "origin/feat gone"', () => {
    const r = okRepo('a', { branch: 'feat', onTrunk: false, currentVsUpstream: { upstream: 'origin/feat', counts: null } });
    assert.deepStrictEqual(gitProblems(r, [], NOW), [{ sev: 1, k: 'upstream', short: 'origin/feat gone', text: 'origin/feat is gone, so feat tracks nothing' }]);
  })) p++; else f++;

  if (test('problems: upstream origin/main (trunk) 3 behind → no pull or push', () => {
    const r = okRepo('a', { currentVsUpstream: { upstream: 'origin/main', counts: { ahead: 0, behind: 3 } } });
    assert.deepStrictEqual(keys(r), []);
  })) p++; else f++;

  if (test('problems: trunk 0 ahead 3 behind → trunk sev 2 "main 3 behind", text "Local main 3 behind origin", level look', () => {
    const r = okRepo('a', { trunkVsOrigin: { ahead: 0, behind: 3 } });
    const ps = gitProblems(r, [], NOW);
    assert.deepStrictEqual(ps, [{ sev: 2, k: 'trunk', short: 'main 3 behind', text: 'Local main 3 behind origin' }]);
    assert.strictEqual(gitLevelOf(r, ps), 'look');
  })) p++; else f++;

  if (test('problems: trunk 1 ahead 0 behind → "main 1 ahead"; 1 ahead 2 behind → "main 1 ahead, 2 behind"', () => {
    assert.strictEqual(only(okRepo('a', { trunkVsOrigin: { ahead: 1, behind: 0 } }), 'trunk')?.short, 'main 1 ahead');
    assert.strictEqual(only(okRepo('a', { trunkVsOrigin: { ahead: 1, behind: 2 } }), 'trunk')?.short, 'main 1 ahead, 2 behind');
  })) p++; else f++;

  if (test('problems: no origin → remote sev 1, level quiet', () => {
    const r = okRepo('a', { hasOrigin: false, trunkVsOrigin: null, trunkRefs: { local: true, origin: false } });
    const ps = gitProblems(r, [], NOW);
    assert.deepStrictEqual(ps, [{ sev: 1, k: 'remote', short: 'no remote', text: 'No remote, so nothing here is backed up' }]);
    assert.strictEqual(gitLevelOf(r, ps), 'quiet');
  })) p++; else f++;

  if (test('problems: detached at abc1234 → detached sev 1 "detached at abc1234"', () => {
    const r = okRepo('a', { branch: null, detachedSha: 'abc1234', onTrunk: false });
    assert.deepStrictEqual(gitProblems(r, [], NOW), [{ sev: 1, k: 'detached', short: 'detached at abc1234', text: 'HEAD detached at abc1234' }]);
  })) p++; else f++;

  if (test('problems: branches behind 20 / idle 7 days / behind 19 and 6 days → stale counts 2, short "2 stale branches"', () => {
    const r = okRepo('a', {
      branches: [branch('b1', { behind: 20 }), branch('b2', { lastCommitMs: NOW - 7 * DAY }), branch('b3', { behind: 19, lastCommitMs: NOW - 6 * DAY })],
    });
    assert.deepStrictEqual(gitProblems(r, [], NOW), [
      { sev: 1, k: 'stale', short: '2 stale branches', text: '2 stale branches (≥ 20 behind or idle a week)' },
    ]);
  })) p++; else f++;

  if (test('problems: sorted by sev descending, ties in build order', () => {
    const r = okRepo('a', {
      lastFetch: fetchErr('offline'), branch: 'feat', onTrunk: false,
      currentVsUpstream: { upstream: 'origin/feat', counts: { ahead: 1, behind: 0 } },
      trunkVsOrigin: { ahead: 0, behind: 2 },
    });
    assert.deepStrictEqual(keys(r), ['fetch', 'push', 'trunk']);
  })) p++; else f++;

  // ── stale branch ───────────────────────────────────────────────────────────
  if (test('isStaleBranch: behind 20 → true; 19 → false; behind null and 7 days old → true; 7 days minus 1ms → false', () => {
    assert.strictEqual(STALE_BEHIND, 20);
    assert.strictEqual(STALE_IDLE_MS, 604_800_000);
    assert.strictEqual(isStaleBranch(branch('b', { behind: 20 }), NOW), true);
    assert.strictEqual(isStaleBranch(branch('b', { behind: 19 }), NOW), false);
    assert.strictEqual(isStaleBranch(branch('b', { behind: null, lastCommitMs: NOW - 7 * DAY }), NOW), true);
    assert.strictEqual(isStaleBranch(branch('b', { behind: null, lastCommitMs: NOW - 7 * DAY + 1 }), NOW), false);
  })) p++; else f++;

  // ── session join ───────────────────────────────────────────────────────────
  if (test('agentOn: projectPath equals toplevel → match; under toplevel → match', () => {
    const r = okRepo('a');
    assert.strictEqual(agentOn(r, 'feat', [sess({ projectPath: '/p/a' })])?.sessionId, 's1');
    assert.strictEqual(agentOn(r, 'feat', [sess({ projectPath: '/p/a/packages/x' })])?.sessionId, 's1');
  })) p++; else f++;

  if (test('agentOn: a sibling "/p/ab" of toplevel "/p/a" → no match', () => {
    assert.strictEqual(agentOn(okRepo('a'), 'feat', [sess({ projectPath: '/p/ab' })]), null);
  })) p++; else f++;

  if (test('agentOn: matches repo.path when it differs from toplevel', () => {
    const r = okRepo('a', { toplevel: '/wt/a', path: '/p/a/sub' });
    assert.notStrictEqual(agentOn(r, 'feat', [sess({ projectPath: '/p/a/sub/deep' })]), null);
  })) p++; else f++;

  if (test('agentOn: projectPath equals the branch\'s worktreePath → match', () => {
    const r = okRepo('a', { branches: [branch('feat', { worktreePath: '/wt/feat' })] });
    assert.notStrictEqual(agentOn(r, 'feat', [sess({ projectPath: '/wt/feat' })]), null);
    assert.notStrictEqual(agentOn(r, 'feat', [sess({ projectPath: '/wt/feat/src' })]), null);
    // another branch's worktree does not count for this one
    assert.strictEqual(agentOn(okRepo('a', { branches: [branch('other', { worktreePath: '/wt/feat' })] }), 'feat', [sess({ projectPath: '/wt/feat' })]), null);
  })) p++; else f++;

  if (test('agentOn: projectPath null → none; branch null → none; missing repo → none; branch mismatch → none; incomplete → none', () => {
    const r = okRepo('a');
    assert.strictEqual(agentOn(r, 'feat', [sess({ projectPath: null })]), null);
    assert.strictEqual(agentOn(r, null, [sess()]), null);
    assert.strictEqual(agentOn({ dirName: 'a', name: 'a', path: '/p/a', state: 'missing' }, 'feat', [sess()]), null);
    assert.strictEqual(agentOn(r, 'feat', [sess({ gitBranch: 'other' })]), null);
    assert.strictEqual(agentOn(r, 'feat', [sess({ status: 'incomplete' })]), null);
  })) p++; else f++;

  if (test('agentOn: working beats a newer idle; of two idle the newer wins; labels "working", "needs answer", "idle 40m"', () => {
    const r = okRepo('a');
    const w = sess({ id: 'w', status: 'working', updatedMs: NOW - 5 * 60_000 });
    const i = sess({ id: 'i', status: 'idle', updatedMs: NOW });
    assert.strictEqual(agentOn(r, 'feat', [i, w])?.sessionId, 'w');
    const old = sess({ id: 'old', status: 'idle', updatedMs: NOW - 90 * 60_000 });
    assert.strictEqual(agentOn(r, 'feat', [old, i])?.sessionId, 'i');
    assert.strictEqual(agentOn(r, 'feat', [sess({ id: 'q', status: 'question' }), i])?.sessionId, 'q');

    assert.deepStrictEqual(agentOn(r, 'feat', [w]), { kind: 'working', label: 'working', sessionId: 'w' });
    assert.deepStrictEqual(agentOn(r, 'feat', [sess({ id: 'q', status: 'question' })]), { kind: 'waiting', label: 'needs answer', sessionId: 'q' });
    assert.deepStrictEqual(agentOn(r, 'feat', [sess({ id: 'i', status: 'idle', updatedMs: Date.now() - 40 * 60_000 })]), { kind: 'idle', label: 'idle 40m', sessionId: 'i' });
  })) p++; else f++;

  // ── ranking ────────────────────────────────────────────────────────────────
  const needsRepo = (name: string, uncommitted = 3) => okRepo(name, { branch: 'feat', onTrunk: false, uncommitted });
  const lookRepo = (name: string) => okRepo(name, { trunkVsOrigin: { ahead: 0, behind: 1 } });
  const deadRepo = (name: string): RepoGitStats => ({ dirName: name, name, path: `/p/${name}`, state: 'not-git' });
  const order = (rs: RepoGitStats[]) => rankGitRepos(rs, [], NOW).map(a => a.repo.name);

  if (test('rank: [quiet q, needs n, look l, dead d] → [n, l, q, d]', () => {
    assert.deepStrictEqual(order([okRepo('q'), needsRepo('n'), lookRepo('l'), deadRepo('d')]), ['n', 'l', 'q', 'd']);
  })) p++; else f++;

  if (test('rank: two needs repos, weights 6 and 3 → heavier first; equal weights keep pin order', () => {
    const heavy = okRepo('heavy', { branch: 'feat', uncommitted: 2, lastFetch: fetchErr('offline') });
    const light = needsRepo('light');
    const ranked = rankGitRepos([light, heavy], [], NOW);
    assert.deepStrictEqual(ranked.map(a => [a.repo.name, a.weight]), [['heavy', 6], ['light', 3]]);
    assert.deepStrictEqual(order([needsRepo('x'), needsRepo('y'), needsRepo('z')]), ['x', 'y', 'z']);
  })) p++; else f++;

  if (test('rank: dead missing (sev 2) before dead not-git (sev 1)', () => {
    const missing: RepoGitStats = { dirName: 'gone', name: 'gone', path: '/p/gone', state: 'missing' };
    assert.deepStrictEqual(order([deadRepo('notgit'), missing]), ['gone', 'notgit']);
  })) p++; else f++;

  if (test('assessGitRepo: carries repo, problems, level, summed weight and verbs', () => {
    const r = needsRepo('a');
    const a = assessGitRepo(r, [], NOW);
    assert.strictEqual(a.repo, r);
    assert.strictEqual(a.level, 'needs');
    assert.strictEqual(a.weight, 3);
    assert.deepStrictEqual(a.verbs, ['commit']);
    assert.strictEqual(a.problems.length, 1);
  })) p++; else f++;

  // ── sync verbs ─────────────────────────────────────────────────────────────
  if (test('syncVerbs: dirty + pull + push + trunk → ["commit","pull","push","update main"]; calm dirty only → []; missing → []', () => {
    const r = okRepo('a', {
      branch: 'feat', onTrunk: false, uncommitted: 2, trunkVsOrigin: { ahead: 0, behind: 4 },
      currentVsUpstream: { upstream: 'origin/feat', counts: { ahead: 1, behind: 1 } },
    });
    assert.deepStrictEqual(gitSyncVerbs(r, gitProblems(r, [], NOW)), ['commit', 'pull', 'push', 'update main']);

    const calm = okRepo('a', { branch: 'feat', onTrunk: false, uncommitted: 2 });
    assert.deepStrictEqual(gitSyncVerbs(calm, gitProblems(calm, [sess()], NOW)), []);

    const missing: RepoGitStats = { dirName: 'm', name: 'm', path: '/p/m', state: 'missing' };
    assert.deepStrictEqual(gitSyncVerbs(missing, gitProblems(missing, [], NOW)), []);
  })) p++; else f++;

  // ── text helpers + tables ──────────────────────────────────────────────────
  if (test('gitPlural: ("stale branch", 2) → "2 stale branches"; ("commit", 1) → "1 commit"; ("fix", 2) → "2 fixes"', () => {
    assert.strictEqual(gitPlural(2, 'stale branch'), '2 stale branches');
    assert.strictEqual(gitPlural(1, 'commit'), '1 commit');
    assert.strictEqual(gitPlural(2, 'fix'), '2 fixes');
    assert.strictEqual(gitPlural(0, 'commit'), '0 commits');
  })) p++; else f++;

  if (test('gitSentence: "a" → "a."; "a." → "a."', () => {
    assert.strictEqual(gitSentence('a'), 'a.');
    assert.strictEqual(gitSentence('a.'), 'a.');
  })) p++; else f++;

  if (test('GIT_LEVELS / GIT_LEVEL_STATUS / GIT_LEVEL_DOT / GIT_LEVEL_RANK hold the binding values', () => {
    assert.deepStrictEqual(GIT_LEVELS, [
      { key: 'needs', label: 'Needs you' }, { key: 'look', label: 'Worth a look' }, { key: 'quiet', label: 'All good' }, { key: 'dead', label: "Can't read" },
    ]);
    assert.deepStrictEqual(GIT_LEVEL_STATUS, { needs: 'needs you', look: 'worth a look', quiet: 'all good', dead: "can't read" });
    assert.deepStrictEqual(GIT_LEVEL_DOT, { needs: 'needs', look: 'flight', quiet: 'quiet', dead: 'dead' });
    assert.deepStrictEqual(GIT_LEVEL_RANK, { needs: 0, look: 1, quiet: 2, dead: 3 });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
