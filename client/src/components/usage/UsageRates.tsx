import type { ModelRateRow } from '../../../../shared/types';
import type { PinHandlers } from '../../hooks/useFloatingTip';
import { useFloatingTip } from '../../hooks/useFloatingTip';
import { useUsageRates } from '../../hooks/useUsageRates';
import {
  coverageCaveat, coverageRows, evidenceParts, figureTip, formatDeviation, formatTok,
  hasFigures, measuredShare, movedLabel, RATES_GLOSSARY, statusLine, verdictText,
  waitingText, weeklyAsideText
} from '../../lib/usageRatesFormat';
import { HowToRead, InfoDot } from './ReadingAids';

/**
 * Token value per model — what one percent of the 5-hour window actually costs,
 * and whether that price has moved.
 *
 * A **status board**: the page opens on the question and its answer, then one
 * card of labelled figures per model, then the definitions. What it says is
 * exactly what it said before the relayout; where it says it is the change.
 *
 * The weighted rate leads because it is the only mix-invariant quantity on the
 * row, and the one the badge judges: raw tokens per percent are dominated by
 * how much context a model's sessions replay, so leading with raw invited a
 * cross-model price reading the figure cannot support. Raw stays, as an
 * explicitly labelled tile. `collecting` is a first-class state, not an empty
 * row — most models sit there for the first fortnight. No `title` attributes:
 * this board is read from a phone, where `title` never fires, so every ⓘ opens
 * the real floating panel `useFloatingTip` owns.
 *
 * The **fitted** rate is a third tile and deliberately does not lead, even
 * though it reads more of the evidence: it is measured jointly across windows
 * where several models ran together, and it has no baseline history of its own,
 * so there is no measured dispersion to set a drift threshold against. The
 * badge is the pooled rate's verdict and nothing on this row changes that. A
 * model that owns no window has no headline at all and shows `—` in the lead
 * tile beside its fitted one — that is the whole reason the tile exists, and it
 * is honest.
 *
 * **The collecting hint is hoisted out of the rows.** It is a fact about the
 * measurement, not about any one model, and printing it once per row made five
 * identical sentences read as five separate findings. Drift and mix-shift hints
 * stay in their row: those *are* facts about one model.
 *
 * **Coverage is a two-segment bar, not a six-hue one.** The question it answers
 * is binary — how much of the spend was measured — and the dataviz palette
 * validator fails this board's own status hues on the lightness band, the chroma
 * floor and adjacent-pair CVD separation, so a six-hue categorical bar could not
 * be built here without a new colour literal `styles.css` forbids. The refusal
 * *reasons* are text, where identity does not depend on hue. It leads with the
 * measured share rather than the refusals: most of what the old single `gap`
 * counter reported was spend that simply predates the recorder, so leading with
 * the refusals made a startup artifact read as a fault. Buckets that cost
 * nothing print nothing.
 */

const BADGE_CLASS: Record<ModelRateRow['verdict'], string> = {
  drift: 'rates-badge drift',
  stable: 'rates-badge stable',
  'mix-shift': 'rates-badge mix',
  thin: 'rates-badge thin'
};

/** One labelled figure, its ⓘ, and whatever the card can say underneath it. */
function Fig({ label, term, lead, value, unit, sub, pin }: {
  label: string;
  term: typeof RATES_GLOSSARY[number]['key'];
  lead?: boolean;
  value: string;
  unit: string;
  sub?: React.ReactNode;
  pin: (text: string) => PinHandlers;
}) {
  return (
    <div className={lead ? 'rates-fig lead' : 'rates-fig'}>
      <div className="rates-lab">
        {label}
        <InfoDot label={label.toLowerCase()} text={figureTip(term)} pin={pin} />
      </div>
      <div className="rates-value">
        {value}<span className="rates-unit">{unit}</span>
      </div>
      {sub !== undefined && sub !== null && <div className="rates-sub">{sub}</div>}
    </div>
  );
}

/**
 * The baseline clause, with `forming` picked out — it is the one word on the
 * evidence line the reader is waiting on, and the only reason the clause is not
 * printed as flat text.
 */
function BaselineClause({ text }: { text: string }) {
  if (!text.startsWith('forming')) return <>{text}</>;
  return <><span className="rates-forming">forming</span>{text.slice('forming'.length)}</>;
}

function Row({ row, pin }: { row: ModelRateRow; pin: (text: string) => PinHandlers }) {
  const verdict = verdictText(row.verdict);
  const ev = evidenceParts(row);
  // The weekly figure stays one line under the tiles rather than becoming a
  // fourth tile: it prices a *different*, ~8–14× larger window, and a tile row
  // reads as one comparable set. It owns no threshold — see `weeklyAsideText`.
  const weekly = weeklyAsideText(row.weekly.weightedPerPct, row.weekly.fittedWeightedPerPct);
  const showRaw = row.rawPerPct !== null && Number.isFinite(row.rawPerPct);
  const showFitted =
    row.fittedWeightedPerPct !== null && Number.isFinite(row.fittedWeightedPerPct);
  // Only the two verdicts that are about *this* model. `thin` is hoisted to a
  // single notice above the list, and `stable` needs no sentence at all.
  const hint = row.verdict === 'drift' || row.verdict === 'mix-shift' ? verdict.hint : null;

  return (
    <li className="rates-row">
      <div className="rates-line">
        <span className="rates-model">{row.model}</span>
        <span className={BADGE_CLASS[row.verdict]}>{verdict.label}</span>
      </div>

      <div className="rates-figs">
        <Fig
          lead
          label="Weighted rate"
          term="weighted"
          value={formatTok(row.weightedPerPct)}
          unit="tok / 1%"
          pin={pin}
          sub={row.deviationPct !== null && (
            <>
              <span className={row.verdict === 'drift' ? 'rates-dev drift' : 'rates-dev'}>
                {formatDeviation(row.deviationPct)}
              </span>{' '}vs baseline
            </>
          )}
        />
        {showRaw && (
          <Fig
            label="Raw tokens"
            term="raw"
            value={formatTok(row.rawPerPct)}
            unit="/ 1%"
            pin={pin}
          />
        )}
        {showFitted && (
          <Fig
            label="Fitted, mixed windows"
            term="fitted"
            value={formatTok(row.fittedWeightedPerPct)}
            unit="/ 1%"
            pin={pin}
            sub={row.fitDeviationPct !== null && (
              <>
                <span className="rates-dev">{formatDeviation(row.fitDeviationPct)}</span>
                {' '}vs weighted
              </>
            )}
          />
        )}
      </div>

      <div className="rates-ev">
        <span><b>Current</b> {ev.current}</span>
        <span><b>Baseline</b> <BaselineClause text={ev.baseline} /></span>
      </div>
      {weekly !== null && <div className="rates-weekly">{weekly}</div>}
      {hint !== null && <div className="rates-hint">{hint}</div>}
    </li>
  );
}

export function UsageRates() {
  const { rates, loading, error } = useUsageRates();
  const { tipRef, pinHandlers } = useFloatingTip();

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
  const status = statusLine(rates.models);
  const shown = rates.models.filter(hasFigures);
  const waiting = rates.models.filter(row => !hasFigures(row));
  const collecting = rates.models.some(row => row.verdict === 'thin');
  const measured = measuredShare(rates.coverage);
  const covRows = coverageRows(rates.coverage);
  const caveat = coverageCaveat(rates.coverage);
  // Geometry, not a statement: the same share `measured` prints, as a width.
  const measuredPct = rates.coverage.movedPct > 0
    ? Math.max(0, Math.min(100, (rates.coverage.pricedPct / rates.coverage.movedPct) * 100))
    : 0;

  return (
    <div className="up">
      <div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />
      <div className="up-head">
        <div>
          <h3>Token value per model</h3>
          <p className="up-sub">
            How many tokens each model gets out of 1% of your 5-hour limit, and whether
            that price has moved. Measured on this machine only.
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

      {status !== null && (
        <div className="rates-status">
          <span className="rates-q">{status.headline}</span>
          <span className="rates-counts">
            {status.counts.map(c => (
              <span key={c.label}><b>{c.n}</b> {c.label}</span>
            ))}
          </span>
        </div>
      )}

      {collecting && (
        <div className="rates-notice">
          {/* The hint verbatim, never re-cut: it is the sentence `verdictText`
              owns, and a lead phrased around it is cheaper than string surgery
              that would silently mangle the copy the day the floors change. */}
          <b>Collecting is the normal first fortnight</b> — {verdictText('thin').hint}.
        </div>
      )}

      {shown.length > 0 && (
        <ul className="rates-list">
          {shown.map(row => <Row key={row.model} row={row} pin={pinHandlers} />)}
        </ul>
      )}

      {waiting.length > 0 && (
        <div className="rates-wait">
          <span className="rates-lab">Not enough evidence yet</span>
          {waiting.map(row => <span key={row.model}>{waitingText(row)}</span>)}
        </div>
      )}

      {rates.models.length > 0 && <HowToRead terms={RATES_GLOSSARY} />}

      {measured !== null && (
        <div className="rates-cov">
          <div className="rates-covhead">
            <h4>How much of your spend was measured</h4>
            <span className="rates-big">
              {measured}<span className="rates-unit">{movedLabel(rates.coverage)}</span>
            </span>
          </div>
          <div className="rates-bar" role="presentation">
            <i className="measured" style={{ width: `${measuredPct}%` }} />
            <i className="rest" />
          </div>
          {caveat !== null && <p className="rates-covnote">{caveat}</p>}
          {covRows.length > 0 && (
            <ul className="rates-covlist">
              {covRows.map(r => (
                <li key={r.label}>
                  <span className="v">{r.value}</span>
                  <span className="k">{r.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default UsageRates;
