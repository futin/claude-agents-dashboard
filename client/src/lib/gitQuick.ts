/**
 * gitQuick.ts — the rules behind the Sync key's menu (quick pull/push spec §Copy table, §Precedence): whether Pull, Push and Sync are enabled and the one
 * line each shows, and the result line a finished quick op leaves. Pure, so `test/git-quick-client.test.ts` drives it without React. The server re-reads
 * the repo before it moves anything, so these rules only decide what the menu offers, never what git is allowed to do.
 */

import type { GitQuickPart, GitQuickResponse, WriteAccess } from '../../../shared/types';
import type { OkRepo } from './gitSync';
import { READ_ONLY_TEXT, refusalKind } from './writeRefusal';

export interface QuickItem {
  enabled: boolean;
  sub: string;
}

export interface QuickCtx {
  writeAccess: WriteAccess | undefined;
  tokenRequired: boolean | undefined;
  tokenStored: boolean;
  /** The host can launch a session at all; only the Sync item needs one. */
  syncAvailable: boolean;
  /** `busy`: a sync is launching or not yet seen; `running`: its session is live. */
  syncState: 'idle' | 'running' | 'busy';
  /** A quick op on this repo is in flight. */
  quickRunning: boolean;
  /** The Sync key's own POST is in flight. */
  syncPending: boolean;
}

export const QUICK_NOTE_TTL_MS = 30_000;

const SYNC_SUB = 'Commit, check, push, prune branches';

const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`;
const on = (sub: string): QuickItem => ({ enabled: true, sub });
const off = (sub: string): QuickItem => ({ enabled: false, sub });

/** The current branch's upstream when a quick op may use it: on origin, and not `origin/<trunk>`, whose numbers are the trunk's. */
function eligibleUpstream(repo: OkRepo): NonNullable<OkRepo['currentVsUpstream']> | null {
  const u = repo.currentVsUpstream;
  if (u === null || !u.upstream.startsWith('origin/') || (repo.trunk !== null && u.upstream === `origin/${repo.trunk}`)) return null;
  return u;
}

/** A pull part that applies (its count) or the reason it does not. */
type PartState = { n: number } | { reason: string };

function trunkPart(repo: OkRepo, checkedOut: boolean): PartState {
  const t = repo.trunk;
  const c = repo.trunkVsOrigin;
  if (t === null || c === null || c.behind === 0) return { reason: 'Nothing to pull' };
  if (c.ahead > 0) return { reason: `${t} has diverged — use Sync` };
  // The trunk that is checked out here is fast-forwarded in place; one checked out in another worktree cannot be moved without touching that worktree.
  if (!checkedOut && repo.trunkCheckedOutElsewhere) return { reason: `${t} is checked out in another worktree` };
  return { n: c.behind };
}

function pullItem(repo: OkRepo, branch: string): QuickItem {
  if (branch === repo.trunk) {
    const t = trunkPart(repo, true);
    return 'n' in t ? on(`Fast-forward ${branch} by ${commits(t.n)}`) : off(t.reason);
  }
  const u = eligibleUpstream(repo);
  const current: PartState | null = u === null
    ? null
    : u.counts === null ? { reason: 'Upstream gone — use Sync' }
      : u.counts.behind === 0 ? { reason: 'Nothing to pull' }
        : u.counts.ahead > 0 ? { reason: `${branch} has diverged — use Sync` }
          : { n: u.counts.behind };
  const trunk = trunkPart(repo, false);
  const cur = current !== null && 'n' in current ? current.n : null;
  const mv = 'n' in trunk ? trunk.n : null;
  if (cur !== null && mv !== null) return on(`${branch} by ${cur} · ${repo.trunk} by ${mv}`);
  if (cur !== null) return on(`Fast-forward ${branch} by ${commits(cur)}`);
  if (mv !== null) return on(`Move ${repo.trunk} forward ${commits(mv)}`);
  return off(current !== null && 'reason' in current ? current.reason : (trunk as { reason: string }).reason);
}

function pushItem(repo: OkRepo, branch: string): QuickItem {
  if (branch === repo.trunk) return off((repo.trunkVsOrigin?.ahead ?? 0) > 0 ? `${branch} is PR-only — use Sync` : 'Nothing to push');
  const u = eligibleUpstream(repo);
  if (u === null) return off('No upstream — use Sync');
  if (u.counts === null) return off('Upstream gone — use Sync');
  if (u.counts.ahead > 0 && u.counts.behind > 0) return off(`${branch} has diverged — use Sync`);
  if (u.counts.ahead === 0) return off('Nothing to push');
  return on(`${commits(u.counts.ahead)} to ${u.upstream}`);
}

/** The menu's three items for one repo. A disabled item always says why: the first reason in the spec's precedence order. */
export function quickMenu(repo: OkRepo, ctx: QuickCtx): { pull: QuickItem; push: QuickItem; sync: QuickItem } {
  const sync = !ctx.syncAvailable
    ? off("This host can't start sessions")
    : ctx.syncState === 'busy' || ctx.quickRunning || ctx.syncPending ? off(SYNC_SUB) : on(SYNC_SUB);
  const blocked = ctx.writeAccess === 'none' ? READ_ONLY_TEXT
    : ctx.tokenRequired && !ctx.tokenStored ? 'Needs the Answer token'
      : ctx.syncState !== 'idle' ? 'Sync is running'
        : repo.branch === null ? 'Detached HEAD'
          : null;
  if (blocked !== null || repo.branch === null) return { pull: off(blocked ?? 'Detached HEAD'), push: off(blocked ?? 'Detached HEAD'), sync };
  return { pull: pullItem(repo, repo.branch), push: pushItem(repo, repo.branch), sync };
}

const TIMEOUT = 'git took over 60s and was stopped. Use Sync.';
const clause = (detail: string | null): string => (detail ? ` — ${detail}` : '');

function okPhrase(p: Extract<GitQuickPart, { ok: true }>, short: boolean): string {
  if (p.kind === 'push') return `pushed ${commits(p.commits)} to ${p.target}`;
  if (p.kind === 'ff') return `pulled ${commits(p.commits)} into ${p.branch}`;
  return short ? `moved ${p.branch} forward ${p.commits}` : `moved ${p.branch} forward ${commits(p.commits)}`;
}

/** The one line a finished quick op leaves under the Git view. Every refusal and every failed part is `warn`. */
export function quickResultLine(res: GitQuickResponse): { text: string; tone: 'ok' | 'warn' } {
  const say = (text: string, tone: 'ok' | 'warn' = 'warn') => ({ text: `${res.repo}: ${text}`, tone });
  switch (res.refusal) {
    case 'fetch-running': return say('a fetch is running — try again in a moment.');
    case 'busy': return say('another pull or push is running on this repo — try again in a moment.');
    case 'in-progress': return say('a merge, rebase or similar is in progress. Use Sync.');
    case 'detached': return say('detached HEAD. Use Sync.');
    case 'nothing': return say(`nothing to ${res.op}.`);
    case 'fetch-failed': return say(res.timedOut ? TIMEOUT : `fetch failed${clause(res.detail)}. Use Sync.`);
    case 'not-ok':
    case 'no-origin': return say("can't read this repo. Use Sync.");
    case null: break;
  }
  const good = res.parts.filter((p): p is Extract<GitQuickPart, { ok: true }> => p.ok);
  const bad = res.parts.filter((p): p is Extract<GitQuickPart, { ok: false }> => !p.ok);
  if (good.length === 0 && bad.length === 0) return say(`nothing to ${res.op}.`);
  if (good.length === 0) return say(bad[0].timedOut ? TIMEOUT : `git refused${clause(bad[0].detail)}. Use Sync.`);
  const done = good.map((p, i) => okPhrase(p, i > 0)).join(', ');
  if (bad.length === 0) return say(`${done}.`, 'ok');
  const f = bad[0];
  return say(`${done}; ${f.branch} ${f.timedOut ? 'took over 60s and was stopped' : `refused${clause(f.detail)}`}. Use Sync.`);
}

export type QuickFailureKind = 'read-only' | 'bad-token' | 'failed';

/** What a request that never got a `GitQuickResponse` back amounts to: a 403 the way every write reads one, anything else a plain failure. */
export function quickFailureKind(status: number, body: unknown): QuickFailureKind {
  const k = refusalKind(status, body);
  return k === 'read-only' ? 'read-only' : k === 'token' ? 'bad-token' : 'failed';
}

export function quickFailureLine(repoName: string, kind: QuickFailureKind): { text: string; tone: 'warn' } {
  const text = kind === 'read-only' ? READ_ONLY_TEXT : kind === 'bad-token' ? 'the server refused the Answer token.' : 'the request failed.';
  return { text: `${repoName}: ${text}`, tone: 'warn' };
}

/** Both stamps are this client's own `Date.now()` — the note's, and the moment a stats poll answered — never the server's clock. */
export function quickNoteExpired(noteAtMs: number, receivedAtMs: number): boolean {
  return receivedAtMs - noteAtMs > QUICK_NOTE_TTL_MS;
}
