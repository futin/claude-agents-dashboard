import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { FetchClock } from '../../../../shared/types';
import type { GitFetchControl } from '../../hooks/useGitFetch';
import type { GitStatsState } from '../../hooks/useGitStats';
import { createFollowTracker, fetchKeyState, fetchReading, followUp, syncReading, type MeterReading } from '../../lib/gitClock';
import {
  GIT_CLOCK_NAME, GIT_POP_LABEL, KEY_NOW, METER_FETCH, METER_NEXT, METER_SYNC, ROW_FETCH_ALL, ROW_LOCAL_SYNC, SYNC_ROW_FAILED_SUB, SYNC_ROW_SUB, gitTroubleLines,
} from '../../lib/gitStatsText';
import { useDismiss } from '../Popover';

/** The chip's and the popover rows' bar: label over value, a flat track, the fill's width inline. The tone is the root's `data-tone`. */
function GitMeter({ label, reading }: { label: string; reading: MeterReading }) {
  return (
    <span className="git-meter" data-tone={reading.tone}>
      <span className="git-meter-head">
        <span className="git-meter-label">{label}</span>{' '}
        <span className="git-meter-value">{reading.value}</span>
      </span>
      <span className="git-meter-track" aria-hidden="true">
        <span className="git-meter-fill" style={{ width: `${reading.fraction * 100}%` }} />
      </span>
    </span>
  );
}

/**
 * The Sync and Fetch clocks (git-fetch spec §4): one chip holding two meters, and the popover with each clock's row and key. It re-renders every second
 * while mounted, as the band's "updated Ns ago" did, and that tick is also what notices a fetch has come due — the early poll below is armed from it.
 *
 * **Name versus description.** The button's name is fixed and the readings ride as its description: a name that changed every second would be re-announced
 * every second for as long as the chip held focus.
 */
export default function GitClockChip({ stats, fetchCtl, tokenRequired, clock }: {
  stats: GitStatsState;
  fetchCtl: GitFetchControl;
  tokenRequired: boolean | undefined;
  /** The payload's fetch clock; undefined before one arrives or from an older server, which the meters read as pending. */
  clock: FetchClock | undefined;
}) {
  const [ticks, setTicks] = useState(0);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const metersId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(root, open, close);

  useEffect(() => {
    const id = window.setInterval(() => setTicks(n => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // The early poll: a fetch due or running is asked about again in a few seconds rather than at the next 30s tick. The timer is not cleared when the effect
  // re-runs on the next tick — the tracker has already spent that key, so cancelling it would lose the follow-up for good. A newer key under the same prefix
  // replaces its predecessor; everything goes at unmount.
  const tracker = useMemo(createFollowTracker, []);
  const timers = useRef(new Map<string, number>());
  const generatedAt = stats.data?.generatedAt;
  useEffect(() => {
    if (generatedAt === undefined) return;
    const f = followUp({ clock, generatedAt, skewMs: stats.skewMs, now: Date.now(), visible: document.visibilityState === 'visible' });
    if (f === null || !tracker.arm(f.key)) return;
    const prefix = f.key.slice(0, f.key.indexOf(':'));
    window.clearTimeout(timers.current.get(prefix));
    timers.current.set(prefix, window.setTimeout(() => {
      timers.current.delete(prefix);
      if (document.visibilityState === 'visible') stats.refresh();
    }, f.delayMs));
  }, [ticks, clock, generatedAt, stats.skewMs, stats.refresh, tracker]);
  useEffect(() => () => { for (const id of timers.current.values()) window.clearTimeout(id); }, []);

  const now = Date.now();
  const sync = syncReading({ polling: stats.polling, error: stats.error, nextPollAtMs: stats.nextPollAtMs, now });
  const fetched = fetchReading({ clock, ownPost: fetchCtl.pending, skewMs: stats.skewMs, now });
  const key = fetchKeyState({
    tokenRequired, tokenStored: fetchCtl.tokenStored, failure: fetchCtl.failure, pending: fetchCtl.pending,
    running: clock?.runningSinceMs != null, intervalSecs: clock?.intervalSecs,
  });
  const trouble = gitTroubleLines(stats.data?.repos ?? [], clock);

  return (
    <div className="git-clock-root" ref={root}>
      <button
        type="button"
        className="git-clock"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={GIT_CLOCK_NAME}
        aria-describedby={metersId}
        onClick={() => setOpen(o => !o)}
      >
        {/* The spaces keep the description `SYNC 12s FETCH 3:12`; `.git-clock-meters` is flex, so they render as nothing. */}
        <span className="git-clock-meters" id={metersId}>
          <GitMeter label={METER_SYNC} reading={sync} />{' '}
          <GitMeter label={METER_FETCH} reading={fetched} />
        </span>
        <span className="git-clock-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="git-pop" role="dialog" aria-label={GIT_POP_LABEL}>
          <div className="git-pop-row">
            <span className="git-pop-text">
              <span className="git-pop-name">{ROW_LOCAL_SYNC}</span>
              <span className={stats.error ? 'git-pop-sub warn' : 'git-pop-sub'}>{stats.error ? SYNC_ROW_FAILED_SUB : SYNC_ROW_SUB}</span>
            </span>
            <GitMeter label={METER_NEXT} reading={sync} />
            {/* Disabled mid-poll, as the band's ↻ was a no-op then; the queue serves the refresh after a POST, not this key. */}
            <button type="button" className="git-pop-key" disabled={stats.polling} onClick={stats.refresh}>{KEY_NOW}</button>
          </div>
          <div className="git-pop-row">
            <span className="git-pop-text">
              <span className="git-pop-name">{ROW_FETCH_ALL}</span>
              <span className={key.subTone === 'amber' ? 'git-pop-sub warn' : 'git-pop-sub'}>{key.sub}</span>
            </span>
            <GitMeter label={METER_NEXT} reading={fetched} />
            <button type="button" className="git-pop-key" disabled={key.disabled} onClick={fetchCtl.start}>{key.label}</button>
          </div>
          {trouble.length > 0 && (
            <div className="git-trouble">
              {trouble.map(t => (
                <span key={t.dirName} className="git-trouble-row">
                  <span className="git-trouble-name">{t.name}</span> <span className="git-trouble-word">{t.word}</span> · {t.age}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
