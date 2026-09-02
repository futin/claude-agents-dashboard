/**
 * probe-usage-split.ts — run the two-term rate fit against this machine's real
 * logs, and print what it says about the per-token ratio between two models.
 *
 *   tsx scripts/probe-usage-split.ts [--dir <repo root>] [--reconstruct] [--days N]
 *
 * Exists because green unit tests are not evidence about live data here: the
 * first version of this fitter's join classified **759 of 759** real intervals
 * as `gap` with every test passing (`docs/subsystems/usage-limits.md`). The
 * question this answers is the one `task-10` was filed on — the measured
 * opus:fable cost per weighted token is ~4.2x against a ~2x list price, and a
 * missing per-request term is the hypothesis. If separating the terms does not
 * move that ratio down, the hypothesis is wrong and belongs back in `bug-13`.
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

import { listTranscripts, projectsRoot } from '../server/lib/scan.js';
import { readRecentSamples, repoRoot } from '../server/lib/usage-history.js';
import { rawTokens, readLedgerSince, weightedTokens } from '../server/lib/usage-ledger.js';
import type { LedgerLine } from '../server/lib/usage-ledger.js';
import {
  SPLIT_FLOORS, SPLIT_MAX_R2, SPLIT_MIN_INDEPENDENT_SHARE,
  currentRange, explainSplits, joinIntervals, rateFor
} from '../server/lib/usage-rate.js';
import type { RateFloors } from '../server/lib/usage-rate.js';

/** No floor: the probe reports the evidence itself rather than hiding it. */
const NO_FLOOR: RateFloors = { minIntervals: 1, minUtil: 0 };
const pool = (i: Parameters<typeof rateFor>[0], m: string, from: number, to: number) =>
  rateFor(i, m, from, to, NO_FLOOR);

const DAY_MS = 86_400_000;
const MTOK = 1_000_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const RECONSTRUCT = process.argv.includes('--reconstruct');
const DIR = arg('dir') ?? repoRoot();
const DAYS = Number(arg('days') ?? 3);

/** Every assistant turn on disk in `[sinceMs, ∞)`, deduplicated by `message.id`. */
function transcriptEvents(sinceMs: number): { ts: number; model: string }[] {
  const events: { ts: number; model: string }[] = [];
  const seen = new Set<string>();
  let files = 0, skipped = 0;
  for (const ref of listTranscripts(projectsRoot())) {
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

/** Ordinary least squares, normal equations, unit-normed columns. No intercept. */
function ols(X: number[][], y: number[]): number[] | null {
  const width = X[0]?.length ?? 0;
  if (width === 0) return null;
  const norms = new Array<number>(width).fill(0);
  for (const row of X) for (let c = 0; c < width; c++) norms[c] += row[c] * row[c];
  for (let c = 0; c < width; c++) {
    norms[c] = Math.sqrt(norms[c]);
    if (norms[c] === 0) return null;
  }
  const A = Array.from({ length: width }, (_, i) => Array.from({ length: width }, (_, j) => {
    let acc = 0;
    for (const row of X) acc += (row[i] / norms[i]) * (row[j] / norms[j]);
    return acc;
  }));
  const b = Array.from({ length: width }, (_, i) => {
    let acc = 0;
    for (let r = 0; r < X.length; r++) acc += (X[r][i] / norms[i]) * y[r];
    return acc;
  });
  for (let col = 0; col < width; col++) {
    let pivot = col;
    for (let r = col + 1; r < width; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = col + 1; r < width; r++) {
      const factor = A[r][col] / A[col][col];
      for (let c = col; c < width; c++) A[r][c] -= factor * A[col][c];
      b[r] -= factor * b[col];
    }
  }
  const z = new Array<number>(width).fill(0);
  for (let r = width - 1; r >= 0; r--) {
    let acc = b[r];
    for (let c = r + 1; c < width; c++) acc -= A[r][c] * z[c];
    z[r] = acc / A[r][r];
  }
  return z.map((v, c) => v / norms[c]);
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

  const intervals = joinIntervals(samples, ledger).filter((i) => i.toT >= sinceMs);
  const byKind = new Map<string, number>();
  for (const i of intervals) {
    const key = typeof i.kind === 'object' ? 'owned:' + i.kind.model : i.kind;
    byKind.set(key, (byKind.get(key) ?? 0) + 1);
  }
  console.log(`\n  intervals: ${intervals.length}`);
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`    ${kind}: ${n}`);
  const usable = intervals.filter(
    (i) => i.reqUsable && i.kind !== 'gap' && i.kind !== 'external'
  );
  console.log(`    → usable for the two-term fit: ${usable.length}`);
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

  // bug-13's estimator: one regressor per model, no request term, same rows.
  const oneTerm = ols(
    usable.map((i) => models.map((m) => (i.tok[m] ? weightedTokens(i.tok[m]) / MTOK : 0))),
    usable.map((i) => i.dUtil)
  );
  console.log('\n  one-term joint OLS over the usable set (bug-13’s estimator):');
  if (oneTerm === null) console.log('    singular');
  else models.forEach((m, k) => console.log(
    `    ${m}: ${oneTerm[k].toFixed(4)} pt/Mtok`
    + (oneTerm[k] > 0 ? `  = ${(1 / oneTerm[k]).toFixed(3)}M weighted/pt` : '')
  ));

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
  console.log(`      one-term joint OLS:  ${ratio((m) => oneTerm?.[models.indexOf(m)])}`);
  console.log(`      two-term fit:        ${ratio((m) => splits.get(m)?.pctPerMWeighted)}`);
  // The counterfactual, because "n/a" hides whether the gap would have closed:
  // what the ratio would be if the sign refusal were lifted. Never shippable —
  // a negative per-request cost is not a price — but it is the answer to
  // "would a per-request term have explained the 4.2x?".
  const rawOf = new Map(diagnostics.map((d) => [d.model, d.raw]));
  console.log(`      same fit, sign refusal lifted (diagnostic only): `
    + ratio((m) => rawOf.get(m)?.pctPerMWeighted));
  console.log('\n    A two-term ratio that has not fallen toward the ~2x price ratio refutes');
  console.log('    the missing-per-request-term hypothesis. Say so rather than reporting');
  console.log('    the new number as an improvement.\n');
  return 0;
}

process.exit(main());
