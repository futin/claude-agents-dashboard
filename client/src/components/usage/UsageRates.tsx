import type { ModelRateRow } from '../../../../shared/types';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  baselineText, coverageClauses, evidenceText, fittedAsideText, formatDeviation,
  formatSharePct, formatTok, pricedPillText, rawAsideText, verdictText, weeklyAsideText
} from '../../lib/usageRatesFormat';

/**
 * Token value per model — what one percent of the 5-hour window actually costs,
 * and whether that price has moved.
 *
 * The weighted rate leads because it is the only mix-invariant quantity on the
 * row, and the one the badge underneath judges: raw tokens per percent are
 * dominated by how much context a model's sessions replay, so leading with raw
 * invited a cross-model price reading the figure cannot support. Raw stays, as
 * an explicitly labelled translation. `collecting` is a first-class state, not
 * an empty row — most models sit there for the first fortnight. No `title`
 * attributes: this board is read from a phone, where `title` never fires.
 *
 * The **fitted** rate is a third line and deliberately does not lead, even
 * though it reads more of the evidence: it is measured jointly across windows
 * where several models ran together, and it has no baseline history of its own,
 * so there is no measured dispersion to set a drift threshold against. The
 * badge is the pooled rate's verdict and nothing on this row changes that. A
 * model that owns no window has no headline at all and shows `—` above its
 * fitted line — that is the whole reason the line exists, and it is honest.
 *
 * The second footer row leads with the **priced** share rather than with the
 * refusals: most of what the old single `gap` counter reported was spend that
 * simply predates the recorder, so leading with the refusals made a startup
 * artifact read as a fault. Buckets that cost nothing print nothing.
 */

const BADGE_CLASS: Record<ModelRateRow['verdict'], string> = {
  drift: 'rates-badge drift',
  stable: 'rates-badge stable',
  'mix-shift': 'rates-badge mix',
  thin: 'rates-badge thin'
};

function Row({ row }: { row: ModelRateRow }) {
  const verdict = verdictText(row.verdict);
  const baseline = baselineText(row.baselineWeightedPerPct, row.baselineDays);
  const rawAside = rawAsideText(row.rawPerPct);
  const fittedAside = fittedAsideText(row.fittedWeightedPerPct, row.fitDeviationPct);
  // A fourth aside, under the fitted one. It owns no threshold and makes no
  // comparison to the 5-hour rate above it — see `weeklyAsideText`.
  const weeklyAside = weeklyAsideText(
    row.weekly.weightedPerPct, row.weekly.fittedWeightedPerPct
  );

  return (
    <li className="rates-row">
      <div className="rates-line">
        <span className="rates-model">{row.model}</span>
        <span className={BADGE_CLASS[row.verdict]}>{verdict.label}</span>
      </div>
      <div className="rates-line">
        <span className="rates-value">
          {formatTok(row.weightedPerPct)}<span className="rates-unit"> weighted / 1%</span>
        </span>
        {row.deviationPct !== null && (
          <span className={row.verdict === 'drift' ? 'rates-dev drift' : 'rates-dev'}>
            {formatDeviation(row.deviationPct)} vs baseline
          </span>
        )}
      </div>
      {rawAside !== null && <div className="rates-raw">{rawAside}</div>}
      {fittedAside !== null && <div className="rates-raw">{fittedAside}</div>}
      {weeklyAside !== null && <div className="rates-raw">{weeklyAside}</div>}
      <div className="rates-meta">
        {baseline} · {evidenceText(row.intervals, row.days, row.utilSum)}
      </div>
      {row.verdict !== 'stable' && <div className="rates-hint">{verdict.hint}</div>}
    </li>
  );
}

export function UsageRates() {
  const { rates, loading, error } = useUsageRates();

  if (loading) return <div className="up-note">fitting the token rates…</div>;
  if (error || !rates) return <div className="up-note">The token rates could not be read.</div>;

  // The note stays up until a weekly figure actually appears, not merely until
  // the first widened line is written. Measured live on 2026-09-06: the record
  // carried a weekly reading within 90 seconds of the recorder starting, while
  // every weekly slot stayed empty for the rest of the day — so gating on
  // `weeklyRecorded` alone would have shown the note for one tick and then left
  // the card looking broken, which is the state it exists to explain.
  // `weeklyRecorded` still chooses *which* sentence, because "the record
  // predates the widening" and "the counter has not moved" are what that field
  // is for.
  const anyWeekly = rates.models.some(
    row => row.weekly.weightedPerPct !== null || row.weekly.fittedWeightedPerPct !== null
  );
  const share = formatSharePct(rates.externalSharePct);
  const priced = pricedPillText(rates.coverage);
  const clauses = coverageClauses(rates.coverage);

  return (
    <div className="up">
      <div className="up-head">
        <div>
          <h3>TOKEN VALUE PER MODEL</h3>
          <p className="up-sub">
            <em>Type-weighted</em> tokens per 1% of the 5-hour limit, measured from
            what this machine spent against what the window charged for it. Weighting
            is what keeps a change of token mix from reading as a repricing, and drift
            is judged on this same rate. Each rate is fitted from this machine's own
            usage, and a model that fires more requests per token carries that
            per-request window cost inside its token rate — so these are per-model
            rates, <b>not a price list to compare across models</b>. Baseline = the
            trailing 14 days before the last three. The <em>fitted</em> line under a
            row is a second estimate of the same quantity, measured jointly across
            the windows where several models ran together — the ones the headline
            rate has to discard. It reads more of the evidence and it is the only
            figure a model used purely as a subagent ever gets, but it is{' '}
            <b>no more comparable across models</b> than the headline, it has no
            baseline history yet, and drift is still judged on the headline alone.
            The <em>weekly limit</em> line prices a point of the <b>weekly</b>
            {' '}window instead — a different, much larger quantity, and the one that
            actually constrains a week of work. It carries <b>no drift verdict</b>,
            because no day-to-day dispersion has been measured for it yet, and it is
            no more comparable across models than the others.
          </p>
        </div>
      </div>

      {!rates.recording && (
        <div className="up-off">
          Usage recording is <b>off</b>, so nothing is being measured and there is no
          ledger to fit. Turn on <b>Record usage history</b> in Settings — a first rate
          needs a few hours of work, and a drift verdict needs about two weeks.
        </div>
      )}

      {rates.recording && rates.models.length === 0 && (
        <div className="up-note">
          Nothing measurable yet. A model appears here once it has held at least 90% of
          the tokens in ten recorded windows, or once ten windows of shared use are
          enough to tell its cost apart from the models beside it — until then every
          interval is still being collected.
        </div>
      )}

      {rates.recording && !anyWeekly && (
        <div className="up-note">
          {rates.weeklyRecorded
            ? <>The <b>weekly</b> series is recording, but the weekly counter has not
              ticked enough inside a recorded window to price a point of it yet.</>
            : <>The <b>weekly</b> series only began recording with this build, so no line
              of the record carries a weekly reading yet.</>}
          {' '}The weekly line fills as the counter ticks — roughly 10–30 points a day on
          recent use, so a first weekly rate within about a day.
        </div>
      )}

      {rates.models.length > 0 && (
        <ul className="rates-list">
          {rates.models.map(row => <Row key={row.model} row={row} />)}
        </ul>
      )}

      {share !== null && (
        <div className="rates-foot">
          <span className="rates-pill">{share} external</span>
          <span>burned outside this machine · excluded from the fit</span>
        </div>
      )}

      {priced !== null && (
        <div className="rates-foot">
          <span className="rates-pill">{priced}</span>
          {/* A leading middot from the second clause on: the flex gap alone is
              8px, which at desktop width let two clauses read as one sentence.
              Kept inside the clause's own span so a wrap still breaks between
              clauses rather than inside one. */}
          {clauses.map((clause, i) => (
            <span key={clause}>{i === 0 ? clause : `· ${clause}`}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default UsageRates;
