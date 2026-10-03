import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { UsageHistoryResponse, UsageHistoryWindow } from '../../../../shared/types';
import { useUsageHistory } from '../../hooks/useUsageHistory';
import { dayTicks, historyFigures, stepPath } from '../../lib/usageHistory';
import type { StatTile } from '../../lib/usageProfile';
import { RowHead, Sheet, StatStrip } from './Sheet';

/**
 * Usage → History: the 5-hour and weekly windows as they were recorded on this machine, over a chosen range, with every stretch nothing was recording
 * drawn as a gap rather than bridged. Backward-looking, where Forecast walks forward and the duty-cycle heatmap holds activity, not utilization.
 *
 * The chart is hand-drawn SVG at the measured pixel width, so strokes stay crisp at phone width without a chart dependency.
 */

const RANGES = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' }
] as const;

const PANEL_H = 110;
const LABEL_H = 22;
const AXIS_H = 22;
const LEFT = 36;
const RIGHT = 8;
const PANEL_GAP = 14;
const CHART_H = LABEL_H + PANEL_H + PANEL_GAP + LABEL_H + PANEL_H + AXIS_H;

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
    { key: 'recorded', label: 'Recorded', value: String(fig.coverage), unit: '%', sub: `of the last ${rangeLabel(history.days)}` },
    { key: 'windows', label: '5h windows', value: String(fig.windows), sub: 'distinct resets seen' },
    { key: 'limit', label: 'Hit 100%', value: String(fig.atLimit), sub: '5-hour windows at the limit', warn: fig.atLimit > 0 },
    fig.weeklyPeak === null
      ? { key: 'weekly', label: 'Weekly peak', value: '—', sub: 'no weekly reading in range' }
      : { key: 'weekly', label: 'Weekly peak', value: fmtPct(fig.weeklyPeak), unit: '%', sub: 'highest weekly reading' }
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

function Chart({ history }: { history: UsageHistoryResponse }) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const hatchId = useId();
  const { sinceT, nowT } = history;
  const span = Math.max(1, nowT - sinceT);
  const w = Math.max(width, LEFT + RIGHT + 1);
  const x = (t: number) => LEFT + ((t - sinceT) / span) * (w - LEFT - RIGHT);
  const top5 = LABEL_H;
  const topW = LABEL_H + PANEL_H + PANEL_GAP + LABEL_H;
  const yIn = (panelTop: number) => (pct: number) => panelTop + PANEL_H * (1 - Math.min(100, Math.max(0, pct)) / 100);
  const ticks = dayTicks(sinceT, nowT, -new Date().getTimezoneOffset());
  const tickFmt: Intl.DateTimeFormatOptions = history.days > 14 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' };

  const panel = (title: string, panelTop: number, windows: UsageHistoryWindow[], cls: string) => {
    const y = yIn(panelTop);
    return (
      <g>
        <text className="usg-hist-ptitle" x={LEFT} y={panelTop - 7}>{title}</text>
        {[0, 50, 100].map(g => (
          <g key={g}>
            <line className={g === 0 ? 'usg-hist-base' : 'usg-hist-grid'} x1={LEFT} x2={w - RIGHT} y1={y(g)} y2={y(g)} />
            {g > 0 && <text className="usg-hist-ylab" x={LEFT - 6} y={y(g) + 4}>{g}%</text>}
          </g>
        ))}
        {windows.flatMap((win, wi) => win.segments.map((seg, si) => (
          seg.length === 1
            ? <circle key={`${wi}-${si}`} className={`usg-hist-dot ${cls}`} cx={x(seg[0].t)} cy={y(seg[0].pct)} r={2} />
            : <path key={`${wi}-${si}`} className={`usg-hist-line ${cls}`} d={stepPath(seg, x, y)} />
        )))}
      </g>
    );
  };

  return (
    <div className="usg-hist-chart" ref={boxRef}>
      {width > 0 && (
        <svg width={w} height={CHART_H} role="img" aria-label="5-hour and weekly utilization over time">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="usg-hist-hatch" x1="0" y1="0" x2="0" y2="6" />
            </pattern>
          </defs>
          {history.gaps.map(gap => (
            <rect
              key={gap.fromT}
              className="usg-hist-gap"
              x={x(gap.fromT)}
              y={top5}
              width={Math.max(1, x(gap.toT) - x(gap.fromT))}
              height={topW + PANEL_H - top5}
              fill={`url(#${hatchId})`}
            />
          ))}
          {panel('5-hour window', top5, history.fiveHour, 'five')}
          {panel('Weekly window', topW, history.weekly, 'wk')}
          {ticks.map(t => (
            <g key={t}>
              <line className="usg-hist-tick" x1={x(t)} x2={x(t)} y1={topW + PANEL_H} y2={topW + PANEL_H + 4} />
              <text className="usg-hist-xlab" x={x(t)} y={topW + PANEL_H + 16}>
                {new Date(t).toLocaleDateString(undefined, tickFmt)}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

export function UsageHistory() {
  const [days, setDays] = useState(7);
  const { history, loading, error } = useUsageHistory(days);

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
        <RowHead title="Utilization over time" sub="Each reading is held flat until the next one · a new tooth is a new window" />
        <Chart history={history} />
        <div className="usg-hist-legend">
          <span><i className="usg-hist-sw five" />5-hour</span>
          <span><i className="usg-hist-sw wk" />weekly</span>
          <span><i className="usg-hist-sw gap" />not recorded</span>
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
