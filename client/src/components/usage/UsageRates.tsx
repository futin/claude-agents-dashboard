import type { ModelDayRate, ModelRateRow } from '../../../../shared/types';
import type { PinHandlers, TipHandlers } from '../../hooks/useFloatingTip';
import { useFloatingTip } from '../../hooks/useFloatingTip';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  coverageCaveat, coverageRows, cutFraction, DAY_FLOOR_PTS, dayLabel, dayStep, dayTip,
  DRIFT_BAND_PCT, figureTip, formatDeviation, formatShare, formatTok, ledgerReading,
  measuredShare, movedLabel, movedTotal, pricedShare, RATES_GLOSSARY, ratesStats, showsDays,
  spanText, verdictClass, verdictText
} from '../../lib/usageRatesFormat';
import { InfoDot } from './ReadingAids';
import { Definitions, RowHead, Sheet, StatStrip } from './Sheet';

/**
 * Token value per model — what one percent of the 5-hour window actually costs,
 * and whether that price has moved.
 *
 * **A ledger, not a set of cards.** Every figure on this page is one model's
 * value for a column every other model also has, which is the definition of a
 * table; the card stack it replaced made five comparable rates read as five
 * independent findings, and cost a scroll to compare any two of them.
 *
 * The **weighted** rate leads the columns because it is the only mix-invariant
 * quantity on the row, and the one the verdict judges: raw tokens per percent
 * are dominated by how much context a model's sessions replay, so leading with
 * raw invites a cross-model price reading the figure cannot support. Raw stays,
 * explicitly labelled. The **fitted** rate is a third column and deliberately
 * does not lead, even though it reads more of the evidence: it is measured
 * jointly across windows where several models ran together, and it has no
 * baseline history of its own, so there is no measured dispersion to set a
 * drift threshold against. A model that owns no window shows `—` in the lead
 * column beside a fitted figure — that is the whole reason that column exists,
 * and it is honest.
 *
 * `collecting` is a first-class row, not an omission: most models sit there for
 * the first fortnight, and a model that has vanished from the table is
 * indistinguishable from a model that was never seen.
 *
 * **Share is of the priced points, not of everything that moved.** The column
 * answers "of the evidence behind these rates, how much is this model's", so
 * the bars read as one breakdown and the priced share underneath them is the
 * total they sum into. What was left *out* of that denominator is the last
 * sheet's subject, in words — the dataviz palette validator fails this board's
 * status hues on the lightness band, the chroma floor and adjacent-pair CVD
 * separation, so a six-hue categorical bar of the refusals could not be built
 * here without a colour literal `styles.css` forbids. Refusal reasons are text,
 * where identity does not depend on hue.
 *
 * **The day strip is a sub-row, not a column.** A badge and a Δ cannot tell a
 * fortnight moving from one loud afternoon, so a model that has a baseline
 * carries one cell per UTC day of the 17-day horizon directly under its own
 * row, spanning every column — a series is one model's shape over time, which
 * is the one thing on this page that is not a value every other model also
 * has. The cells are coloured by which side of *this model's* baseline the day
 * landed on: polarity, stepped at the verdict's own band, never a magnitude
 * ramp, which would need the baseline figure in the reader's head. It is drawn
 * only where there is a baseline to judge against — a row of unjudged grey
 * under a `collecting` verdict reads as a broken chart, and the ledger sheet
 * already says the baseline is forming. The cells are ~17px on a phone, so the
 * floating panel is the readout, as it is for the profile grid's 168 cells.
 *
 * No `title` attributes: this board is read from a phone, where `title` never
 * fires, so every ⓘ opens the real floating panel `useFloatingTip` owns.
 *
 * Mock: `docs/guides/mockups/redesign-mock.html` `#rates`.
 */

/** The rates table's column count, so a full-width sub-row cannot drift from it. */
const RATE_COLS = 9;

/**
 * The class a day cell wears: its colour step when rated, otherwise its state,
 * which the stylesheet renders as texture. `none` is the bare cell.
 */
function dayClass(day: ModelDayRate): string {
  if (day.state === 'rated') {
    const step = dayStep(day.deviationPct);
    return step === 'unjudged' ? '' : step;
  }
  return day.state === 'none' ? '' : day.state;
}

/**
 * One model's days, as the sub-row under its own row in the table.
 *
 * The dashed rule is the current window's true start, `cutFraction` along the
 * strip — it cuts *through* a cell because the window starts mid-day, and that
 * is the honest geometry: the cut day belongs to both windows, which is why the
 * ledger can say "4 days" for a 3-day window. The cells spread the hover-only
 * bundle and carry `tabIndex` + `aria-label` of the same text, so keyboard and
 * screen-reader users read what the pointer does.
 */
function DayStrip({ row, generatedAt, tip, pin }: {
  row: ModelRateRow;
  generatedAt: string;
  tip: (text: string) => TipHandlers;
  pin: (text: string) => PinHandlers;
}) {
  const today = generatedAt.slice(0, 10);
  const cut = cutFraction(row.daily, generatedAt);
  return (
    <tr className="days">
      <td colSpan={RATE_COLS}>
        <div className="rates-days">
          <div className="rates-dayhead">
            By day
            <InfoDot label="day strip" text={figureTip('daily')} pin={pin} />
            <span className="rates-days-r">
              vs baseline {formatTok(row.baselineWeightedPerPct)}
            </span>
          </div>
          <div
            className="rates-daygrid"
            style={{ gridTemplateColumns: `repeat(${row.daily.length}, minmax(0, 1fr))` }}
          >
            {row.daily.map(day => {
              const text = dayTip(day, today);
              return (
                <div
                  key={day.date}
                  className={`rates-day ${dayClass(day)}`.trim()}
                  tabIndex={0}
                  aria-label={text.replace(/\n/g, ' — ')}
                  {...tip(text)}
                />
              );
            })}
            {cut !== null && (
              <span
                className="rates-cut"
                style={{ left: `${(cut * 100).toFixed(2)}%` }}
                aria-hidden="true"
              ><span>−3d</span></span>
            )}
          </div>
          <div className="rates-dayaxis">
            <span>{dayLabel(row.daily[0].date)}</span>
            <span className="rates-dayaxis-mid">← baseline · current →</span>
            <span>today</span>
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * The strip's key, once under the table. The swatches are the cells' own
 * classes, so the legend cannot drift from the strip; the figures are the
 * constants the steps and the thin floor are drawn from.
 */
function DayLegend() {
  return (
    <div className="rates-dayleg">
      <small>pricier</small>
      <span className="rates-daysw">
        <i className="rates-day far-below" /><i className="rates-day below" />
        <i className="rates-day within" />
        <i className="rates-day above" /><i className="rates-day far-above" />
      </span>
      <small>cheaper</small>
      <small className="rates-dayleg-k">
        −{2 * DRIFT_BAND_PCT}% · −{DRIFT_BAND_PCT} · within ±{DRIFT_BAND_PCT}% · +{DRIFT_BAND_PCT}
        {' '}· +{2 * DRIFT_BAND_PCT}% vs the model's baseline
      </small>
      <span className="rates-dayleg-item">
        <span className="rates-daysw"><i className="rates-day thin" /></span>
        <small>under {DAY_FLOOR_PTS} pts</small>
      </span>
      <span className="rates-dayleg-item">
        <span className="rates-daysw"><i className="rates-day" /></span><small>no windows</small>
      </span>
      <span className="rates-dayleg-item">
        <span className="rates-daysw"><i className="rates-day pre-ledger" /></span>
        <small>before recording</small>
      </span>
    </div>
  );
}

/**
 * One model's row in the rates table, and — where the model has a baseline to
 * judge its days against — the day strip that belongs to it. The pair is a
 * fragment and not one `<tr>`: `tr.wdays` drops its own rule so the two rows
 * read as one block at both measures.
 */
function RateRow({ row, share, generatedAt, tip, pin }: {
  row: ModelRateRow;
  share: number | null;
  generatedAt: string;
  tip: (text: string) => TipHandlers;
  pin: (text: string) => PinHandlers;
}) {
  const showFitted = row.fittedWeightedPerPct !== null
    && Number.isFinite(row.fittedWeightedPerPct);
  const days = showsDays(row);
  return (
    <>
    <tr className={days ? 'wdays' : undefined}>
      <td className="name">{row.model}</td>
      <td data-l="Verdict"><span className={verdictClass(row.verdict)}>{verdictText(row.verdict).label}</span></td>
      <td data-l="Weighted" className={row.weightedPerPct === null ? 'n mut' : 'n'}>
        {formatTok(row.weightedPerPct)}
      </td>
      <td data-l="Raw" className={row.rawPerPct === null ? 'n mut' : 'n'}>{formatTok(row.rawPerPct)}</td>
      <td data-l="Fitted" className={showFitted ? 'n' : 'n mut'}>{formatTok(row.fittedWeightedPerPct)}</td>
      <td data-l="Δ baseline" className="n">
        {row.deviationPct === null
          ? <span className="mut">—</span>
          : <span className={row.verdict === 'drift' ? 'dev bad' : 'dev'}>
            {formatDeviation(row.deviationPct)}
          </span>}
      </td>
      <td data-l="Windows" className="n">{row.intervals}</td>
      <td data-l="Share" className="n">{formatShare(share)}</td>
      <td className="barcell">
        <i
          className={row.weightedPerPct === null ? 'bar assumed' : 'bar'}
          style={{ width: `${share ?? 0}%` }}
        />
      </td>
    </tr>
    {days && <DayStrip row={row} generatedAt={generatedAt} tip={tip} pin={pin} />}
    </>
  );
}

export function UsageRates() {
  const { rates, loading, error } = useUsageRates();
  const { tipRef, tipHandlers, pinHandlers } = useFloatingTip();

  if (loading) return <p className="note">fitting the token rates…</p>;
  if (error || !rates) return <p className="note">The token rates could not be read.</p>;

  const dot = (key: typeof RATES_GLOSSARY[number]['key'], label: string) => (
    <InfoDot label={label} text={figureTip(key)} pin={pinHandlers} />
  );

  // The note stays up until a weekly figure actually appears, not merely until
  // the first widened line is written. Measured live on 2026-09-06: the record
  // carried a weekly reading within 90 seconds of the recorder starting, while
  // every weekly slot stayed empty for the rest of the day — so gating on
  // `weeklyRecorded` alone would have shown the note for one tick and then left
  // the page looking broken, which is the state it exists to explain.
  const anyWeekly = rates.models.some(
    row => row.weekly.weightedPerPct !== null || row.weekly.fittedWeightedPerPct !== null
  );
  const models = rates.models;
  const priced = models.filter(m => m.verdict !== 'thin');
  const caveat = coverageCaveat(rates.coverage);
  const covRows = coverageRows(rates.coverage);
  const measured = measuredShare(rates.coverage);
  const windows = models.reduce((n, m) => n + m.intervals, 0);
  const pricedPts = Math.round(rates.coverage.pricedPct).toLocaleString('en-US');

  return (
    <div className="up">
      <div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />

      {!rates.recording && (
        <div className="up-off">
          Usage recording is <b>off</b>, so nothing is being measured and there is no
          ledger to fit. Turn on <b>Record usage history</b> in Settings — a first rate
          needs a few hours of work, and a drift verdict needs about two weeks.
        </div>
      )}

      <StatStrip tiles={ratesStats(models, rates.coverage)} />

      <Sheet>
        <RowHead
          title="Token value per model"
          info={dot('across', 'cross-model reading')}
          sub="Weighted is the headline; raw counts cache reads the limit does not charge for"
          right={models.length > 0 && (
            <span className="chip">{models.length} model{models.length === 1 ? '' : 's'}</span>
          )}
        />

        {models.length === 0 ? (
          <p className="note">
            {rates.recording
              ? <>Nothing measurable yet. A model appears here once it has held at least 90% of
                the tokens in ten recorded windows, or once ten windows of shared use are
                enough to tell its cost apart from the models beside it — until then every
                interval is still being collected.</>
              : <>No ledger, so no rows.</>}
          </p>
        ) : (
          <>
            <table className="dt stack">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Verdict</th>
                  <th scope="col" className="n">Weighted {dot('weighted', 'weighted rate')}</th>
                  <th scope="col" className="n">Raw {dot('raw', 'raw token count')}</th>
                  <th scope="col" className="n">Fitted {dot('fitted', 'fitted rate')}</th>
                  <th scope="col" className="n">Δ baseline {dot('baseline', 'baseline')}</th>
                  <th scope="col" className="n">Windows {dot('window', 'window')}</th>
                  <th scope="col" className="n">Share</th>
                  <th scope="col" className="barcell" />
                </tr>
              </thead>
              <tbody>
                {models.map(row => (
                  <RateRow
                    key={row.model}
                    row={row}
                    share={pricedShare(row, models)}
                    generatedAt={rates.generatedAt}
                    tip={tipHandlers}
                    pin={pinHandlers}
                  />
                ))}
                <tr className="tot">
                  <td className="name">Priced share</td>
                  <td />
                  <td data-l="Priced" className="n">{pricedPts}</td>
                  <td className="n mut" colSpan={2}>
                    points of {movedTotal(rates.coverage)} explained
                  </td>
                  <td className="n" />
                  <td data-l="Windows" className="n">{windows}</td>
                  <td data-l="Share" className="n">{measured ?? '—'}</td>
                  <td className="barcell">
                    <i
                      className="bar hatch"
                      style={{ width: measured === null ? '0%' : measured }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
            {models.some(showsDays) && <DayLegend />}
            {priced.length < models.length && (
              <p className="note">
                <b>Collecting is the normal first fortnight</b> — {verdictText('thin').hint}.
              </p>
            )}
          </>
        )}
      </Sheet>

      {models.length > 0 && (
        <Sheet>
          <RowHead
            title="Evidence ledger"
            sub="What each rate was fitted on, and against what"
          />
          <table className="dt stack">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="n">Current windows</th>
                <th scope="col">Span</th>
                <th scope="col">Baseline</th>
                <th scope="col">Reading</th>
              </tr>
            </thead>
            <tbody>
              {models.map(row => (
                <tr key={row.model}>
                  <td className="name">{row.model}</td>
                  <td data-l="Current windows" className="n">{row.intervals}</td>
                  <td data-l="Span" className="mut">{spanText(row)}</td>
                  <td data-l="Baseline" className="mut">
                    {row.baselineDays <= 0
                      ? 'not established'
                      : `${row.baselineDays} day${row.baselineDays === 1 ? '' : 's'}`
                      + (row.baselineWeightedPerPct === null ? ' · forming' : '')}
                  </td>
                  <td data-l="Reading" className="mut">{ledgerReading(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rates.recording && !anyWeekly && (
            <p className="note">
              {rates.weeklyRecorded
                ? <>The <b>weekly</b> series is recording, but the weekly counter has not
                  ticked enough inside a recorded window to price a point of it yet.</>
                : <>The <b>weekly</b> series only began recording with this build, so no line
                  of the record carries a weekly reading yet.</>}
              {' '}The weekly line fills as the counter ticks — roughly 10–30 points a day on
              recent use, so a first weekly rate within about a day.
            </p>
          )}
        </Sheet>
      )}

      {covRows.length > 0 && (
        <Sheet>
          <RowHead
            title="Where the unpriced points went"
            sub={'Every point the 5-hour counter moved that no rate could be fitted on, and '
              + 'what refused it'}
            right={<span className="chip">{movedTotal(rates.coverage)} pts moved</span>}
          />
          <table className="dt">
            <thead>
              <tr>
                <th scope="col">Refused because</th>
                <th scope="col" className="n">Share</th>
              </tr>
            </thead>
            <tbody>
              {covRows.map(r => (
                <tr key={r.label}>
                  <td className="mut">{r.label}</td>
                  <td className="n">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {caveat !== null && <p className="note">{caveat}</p>}
        </Sheet>
      )}

      <Definitions terms={RATES_GLOSSARY} />
    </div>
  );
}

export default UsageRates;
