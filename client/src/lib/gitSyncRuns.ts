/**
 * gitSyncRuns.ts — what a new sessions payload does to the remembered Git Sync runs. Kept apart from `useGitSync` so the transition is tested without
 * React (`test/git-sync-client.test.ts`).
 */

import type { SessionsResponse } from '../../../shared/types';
import { syncPhase, type SyncRuns } from './gitSync';

export interface Reconciled {
  /** The same object as the input when nothing was dropped or newly marked seen, so the caller can skip a write. */
  runs: SyncRuns;
  /** Toplevels whose run ended: their repos are worth a re-poll. */
  ended: string[];
  /** Runs whose launch failed, for the note. */
  failed: { name: string; error: string | null }[];
}

export function reconcileRuns(runs: SyncRuns, data: SessionsResponse | null, nowMs: number): Reconciled {
  const ended: string[] = [];
  const failed: { name: string; error: string | null }[] = [];
  let next: SyncRuns | null = null;
  for (const [toplevel, run] of Object.entries(runs)) {
    const phase = syncPhase(run, data, nowMs);
    if (phase.kind === 'running' && !run.seen) {
      next ??= { ...runs };
      next[toplevel] = { ...run, seen: true };
      continue;
    }
    if (phase.kind !== 'ended' && phase.kind !== 'failed') continue;
    if (phase.kind === 'ended') ended.push(toplevel);
    else failed.push({ name: run.name, error: phase.error });
    next ??= { ...runs };
    delete next[toplevel];
  }
  return { runs: next ?? runs, ended, failed };
}
