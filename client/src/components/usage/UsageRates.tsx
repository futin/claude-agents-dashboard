import type { ModelRateRow } from '../../../../shared/types';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  evidenceText, formatDeviation, formatSharePct, formatTok, verdictText
} from '../../lib/usageRatesFormat';

/**
 * Token value per model — what one percent of the 5-hour window actually costs,
 * and whether that price has moved.
 *
 * **Why this exists.** The header bars say a percent was spent; nothing said
 * what a percent *is*. Without that, choosing a model is anecdote ("Opus feels
 * expensive"), and a change in the exchange rate is invisible — which is the
 * thing worth knowing, because it changes what a day's budget buys.
 *
 * Design notes that are deliberate:
 *
 * - **The raw number leads, the weighted one judges.** "9.0M / 1%" is the
 *   figure a person can plan against; the verdict badge underneath is computed
 *   on the *weighted* rate, which is mix-invariant. When only the raw number
 *   moves the badge says `mix shift`, in as many words — never `drift`.
 * - **Every rate is shown with its evidence.** Windows and cumulative movement
 *   sit on the same row as the number. A rate with no evidence line would be a
 *   claim; with one it is a measurement.
 * - **`collecting` is a first-class state, not an empty row.** Most models will
 *   sit there for the first fortnight, and a card that showed nothing during
 *   its own warm-up would read as broken.
 * - **The external-burn pill is not decoration.** Utilization burned on another
 *   device cannot be attributed here, so it is excluded from the fit — and the
 *   one systematic bias in the measurement is disclosed rather than absorbed.
 * - **No `title` attributes.** This board is read from a phone, where `title`
 *   never fires; every explanation is real text in the row.
 */

const BADGE_CLASS: Record<ModelRateRow['verdict'], string> = {
  drift: 'rates-badge drift',
  stable: 'rates-badge stable',
  'mix-shift': 'rates-badge mix',
  thin: 'rates-badge thin'
};

function Row({ row }: { row: ModelRateRow }) {
  const verdict = verdictText(row.verdict);
  const baseline = row.baselineRawPerPct === null
    ? 'no baseline yet'
    : `baseline ${formatTok(row.baselineRawPerPct)}`;

  return (
    <li className="rates-row">
      <div className="rates-line">
        <span className="rates-model">{row.model}</span>
        <span className={BADGE_CLASS[row.verdict]}>{verdict.label}</span>
      </div>
      <div className="rates-line">
        <span className="rates-value">
          {formatTok(row.rawPerPct)}<span className="rates-unit"> / 1%</span>
        </span>
        {row.deviationPct !== null && (
          <span className={row.verdict === 'drift' ? 'rates-dev drift' : 'rates-dev'}>
            {formatDeviation(row.deviationPct)} weighted
          </span>
        )}
      </div>
      <div className="rates-meta">
        {baseline} · {evidenceText(row.intervals, row.utilSum)}
      </div>
      {row.verdict !== 'stable' && <div className="rates-hint">{verdict.hint}</div>}
    </li>
  );
}

export function UsageRates() {
  const { rates, loading, error } = useUsageRates();

  if (loading) return <div className="up-note">fitting the token rates…</div>;
  if (error || !rates) return <div className="up-note">The token rates could not be read.</div>;

  const share = formatSharePct(rates.externalSharePct);

  return (
    <div className="up">
      <div className="up-head">
        <div>
          <h3>TOKEN VALUE PER MODEL</h3>
          <p className="up-sub">
            Tokens per 1% of the 5-hour limit, measured from what this machine spent
            against what the window charged for it. Drift is judged on the{' '}
            <em>type-weighted</em> rate, so a change of token mix never reads as a
            repricing. Baseline = the trailing 14 days before the last three.
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
          the tokens in ten recorded windows — until then every interval is still being
          collected.
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
    </div>
  );
}

export default UsageRates;
