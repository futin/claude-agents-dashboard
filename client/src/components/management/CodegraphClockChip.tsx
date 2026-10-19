import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { WriteAccess } from '../../../../shared/types';
import type { CodegraphState } from '../../hooks/useCodegraph';
import type { CodegraphRunControl } from '../../hooks/useCodegraphRun';
import type { CodegraphAssessed } from '../../lib/codegraphLevels';
import {
  CODEGRAPH_CLOCK_NAME, CODEGRAPH_KEY_NOW, CODEGRAPH_POP_LABEL, METER_READ, METER_READ_READING, METER_WATCHERS, ROW_REREAD, ROW_REREAD_SUB, ROW_SYNC_ALL,
  ROW_SYNC_ALL_NEEDS_TOKEN_SUB, ROW_SYNC_ALL_NONE_SUB, rowSyncAllSub, watchersValue,
} from '../../lib/codegraphText';
import { syncReading, type MeterReading } from '../../lib/gitClock';
import { READ_ONLY_TEXT } from '../../lib/writeRefusal';
import Chevron from '../Chevron';
import { useDismiss } from '../Popover';
import { GitMeter } from './GitClockChip';

/** The repos Sync all behind would run: Worth a look for pending changes with no watcher, and nothing already running there (that would only 409). */
export function behindRepos(ranked: readonly CodegraphAssessed[]): CodegraphAssessed[] {
  return ranked.filter(a => a.level === 'look' && a.repo.run === null && a.problems.some(p => p.key === 'pending'));
}

/** WATCHERS: indexed repos with a watcher over all indexed repos; amber while a Worth a look repo has none to catch its changes up. */
function watchersReading(ranked: readonly CodegraphAssessed[]): MeterReading {
  const indexed = ranked.filter(a => a.level !== 'none');
  const watching = indexed.filter(a => a.repo.watching).length;
  const amber = ranked.some(a => a.level === 'look' && !a.repo.watching);
  return { value: watchersValue(watching, indexed.length), fraction: indexed.length === 0 ? 0 : watching / indexed.length, tone: amber ? 'amber' : 'green' };
}

/**
 * The CodeGraph clock chip: Git's chip with two meters, READ (the countdown to the next 30s poll) and WATCHERS, and a popover with Re-read status and Sync all
 * behind. It re-renders every second for the countdown. The button's name is fixed and the readings ride as its description, as Git's do, so a focused chip
 * is not re-announced every second.
 */
export default function CodegraphClockChip({ cg, ranked, runCtl, tokenMissing, writeAccess }: {
  cg: CodegraphState;
  ranked: readonly CodegraphAssessed[];
  runCtl: CodegraphRunControl;
  tokenMissing: boolean;
  writeAccess: WriteAccess | undefined;
}) {
  const [, setTicks] = useState(0);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const metersId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);

  useEffect(() => {
    const id = window.setInterval(() => setTicks(n => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const raw = syncReading({ polling: cg.polling, error: cg.error, nextPollAtMs: cg.nextPollAtMs, now: Date.now() });
  const read: MeterReading = raw.tone === 'live' ? { ...raw, value: METER_READ_READING } : raw;
  const watchers = watchersReading(ranked);
  const behind = behindRepos(ranked);
  const readOnly = writeAccess === 'none';
  const syncAllSub = behind.length === 0 ? ROW_SYNC_ALL_NONE_SUB : readOnly ? READ_ONLY_TEXT : tokenMissing ? ROW_SYNC_ALL_NEEDS_TOKEN_SUB : rowSyncAllSub(behind.length);
  const syncAllWarn = behind.length > 0 && (readOnly || tokenMissing);
  const syncAllOff = behind.length === 0 || readOnly || tokenMissing || runCtl.pendingKey !== null;

  return (
    <div className="git-clock-root" ref={root}>
      <button
        type="button"
        className="git-clock"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={CODEGRAPH_CLOCK_NAME}
        aria-describedby={metersId}
        onClick={() => setOpen(o => !o)}
      >
        <span className="git-clock-meters" id={metersId}>
          <GitMeter label={METER_READ} reading={read} />{' '}
          <GitMeter label={METER_WATCHERS} reading={watchers} />
        </span>
        <span className="git-clock-caret" aria-hidden="true"><Chevron /></span>
      </button>
      {open && (
        <div className="git-pop" role="dialog" aria-label={CODEGRAPH_POP_LABEL}>
          <div className="git-pop-row">
            <span className="git-pop-text">
              <span className="git-pop-name">{ROW_REREAD}</span>
              <span className="git-pop-sub">{ROW_REREAD_SUB}</span>
            </span>
            <GitMeter label={METER_READ} reading={read} />
            <button type="button" className="git-pop-key" disabled={cg.polling} onClick={cg.refresh}>{CODEGRAPH_KEY_NOW}</button>
          </div>
          <div className="git-pop-row">
            <span className="git-pop-text">
              <span className="git-pop-name">{ROW_SYNC_ALL}</span>
              <span className={syncAllWarn ? 'git-pop-sub warn' : 'git-pop-sub'}>{syncAllSub}</span>
            </span>
            <span aria-hidden="true" />
            <button
              type="button"
              className="git-pop-key"
              disabled={syncAllOff}
              onClick={() => void runCtl.runAll(behind.map(a => ({ dirName: a.repo.dirName, name: a.repo.name })))}
            >
              {CODEGRAPH_KEY_NOW}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
