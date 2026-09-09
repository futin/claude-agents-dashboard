/**
 * probe-usage-split.ts — run both joint rate fits against this machine's real
 * logs, and print what they say about the per-token ratio between two models.
 *
 *   tsx scripts/probe-usage-split.ts [--dir <repo root>] [--reconstruct] [--days N] [--weekly]
 *
 * Exists because green unit tests are not evidence about live data here: the
 * first version of this fitter's join classified **759 of 759** real intervals
 * as `gap` with every test passing (`docs/subsystems/usage-limits.md`). The
 * question this answers is the one `task-10` was filed on — the measured
 * opus:fable cost per weighted token is ~4.2x where the API list price is
 * 2.00x (checked 2026-09-02; the limit's own weighting is unpublished), and a
 * missing per-request term is the hypothesis. If separating the terms does not
 * move that ratio down, the hypothesis is wrong and belongs back in `bug-13`.
 *
 * `--weekly` adds the same treatment for the **weekly** window: how much of the
 * record carries a weekly reading at all, every window boundary the record saw
 * and the wall time between consecutive ones, the weekly interval tally, and the
 * pooled and fitted weekly rates with their refusals. The boundary list is the
 * instrument for the cadence question — `docs/subsystems/usage-limits.md`'s ⚠️
 * has been guessing between 7 days and the 72 hours community reports claim, and
 * this account saw the counter reset twice inside one nominal week
 * (2026-09-01 and 2026-09-04). This prints that directly rather than by report.
 *
 * `--reconstruct` replays `~/.claude/projects/**.jsonl` to synthesize the `req`
 * counts for ledger lines written before the recorder produced them, so the
 * probe can be run before a day of live recording exists. It is an
 * approximation of what the recorder would have written, not the same thing:
 * the recorder dedups `message.id` per transcript against a bounded ring as it
 * streams, while this dedups globally over whole files, and any transcript
 * since deleted or rotated is simply missing. Both differences can only
 * *under*-count requests for older ticks. Lines that already carry `req` are
 * left exactly as they are.
 *
 *   stdout   one report, human-readable
 *   exit 0   the fit ran (whatever it concluded)
 *   exit 1   not enough data to fit anything
 */

import fs from 'node:fs';

import { listUsageTranscripts, projectsRoot } from '../server/lib/scan.js';
import { readRecentSamples, repoRoot, sameWindow } from '../server/lib/usage-history.js';
import type { UsageSample } from '../server/lib/usage-history.js';
import { ledgerStartMs, rawTokens, readLedgerSince } from '../server/lib/usage-ledger.js';
import type { LedgerLine } from '../server/lib/usage-ledger.js';
import {
  CURRENT_FLOORS, CURRENT_MS, EXTERNAL_WEIGHTED_MAX_WEEKLY, SPLIT_FLOORS, SPLIT_MAX_R2,
  SPLIT_MIN_INDEPENDENT_SHARE, WEEKLY_FLOORS, coverageBreakdown, currentRange, explainRates,
  explainSplits, fitDeviation, isUnpriced, joinIntervals, joinWeeklyIntervals, ledgerBreakMs,
  rateFor
} from '../server/lib/usage-rate.js';
import type { RateFloors } from '../server/lib/usage-rate.js';

/** No floor: the probe reports the evidence itself rather than hiding it. */
const NO_FLOOR: RateFloors = { minIntervals: 1, minUtil: 0, minDays: 0 };
const pool = (i: Parameters<typeof rateFor>[0], m: string, from: number, to: number) =>
  rateFor(i, m, from, to, NO_FLOOR);

const DAY_MS = 86_400_000;
const MTOK = 1_000_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const RECONSTRUCT = process.argv.includes('--reconstruct');
const WEEKLY = process.argv.includes('--weekly');
const DIR = arg('dir') ?? repoRoot();
const DAYS = Number(arg('days') ?? 3);

/** Every assistant turn on disk in `[sinceMs, ∞)`, deduplicated by `message.id`. */
function transcriptEvents(sinceMs: number): { ts: number; model: string }[] {
  const events: { ts: number; model: string }[] = [];
  const seen = new Set<string>();
  let files = 0, skipped = 0;
  for (const ref of listUsageTranscripts(projectsRoot())) {
    try {
      if (fs.statSync(ref.file).mtimeMs < sinceMs) { skipped++; continue; }
    } catch { continue; }
    files++;
    let text: string;
    try { text = fs.readFileSync(ref.file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec?.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
      const tok = {
        in: Number(msg.usage.input_tokens) || 0,
        out: Number(msg.usage.output_tokens) || 0,
        cc: Number(msg.usage.cache_creation_input_tokens) || 0,
        cr: Number(msg.usage.cache_read_input_tokens) || 0
      };
      if (rawTokens(tok) <= 0) continue;
      const model = typeof msg.model === 'string' ? msg.model : '';
      if (!model) continue;
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      events.push({ ts, model });
    }
  }
  console.log(`  transcripts read: ${files} (${skipped} older than the window)`);
  return events.sort((a, b) => a.ts - b.ts);
}

/** Fill in `req` for lines that lack it, from the transcripts. */
function reconstruct(ledger: LedgerLine[], sinceMs: number): LedgerLine[] {
  const events = transcriptEvents(sinceMs - DAY_MS);
  return ledger.map((line) => {
    if (line.req !== undefined) return line;
    const req: Record<string, number> = {};
    for (const e of events) {
      if (e.ts <= line.prevT || e.ts > line.t) continue;
      req[e.model] = (req[e.model] ?? 0) + 1;
    }
    // Only the models the ledger itself recorded spend for; a transcript event
    // the recorder never saw must not invent a model in this line.
    for (const model of Object.keys(req)) if (!(model in line.tok)) delete req[model];
    for (const model of Object.keys(line.tok)) if (!(model in req)) req[model] = 0;
    return { ...line, req };
  });
}

/**
 * The weekly half of the report — what `--weekly` exists for.
 *
 * Green unit tests are not evidence about live data here (759 of 759 intervals
 * once classified `gap` with the whole suite passing), and the weekly series has
 * two extra ways to read as empty that the 5-hour one does not: a record written
 * before the field existed, and a counter that has not ticked yet. Both are
 * printed as counts rather than inferred from an empty table.
 */
function weeklyReport(
  samples: UsageSample[], ledger: LedgerLine[], startMs: number | null,
  nowMs: number, sinceMs: number
): void {
  console.log('\n  ── the weekly window ──');
  const carrying = samples.filter((s) => s.week !== undefined).length;
  console.log(`  samples carrying a week field: ${carrying} / ${samples.length}`);
  if (carrying === 0) {
    console.log('  nothing to join — every line predates the widened record.');
    return;
  }

  // Every distinct published boundary, in the order the record saw them, with
  // the wall time between consecutive stamps. 168 h is what the name implies;
  // 72 h is what this account actually saw between 2026-09-01 and 2026-09-04.
  const boundaries: { stamp: string | null; firstSeen: number }[] = [];
  for (const sample of samples) {
    const week = sample.week;
    if (week === undefined) continue;
    const last = boundaries[boundaries.length - 1];
    if (last !== undefined && sameWindow(last.stamp, week.resetsAt)) continue;
    boundaries.push({ stamp: week.resetsAt, firstSeen: sample.t });
  }
  console.log(`  weekly window boundaries observed: ${boundaries.length}`);
  for (let i = 0; i < boundaries.length; i++) {
    const { stamp, firstSeen } = boundaries[i];
    const prev = i > 0 ? boundaries[i - 1].stamp : null;
    const gapH = prev !== null && stamp !== null
      ? (Date.parse(stamp) - Date.parse(prev)) / 3_600_000
      : null;
    console.log(`    ${stamp ?? 'no window reported'}   first seen `
      + `${new Date(firstSeen).toISOString()}`
      + (gapH === null ? '' : `   +${gapH.toFixed(1)} h since the previous stamp`));
  }

  const intervals = joinWeeklyIntervals(samples, ledger, startMs).filter((i) => i.toT >= sinceMs);
  const byKind = new Map<string, { n: number; pts: number }>();
  for (const i of intervals) {
    const key = typeof i.kind === 'object' ? 'owned:' + i.kind.model : i.kind;
    const acc = byKind.get(key) ?? { n: 0, pts: 0 };
    acc.n++; acc.pts += i.dUtil;
    byKind.set(key, acc);
  }
  console.log(`\n  weekly intervals: ${intervals.length}`
    + `  (external threshold ${EXTERNAL_WEIGHTED_MAX_WEEKLY} weighted)`);
  for (const [kind, { n, pts }] of [...byKind].sort((a, b) => b[1].pts - a[1].pts)) {
    console.log(`    ${kind}: ${n} intervals, ${pts.toFixed(1)} pts`);
  }
  if (intervals.length === 0) {
    console.log('    the weekly counter has not ticked inside a recorded window yet.');
    return;
  }

  const cur = currentRange(nowMs);
  console.log(`\n  weekly rates over the last ${CURRENT_MS / DAY_MS}d `
    + `(floors ${WEEKLY_FLOORS.minIntervals}/${WEEKLY_FLOORS.minUtil}/${WEEKLY_FLOORS.minDays}):`);
  const models = [...new Set(intervals.flatMap((i) => Object.keys(i.tok)))].sort();
  for (const model of models) {
    const evidence = pool(intervals, model, cur.sinceMs, cur.untilMs);
    const gated = rateFor(intervals, model, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS);
    if (evidence === null) { console.log(`    ${model}: owns no weekly interval`); continue; }
    const counters = `${evidence.intervals} owned, ${evidence.utilSum.toFixed(1)} pts`
      + `, ${evidence.days} days`;
    console.log(`    ${model}: pooled `
      + (gated === null
        ? `refused (thin) — measured ${(evidence.weightedPerPct / MTOK).toFixed(3)}M weighted/pt`
        : `${(gated.weightedPerPct / MTOK).toFixed(3)}M weighted/pt`)
      + `  (${counters})`);
  }
  for (const d of explainRates(intervals, cur.sinceMs, cur.untilMs, WEEKLY_FLOORS)) {
    const counters = `share=${d.independentShare.toFixed(4)}, ${d.intervals} intervals`
      + `, ${d.utilSum.toFixed(1)} pts, ${d.days} days`;
    console.log(`    ${d.model}: fitted `
      + (d.fit === null
        ? `none — ${d.refusal}`
        : `${(d.fit.weightedPerPct / MTOK).toFixed(3)}M weighted/pt`)
      + `  (${counters})`);
  }
  console.log('\n    Against the 1.8–2.8 M per weekly point measured on 2026-09-06 — a week in');
  console.log('    which the counter reset twice. If this week was abnormal too, say so and');
  console.log('    leave EXTERNAL_WEIGHTED_MAX_WEEKLY provisional rather than re-deriving.');
}

function main(): number {
  const nowMs = Date.now();
  const sinceMs = nowMs - DAYS * DAY_MS;
  console.log(`\n=== two-term rate probe — ${new Date(nowMs).toISOString()} ===\n`);
  console.log(`  dir: ${DIR}`);
  console.log(`  window: last ${DAYS}d`);

  const samples = readRecentSamples(DIR, 16_777_216);
  let ledger = readLedgerSince(sinceMs, DIR);
  const withCounts = ledger.filter((l) => l.req !== undefined).length;
  console.log(`  samples: ${samples.length}   ledger lines: ${ledger.length} (${withCounts} carry req)`);
  if (RECONSTRUCT && withCounts < ledger.length) {
    console.log('  reconstructing missing counts from transcripts…');
    ledger = reconstruct(ledger, sinceMs);
  }

  // The real start instant, so `pre-ledger` is separated from `gap` here
  // exactly as the endpoint separates them. Without it every unrecorded
  // interval reads as downtime — the failure this section exists to catch.
  const startMs = ledgerStartMs(DIR);
  const intervals = joinIntervals(samples, ledger, startMs).filter((i) => i.toT >= sinceMs);
  const byKind = new Map<string, number>();
  for (const i of intervals) {
    const key = typeof i.kind === 'object' ? 'owned:' + i.kind.model : i.kind;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  console.log(`\n  intervals: ${intervals.length}`);
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`    ${kind}: ${n}`);
  const usable = intervals.filter(
    (i) => i.reqUsable && !isUnpriced(i.kind) && i.kind !== 'external'
  );
  console.log(`    → usable for the two-term fit: ${usable.length}`);

  // What each refusal actually costs, in the same units the card discloses —
  // green unit tests have already shipped a join that called 759 of 759 live
  // intervals `gap`, so the buckets are only believable measured here.
  const buckets = coverageBreakdown(intervals, sinceMs, Number.POSITIVE_INFINITY);
  const breakHours = ledgerBreakMs(ledger, sinceMs, Number.POSITIVE_INFINITY) / 3_600_000;
  console.log(`\n  recording start: ${startMs === null
    ? 'unprovable (no ledger, or it may have rotated) — pre-ledger collapses into gap'
    : new Date(startMs).toISOString() + ' (provable)'}`);
  console.log(`  ledger breaks inside the window: ${breakHours.toFixed(2)} h`);
  console.log(`  coverage over ${buckets.moved.toFixed(1)} moved points:`);
  const countOf = (k: string): number => intervals.filter(
    (i) => (typeof i.kind === 'object' ? 'priced' : i.kind === 'pre-ledger' ? 'preLedger' : i.kind) === k
  ).length;
  for (const key of ['priced', 'mixed', 'external', 'preLedger', 'gap', 'partial'] as const) {
    const points = buckets[key];
    const pct = buckets.moved > 0 ? (points / buckets.moved) * 100 : 0;
    console.log(`    ${key}: ${countOf(key)} intervals, ${points.toFixed(1)} pts`
      + `, ${pct.toFixed(1)}% of moved`);
  }
  // Before the early return below: the weekly report is about the *history*
  // record and does not need request counts, so a ledger with none must not
  // suppress it.
  if (WEEKLY) weeklyReport(samples, ledger, startMs, nowMs, sinceMs);

  const models = [...new Set(usable.flatMap((i) => Object.keys(i.tok)))].sort();
  if (models.length === 0) {
    // Empty pre-upgrade ticks pass the count check trivially — no spend is no
    // missing measurement — so `usable` can be non-empty with nothing in it.
    console.log('\n  no model spent anything in a countable interval.');
    console.log('  Re-run with --reconstruct, or after a day of recording with counts.\n');
    return 1;
  }
  const cur = currentRange(nowMs);

  // The shipped pooled ratio, per model, over the same window.
  console.log('\n  pooled single ratio (what the card shows today):');
  const pooled = new Map<string, number>();
  for (const model of models) {
    const fitted = pool(intervals, model, cur.sinceMs, cur.untilMs);
    if (!fitted) { console.log(`    ${model}: no owned interval`); continue; }
    pooled.set(model, fitted.weightedPerPct);
    console.log(`    ${model}: ${(fitted.weightedPerPct / MTOK).toFixed(3)}M weighted/pt`
      + `  (${fitted.intervals} intervals, ${fitted.utilSum.toFixed(1)} pts)`);
  }

  // The one-term joint fit, **gated** — what the card actually publishes beside
  // the pooled rate, refusals and all. An ungated OLS here is how a model the
  // server refuses gets cited as a measurement, which is a mistake this probe
  // has already made once.
  const rateDiagnostics = explainRates(intervals, cur.sinceMs, cur.untilMs);
  const oneTerm = new Map(rateDiagnostics.filter((d) => d.fit).map((d) => [d.model, d.fit!]));
  console.log(`\n  one-term joint fit vs the pooled rate (floors ${CURRENT_FLOORS.minIntervals}/`
    + `${CURRENT_FLOORS.minUtil}/${CURRENT_FLOORS.minDays},`
    + ` independent share ≥ ${SPLIT_MIN_INDEPENDENT_SHARE}):`);
  for (const d of rateDiagnostics) {
    const evidence = `share=${d.independentShare.toFixed(4)}, ${d.intervals} intervals`
      + `, ${d.utilSum.toFixed(1)} pts, ${d.days} days`;
    if (!d.fit) {
      const raw = d.raw === null ? '' : `, least squares wanted ${d.raw.toFixed(4)} pt/Mtok`;
      console.log(`    ${d.model}: no fitted rate — ${d.refusal}  (${evidence}${raw})`);
      continue;
    }
    // Recomputed rather than read out of `pooled` above: that map is keyed by
    // `models`, which comes from the *two-term* usable set and so still
    // requires `reqUsable`. A model that owns windows but appears only on
    // pre-upgrade ledger lines is missing from it, and reporting that as "owns
    // no window" would be a different — and false — statement.
    const owned = pool(intervals, d.model, cur.sinceMs, cur.untilMs);
    const p = owned?.weightedPerPct;
    const gap = p === undefined || p <= 0
      ? `no pooled rate — this model owns no window in the last ${CURRENT_MS / DAY_MS}d`
      : `pooled ${(p / MTOK).toFixed(4)}M over ${owned!.intervals} owned, gap `
        + `${(fitDeviation(d.fit.weightedPerPct, p) ?? 0).toFixed(1)}%`;
    console.log(`    ${d.model}: fitted ${(d.fit.weightedPerPct / MTOK).toFixed(4)}M weighted/pt`
      + `  (${gap})`);
    console.log(`      ${d.fit.pctPerMWeighted.toFixed(4)} pt/Mtok  (${evidence})`);
  }

  // This branch's estimator, with its reasoning for every model — a bare
  // "thin" is not a finding, and which gate refused is the whole diagnosis.
  const diagnostics = explainSplits(intervals, cur.sinceMs, cur.untilMs);
  const splits = new Map(diagnostics.filter((d) => d.fit).map((d) => [d.model, d.fit!]));
  console.log(`\n  two-term fit (floors ${SPLIT_FLOORS.minIntervals}/${SPLIT_FLOORS.minUtil},`
    + ` r² ceiling ${SPLIT_MAX_R2}, independent share ≥ ${SPLIT_MIN_INDEPENDENT_SHARE}):`);
  for (const d of diagnostics) {
    const evidence = `r²=${d.r2.toFixed(4)}, share=${d.independentShare.toFixed(4)}`
      + `, ${d.intervals} intervals, ${d.utilSum.toFixed(1)} pts`;
    if (!d.fit) {
      const raw = d.raw
        ? `, least squares wanted tok=${d.raw.pctPerMWeighted.toFixed(4)} pt/Mtok`
          + ` req=${d.raw.pctPerRequest.toFixed(5)} pt/request`
        : '';
      console.log(`    ${d.model}: no split — ${d.refusal}  (${evidence}${raw})`);
      continue;
    }
    console.log(`    ${d.model}: ${d.fit.pctPerMWeighted.toFixed(4)} pt/Mtok`
      + `  +  ${d.fit.pctPerRequest.toFixed(5)} pt/request  (${evidence})`);
    // How much of this model's measured movement the request term explains —
    // the size of the thing a single ratio was hiding.
    let reqs = 0, moved = 0;
    for (const interval of usable) {
      if (!(d.model in interval.tok)) continue;
      reqs += interval.req[d.model] ?? 0;
      moved += interval.dUtil;
    }
    const explained = (d.fit.pctPerRequest * reqs) / moved;
    console.log(`      ${Math.round(reqs)} requests → ${(explained * 100).toFixed(1)}%`
      + ` of the ${moved.toFixed(1)} points it appears in`);
  }

  // The headline: the per-token ratio, before and after.
  const [a, b] = models
    .map((m) => ({ m, util: pool(intervals, m, cur.sinceMs, cur.untilMs)?.utilSum ?? 0 }))
    .sort((x, y) => y.util - x.util)
    .slice(0, 2)
    .map((x) => x.m);
  console.log('\n  ── the ratio task-10 was filed on ──');
  if (!a || !b) {
    console.log('    fewer than two models in this window; nothing to compare.');
    return 0;
  }
  const ratio = (get: (m: string) => number | undefined): string => {
    const x = get(a), y = get(b);
    if (x === undefined || y === undefined || x <= 0 || y <= 0) return 'n/a';
    return (y / x).toFixed(2) + 'x';
  };
  console.log(`    ${a} : ${b}, cost per weighted token`);
  console.log(`      pooled single ratio: ${ratio((m) => {
    const w = pooled.get(m);
    return w === undefined || w <= 0 ? undefined : 1 / w;
  })}`);
  console.log(`      one-term joint fit:  ${ratio((m) => oneTerm.get(m)?.pctPerMWeighted)}`);
  console.log(`      two-term fit:        ${ratio((m) => splits.get(m)?.pctPerMWeighted)}`);
  // The counterfactual, because "n/a" hides whether the gap would have closed:
  // what the ratio would be if the sign refusal were lifted. Never shippable —
  // a negative per-request cost is not a price — but it is the answer to
  // "would a per-request term have explained the 4.2x?".
  const rawOf = new Map(diagnostics.map((d) => [d.model, d.raw]));
  console.log(`      same fit, sign refusal lifted (diagnostic only): `
    + ratio((m) => rawOf.get(m)?.pctPerMWeighted));
  console.log('\n    A two-term ratio that has not fallen toward the 2.00x list-price ratio refutes');
  console.log('    the missing-per-request-term hypothesis. Say so rather than reporting');
  console.log('    the new number as an improvement.\n');
  return 0;
}

process.exit(main());
