import { useCallback, useState } from 'react';

import { authHeaders } from '../lib/answerToken';
import { writeFailureText } from '../lib/routines';
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
  /** The key of the write in flight (`run:<name>`, `toggle:<name>` …), so only its control greys out. */
  busy: string | null;
  /**
   * One write to the routines API with the Answer token. A refusal lands in `note` unless `inline` is set — the drawer shows its own, over the page that
   * would otherwise hide it. Every success re-polls the ledger so the change shows before the next tick.
   */
  send(what: string, key: string, method: string, url: string, body?: unknown, inline?: boolean): Promise<RoutineWriteResult>;
}

export function useRoutineWrite(refresh: () => void): RoutineWriteControl {
  const [token] = useAnswerToken();
  const [note, setNote] = useState<RoutineNote | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const send = useCallback(async (what: string, key: string, method: string, url: string, body?: unknown, inline = false): Promise<RoutineWriteResult> => {
    setBusy(key);
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
    setBusy(cur => (cur === key ? null : cur));
    const ok = status >= 200 && status < 300;
    const failure = ok ? null : writeFailureText(what, status, parsed);
    if (failure && !inline) setNote({ text: failure, tone: 'warn' });
    if (ok) refresh();
    return { ok, status, body: parsed, failure };
  }, [token, refresh]);

  return { note, setNote, busy, send };
}
