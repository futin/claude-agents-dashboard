import { useCallback, useEffect, useRef, useState } from 'react';

import type { RepoGitStats, Session } from '../../../shared/types';
import {
  SYNC_NEEDS_TOKEN, SYNC_SCAN_LIMIT, canSync, parseSyncRuns, runFor, syncFailedText, syncLaunchErrorText, syncPhase, syncRequest,
  type OkRepo, type SyncPhase,
} from '../lib/gitSync';
import { reconcileRuns } from '../lib/gitSyncRuns';
import { usePersistedState } from './usePersistedState';
import { useRemoteAnswer } from './useRemoteAnswer';
import { useSessions } from './useSessions';
import { useSettings } from './useSettings';
import { useSpawn } from './useSpawn';

export interface GitSyncControl {
  /** The host can spawn (`HealthResponse.spawnAvailable`); no button draws until it says so. */
  available: boolean;
  /** The repo's remembered run as it stands now; null when it has none. */
  phaseFor(repo: RepoGitStats): SyncPhase | null;
  start(repo: OkRepo): void;
  /** A launch is in flight. Shared by every button: one launch at a time. */
  pending: boolean;
  /** The toplevel whose launch is in flight, so only its button reads "Starting…"; null otherwise. */
  starting: string | null;
  /** The one line under the band: a launch that was refused or failed to start. */
  note: string | null;
  /** The drawer's session: the live row while the payload has it, else the last row seen for the opened id. */
  chat: Session | null;
  openChat(id: string): void;
  closeChat(): void;
}

/**
 * Management › Git's Sync button (git-stats spec §9). Runs are remembered per device under their repo's toplevel; the sessions poll runs only while one
 * is remembered or its drawer is open, and asks for every row the server allows so a sync parked on its question rarely falls off the list. A run that
 * ends is forgotten and `onEnded` re-polls git stats, once per payload however many ended.
 */
export function useGitSync(onEnded: () => void): GitSyncControl {
  const { settings } = useSettings();
  const remote = useRemoteAnswer();
  const { launch, pending, error, needsToken } = useSpawn();
  // The literal key, not SYNC_RUNS_KEY: the Reset sweep in test/client-settings.test.ts reads keys off the source.
  const [stored, setStored] = usePersistedState<unknown>('management.syncRuns', {});
  const runs = parseSyncRuns(stored);
  const [chatId, setChatId] = useState<string | null>(null);
  const [lastChat, setLastChat] = useState<Session | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const hasRuns = Object.keys(runs).length > 0;
  const { data } = useSessions({ enabled: hasRuns || chatId !== null, limit: SYNC_SCAN_LIMIT });

  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const cur = parseSyncRuns(stored);
    const r = reconcileRuns(cur, data, now);
    if (r.runs === cur) return;
    // Functional, so a launch recorded since this render is reconciled too rather than overwritten.
    setStored((latest: unknown) => reconcileRuns(parseSyncRuns(latest), data, now).runs);
    if (r.failed.length > 0) setNote(syncFailedText(r.failed[0].name, r.failed[0].error));
    if (r.ended.length > 0 || r.failed.length > 0) onEndedRef.current();
    // `stored` is read, not watched: a new payload is what can change a run, and the write above would otherwise re-run this on its own result.
  }, [data]);

  const liveChat = chatId && data ? data.sessions.find(s => s.id === chatId) ?? null : null;
  useEffect(() => {
    if (liveChat) setLastChat(liveChat);
  }, [liveChat]);

  // useSpawn reports a refusal through state, so it is read when `pending` drops, in the render that carries it — not in `start`'s stale closure,
  // and not off `needsToken`, which a second 403 in a row leaves unchanged.
  const startedName = useRef<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => {
    if (pending || startedName.current === null) return;
    const name = startedName.current;
    startedName.current = null;
    setStarting(null);
    if (needsToken) setNote(SYNC_NEEDS_TOKEN);
    else if (error) setNote(syncLaunchErrorText(name, error));
  }, [pending]);

  const available = remote.state?.spawnAvailable === true;
  const ceiling = remote.state?.spawnMaxPermission;

  const start = useCallback((repo: OkRepo): void => {
    if (pending || !available || !canSync(repo) || runFor(runs, repo)) return;
    setNote(null);
    startedName.current = repo.name;
    setStarting(repo.toplevel);
    void launch(syncRequest(repo, settings, ceiling)).then(sessionId => {
      if (!sessionId) return;
      setStored((cur: unknown) => ({
        ...parseSyncRuns(cur),
        [repo.toplevel]: { sessionId, dirName: repo.dirName, name: repo.name, launchedAtMs: Date.now(), seen: false },
      }));
    });
  }, [pending, available, runs, launch, settings, ceiling, setStored]);

  const phaseFor = (repo: RepoGitStats): SyncPhase | null => {
    const run = runFor(runs, repo);
    return run ? syncPhase(run, data, Date.now()) : null;
  };

  return {
    available,
    phaseFor,
    start,
    pending,
    starting,
    note,
    chat: chatId ? liveChat ?? (lastChat?.id === chatId ? lastChat : null) : null,
    openChat: setChatId,
    closeChat: () => { setChatId(null); setLastChat(null); },
  };
}
