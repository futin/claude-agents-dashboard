import type { ModelRateRow } from '../../../../shared/types';
import { useFloatingTip } from '../../hooks/useFloatingTip';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  coverageCaveat, coverageRows, figureTip, formatDeviation, formatShare, formatTok,
  ledgerReading, measuredShare, movedLabel, movedTotal, pricedShare, RATES_GLOSSARY, ratesStats,
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
 * No `title` attributes: this board is read from a phone, where `title` never
 * fires, so every ⓘ opens the real floating panel `useFloatingTip` owns.
 *
 * Mock: `docs/guides/mockups/redesign-mock.html` `#rates`.
 */

/** One model's row in the rates table. */
function RateRow({ row, share }: { row: ModelRateRow; share: number | null }) {
  const showFitted = row.fittedWeightedPerPct !== null
    && Number.isFinite(row.fittedWeightedPerPct);
  return (
    <tr>
      <td className="name">{row.model}</td>
      <td><span className={verdictClass(row.verdict)}>{verdictText(row.verdict).label}</span></td>
      <td className={row.weightedPerPct === null ? 'n mut' : 'n'}>
        {formatTok(row.weightedPerPct)}
      </td>
      <td className={row.rawPerPct === null ? 'n mut' : 'n'}>{formatTok(row.rawPerPct)}</td>
      <td className={showFitted ? 'n' : 'n mut'}>{formatTok(row.fittedWeightedPerPct)}</td>
      <td className="n">
        {row.deviationPct === null
          ? <span className="mut">—</span>
          : <span className={row.verdict === 'drift' ? 'dev bad' : 'dev'}>
            {formatDeviation(row.deviationPct)}
          </span>}
      </td>
      <td className="n">{row.intervals}</td>
      <td className="n">{formatShare(share)}</td>
      <td className="barcell">
        <i
          className={row.weightedPerPct === null ? 'bar assumed' : 'bar'}
          style={{ width: `${share ?? 0}%` }}
        />
      </td>
    </tr>
  );
}

export function UsageRates() {
  const { rates, loading, error } = useUsageRates();
  const { tipRef, pinHandlers } = useFloatingTip();

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
            <table className="dt">
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
                  <RateRow key={row.model} row={row} share={pricedShare(row, models)} />
                ))}
                <tr className="tot">
                  <td>Priced share</td>
                  <td />
                  <td className="n">{pricedPts}</td>
                  <td className="n mut" colSpan={2}>
                    points of {movedTotal(rates.coverage)} explained
                  </td>
                  <td className="n" />
                  <td className="n">{windows}</td>
                  <td className="n">{measured ?? '—'}</td>
                  <td className="barcell">
                    <i
                      className="bar hatch"
                      style={{ width: measured === null ? '0%' : measured }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
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
          <table className="dt">
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
                  <td className="n">{row.intervals}</td>
                  <td className="mut">{spanText(row)}</td>
                  <td className="mut">
                    {row.baselineDays <= 0
                      ? 'not established'
                      : `${row.baselineDays} day${row.baselineDays === 1 ? '' : 's'}`
                      + (row.baselineWeightedPerPct === null ? ' · forming' : '')}
                  </td>
                  <td className="mut">{ledgerReading(row)}</td>
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
                <th scope="col" className="n">Share</th>
                <th scope="col">Refused because</th>
              </tr>
            </thead>
            <tbody>
              {covRows.map(r => (
                <tr key={r.label}>
                  <td className="n">{r.value}</td>
                  <td className="mut">{r.label}</td>
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
