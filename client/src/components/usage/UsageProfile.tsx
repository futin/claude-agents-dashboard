import { useState } from 'react';

import type { ForecastConfidence, UsageProfileCell } from '../../../../shared/types';
import { useUsageProfile } from '../../hooks/useUsageProfile';

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
 * - **Square cells, at the mockup's proportions.** `aspect-ratio: 1` with a
 *   320px grid, which measures out at 38px cells and a 971px-tall grid — the
 *   mockup's variant C is 38.84px and 992px, the difference being that this
 *   labels all 24 hours and so needs a wider axis column. `max-width` on
 *   `.up-grid` is the single knob: the columns are `1fr` and the cells are
 *   square, so the grid's width sets the cell size and therefore the height.
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
      `${when}\nno evidence yet\n${Math.round(cell.observedMin)} of 60 min needed\n` +
      'falls back to the weekly mean'
    );
  }
  const evidence = weeks >= 2
    ? `${Math.round(weeks)} weeks of evidence`
    : `${Math.round(cell.observedMin)} of 60 min — under one week`;
  const stale = cell.staleWeeks > 8 ? `\nlast seen ${cell.staleWeeks} weeks ago` : '';
  const level = cell.weight <= 0.02
    ? 'never active — measured, not missing'
    : `${Math.round(cell.weight * 100)}% active`;
  return `${when}\n${level}\n${evidence}${stale}`;
}

const fmtHour = (iso: string) => {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:00`;
};

export function UsageProfile() {
  const { profile, loading, error } = useUsageProfile();
  const [showTable, setShowTable] = useState(false);

  if (loading) return <div className="up-note">reading the usage profile…</div>;
  if (error || !profile) return <div className="up-note">The usage profile could not be read.</div>;

  const { cells, globalMean, confidence, recording, walk, exhaustAt } = profile;
  const at = (day: number, hour: number) => cells[day * 24 + hour];
  const maxGain = walk.reduce((m, s) => Math.max(m, s.gain), 0);

  return (
    <div className="up">
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
                    title={cellTitle(c, day, hour)}
                    aria-label={cellTitle(c, day, hour).replace(/\n/g, ' — ')}
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

      {walk.length > 0 && (
        <div className="up-walk">
          <div className="up-walkbars">
            {walk.map(step => (
              <div
                key={step.t}
                className={`up-wb${step.gain <= 0 ? ' idle' : ''}`}
                style={step.gain > 0 && maxGain > 0
                  ? { height: `${Math.max(3, (step.gain / maxGain) * 100)}%` }
                  : undefined}
                title={`${fmtHour(step.t)} · +${step.gain.toFixed(1)}%`}
              />
            ))}
          </div>
          <div className="up-walkmeta">
            <span>the walk behind the current weekly projection</span>
            <span className={exhaustAt ? 'up-hit' : undefined}>
              {exhaustAt ? `hits 100% ${fmtHour(exhaustAt)}` : 'coasts to the reset'}
            </span>
          </div>
          <p className="up-note">
            Flat stubs are hours the profile expects to be idle — they contribute nothing,
            which is the whole point of the feature. The visible gap across the weekend is
            what stops the projection landing on Saturday.
          </p>
        </div>
      )}
    </div>
  );
}
