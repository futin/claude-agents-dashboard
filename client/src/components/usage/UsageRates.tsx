import type { ModelRateRow } from '../../../../shared/types';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  baselineText, evidenceText, formatDeviation, formatSharePct, formatTok, rawAsideText, verdictText
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

  const share = formatSharePct(rates.externalSharePct);

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
            trailing 14 days before the last three.
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
