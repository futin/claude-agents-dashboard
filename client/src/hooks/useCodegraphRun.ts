import { useCallback, useEffect, useRef, useState } from 'react';

import type { CodegraphRunKind, WriteAccess } from '../../../shared/types';
import { authHeaders } from '../lib/answerToken';
import { runNote } from '../lib/codegraphPoll';
import { useAnswerToken } from './useAnswerToken';
import { useRemoteAnswer } from './useRemoteAnswer';

export interface CodegraphRunControl {
  /** Start one run: `POST /api/codegraph/run`. A no-op while another of this tab's POSTs is out. */
  run(dirName: string, name: string, kind: CodegraphRunKind): Promise<void>;
  /** Sync each target in turn, one POST at a time; stops at the first answer that is not a 200, so a missing token is said once, not once per repo. */
  runAll(targets: { dirName: string; name: string }[]): Promise<void>;
  /** `<dirName>:<kind>` of the POST in flight, so only that key reads "Syncing" / "Reindexing"; null otherwise. */
  pendingKey: string | null;
  /** The one line under the band: the last start that was refused or failed. Null after a start that went through. */
  note: string | null;
  /** The server wants an Answer token on writes (`HealthResponse.tokenRequired`); undefined until health answers or on an older server. */
  tokenRequired: boolean | undefined;
  /** This browser's write access (`HealthResponse.writeAccess`); `'none'` disables the keys. Undefined as `tokenRequired` is. */
  writeAccess: WriteAccess | undefined;
}

/** The key `pendingKey` carries, so a component asks "is this repo's Sync the one in flight" without rebuilding the spelling. */
export function codegraphRunKey(dirName: string, kind: CodegraphRunKind): string {
  return `${dirName}:${kind}`;
}

/**
 * Management › CodeGraph's Sync and Reindex keys. The POST answers as soon as the server has started the run, so `onChange` (the status poll) runs after
 * every answer — a refusal included — and picks the run's `run` field up at once rather than at the next tick.
 */
export function useCodegraphRun(onChange: () => void): CodegraphRunControl {
  const [token] = useAnswerToken();
  const remote = useRemoteAnswer();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // True when the start went through, so `runAll` knows whether to go on.
  const post = useCallback(async (dirName: string, name: string, kind: CodegraphRunKind): Promise<boolean> => {
    setPendingKey(codegraphRunKey(dirName, kind));
    let line: string | null;
    try {
      const res = await fetch('/api/codegraph/run', {
        method: 'POST',
        headers: authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dirName, kind }),
      });
      line = runNote(res.status, await res.json().catch(() => undefined), name, kind);
    } catch {
      line = runNote(0, undefined, name, kind);
    }
    if (aliveRef.current) {
      setNote(line);
      setPendingKey(null);
    }
    onChangeRef.current();
    return line === null;
  }, [token]);

  const run = useCallback(async (dirName: string, name: string, kind: CodegraphRunKind): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try { await post(dirName, name, kind); } finally { busyRef.current = false; }
  }, [post]);

  const runAll = useCallback(async (targets: { dirName: string; name: string }[]): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      for (const t of targets) {
        if (!(await post(t.dirName, t.name, 'sync'))) break;
      }
    } finally { busyRef.current = false; }
  }, [post]);

  return { run, runAll, pendingKey, note, tokenRequired: remote.state?.tokenRequired, writeAccess: remote.state?.writeAccess };
}
