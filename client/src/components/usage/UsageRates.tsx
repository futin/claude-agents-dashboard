import type { ModelRateRow } from '../../../../shared/types';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  evidenceText, formatDeviation, formatSharePct, formatTok, verdictText
} from '../../lib/usageRatesFormat';

/**
 * Token value per model — what one percent of the 5-hour window actually costs,
 * and whether that price has moved.
 *
 * The raw number leads because it is what a person plans against; the badge
 * underneath judges on the weighted rate. `collecting` is a first-class state,
 * not an empty row — most models sit there for the first fortnight. No `title`
 * attributes: this board is read from a phone, where `title` never fires.
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
