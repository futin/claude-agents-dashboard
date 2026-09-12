import { useState } from 'react';

import type { UsageProfileCell, UsageProfileResponse } from '../../../../shared/types';
import type { PinHandlers, TipHandlers } from '../../hooks/useFloatingTip';
import { useFloatingTip } from '../../hooks/useFloatingTip';
import { useUsageProfile } from '../../hooks/useUsageProfile';
import {
  cellTitle, DAY_ORDER, DAYS, earliestWeightMs, forecastStats, nextWeekStartMs,
  profileGlossary, profileProgress, profileTip, TRUST_FLOOR_MIN, type ProfileTerm
} from '../../lib/usageProfile';
import {
  absentText, crossingX, dayTicks, fmtWalkHour, headroomScale, headSegments, hitRect,
  hourOfWeekLocal,
  joinPoints, pctX, pctY, pointsAttr, segAreaPath, stepTitle, VIEW_H, walkWidth, yHead, zeroY,
  type HeadScale
} from '../../lib/walkChart';
import { headBarPct, walkRows, weightSource, type WalkTable } from '../../lib/walkRows';
import { InfoDot } from './ReadingAids';
import { Band, Definitions, RowHead, Sheet, SheetDivider, StatStrip } from './Sheet';

/**
 * The forecast page — the duty-cycle profile behind the weekly projection, and
 * the forward walk it produces.
 *
 * **Why this exists.** The forecast silently changes a number the user acts on,
 * using a model built in the background. Without an inspector a wrong
 * projection is undebuggable — the only recourse is reading `.usage-profile.json`
 * by hand. The 168 weights *are* the explanation. This is disclosure, not
 * decoration.
 *
 * **The reading order is the analyst's, not the chart's.** Five figures first —
 * where the window stands, when it runs out, how hard the rest of the week is
 * expected to be worked, how much has been observed, and whether to believe any
 * of it. Then the walk, as a picture and as rows off the *same* array, so the
 * two cannot disagree. Then the learned week, which is the evidence under
 * everything above it. Then every definition the page used, printed.
 *
 * Design notes that are deliberate, not incidental:
 *
 * - **A cell is one hour *of the week*, and evidence accumulates across weeks.**
 *   Monday 09:00 and Tuesday 09:00 are different cells; nothing is averaged
 *   across days. A cell can gather at most 60 minutes per week, so the tooltip
 *   states evidence in *weeks* — "300 min observed" on a one-hour cell reads as
 *   a contradiction.
 * - **One hue, five steps, derived with `color-mix`.** A grid of magnitudes is a
 *   sequential scale, so never a multi-hue ramp; and five themes × five steps is
 *   25 hex values nobody can validate, whereas
 *   `color-mix(in oklab, var(--cyan) N%, var(--strip))` is monotonic by
 *   construction and cannot violate the no-hardcoded-color rule.
 * - **Evidence is texture, not a sixth colour step.** An untrusted cell has *no
 *   value*, not a low one. Hue-coding confidence would read as a rainbow ramp
 *   and put confidence on the same scale as weight, which it isn't.
 * - **The numbers view is required, not a nicety.** The two lowest ramp steps
 *   fall below 3:1 against the card surface, and that obligates a non-colour
 *   path to the same weights. The mock has no such control; it is kept, in the
 *   slot the mock puts a filter chip in.
 * - **A real tooltip element, not the `title` attribute.** `title` is drawn by
 *   browser chrome, needs a dwell, and — the reason that settles it — never
 *   fires on touch. This dashboard is read from a phone, so `title` put the
 *   per-cell evidence out of reach on the device that matters most. The floating
 *   element here answers hover, press (pointerenter fires on touch-down, so
 *   press-and-hold inspects a cell), and keyboard focus, and it is written with
 *   `textContent` + `white-space: pre-line` rather than any innerHTML.
 * - **The week is drawn twice and shown once.** Wide, it is 7 rows of 24 hours,
 *   which reads across a sheet. On a phone that would be 24 columns in a
 *   thumb's width, so under 700px the transpose swaps back: the axis needing 24
 *   slots runs the direction a phone actually has. Both grids are in the markup
 *   and `display` picks one, so neither can be the one that silently broke —
 *   and `display:none` takes the hidden grid's 168 cells out of the tab order.
 *
 * Mock: `docs/guides/mockups/redesign-mock.html` `#forecast`.
 */

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

/**
 * Hours as the tables print them: whole where they are whole, one decimal where
 * the reset cuts an hour in half. A column of `13 / 24 / 24 / 8.0` reads as a
 * mistake; `13 / 24 / 24 / 8` beside a real `7.5` does not.
 */
function hrs(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Points spent, always as a subtraction. The minus is U+2212, not a hyphen. */
function pts(n: number): string {
  const v = Math.abs(n) < 0.05 ? 0 : n;
  return `${v > 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

/** Points left — negative past empty, and set in the same minus as `pts`. */
function left(n: number): string {
  const v = Math.round(n);
  return v < 0 ? `−${Math.abs(v)}` : String(v);
}

/**
 * The forward walk as headroom, draining to empty and then past it.
 *
 * Design notes that are deliberate, not incidental:
 *
 * - **y is what is left, not what is spent.** The page exists to answer "when
 *   does the weekly window run out", and a draining line puts that answer where
 *   the curve meets a rule at zero. The area below the rule is then a quantity
 *   rather than dead space: the work the window cannot pay for.
 * - **Ink says evidence, position says quantity.** Solid is a measured weight,
 *   dashed is the weekly mean standing in — above the rule and below it alike.
 *   The curve's *height* is unchanged by which: the forecast genuinely counts an
 *   unlearned hour at `globalMean`, and that pessimistic edge is deliberate.
 *   With no learned buckets at all the whole line is dashed, which is the honest
 *   picture.
 * - **One SVG with a `viewBox`, `preserveAspectRatio="none"` and
 *   `vector-effect: non-scaling-stroke`.** The flexbox strip this replaced gave
 *   every bar a fractional CSS width, and the compositor rounded each bar's two
 *   edges to device pixels independently — a ±1px swing between neighbours that
 *   no CSS tuning can remove, because the rounding is per element. One
 *   coordinate space scaled uniformly removes it structurally instead.
 * - **Text lives outside the SVG.** `preserveAspectRatio="none"` stretches
 *   everything it paints, glyphs included, so every label is an HTML overlay
 *   positioned by percentage.
 * - **Full-height hit columns, and a real tooltip element.** A hit area on the
 *   line itself is a mouse-only affordance; `title` never fires on touch. Both
 *   matter more than usual here — this is read from a phone.
 */
function HeadroomChart({ walk, exhaustAt, startHead, cells, scale, tipHandlers }: {
  walk: UsageProfileResponse['walk'];
  exhaustAt: string | null;
  startHead: number;
  cells: UsageProfileCell[];
  scale: HeadScale;
  tipHandlers: (text: string) => TipHandlers;
}) {
  const n = walk.length;
  const w = walkWidth(n);
  const segs = headSegments(walk, scale);
  const above = joinPoints(segs.filter(s => !s.below));
  const cross = crossingX(walk);
  const ticks = dayTicks(walk).filter(t => t.kind === 'day');
  const zero = zeroY(scale);

  return (
    <div className="walk">
      <div className="walkwrap">
        <svg
          className="hrchart"
          viewBox={`0 0 ${w} ${VIEW_H}`}
          preserveAspectRatio="none"
          focusable="false"
        >
          {ticks.map(t => (
            <line key={t.x} className="wk-day" x1={t.x} x2={t.x} y1={0} y2={VIEW_H} />
          ))}
          {/* One shape for the headroom, one per below-rule segment for the
              deficit: only the deficit is split by evidence, and only the
              deficit needs to be, because that is where a guess costs you. */}
          <path className="hr-area" d={segAreaPath(above, scale)} />
          {segs.filter(s => s.below).map((s, i) => (
            <path
              key={`d${i}`}
              className={s.learned ? 'hr-debt measured' : 'hr-debt'}
              d={segAreaPath(s.points, scale)}
            />
          ))}
          <line className="hr-zero" x1={0} x2={w} y1={zero} y2={zero} />
          {segs.map((s, i) => (
            <polyline
              key={`l${i}`}
              className={`hr-line${s.below ? ' debt' : ''}${s.learned ? '' : ' assumed'}`}
              points={pointsAttr(s.points)}
            />
          ))}
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
        <span className="ylab" style={{ top: `${pctY(yHead(startHead, scale))}%` }}>
          {Math.round(startHead)} pts
        </span>
        <span className="ylab" style={{ top: `${pctY(zero)}%` }}>empty</span>
        {scale.lo < 0 && (
          <span className="ylab debt" style={{ top: `${pctY(yHead(scale.lo, scale))}%` }}>
            −{Math.round(-scale.lo)}
          </span>
        )}
        {cross !== null && (
          <>
            <span
              className="crossdot"
              style={{ left: `${pctX(cross, n)}%`, top: `${pctY(zero)}%` }}
            />
            {exhaustAt && (
              <span
                className="crosstag"
                style={{ left: `${pctX(cross, n)}%`, top: `${pctY(zero)}%` }}
              >
                {/* The crossing *time*, not the word `empty`: the y label on
                    the rule already says empty, and the figure strip prints
                    this same string, so the mark and the claim are one reading. */}
                {fmtWalkHour(exhaustAt)}
              </span>
            )}
          </>
        )}
      </div>
      <div className="walkdays">
        {/* `now` is left-aligned rather than centred on x=0: the first midnight
            can be one hour away, and two centred labels that close collide. */}
        <span className="now">now</span>
        {ticks.map(t => (
          <span key={t.x} style={{ left: `${pctX(t.x, n)}%` }}>{t.label}</span>
        ))}
      </div>
    </div>
  );
}

/** The walk's own legend: what the two inks mean, and what the two fills mean. */
function WalkLegend({ tip }: { tip: (key: ProfileTerm, label: string) => React.ReactNode }) {
  return (
    <div className="uplegend">
      {/* Each swatch and its words are one flex item: split across a wrap, a
          lone swatch at the end of a line reads as a sixth state. */}
      <span className="key"><i className="rule" />solid — points still to spend, on a measured weight</span>
      <span className="key"><i className="rule dash" />dashed — no evidence for that hour of the week yet</span>
      {tip('ink', 'solid and dashed line')}
      <span className="gap" />
      <span className="key"><i className="rule brick red" />borrowed on measured hours</span>
      <span className="key"><i className="rule brick" />borrowed on hours at the weekly mean</span>
      {tip('ceiling', 'empty line')}
    </div>
  );
}

/** The same walk as rows: one local day each, plus the row to the reset. */
function WalkTableRows({ table, globalMean }: { table: WalkTable; globalMean: number }) {
  const { rows, totals, startHead } = table;
  return (
    <table className="dt">
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col" className="n">Hours</th>
          <th scope="col" className="n">Active h</th>
          <th scope="col">Weight source</th>
          <th scope="col" className="n">Spent</th>
          <th scope="col" className="n">Left</th>
          <th scope="col" className="barcell" />
          <th scope="col">Note</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.key}>
            <td className="name">
              {r.label}{r.isNow && <span className="cs"> · now</span>}
            </td>
            <td className="n">{hrs(r.hours)}</td>
            <td className="n">{r.activeHours.toFixed(1)}</td>
            <td>{weightSource(r, globalMean)}</td>
            <td className="n">{pts(r.spent)}</td>
            <td className={r.endHead < 0 ? 'n over' : 'n'}>{left(r.endHead)}</td>
            <td className="barcell">
              <i
                className={r.learned === 0 ? 'bar assumed' : 'bar'}
                style={{ width: `${headBarPct(r.endHead, startHead)}%` }}
              />
            </td>
            <td className="mut">
              {/* The deficit is only reported on a day that *deepened* it: a
                  day past the crossing that spends nothing repeats the figure
                  above it, and a column of the same number three times reads
                  as three findings. */}
              {r.crossesAt !== null
                ? `empty at ${r.crossesAt}`
                : r.endHead < 0 && r.spent >= 0.05 ? `${Math.round(-r.endHead)} pts past empty`
                  : i === rows.length - 1 ? 'to the weekly reset' : ''}
            </td>
          </tr>
        ))}
        <tr className="tot">
          <td>To the reset</td>
          <td className="n">{hrs(totals.hours)}</td>
          <td className="n">{totals.activeHours.toFixed(1)}</td>
          <td>
            {totals.learned} measured · {totals.slices - totals.learned} at the mean
          </td>
          <td className="n">{pts(totals.spent)}</td>
          <td className={totals.endHead < 0 ? 'n over' : 'n'}>{left(totals.endHead)}</td>
          <td className="barcell">
            <i className="bar hatch" style={{ width: '100%' }} />
          </td>
          <td className="mut">
            {/* Keyed off `crossed`, not off the unpayable counter: a crossing
                inside the last slice leaves no whole hour after it, and keying
                off the counter made this cell say the window coasts while the
                Left cell beside it printed a negative. Under an hour past the
                crossing the row says it went empty without naming a count the
                rounding would print as `0 hours`. */}
            {!totals.crossed
              ? 'the window coasts to its reset'
              : Math.round(totals.unpayableHours) > 0
                ? `${hrs(totals.unpayableHours)} hours past the crossing the window cannot pay for`
                : 'the window goes empty before its reset'}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The learned week as a grid. `wide` is 7 rows of 24 hours; the other is the
 * transpose. Both are rendered; `styles.css` shows exactly one.
 */
function HourGrid({ wide, cells, tipHandlers }: {
  wide: boolean;
  cells: UsageProfileCell[];
  tipHandlers: (text: string) => TipHandlers;
}) {
  const at = (day: number, hour: number) => cells[day * 24 + hour];
  const cell = (day: number, hour: number) => {
    const c = at(day, hour);
    const text = cellTitle(c, day, hour);
    return (
      <div
        key={`${day}-${hour}`}
        className={`up-cell ${c.weight == null ? 'unknown' : stepOf(c.weight)}`.trim()}
        tabIndex={0}
        role="img"
        aria-label={text.replace(/\n/g, ' — ')}
        {...tipHandlers(text)}
      />
    );
  };

  if (wide) {
    return (
      <div className="hmx wide" aria-hidden={false}>
        <div className="hrs">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h}>{String(h).padStart(2, '0')}</span>
          ))}
        </div>
        <div className="lab">
          {DAY_ORDER.map(day => <span key={day}>{DAYS[day]}</span>)}
        </div>
        <div className="gx">
          {DAY_ORDER.map(day => Array.from({ length: 24 }, (_, h) => cell(day, h)))}
        </div>
      </div>
    );
  }
  return (
    <div className="hmx tall" style={{ gridTemplateColumns: '40px repeat(7,1fr)' }}>
      <div />
      {DAY_ORDER.map(day => <div key={day} className="up-axis">{DAYS[day]}</div>)}
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} style={{ display: 'contents' }}>
          <div className="up-axis left">{String(hour).padStart(2, '0')}:00</div>
          {DAY_ORDER.map(day => cell(day, hour))}
        </div>
      ))}
    </div>
  );
}

export function UsageProfile() {
  const { profile, loading, error } = useUsageProfile();
  const [showNumbers, setShowNumbers] = useState(false);

  // Both bundles off the one panel: hover-only for the grid cells and the
  // walk's hit columns, click-to-pin for the ⓘ glyphs, which have to stay open
  // long enough to read a definition.
  const { tipRef, tipHandlers, pinHandlers } = useFloatingTip();

  if (loading) return <p className="note">reading the usage profile…</p>;
  if (error || !profile) return <p className="note">The usage profile could not be read.</p>;

  const {
    cells, globalMean, confidence, recording, walk, exhaustAt, walkAbsent,
    utilizationPct, resetsAt, dutyCycle
  } = profile;

  const dot = (key: ProfileTerm, label: string) => (
    <InfoDot label={label} text={profileTip(key, globalMean)} pin={pinHandlers} />
  );

  const progress = profileProgress(cells);
  const startHead = utilizationPct === null ? 100 : 100 - utilizationPct;
  const table = walkRows(walk, { resetsAt, startHead });
  const scale = headroomScale(walk, startHead);
  const tiles = forecastStats({
    utilizationPct,
    resetsAt,
    exhaustAt,
    dutyCycle,
    hoursLeft: table.totals.hours,
    activeHours: table.totals.activeHours,
    // The strip sits above the `walk.length === 0` branch, so it has to know
    // there was no walk: without this the crossing tile would state a coasting
    // week four inches above the note saying nothing could be projected.
    hasWalk: walk.length > 0,
    progress,
    confidence,
    nowMs: Date.now()
  });

  // Dated from the cells, not the calendar: a bucket carrying last week's stamp
  // folds at its next occurrence, which is usually days before the next Monday.
  // With nothing recorded there is no occurrence to date, and the week boundary
  // is then the true floor — an hour has to be observed before it can fold.
  const now = Date.now();
  const first = new Date(earliestWeightMs(cells, now) ?? nextWeekStartMs(now));
  const when = first.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="up">
      <div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />

      {!recording && (
        <div className="up-off">
          Usage recording is <b>off</b>, so nothing new is being learned and the weekly
          forecast is the plain flat-rate one. Turn on <b>Record usage history</b> in
          Settings to start building a profile — it needs roughly two weeks before the
          forecast improves.
        </div>
      )}

      <StatStrip tiles={tiles} renderInfo={(term) => dot(term as ProfileTerm, term)} />

      <Sheet>
        <RowHead
          title="The headroom, draining"
          info={dot('walk', 'walk')}
          sub={'What is left of the weekly window rather than what is spent: it reaches zero '
            + 'at the crossing, and everything under the rule is time the window cannot pay for'}
          right={walk.length > 0 && <span className="chip">{hrs(table.totals.hours)} hours</span>}
        />

        {walk.length === 0 ? (
          // Never an unmounted section: idle is a normal state, and a panel that
          // vanishes reads as a broken feature rather than as nothing to draw.
          <p className="note">{absentText(walkAbsent ?? 'no-window')}</p>
        ) : (
          <>
            <HeadroomChart
              walk={walk}
              exhaustAt={exhaustAt}
              startHead={startHead}
              cells={cells}
              scale={scale}
              tipHandlers={tipHandlers}
            />
            <WalkLegend tip={dot} />
            {scale.clamped && (
              <p className="note">
                The deficit runs deeper than the plot shows: the band below the rule stops at
                the height of the headroom above it, so the line sits on the floor rather
                than flattening the drain into a sliver.
              </p>
            )}

            <SheetDivider />

            <RowHead
              sub2
              title="Hour by hour, as rows"
              sub={`The same ${hrs(table.totals.hours)} hours the curve walks, grouped by day`}
              right={<span className="chip">Daily rows</span>}
            />
            <WalkTableRows table={table} globalMean={globalMean} />
          </>
        )}
      </Sheet>

      <Sheet>
        <RowHead
          title="The week, as observed"
          info={dot('cell', 'hour of the week')}
          sub={'168 hour-of-week weights · an empty cell is a measured idle hour, a hatched '
            + 'one has no evidence yet'}
          right={
            <button
              type="button"
              className="chip"
              aria-pressed={showNumbers}
              onClick={() => setShowNumbers(v => !v)}
            >
              {showNumbers ? 'Show grid' : 'Show numbers'}
            </button>
          }
        />

        {showNumbers ? (
          <div className="up-tablewrap">
            <table className="dt up-table">
              <thead>
                <tr>
                  <th scope="col">Hour</th>
                  {DAY_ORDER.map(day => <th key={day} scope="col" className="n">{DAYS[day]}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 24 }, (_, hour) => (
                  <tr key={hour}>
                    <th scope="row">{String(hour).padStart(2, '0')}:00</th>
                    {DAY_ORDER.map(day => {
                      const c = cells[day * 24 + hour];
                      return (
                        <td key={day} className={c.weight == null ? 'n mut' : 'n'}>
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
          <>
            <HourGrid wide cells={cells} tipHandlers={tipHandlers} />
            <HourGrid wide={false} cells={cells} tipHandlers={tipHandlers} />
          </>
        )}

        <div className="uplegend">
          <small>never</small>
          <span className="ramp-sw">
            <i className="up-cell" />
            <i className="up-cell q1" /><i className="up-cell q2" /><i className="up-cell q3" />
            <i className="up-cell q4" /><i className="up-cell q5" />
          </span>
          <small>always</small>
          {dot('weight', 'weight')}
          <span className="gap" />
          <span className="key">
            <i className="up-cell unknown" />
            no evidence yet — falls back to the {Math.round(globalMean * 100)}% weekly mean
          </span>
          {dot('evidence', 'evidence')}
        </div>

        {progress.trusted === 0 && (
          <p className="note">
            {progress.atFloor > 0
              ? <>{progress.atFloor} {progress.atFloor === 1 ? 'hour has' : 'hours have'} enough
                evidence — the first weight appears on {when}, when that hour comes round in a
                new week.</>
              : <>No weights yet: an hour needs {TRUST_FLOOR_MIN} min of evidence and one week to
                fold, so the earliest a weight can appear is {when}.</>}
          </p>
        )}
      </Sheet>

      <Definitions terms={profileGlossary(globalMean)} />
    </div>
  );
}
