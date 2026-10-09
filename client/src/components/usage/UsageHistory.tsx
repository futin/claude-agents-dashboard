import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { UsageHistoryResponse } from '../../../../shared/types';
import type { TipHandlers } from '../../hooks/useFloatingTip';
import { useFloatingTip } from '../../hooks/useFloatingTip';
import { useUsageHistory } from '../../hooks/useUsageHistory';
import { historyFigures, weekRows } from '../../lib/usageHistory';
import type { WeekDay, WeekRow } from '../../lib/usageHistory';
import type { StatTile } from '../../lib/usageProfile';
import { RowHead, Sheet, StatStrip } from './Sheet';

/**
 * Usage → History: one bar per weekly window as it was recorded on this machine, over a chosen range, filled day by day; the right edge is the weekly
 * limit. Backward-looking, where Forecast walks forward and the duty-cycle heatmap holds activity, not utilization.
 *
 * The chart is hand-drawn SVG at the measured pixel width, so strokes stay crisp at phone width without a chart dependency. The rows and their
 * day segments come from `weekRows`; this file only draws them.
 */

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' }
] as const;

const ROW_H = 26;
const ROW_GAP = 24;
const TOP = 30;
/** The label columns left and right of the track; the phone gets slimmer ones so the track keeps room. */
const WIDE = { left: 128, right: 132 };
const NARROW = { left: 76, right: 84 };
const NARROW_BELOW = 560;
/** A day label needs this much segment; the pre segment's `earlier` needs more. */
const DAY_LABEL_MIN_PX = 30;
const PRE_LABEL_MIN_PX = 44;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function fmtPct(pct: number): string {
  return `${Math.round(pct * 10) / 10}`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function rangeLabel(days: number): string {
  return RANGES.find(r => r.days === days)?.label ?? `${days}d`;
}

function historyTiles(history: UsageHistoryResponse): StatTile[] {
  const fig = historyFigures(history);
  return [
    { key: 'recorded', label: 'Recorded', value: `${fig.coverage}%`, sub: `of the last ${rangeLabel(history.days)}` },
    { key: 'windows', label: '5h windows', value: String(fig.windows), sub: 'distinct resets seen' },
    { key: 'limit', label: 'Hit 100%', value: String(fig.atLimit), sub: '5-hour windows at the limit', warn: fig.atLimit > 0 },
    fig.weeklyPeak === null
      ? { key: 'weekly', label: 'Weekly peak', value: '—', sub: 'no weekly reading in range' }
      : { key: 'weekly', label: 'Weekly peak', value: `${fmtPct(fig.weeklyPeak)}%`, sub: 'highest weekly reading' }
  ];
}

/** Measured width of an element, following resizes. */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** `2h`, or `1.5d` from a day up; never under `1h`. */
function fmtDur(ms: number): string {
  return ms >= DAY_MS ? `${Math.round((ms / DAY_MS) * 10) / 10}d` : `${Math.max(1, Math.round(ms / HOUR_MS))}h`;
}

const fmtDay = (ms: number, long: boolean) =>
  new Date(ms).toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' });
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function dayTip(row: WeekRow, day: WeekDay): string {
  const gain = day.toPct - day.fromPct;
  const from = row.prePct > 0 && day.fromT === row.firstT ? ` from ${fmtClock(day.fromT)}` : '';
  const off = day.offMs > 0 ? `\nincludes ${fmtDur(day.offMs)} not recorded — use from those hours lands here` : '';
  return `${fmtDay(day.fromT, true)}${from}\n+${fmtPct(gain)}% of the week · ${fmtPct(day.toPct)}% by the end of the day${off}`;
}

function preTip(row: WeekRow, rangeText: string): string {
  const when = row.preCause === 'range' ? `the ${rangeText} range opens` : 'recording picked this week up';
  return `before this range\n${fmtPct(row.prePct)}% of the week was already spent when ${when}`;
}

function WeekFill({ history, tip }: { history: UsageHistoryResponse; tip: (text: string) => TipHandlers }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const hatchId = useId();
  const rows = weekRows(history, -new Date().getTimezoneOffset());
  const { left: L, right: R } = width < NARROW_BELOW ? NARROW : WIDE;
  const w = Math.max(width, L + R + 1);
  const pw = w - L - R;
  const x = (pct: number) => L + (Math.min(100, Math.max(0, pct)) / 100) * pw;
  const H = TOP + rows.length * (ROW_H + ROW_GAP) - ROW_GAP + 8;
  const rangeText = rangeLabel(history.days);
  const mid = ROW_H / 2 + 4;

  const day = (row: WeekRow, d: WeekDay, di: number, y: number) => {
    const text = dayTip(row, d);
    const sx = x(d.fromPct) + (d.fromPct > 0 ? 1 : 0);
    const sw = Math.max(1.5, x(d.toPct) - x(d.fromPct) - (d.fromPct > 0 ? 2 : 1));
    return (
      <g key={d.fromT}>
        <rect className={`usg-wf-seg ${di % 2 ? 'b' : 'a'}`} x={sx} y={y} width={sw} height={ROW_H} rx={3} tabIndex={0} aria-label={text.replace(/\n/g, ' — ')} {...tip(text)} />
        {d.offMs > 0 && <rect x={sx} y={y} width={sw} height={ROW_H} rx={3} fill={`url(#${hatchId})`} pointerEvents="none" />}
        {sw >= DAY_LABEL_MIN_PX && <text className="usg-wf-day" x={sx + sw / 2} y={y + mid}>{new Date(d.fromT).toLocaleDateString(undefined, { weekday: 'short' })}</text>}
      </g>
    );
  };

  const rowEl = (row: WeekRow, i: number) => {
    const y = TOP + i * (ROW_H + ROW_GAP);
    const preW = Math.max(1.5, x(row.prePct) - L - 1);
    // No previous reset means the week's start is unknown: say where the record starts, not a date that reads as the start.
    const title = row.current ? 'This week' : row.resetsAtMs === null ? 'Unscoped' : row.startT === null ? `from ${fmtDate(row.firstT)}` : fmtDate(row.startT);
    const hits = row.limitHits;
    return (
      <g key={row.key}>
        <rect className="usg-wf-track" x={L} y={y} width={pw} height={ROW_H} rx={4} />
        {row.prePct > 0 && (
          <>
            <rect className="usg-wf-seg pre" x={L} y={y} width={preW} height={ROW_H} rx={3} tabIndex={0} aria-label={preTip(row, rangeText).replace(/\n/g, ' — ')} {...tip(preTip(row, rangeText))} />
            {preW >= PRE_LABEL_MIN_PX && <text className="usg-wf-day" x={L + preW / 2} y={y + mid}>earlier</text>}
          </>
        )}
        {row.days.map((d, di) => day(row, d, di, y))}
        <text className="usg-wf-lab" x={L - 12} y={y + 11}>{title}</text>
        <text className="usg-wf-sub" x={L - 12} y={y + 24}>{row.resetsAtMs === null ? 'no reset stamp' : `resets ${fmtDay(row.resetsAtMs, false)}`}</text>
        <text className="usg-wf-peak" x={w - R + 12} y={y + 13}>{fmtPct(row.peakPct)}%{row.current ? ' so far' : ''}</text>
        <text className="usg-wf-sub start" x={w - R + 12} y={y + 26}>{hits > 0 ? `${hits} × 5h limit hit` : 'no 5h limit hit'}</text>
      </g>
    );
  };

  return (
    <div className="usg-wf" ref={boxRef}>
      {width > 0 && (
        <svg width={w} height={H} role="img" aria-label="Each weekly window filled day by day">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="usg-wf-hatch" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          {[0, 25, 50, 75, 100].map(p => (
            <g key={p}>
              <line className={p === 100 ? 'usg-wf-limit' : 'usg-wf-grid'} x1={x(p)} x2={x(p)} y1={TOP - 6} y2={H} />
              <text className={`usg-wf-axis${p === 100 ? ' lim' : ''}`} x={x(p)} y={TOP - 12}>{p === 100 ? 'limit' : `${p}%`}</text>
            </g>
          ))}
          {rows.map(rowEl)}
        </svg>
      )}
    </div>
  );
}

export function UsageHistory() {
  const [days, setDays] = useState(7);
  const { history, loading, error } = useUsageHistory(days);
  const { tipRef, tipHandlers } = useFloatingTip();

  const rangeSwitch = (
    <div className="seg usg-hist-range" role="group" aria-label="History range">
      {RANGES.map(r => (
        <button key={r.days} className={r.days === days ? 'on' : ''} aria-pressed={r.days === days} onClick={() => setDays(r.days)}>
          {r.label}
        </button>
      ))}
    </div>
  );

  if (!history) {
    return (
      <div className="up">
        {rangeSwitch}
        <p className="note">{loading ? 'reading the usage history…' : error ? 'The usage history could not be read.' : null}</p>
      </div>
    );
  }

  const hasData = history.fiveHour.length > 0 || history.weekly.length > 0;
  const lastT = history.fiveHour.reduce((last, win) => Math.max(last, win.lastT), 0);
  const weeklyRows = [...history.weekly].reverse();

  return (
    <div className="up">
      <div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />
      {rangeSwitch}

      {history.error && <p className="note">The usage history could not be read.</p>}

      {!history.recording && !hasData && (
        <div className="up-off">
          Usage recording is <b>off</b>, so nothing has been recorded. Turn on <b>Record usage history</b> in Settings — the history fills in from
          the next sample.
        </div>
      )}
      {!history.recording && hasData && lastT > 0 && (
        <p className="note">Recording is off — the history ends at {fmtWhen(lastT)}.</p>
      )}

      <StatStrip tiles={historyTiles(history)} />

      <Sheet>
        <RowHead
          title="Utilization over time"
          sub="One bar per weekly window, filled day by day · the right edge is the weekly limit, so a full bar is a week you ran out"
        />
        {history.weekly.length === 0 ? (
          <p className="note">No weekly reading was recorded in this range.</p>
        ) : (
          <WeekFill history={history} tip={tipHandlers} />
        )}
        <div className="usg-hist-legend">
          <span><i className="usg-hist-sw a" /><i className="usg-hist-sw b" />one day's share of the week</span>
          <span><i className="usg-hist-sw pre" />spent before the range starts</span>
          <span><i className="usg-hist-sw lim" />the weekly limit</span>
          <span><i className="usg-hist-sw off" />holds hours nothing was recording</span>
        </div>
      </Sheet>

      <Sheet>
        <RowHead title="Weekly windows" sub="Newest first · peak is the highest weekly reading recorded in range" />
        {weeklyRows.length === 0 ? (
          <p className="note">No weekly reading was recorded in this range.</p>
        ) : (
          <table className="dt">
            <thead>
              <tr>
                <th scope="col">Resets at</th>
                <th scope="col">Recorded from</th>
                <th scope="col" className="n">Peak</th>
              </tr>
            </thead>
            <tbody>
              {weeklyRows.map(win => {
                const resets = win.resetsAt === null ? NaN : Date.parse(win.resetsAt);
                return (
                  <tr key={`${win.resetsAt}-${win.firstT}`}>
                    <td>{Number.isNaN(resets) ? 'unscoped' : fmtWhen(resets)}</td>
                    <td>{fmtWhen(win.firstT)}</td>
                    <td className="n">{fmtPct(win.peakPct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Sheet>
    </div>
  );
}
