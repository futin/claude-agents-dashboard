import { useCallback, useEffect, useRef, useState } from 'react';

import type { ForecastConfidence, UsageProfileCell, UsageProfileResponse } from '../../../../shared/types';
import { useUsageProfile } from '../../hooks/useUsageProfile';
import { fmtObserved, nextWeekStartMs, profileProgress, TRUST_FLOOR_MIN } from '../../lib/usageProfile';
import {
  absentText, areaPath, crossingX, dayTicks, fmtWalkHour, hitRect, hourOfWeekLocal,
  pctX, pctY, pointsAttr, splitRuns, stepTitle, VIEW_H, walkPoints, walkWidth, Y_MAX, yOf
} from '../../lib/walkChart';

/**
 * The duty-cycle profile inspector — a 24×7 hour-of-week heatmap over the
 * learned weights, plus the forward walk that produced the current weekly
 * projection.
 *
 * **Why this exists.** The forecast silently changes a number the user acts on,
 * using a model built in the background. Without an inspector a wrong
 * projection is undebuggable — the only recourse is reading `.usage-profile.json`
 * by hand. The 168 weights *are* the explanation. This is disclosure, not
 * decoration.
 *
 * Design notes that are deliberate, not incidental:
 *
 * - **Hours as rows, days as columns.** The axis needing 24 slots runs the
 *   direction a phone actually has.
 * - **One hue, five steps, derived with `color-mix`.** A grid of magnitudes is a
 *   sequential scale, so never a multi-hue ramp; and five themes × five steps is
 *   25 hex values nobody can validate, whereas
 *   `color-mix(in oklab, var(--cyan) N%, var(--strip))` is monotonic by
 *   construction and cannot violate the no-hardcoded-color rule.
 * - **Evidence is texture, not a sixth colour step.** An untrusted cell has *no
 *   value*, not a low one. Hue-coding confidence would read as a rainbow ramp
 *   and put confidence on the same scale as weight, which it isn't.
 * - **A cell is one hour *of the week*, and evidence accumulates across weeks.**
 *   Monday 09:00 and Tuesday 09:00 are different cells; nothing is averaged
 *   across days. A cell can gather at most 60 minutes per week, so the tooltip
 *   states evidence in *weeks* — "300 min observed" on a one-hour cell reads as
 *   a contradiction.
 * - **The table view is required, not a nicety.** The two lowest ramp steps fall
 *   below 3:1 against the card surface, and that obligates a non-colour path to
 *   the same numbers.
 * - **A real tooltip element, not the `title` attribute.** `title` is drawn by
 *   browser chrome, needs a dwell, and — the reason that settles it — never
 *   fires on touch. This dashboard is read from a phone, so `title` put the
 *   per-cell evidence out of reach on the device that matters most. The floating
 *   element here answers hover, press (pointerenter fires on touch-down, so
 *   press-and-hold inspects a cell), and keyboard focus, and it is written with
 *   `textContent` + `white-space: pre-line` rather than any innerHTML.
 * - **Square cells, at the mockup's proportions, one size down.**
 *   `aspect-ratio: 1` is what makes this read as a calendar rather than a bar
 *   chart lying down. The mockup's variant C is 320px wide → 38.84px cells →
 *   992px tall; this uses 250px → ~28px cells → ~730px, which keeps the shape
 *   and brings the week within about one screen. `max-width` on `.up-grid` is
 *   the single knob: the columns are `1fr` and the cells are square, so width
 *   sets the cell size and therefore the height.
 * - **Every hour carries a label, not every second one.** Labelling alternate
 *   rows put the axis's only vertical rhythm cue at *twice* the row pitch, and
 *   the eye chunked the rows into pairs and read each pair boundary as a wider
 *   gap. The geometry was never uneven — measured at DPR 2, every row boundary
 *   snapped to exactly 32 device pixels — so this is a fix to a Gestalt
 *   artefact, and labelling every row removes the offending rhythm rather than
 *   hiding it. Labelling every 6th hour also removes it, but then an hour can
 *   only be identified by counting rows.
 *
 * Reference: `docs/guides/mockups/usage-profile-heatmap-mockups.html`, variant C.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Which of the five ramp steps a weight lands on.
 *
 * A weight of zero gets **no** step: it is a bare bordered cell, because "you
 * never work this hour" is a different statement from "you work 15% of it", and
 * a five-step ramp starting at 0 would render both as q1. Three visually
 * distinct states, which is the point: empty = measured idle, hatched = no
 * evidence, filled = measured active.
 */
function stepOf(weight: number): string {
  if (weight <= 0.02) return '';           // measured idle — the bare track
  if (weight <= 0.2) return 'q1';
  if (weight <= 0.4) return 'q2';
  if (weight <= 0.6) return 'q3';
  if (weight <= 0.8) return 'q4';
  return 'q5';
}

const CONFIDENCE_TEXT: Record<ForecastConfidence, string> = {
  none: 'no learned hours yet — the forecast is still the flat-rate one',
  thin: 'thin — expected for the first couple of weeks; the shape is still moving',
  ok: 'enough evidence to lead with'
};

/** The tooltip for one cell. Wording matters here — see the module docstring. */
function cellTitle(cell: UsageProfileCell, day: number, hour: number): string {
  const when = `${DAYS[day]} ${String(hour).padStart(2, '0')}:00 · every week`;
  const weeks = cell.observedMin / 60;
  if (cell.weight == null) {
    return (
      `${when}\nno evidence yet\n${Math.round(cell.observedMin)} of ${TRUST_FLOOR_MIN} min needed\n` +
      'falls back to the weekly mean'
    );
  }
  const evidence = weeks >= 2
    ? `${Math.round(weeks)} weeks of evidence`
    : `${Math.round(cell.observedMin)} of ${TRUST_FLOOR_MIN} min — under one week`;
  const stale = cell.staleWeeks > 8 ? `\nlast seen ${cell.staleWeeks} weeks ago` : '';
  const level = cell.weight <= 0.02
    ? 'never active — measured, not missing'
    : `${Math.round(cell.weight * 100)}% active`;
  return `${when}\n${level}\n${evidence}${stale}`;
}

/**
 * What the profile has so far, and which gate it is waiting on.
 *
 * Without this the inspector's first week is 168 identical hatched cells and no
 * sign that recording works — which reads as broken rather than as early. The
 * grid itself stays honest (evidence is texture, never a colour step); this says
 * in words what the texture cannot.
 */
function RecordingStatus({ cells, recording }: { cells: UsageProfileCell[]; recording: boolean }) {
  const { touched, totalMin, atFloor, trusted } = profileProgress(cells);
  if (!recording && touched === 0) return null;   // the `.up-off` block says it all

  const monday = new Date(nextWeekStartMs(Date.now()));
  const when = monday.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="up-status">
      <span>{touched} of 168 hours observed</span>
      <span>{fmtObserved(totalMin)} recorded</span>
      {trusted > 0 ? (
        <span>{trusted} carrying a weight</span>
      ) : atFloor > 0 ? (
        <span className="up-status-wait">
          {atFloor} {atFloor === 1 ? 'hour has' : 'hours have'} enough evidence — weights appear
          when the week rolls over on {when}
        </span>
      ) : (
        <span className="up-status-wait">
          no weights yet — an hour needs {TRUST_FLOOR_MIN} min of evidence, and the first fold
          happens when the week rolls over on {when}
        </span>
      )}
    </div>
  );
}

/**
 * The handler bundle {@link UsageProfile.tipHandlers} hands a hoverable mark.
 *
 * Typed against `Element`, not `HTMLElement`: the same bundle is spread onto the
 * heatmap's `<div>` cells and the strip's `<rect>` hit columns.
 */
interface TipHandlers {
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onFocus: (e: React.FocusEvent<Element>) => void;
  onBlur: () => void;
}

/**
 * The forward walk, as a cumulative climb to a 100% ceiling.
 *
 * Design notes that are deliberate, not incidental:
 *
 * - **The y axis is the cumulative window percentage, not the per-hour gain.**
 *   The panel exists to answer "when does the weekly window hit 100%". A
 *   per-hour bar chart makes the reader integrate 117 bars to get there; a
 *   climbing curve puts the answer at the intersection with the ceiling. The
 *   per-hour auditing a bar chart is good at is already done better by the 24×7
 *   heatmap directly above — the old strip was competing with its own card.
 * - **Solid = measured, dashed = assumed. The curve's *height* is unchanged.**
 *   Not a reversal of the encoding, a split of it: the forecast genuinely counts
 *   an unlearned hour at `globalMean`, and that pessimistic edge is deliberate.
 *   Only the ink says which hours are a measurement. With no learned buckets at
 *   all the whole line is dashed — which is the honest picture, and the reason
 *   the old "the visible gap across the weekend" note had to go: it narrated a
 *   profile the reader did not have.
 * - **One SVG with a `viewBox`, `preserveAspectRatio="none"` and
 *   `vector-effect: non-scaling-stroke`.** The flexbox strip gave every bar a
 *   fractional CSS width, and the compositor rounded each bar's two edges to
 *   device pixels independently — a ±1px swing between neighbours that no CSS
 *   tuning can remove, because the rounding is per element. One coordinate
 *   space scaled uniformly removes it structurally instead.
 * - **Text lives outside the SVG.** `preserveAspectRatio="none"` stretches
 *   everything it paints, glyphs included, so every label is an HTML overlay
 *   positioned by percentage.
 * - **Full-height hit columns, and a real tooltip element.** A hit area on the
 *   line itself is a mouse-only affordance; `title` never fires on touch. Both
 *   matter more than usual here — this is read from a phone.
 */
function WalkStrip({ walk, exhaustAt, walkAbsent, globalMean, cells, tipHandlers }: {
  walk: UsageProfileResponse['walk'];
  exhaustAt: string | null;
  walkAbsent: UsageProfileResponse['walkAbsent'];
  globalMean: number;
  cells: UsageProfileCell[];
  tipHandlers: (text: string) => TipHandlers;
}) {
  const n = walk.length;
  const w = walkWidth(n);
  const runs = splitRuns(walk);
  const points = walkPoints(walk);
  const cross = crossingX(walk);
  const ticks = dayTicks(walk);
  const ceiling = yOf(100);

  return (
    <div className="up-walk">
      <div className="up-walkmeta">
        <span>the walk behind the current weekly projection</span>
        {n > 0 && (
          <span className={exhaustAt ? 'up-hit' : undefined}>
            {exhaustAt ? `hits 100% ${fmtWalkHour(exhaustAt)}` : 'coasts to the reset'}
          </span>
        )}
      </div>

      {n === 0 ? (
        // Never an unmounted section: idle is a normal state, and a panel that
        // vanishes reads as a broken feature rather than as nothing to draw.
        <p className="up-note">{absentText(walkAbsent ?? 'no-window')}</p>
      ) : (
        <>
          <div className="up-chartwrap">
            <svg
              className="up-chart"
              viewBox={`0 0 ${w} ${VIEW_H}`}
              preserveAspectRatio="none"
              focusable="false"
            >
              {ticks.filter(t => t.kind === 'day').map(t => (
                <line key={t.x} className="up-daytick" x1={t.x} x2={t.x} y1={0} y2={VIEW_H} />
              ))}
              <line className="up-ceiling" x1={0} x2={w} y1={ceiling} y2={ceiling} />
              <path className="up-area" d={areaPath(points)} />
              {/* After the area, before the line: a wash faint enough not to bury
                  the curve is also too faint to survive being painted under the
                  area fill. */}
              {cross !== null && (
                <rect className="up-dead" x={cross} y={0} width={w - cross} height={VIEW_H} />
              )}
              {runs.map((run, i) => (
                <polyline
                  key={i}
                  className={`up-line${run.learned ? '' : ' assumed'}`}
                  points={pointsAttr(run.points)}
                />
              ))}
              {cross !== null && (
                <line className="up-cross" x1={cross} x2={cross} y1={0} y2={VIEW_H} />
              )}
              {walk.map((step, i) => {
                const rect = hitRect(i, n);
                const text = stepTitle(step, cells[hourOfWeekLocal(step.t)]);
                return (
                  <rect
                    key={step.t}
                    className="up-hit-col"
                    x={rect.x}
                    y={0}
                    width={rect.w}
                    height={VIEW_H}
                    role="img"
                    tabIndex={0}
                    aria-label={text.replace(/\n/g, ' — ')}
                    {...tipHandlers(text)}
                  />
                );
              })}
            </svg>
            <span className="up-ceillab" style={{ top: `${pctY(ceiling)}%` }}>100%</span>
            {/* `now` sits in the chart's top-left corner rather than in the day
                row: the first midnight can be one hour away, and a centred day
                label that close to x=0 lands straight on top of it. The corner
                is empty by construction — the curve starts at the window's
                current utilization, never at the ceiling. */}
            <span className="up-nowlab">now</span>
            {cross !== null && exhaustAt && (
              <span className="up-crosslab" style={{ left: `${pctX(cross, n)}%` }}>
                {fmtWalkHour(exhaustAt)}
              </span>
            )}
          </div>
          <div className="up-days">
            {ticks.filter(t => t.kind === 'day').map(t => (
              <span key={t.x} className="up-daylab" style={{ left: `${pctX(t.x, n)}%` }}>
                {t.label}
              </span>
            ))}
          </div>
          <p className="up-note">
            Cumulative window use from now to the weekly reset.{' '}
            <span className="up-key"><i className="up-key-solid" /> solid</span> hours are walked
            with a measured weight;{' '}
            <span className="up-key"><i className="up-key-dash" /> dashed</span> hours have no
            evidence for that hour of the week yet and fall back to the{' '}
            {Math.round(globalMean * 100)}% weekly mean — the same height, a weaker claim. The
            scale stops at {Y_MAX}%: past the ceiling, everything is equally over.
          </p>
        </>
      )}
    </div>
  );
}

export function UsageProfile() {
  const { profile, loading, error } = useUsageProfile();
  const [showTable, setShowTable] = useState(false);

  // Written to directly rather than through state: a pointermove that re-rendered
  // 168 cells to move one box would be absurd.
  const tipRef = useRef<HTMLDivElement>(null);
  /** The mark a *keyboard*-shown tooltip belongs to; null when pointer-shown. */
  const anchorRef = useRef<Element | null>(null);

  const placeTip = useCallback((x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    // Measure from the origin, never from wherever the panel was last left.
    // It is `position: fixed` with no `right`, so the viewport edge caps its
    // available width: measured while sitting near the right edge it reports a
    // *narrower* box than it will occupy once moved, and the clamp below then
    // lets it hang off the screen by the difference.
    tip.style.left = '0px';
    tip.style.top = '0px';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - w - 8)) + 'px';
    // Above the mark by default, not below. Whatever is pointing at it sits
    // underneath — a cursor a little, a finger a lot — so the space below is
    // both occluded and the half far more likely to run off the bottom of the
    // screen. Drop under only when there is no room above, and clamp either
    // way so the panel can never leave the viewport.
    const above = y - h - 14;
    const below = Math.min(y + 18, window.innerHeight - h - 8);
    tip.style.top = Math.max(8, above >= 8 ? above : below) + 'px';
  }, []);

  const showTip = useCallback((text: string, x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    tip.textContent = text;   // never innerHTML; the CSS keeps the newlines
    tip.style.opacity = '1';
    placeTip(x, y);
  }, [placeTip]);

  const hideTip = useCallback(() => {
    const tip = tipRef.current;
    if (tip) tip.style.opacity = '0';
  }, []);

  // A shown tooltip is positioned in viewport coordinates, so a scroll would
  // strand it — the panel holding still while the mark slides out from under it.
  // `capture` because the scroller is an ancestor, not the window.
  //
  // A *keyboard*-shown tooltip follows its mark instead of hiding: tabbing to an
  // off-screen cell makes the browser scroll it into view, and hiding on that
  // scroll would blank the tooltip the focus had just opened.
  useEffect(() => {
    const onScroll = () => {
      const anchor = anchorRef.current;
      if (anchor && document.activeElement === anchor) {
        const r = anchor.getBoundingClientRect();
        placeTip(r.right, r.top);
        return;
      }
      hideTip();
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', hideTip);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', hideTip);
    };
  }, [hideTip, placeTip]);

  /** Hover / press / focus handlers for one hoverable mark. */
  const tipHandlers = useCallback((text: string) => ({
    onPointerEnter: (e: React.PointerEvent) => {
      anchorRef.current = null;          // pointer-shown: a scroll should hide it
      showTip(text, e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent) => placeTip(e.clientX, e.clientY),
    onPointerLeave: hideTip,
    onPointerCancel: hideTip,
    // Keyboard: anchor to the mark itself, since there is no pointer.
    onFocus: (e: React.FocusEvent<Element>) => {
      anchorRef.current = e.currentTarget;
      const r = e.currentTarget.getBoundingClientRect();
      showTip(text, r.right, r.top);
    },
    onBlur: () => { anchorRef.current = null; hideTip(); }
  }), [showTip, placeTip, hideTip]);

  if (loading) return <div className="up-note">reading the usage profile…</div>;
  if (error || !profile) return <div className="up-note">The usage profile could not be read.</div>;

  const { cells, globalMean, confidence, recording, walk, exhaustAt, walkAbsent } = profile;
  const at = (day: number, hour: number) => cells[day * 24 + hour];

  return (
    <div className="up">
      <div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />
      <div className="up-head">
        <div>
          <h3>LEARNED HOURS</h3>
          <p className="up-sub">
            The 168 hour-of-week weights the weekly forecast walks over. Each cell is{' '}
            <em>one hour of the week</em> — Monday 09:00 is a different cell from Tuesday
            09:00, and nothing is averaged across days. What accumulates across{' '}
            <em>weeks</em> is the evidence.
          </p>
        </div>
        <button
          type="button"
          className="up-toggle"
          aria-pressed={showTable}
          onClick={() => setShowTable(v => !v)}
        >
          {showTable ? 'show grid' : 'show table'}
        </button>
      </div>

      {!recording && (
        <div className="up-off">
          Usage recording is <b>off</b>, so nothing new is being learned and the weekly
          forecast is the plain flat-rate one. Turn on <b>Record usage history</b> in
          Settings to start building a profile — it needs roughly two weeks before the
          forecast improves.
        </div>
      )}

      <RecordingStatus cells={cells} recording={recording} />

      {showTable ? (
        <div className="up-tablewrap">
          <table className="up-table">
            <thead>
              <tr>
                <th scope="col">Hour</th>
                {DAYS.map(d => <th key={d} scope="col">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 24 }, (_, hour) => (
                <tr key={hour}>
                  <th scope="row">{String(hour).padStart(2, '0')}:00</th>
                  {DAYS.map((d, day) => {
                    const c = at(day, hour);
                    return (
                      <td key={d} className={c.weight == null ? 'up-td-none' : undefined}>
                        {c.weight == null ? '—' : `${Math.round(c.weight * 100)}%`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="up-grid" style={{ gridTemplateColumns: '40px repeat(7,1fr)' }}>
          <div />
          {DAYS.map(d => <div key={d} className="up-axis">{d}</div>)}
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="up-hourrow" style={{ display: 'contents' }}>
              <div className="up-axis left">{String(hour).padStart(2, '0')}:00</div>
              {DAYS.map((d, day) => {
                const c = at(day, hour);
                return (
                  <div
                    key={d}
                    className={`up-cell ${c.weight == null ? 'unknown' : stepOf(c.weight)}`.trim()}
                    tabIndex={0}
                    aria-label={cellTitle(c, day, hour).replace(/\n/g, ' — ')}
                    {...tipHandlers(cellTitle(c, day, hour))}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="up-legend">
        <small>never</small>
        <div className="up-swatches">
          <div className="up-cell" />
          <div className="up-cell q1" /><div className="up-cell q2" /><div className="up-cell q3" />
          <div className="up-cell q4" /><div className="up-cell q5" />
        </div>
        <small>always</small>
        <div className="up-cell unknown up-legend-none" />
        <small>
          no evidence yet — falls back to the {Math.round(globalMean * 100)}% weekly mean
        </small>
        <small className="up-conf">confidence: {confidence} — {CONFIDENCE_TEXT[confidence]}</small>
      </div>

      <WalkStrip
        walk={walk}
        exhaustAt={exhaustAt}
        walkAbsent={walkAbsent}
        globalMean={globalMean}
        cells={cells}
        tipHandlers={tipHandlers}
      />
    </div>
  );
}
