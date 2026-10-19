/**
 * Client domain logic of the Sync menu's quick Pull and Push (`client/src/lib/gitQuick.ts`, quick pull/push spec §Copy table and §Precedence): which item
 * is enabled and why not, and the one result line a finished op leaves. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import {
  QUICK_NOTE_TTL_MS, quickFailureKind, quickFailureLine, quickMenu, quickNoteExpired, quickResultLine,
  type QuickCtx,
} from '../client/src/lib/gitQuick.js';
import type { OkRepo } from '../client/src/lib/gitSync.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';
import type { GitQuickPart, GitQuickResponse } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; } catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** On `main` (the trunk), with an origin, level with it, no upstream row, the trunk checked out nowhere else. */
function ok(over: Partial<OkRepo> = {}): OkRepo {
  const branch = over.branch === undefined ? 'main' : over.branch;
  return {
    dirName: '-r', name: 'repo', path: '/r', state: 'ok', toplevel: '/r', branch, detachedSha: branch === null ? 'abc1234' : null,
    onTrunk: branch === 'main', uncommitted: 0, trunk: 'main', hasOrigin: true, originUrl: null, trunkVsOrigin: { ahead: 0, behind: 0 },
    trunkRefs: { local: true, origin: true }, trunkCheckedOutElsewhere: false, currentVsUpstream: null, fetchedAtMs: null, lastFetch: null,
    branches: [], unmergedTotal: 0, mergedCount: 0, ...over,
  };
}

const ctx = (over: Partial<QuickCtx> = {}): QuickCtx => ({
  writeAccess: 'open', tokenRequired: false, tokenStored: false, syncAvailable: true, syncState: 'idle', quickRunning: false, syncPending: false, ...over,
});

const up = (upstream: string, counts: { ahead: number; behind: number } | null) => ({ currentVsUpstream: { upstream, counts } });
const tvo = (ahead: number, behind: number) => ({ trunkVsOrigin: { ahead, behind } });

const on = (sub: string) => ({ enabled: true, sub });
const off = (sub: string) => ({ enabled: false, sub });
const SYNC_SUB = 'Commit, check, push, prune branches';

function res(op: 'pull' | 'push', over: Partial<GitQuickResponse> = {}, repo = 'guide-manager'): GitQuickResponse {
  return { op, repo, parts: [], refusal: null, detail: null, timedOut: false, ...over };
}
const okPart = (kind: GitQuickPart['kind'], branch: string, target: string, commits: number): GitQuickPart => ({ kind, branch, target, ok: true, commits });
const badPart = (kind: GitQuickPart['kind'], branch: string, target: string, detail: string, timedOut = false): GitQuickPart =>
  ({ kind, branch, target, ok: false, timedOut, detail });
const refused = (refusal: GitQuickResponse['refusal'], over: Partial<GitQuickResponse> = {}, op: 'pull' | 'push' = 'pull') =>
  quickResultLine(res(op, { refusal, ...over }, 'claude-global'));

export async function run(): Promise<number> {
  console.log('\n=== git quick client (lib/gitQuick.ts) ===\n');
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };
  const pull = (r: OkRepo, c = ctx()) => quickMenu(r, c).pull;
  const push = (r: OkRepo, c = ctx()) => quickMenu(r, c).push;

  // Pull sub-lines
  check(test('pull on the trunk 1 behind → Fast-forward main by 1 commit', () => {
    assert.deepStrictEqual(pull(ok(tvo(0, 1))), on('Fast-forward main by 1 commit'));
  }));
  check(test('pull on fix/x 3 behind origin/fix/x, trunk level → Fast-forward fix/x by 3 commits', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...up('origin/fix/x', { ahead: 0, behind: 3 }) })), on('Fast-forward fix/x by 3 commits'));
  }));
  check(test('pull on fix/x with no upstream, trunk 5 behind → Move main forward 5 commits', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5) })), on('Move main forward 5 commits'));
  }));
  check(test('pull with both parts → fix/x by 3 · main by 5', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5), ...up('origin/fix/x', { ahead: 0, behind: 3 }) })), on('fix/x by 3 · main by 5'));
  }));

  // Pull blocked
  check(test('pull on fix/x, no upstream, trunk 5 behind but checked out elsewhere → main is checked out in another worktree', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5), trunkCheckedOutElsewhere: true })), off('main is checked out in another worktree'));
  }));
  check(test('same with upstream origin/fix/x gone → Upstream gone — use Sync (the current branch reason wins)', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5), trunkCheckedOutElsewhere: true, ...up('origin/fix/x', null) })),
      off('Upstream gone — use Sync'));
  }));
  check(test('same with upstream diverged → fix/x has diverged — use Sync', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5), trunkCheckedOutElsewhere: true, ...up('origin/fix/x', { ahead: 1, behind: 1 }) })),
      off('fix/x has diverged — use Sync'));
  }));
  check(test('pull on a diverged trunk → main has diverged — use Sync', () => {
    assert.deepStrictEqual(pull(ok(tvo(1, 1))), off('main has diverged — use Sync'));
  }));
  check(test('pull on a level trunk, or a trunk only ahead → Nothing to pull', () => {
    assert.deepStrictEqual(pull(ok()), off('Nothing to pull'));
    assert.deepStrictEqual(pull(ok(tvo(2, 0))), off('Nothing to pull'));
  }));
  check(test('fix/x diverged from its upstream but the trunk is 5 behind and free → enabled Move main forward 5 commits', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...tvo(0, 5), ...up('origin/fix/x', { ahead: 1, behind: 1 }) })), on('Move main forward 5 commits'));
  }));
  check(test('fix/x tracking upstream/fix/x 2 behind, trunk level → Nothing to pull (another remote is not eligible)', () => {
    assert.deepStrictEqual(pull(ok({ branch: 'fix/x', ...up('upstream/fix/x', { ahead: 0, behind: 2 }) })), off('Nothing to pull'));
  }));

  // Push
  check(test('push feat/x 2 ahead of origin/feat/x → 2 commits to origin/feat/x; 1 ahead → 1 commit', () => {
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/feat/x', { ahead: 2, behind: 0 }) })), on('2 commits to origin/feat/x'));
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/feat/x', { ahead: 1, behind: 0 }) })), on('1 commit to origin/feat/x'));
  }));
  check(test('push on the trunk 1 ahead → main is PR-only — use Sync; level → Nothing to push', () => {
    assert.deepStrictEqual(push(ok(tvo(1, 0))), off('main is PR-only — use Sync'));
    assert.deepStrictEqual(push(ok()), off('Nothing to push'));
  }));
  check(test('push with no upstream, an upstream on another remote, or origin/main → No upstream — use Sync', () => {
    assert.deepStrictEqual(push(ok({ branch: 'feat/x' })), off('No upstream — use Sync'));
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('upstream/feat/x', { ahead: 1, behind: 0 }) })), off('No upstream — use Sync'));
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/main', { ahead: 1, behind: 0 }) })), off('No upstream — use Sync'));
  }));
  check(test('push with the upstream gone, diverged, or level → its reason', () => {
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/feat/x', null) })), off('Upstream gone — use Sync'));
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/feat/x', { ahead: 1, behind: 1 }) })), off('feat/x has diverged — use Sync'));
    assert.deepStrictEqual(push(ok({ branch: 'feat/x', ...up('origin/feat/x', { ahead: 0, behind: 0 }) })), off('Nothing to push'));
  }));

  // Precedence
  check(test('write access none → both disabled with READ_ONLY_TEXT; token required and not stored → Needs the Answer token', () => {
    const r = ok(tvo(0, 1));
    assert.deepStrictEqual(pull(r, ctx({ writeAccess: 'none' })), off(READ_ONLY_TEXT));
    assert.deepStrictEqual(push(r, ctx({ writeAccess: 'none' })), off(READ_ONLY_TEXT));
    assert.deepStrictEqual(pull(r, ctx({ tokenRequired: true, tokenStored: false })), off('Needs the Answer token'));
    assert.deepStrictEqual(pull(r, ctx({ tokenRequired: true, tokenStored: true })), on('Fast-forward main by 1 commit'));
  }));
  check(test('a running sync → Sync is running; detached → Detached HEAD, for both items', () => {
    assert.deepStrictEqual(pull(ok(tvo(0, 1)), ctx({ syncState: 'running' })), off('Sync is running'));
    const d = ok({ branch: null, ...tvo(0, 1) });
    assert.deepStrictEqual(pull(d), off('Detached HEAD'));
    assert.deepStrictEqual(push(d), off('Detached HEAD'));
  }));

  // Sync item
  check(test('sync item: no spawn → disabled This host can\'t start sessions and pull still enabled; otherwise enabled', () => {
    const m = quickMenu(ok(tvo(0, 1)), ctx({ syncAvailable: false }));
    assert.deepStrictEqual(m.sync, off("This host can't start sessions"));
    assert.strictEqual(m.pull.enabled, true);
    assert.deepStrictEqual(quickMenu(ok(), ctx()).sync, on(SYNC_SUB));
  }));
  check(test('sync item: running → enabled (it opens the chat), pull and push Sync is running; busy, quick running or pending → disabled', () => {
    const m = quickMenu(ok(tvo(0, 1)), ctx({ syncState: 'running' }));
    assert.deepStrictEqual(m.sync, on(SYNC_SUB));
    assert.deepStrictEqual(m.pull, off('Sync is running'));
    assert.deepStrictEqual(m.push, off('Sync is running'));
    assert.deepStrictEqual(quickMenu(ok(), ctx({ syncState: 'busy' })).sync, off(SYNC_SUB));
    assert.deepStrictEqual(quickMenu(ok(), ctx({ quickRunning: true })).sync, off(SYNC_SUB));
    assert.deepStrictEqual(quickMenu(ok(), ctx({ syncPending: true })).sync, off(SYNC_SUB));
  }));

  // Result lines
  check(test('result: one ff, one move, both', () => {
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [okPart('ff', 'main', 'origin/main', 1)] }, 'claude-global')),
      { text: 'claude-global: pulled 1 commit into main.', tone: 'ok' });
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [okPart('move', 'main', 'origin/main', 5)] })),
      { text: 'guide-manager: moved main forward 5 commits.', tone: 'ok' });
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [okPart('ff', 'fix/x', 'origin/fix/x', 3), okPart('move', 'main', 'origin/main', 5)] })),
      { text: 'guide-manager: pulled 3 commits into fix/x, moved main forward 5.', tone: 'ok' });
  }));
  check(test('result: one part ok and one refused → one warn line, the ok part first', () => {
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [badPart('ff', 'fix/x', 'origin/fix/x', 'D'), okPart('move', 'main', 'origin/main', 5)] })),
      { text: 'guide-manager: moved main forward 5 commits; fix/x refused — D. Use Sync.', tone: 'warn' });
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [okPart('ff', 'fix/x', 'origin/fix/x', 3), badPart('move', 'main', 'origin/main', 'D')] })),
      { text: 'guide-manager: pulled 3 commits into fix/x; main refused — D. Use Sync.', tone: 'warn' });
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [badPart('ff', 'fix/x', 'origin/fix/x', ''), okPart('move', 'main', 'origin/main', 5)] })),
      { text: 'guide-manager: moved main forward 5 commits; fix/x refused. Use Sync.', tone: 'warn' });
  }));
  check(test('result: both parts refused → the first one\'s detail, one sentence', () => {
    assert.deepStrictEqual(quickResultLine(res('pull', { parts: [badPart('ff', 'fix/x', 'origin/fix/x', 'D1'), badPart('move', 'main', 'origin/main', 'D2')] })),
      { text: 'guide-manager: git refused — D1. Use Sync.', tone: 'warn' });
  }));
  check(test('result: pushed; a single refused part; an empty detail; a timeout', () => {
    assert.deepStrictEqual(quickResultLine(res('push', { parts: [okPart('push', 'feat/x', 'origin/feat/x', 2)] }, 'claude-agents-dashboard')),
      { text: 'claude-agents-dashboard: pushed 2 commits to origin/feat/x.', tone: 'ok' });
    assert.deepStrictEqual(quickResultLine(res('push', { parts: [badPart('push', 'feat/x', 'origin/feat/x', 'D')] }, 'claude-global')),
      { text: 'claude-global: git refused — D. Use Sync.', tone: 'warn' });
    assert.deepStrictEqual(quickResultLine(res('push', { parts: [badPart('push', 'feat/x', 'origin/feat/x', '')] }, 'claude-global')),
      { text: 'claude-global: git refused. Use Sync.', tone: 'warn' });
    assert.deepStrictEqual(quickResultLine(res('push', { parts: [badPart('push', 'feat/x', 'origin/feat/x', '', true)] }, 'claude-global')),
      { text: 'claude-global: git took over 60s and was stopped. Use Sync.', tone: 'warn' });
  }));
  check(test('result: every refusal is one warn line', () => {
    const warn = (text: string) => ({ text, tone: 'warn' });
    assert.deepStrictEqual(refused('fetch-running'), warn('claude-global: a fetch is running — try again in a moment.'));
    assert.deepStrictEqual(refused('fetch-failed', { timedOut: true, detail: '' }), warn('claude-global: git took over 60s and was stopped. Use Sync.'));
    assert.deepStrictEqual(refused('fetch-failed', { detail: 'D' }), warn('claude-global: fetch failed — D. Use Sync.'));
    assert.deepStrictEqual(refused('fetch-failed', { detail: '' }), warn('claude-global: fetch failed. Use Sync.'));
    assert.deepStrictEqual(refused('busy'), warn('claude-global: another pull or push is running on this repo — try again in a moment.'));
    assert.deepStrictEqual(refused('in-progress'), warn('claude-global: a merge, rebase or similar is in progress. Use Sync.'));
    assert.deepStrictEqual(refused('detached'), warn('claude-global: detached HEAD. Use Sync.'));
    assert.deepStrictEqual(refused('nothing'), warn('claude-global: nothing to pull.'));
    assert.deepStrictEqual(refused('nothing', {}, 'push'), warn('claude-global: nothing to push.'));
    assert.deepStrictEqual(refused('not-ok'), warn("claude-global: can't read this repo. Use Sync."));
    assert.deepStrictEqual(refused('no-origin'), warn("claude-global: can't read this repo. Use Sync."));
  }));

  // Request failures
  check(test('failure lines: read-only, bad token, failed; a 403 maps through refusalKind', () => {
    assert.deepStrictEqual(quickFailureLine('claude-global', 'read-only'), { text: `claude-global: ${READ_ONLY_TEXT}`, tone: 'warn' });
    assert.deepStrictEqual(quickFailureLine('claude-global', 'bad-token'), { text: 'claude-global: the server refused the Answer token.', tone: 'warn' });
    assert.deepStrictEqual(quickFailureLine('claude-global', 'failed'), { text: 'claude-global: the request failed.', tone: 'warn' });
    assert.strictEqual(quickFailureKind(403, { error: 'read-only from this network' }), 'read-only');
    assert.strictEqual(quickFailureKind(403, { error: 'bad token' }), 'bad-token');
    assert.strictEqual(quickFailureKind(500, { error: 'git quick failed' }), 'failed');
  }));

  // Note expiry
  check(test('the note expires strictly after 30s on the client clock', () => {
    assert.strictEqual(QUICK_NOTE_TTL_MS, 30_000);
    assert.strictEqual(quickNoteExpired(0, 30_000), false);
    assert.strictEqual(quickNoteExpired(0, 30_001), true);
  }));

  console.log(`\ngit-quick-client: ${pass}/${total} passed`);
  return total - pass;
}
