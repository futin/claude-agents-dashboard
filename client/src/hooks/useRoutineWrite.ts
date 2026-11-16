import { useCallback, useRef, useState } from 'react';

import { authHeaders } from '../lib/answerToken';
import { busyAdd, busyRemove, writeFailureText } from '../lib/routines';
import { useAnswerToken } from './useAnswerToken';

export interface RoutineWriteResult {
  ok: boolean;
  /** 0 when the fetch never answered. */
  status: number;
  body: unknown;
  /** The refusal as one line, null on success. */
  failure: string | null;
}

export interface RoutineNote { text: string; tone: 'warn' | 'ok' }

export interface RoutineWriteControl {
  /** The page's one status line under the toolbar. */
  note: RoutineNote | null;
  setNote(note: RoutineNote | null): void;
  /** The keys of the writes in flight (`run:<name>`, `toggle:<name>` …), so only their controls grey out — each one until its own POST settles. */
  busy: ReadonlySet<string>;
  /**
   * One write to the routines API with the Answer token. A refusal lands in `note` unless `inline` is set — the drawer shows its own, over the page that
   * would otherwise hide it. Every success re-polls the ledger so the change shows before the next tick. A key already in flight is refused without a fetch
   * (`ok: false`, `status: 0`, `failure: null`, `note` untouched), so a double click cannot write twice.
   */
  send(what: string, key: string, method: string, url: string, body?: unknown, inline?: boolean): Promise<RoutineWriteResult>;
}

export function useRoutineWrite(refresh: () => void): RoutineWriteControl {
  const [token] = useAnswerToken();
  const [note, setNote] = useState<RoutineNote | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The refusal reads this, not `busy`: a second click can land before React re-renders with the first one's key.
  const inFlight = useRef(new Set<string>());

  const send = useCallback(async (what: string, key: string, method: string, url: string, body?: unknown, inline = false): Promise<RoutineWriteResult> => {
    if (inFlight.current.has(key)) return { ok: false, status: 0, body: null, failure: null };
    inFlight.current.add(key);
    setBusy(cur => busyAdd(cur, key));
    if (!inline) setNote(null);
    let status = 0;
    let parsed: unknown = null;
    try {
      const res = await fetch(url, {
        method,
        headers: authHeaders(token, body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      status = res.status;
      parsed = await res.json().catch(() => null);
    } catch {
      status = 0;
    }
    inFlight.current.delete(key);
    setBusy(cur => busyRemove(cur, key));
    const ok = status >= 200 && status < 300;
    const failure = ok ? null : writeFailureText(what, status, parsed);
    if (failure && !inline) setNote({ text: failure, tone: 'warn' });
    if (ok) refresh();
    return { ok, status, body: parsed, failure };
  }, [token, refresh]);

  return { note, setNote, busy, send };
}
