/**
 * Quick Pull and Push from the Sync menu: fast-forward only, no Claude session (spec `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md`).
 * Everything is re-read from disk; the client only names the pin and the op, so a stale menu can never make this move a ref the rules forbid. Hooks run
 * as the user configured them: a pre-push hook that refuses is a failed part, never bypassed.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GitQuickOp, GitQuickPart, GitQuickPartKind, GitQuickRefusal, GitQuickResponse } from '../../shared/types.js';
import { fetchInFlight, makeFetchRunner, promptlessEnv } from './git-fetch.js';
import type { FetchRunner } from './git-fetch.js';
import { tryLockRepo } from './git-locks.js';
import { trunkOf } from './git-stats.js';

/** Longer than fetch-all's 30s: a push runs the user's pre-push hook, which may run a test suite. */
export const QUICK_TIMEOUT_MS = 60_000;

const LOCAL_ENV: Record<string, string> = { LC_ALL: 'C' };

/** Any of these under the git dir means an operation the user started is unfinished; a fast-forward on top of it would be a surprise. */
const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

const defaultRunner = (): FetchRunner => makeFetchRunner({ timeoutMs: QUICK_TIMEOUT_MS });
let runner: FetchRunner = defaultRunner();

/** Test seam: replace the git runner; null restores the default. */
export function overrideQuickRunner(run: FetchRunner | null): void {
  runner = run ?? defaultRunner();
}

/** Git's first non-empty stderr line, without the `error: ` / `fatal: ` prefix the UI would only repeat. */
function firstLine(stderr: string): string {
  const line = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return line.replace(/^(error|fatal): /, '');
}

/**
 * Runs one quick op on the repo at `pin.toplevel`. Never throws for a git failure: the answer is either one refusal or the parts it attempted, some of
 * which may have failed.
 */
export async function runQuickOp(pin: { name: string; toplevel: string }, op: GitQuickOp): Promise<GitQuickResponse> {
  const run = runner;
  const local = (args: string[]) => run(pin.toplevel, args, LOCAL_ENV);
  const answer = (refusal: GitQuickRefusal | null, parts: GitQuickPart[] = [], detail: string | null = null, timedOut = false): GitQuickResponse =>
    ({ op, repo: pin.name, parts, refusal, detail, timedOut });

  const top = await local(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [toplevel, rawCommon] = top.stdout.split('\n').map(l => l.trim());
  if (top.code !== 0 || !toplevel || !rawCommon) return answer('not-ok');
  let commonDir: string;
  try {
    commonDir = fs.realpathSync(rawCommon);
  } catch {
    return answer('not-ok');
  }
  const remotes = await local(['remote']);
  if (remotes.code !== 0) return answer('not-ok');
  if (!remotes.stdout.split('\n').some(r => r.trim() === 'origin')) return answer('no-origin');

  // Both checks and the lock happen in one synchronous stretch, so fetch-all cannot start between "not in flight" and "locked".
  if (fetchInFlight()) return answer('fetch-running');
  const release = tryLockRepo(commonDir);
  if (release === null) return answer('busy');
  try {
    const gitRun = (cwd: string, args: string[]) => run(cwd, args, LOCAL_ENV);

    for (const name of IN_PROGRESS) {
      const p = await local(['rev-parse', '--git-path', name]);
      if (p.code === 0 && fs.existsSync(path.resolve(toplevel, p.stdout.trim()))) return answer('in-progress');
    }

    const head = await local(['symbolic-ref', '-q', '--short', 'HEAD']);
    const branch = head.stdout.trim();
    if (head.code !== 0 || !branch) return answer('detached');
    const trunk = await trunkOf(gitRun, toplevel);
    if (trunk === null) return answer('nothing');

    const upstream = await (async (): Promise<string | null> => {
      const u = await local(['rev-parse', '--abbrev-ref', `${branch}@{u}`]);
      const name = u.stdout.trim();
      return u.code === 0 && name.startsWith('origin/') && name !== `origin/${trunk}` ? name : null;
    })();

    /** `[ahead, behind]` of `a` against `b`, or null when either ref is missing. */
    const counts = async (a: string, b: string): Promise<[number, number] | null> => {
      const r = await local(['rev-list', '--left-right', '--count', `${a}...${b}`]);
      if (r.code !== 0) return null;
      const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
      return Number.isFinite(ahead) && Number.isFinite(behind) ? [ahead, behind] : null;
    };

    const part = (kind: GitQuickPartKind, partBranch: string, target: string, r: Awaited<ReturnType<FetchRunner>>, commits: number): GitQuickPart =>
      (r.code === 0 && !r.timedOut
        ? { kind, branch: partBranch, target, ok: true, commits }
        : { kind, branch: partBranch, target, ok: false, timedOut: r.timedOut, detail: r.timedOut ? '' : firstLine(r.stderr) });

    const env = await promptlessEnv(toplevel, run);

    if (op === 'push') {
      if (branch === trunk || upstream === null) return answer('nothing');
      const c = await counts(`refs/heads/${branch}`, `refs/remotes/${upstream}`);
      if (c === null || c[0] === 0 || c[1] !== 0) return answer('nothing');
      if (env === null) return answer(null, [{ kind: 'push', branch, target: upstream, ok: false, timedOut: false, detail: '' }]);
      const r = await run(toplevel, ['push', 'origin', `refs/heads/${branch}:refs/heads/${upstream.slice('origin/'.length)}`], env);
      return answer(null, [part('push', branch, upstream, r, c[0])]);
    }

    if (env === null) return answer('fetch-failed', [], '');
    const fetched = await run(toplevel, ['fetch', 'origin'], env);
    if (fetched.code !== 0 || fetched.timedOut) return answer('fetch-failed', [], fetched.timedOut ? '' : firstLine(fetched.stderr), fetched.timedOut);

    const parts: GitQuickPart[] = [];
    const ffTarget = branch === trunk ? `origin/${trunk}` : upstream;
    if (ffTarget !== null) {
      const c = await counts('HEAD', `refs/remotes/${ffTarget}`);
      if (c !== null && c[1] > 0 && c[0] === 0) {
        const r = await local(['merge', '--ff-only', '-q', `refs/remotes/${ffTarget}`]);
        parts.push(part('ff', branch, ffTarget, r, c[1]));
      }
    }

    if (branch !== trunk) {
      const wt = await local(['for-each-ref', '--format=%(worktreepath)', `refs/heads/${trunk}`]);
      // An empty listing with code 0 is either "no local trunk" or "checked out nowhere"; the counts below need the ref, which settles which.
      if (wt.code === 0 && wt.stdout.trim() === '') {
        const c = await counts(`refs/heads/${trunk}`, `refs/remotes/origin/${trunk}`);
        if (c !== null && c[1] > 0 && c[0] === 0) {
          // A non-`+` refspec: git itself refuses a non-fast-forward or a branch checked out since the re-read above.
          const r = await run(toplevel, ['fetch', 'origin', `${trunk}:${trunk}`], env);
          parts.push(part('move', trunk, `origin/${trunk}`, r, c[1]));
        }
      }
    }

    return parts.length > 0 ? answer(null, parts) : answer('nothing');
  } finally {
    release();
  }
}
