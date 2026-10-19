import { useCallback, useRef, useState } from 'react';

import type { GitQuickOp, GitQuickRequest, GitQuickResponse, RepoGitStats, WriteAccess } from '../../../shared/types';
import { authHeaders } from '../lib/answerToken';
import { quickFailureKind, quickFailureLine, quickResultLine } from '../lib/gitQuick';
import type { OkRepo } from '../lib/gitSync';
import { useAnswerToken } from './useAnswerToken';

export interface QuickNote {
  text: string;
  tone: 'ok' | 'warn';
  /** This client's `Date.now()` when the answer arrived; the note expires against the same clock. */
  atMs: number;
}

export interface GitQuickControl {
  /** `POST /api/git-quick` for one repo. A no-op while that repo already has one out, while a token the server wants is not stored, and on a read-only network. */
  run(repo: OkRepo, op: GitQuickOp): void;
  /** The op this tab has out for the repo, or null. */
  runningFor(repo: RepoGitStats): GitQuickOp | null;
  /** The last answer's one line, for whichever repo answered last. */
  note: QuickNote | null;
  clearNote(): void;
  tokenStored: boolean;
}

/**
 * The Sync menu's quick Pull and Push (quick pull/push spec §The UI). One POST per repo at a time, keyed by toplevel; different repos may run side by
 * side, since the server locks per repo too. `onDone` is the stats poll, run after every answer so the pills show what moved.
 */
export function useGitQuick(tokenRequired: boolean | undefined, writeAccess: WriteAccess | undefined, onDone: () => void): GitQuickControl {
  const [token] = useAnswerToken();
  const [running, setRunning] = useState<ReadonlyMap<string, GitQuickOp>>(new Map());
  const [note, setNote] = useState<QuickNote | null>(null);
  // The state map lags a render behind; the ref is what stops a double click from sending twice.
  const runningRef = useRef(new Set<string>());
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const tokenStored = token !== '';

  const run = useCallback((repo: OkRepo, op: GitQuickOp): void => {
    const key = repo.toplevel;
    if (runningRef.current.has(key) || writeAccess === 'none' || (tokenRequired === true && !tokenStored)) return;
    runningRef.current.add(key);
    setRunning(m => new Map(m).set(key, op));
    const body: GitQuickRequest = { dirName: repo.dirName, op };
    const say = (line: { text: string; tone: 'ok' | 'warn' }) => setNote({ ...line, atMs: Date.now() });
    fetch('/api/git-quick', { method: 'POST', headers: authHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then(async res => {
        const json: unknown = await res.json().catch(() => null);
        // 409 carries a whole response too (busy, fetch running); any other non-200 never does.
        if ((res.status === 200 || res.status === 409) && json !== null && typeof json === 'object' && Array.isArray((json as GitQuickResponse).parts)) {
          say(quickResultLine(json as GitQuickResponse));
        } else {
          say(quickFailureLine(repo.name, quickFailureKind(res.status, json)));
        }
      }, () => say(quickFailureLine(repo.name, 'failed')))
      .finally(() => {
        runningRef.current.delete(key);
        setRunning(m => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
        onDoneRef.current();
      });
  }, [tokenRequired, writeAccess, tokenStored, token]);

  const runningFor = useCallback((repo: RepoGitStats): GitQuickOp | null => (repo.state === 'ok' ? running.get(repo.toplevel) ?? null : null), [running]);
  const clearNote = useCallback(() => setNote(null), []);

  return { run, runningFor, note, clearNote, tokenStored };
}
