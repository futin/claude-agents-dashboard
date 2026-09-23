/**
 * rates-audit.ts — audit the Token-value card's inputs against the transcripts.
 *
 *   tsx scripts/rates-audit.ts <ledger|surfaces|modifiers|offbook|gap>
 *       [--root <projects dir>]... [--dir <repo root>] [--days N] [--model <id>] [--tz <IANA zone>]
 *
 * Every token figure here is re-derived from `~/.claude/projects/**.jsonl`
 * directly — a data path independent of `.usage-ledger.jsonl` — so the recorder
 * and the card can be audited the way `pnpm check:weights` audits
 * `TYPE_WEIGHTS`. The ledger is read only for its tick boundaries and, in
 * `ledger`, as the thing being checked. The pipeline lives in
 * `scripts/lib/transcript-audit.ts`.
 *
 *   ledger     does the ledger hold what the account spent? Per UTC day × model
 *              over the last `--days` (7) complete days. The gate `pnpm
 *              check:ledger` runs: exit 1 naming every row with ≥ 5M disk
 *              weight whose recorded/disk ratio is outside [0.95, 1.05].
 *   surfaces   is a `drift` badge a repricing or a desktop↔headless mix shift?
 *              Per window × dominant `entrypoint` for `--model` (claude-opus-5),
 *              beside the real `driftRow`. Report only.
 *   modifiers  did the *requests* change — speed, service tier, effort, >200k
 *              context? Per UTC day for `--model`. Report only.
 *   offbook    spend with no usage record — API errors, usage-less assistant
 *              lines, compactions — per `entrypoint`. Raw line counts, not
 *              deduplicated. Report only.
 *   gap        why does a headless token spend more of the 5-hour window than
 *              an interactive one? Over the full baseline range, `--model`
 *              bins split interactive vs headless, the foreign-spend check,
 *              one table per on-disk covariate (permission mode, concurrency,
 *              nested share, utilization band, API errors) with the share of
 *              the gap each explains, and a verdict. `--root` may repeat: the
 *              roots are walked as one corpus, deduplicated on `message.id`.
 *              Report only.
 *
 * `probe-usage-split.ts --reconstruct` has its own transcript replay for the
 * `req` counts; the overlap is known and left alone.
 *
 *   exit 0   the report ran (for `ledger`: and every gated row reconciles)
 *   exit 1   `ledger` found a row that does not reconcile
 *   exit 2   unknown subcommand
 */

import { projectsRoot } from '../server/lib/scan.js';
import { RATES_HISTORY_BYTES, readRecentSamples } from '../server/lib/usage-history.js';
import { ledgerStartMs, rawTokens, readLedgerSince } from '../server/lib/usage-ledger.js';
import {
  BASELINE_MS, baselineRange, currentRange, driftRow, EXTERNAL_WEIGHTED_MAX, joinIntervals
} from '../server/lib/usage-rate.js';
import type { DriftRow, Interval } from '../server/lib/usage-rate.js';
import {
  addBin as addBinFor, binCovariates, completeDays, COVARIATES, DAY_MS, emptyAcc, explainedShare, formatShares,
  GATE_FLOOR_WEIGHTED, gapRatio, gapVerdict, gateFailures, isInteractive, ledgerRows, mergeBins, mergeLevels,
  MIXED_SURFACE, modelDominates, modifierRows, readOffbookMarks, readRecords, rebuildLedger, recordWeighted, scanFiles,
  stratify, surfaceLabel, walkTranscripts
} from './lib/transcript-audit.js';
import type { Acc, AuditFile, AuditRecord, Bin, Covariate, LabelledBin } from './lib/transcript-audit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Every value of a repeatable flag, in order. */
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === '--' + name) out.push(process.argv[i + 1]);
  return out;
}

/** The first bare word that is not a flag's value — `pnpm audit:rates -- surfaces` may pass the `--` through. */
function subcommand(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    if (args[i].startsWith('--')) { i++; continue; }
    return args[i];
  }
  return undefined;
}

const SUB = subcommand();
const ROOT = arg('root') ?? projectsRoot();
const ROOTS = args('root').length > 0 ? args('root') : [ROOT];
const DIR = arg('dir');
const DAYS = Number(arg('days') ?? 7);
const MODEL = arg('model') ?? 'claude-opus-5';
const TZ = arg('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const NOW = Date.now();

/** Σutil under this is ±33% rounding noise, so a row that thin is suppressed and counted. */
const MIN_ROW_UTIL = 3;

const M = (n: number): string => (n / 1e6).toFixed(2) + 'M';
const K = (n: number): string => (n / 1e3).toFixed(0) + 'k';
const P = (n: number, d: number): string => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : '-');

function header(title: string, files: number, records: number, roots: string[] = [ROOT]): void {
  console.log(`\n${title}\n  root ${roots.join(', ')}\n  ${files} transcripts, ${records} records\n`);
}

// ── ledger ──

function runLedger(): number {
  const { sinceMs, untilMs } = completeDays(NOW, DAYS);
  const files = walkTranscripts(ROOT, sinceMs);
  const records = readRecords(files);
  const rows = ledgerRows(records, readLedgerSince(sinceMs, DIR), sinceMs, untilMs);
  header(`ledger — ${DAYS} complete UTC days, disk vs recorded weighted tokens`, files.length, records.length);

  console.log('  day         model                          disk-top   nested     disk       in-ticks   recorded   ratio');
  for (const r of rows) {
    console.log('  ' + r.day + '  ' + r.model.padEnd(30)
      + M(r.diskTop).padStart(9) + M(r.diskNested).padStart(11) + M(r.disk).padStart(11)
      + M(r.inTicks).padStart(11) + M(r.recorded).padStart(11) + (r.ratio === null ? '-' : r.ratio.toFixed(3)).padStart(8)
      + (r.disk < GATE_FLOOR_WEIGHTED ? '   (under floor)' : ''));
  }
  const failures = gateFailures(rows);
  console.log('\n  in-ticks: the disk weight that fell inside a real ledger tick. A ratio low against disk but not');
  console.log('  against in-ticks is recorder downtime; low against both is a blind spot.\n');
  if (failures.length > 0) {
    for (const r of failures) {
      console.log(`  ✗ ${r.day} ${r.model}: recorded ${M(r.recorded)} of ${M(r.disk)} on disk `
        + `(ratio ${r.ratio === null ? '-' : r.ratio.toFixed(3)})`);
    }
    console.log(`\nFAIL (${failures.length}) — the ledger does not hold what the transcripts spent`);
    return 1;
  }
  console.log('OK — every row over the floor reconciles within ±5%.');
  return 0;
}

// ── surfaces ──

const addBin = (acc: Acc, bin: Bin, requests: number): void => addBinFor(acc, bin, requests, MODEL);

/** Rows keyed by label, printed with the thin ones suppressed and counted. */
function printAccs(rows: Map<string, Acc>, labelWidth: number): void {
  let suppressed = 0;
  for (const [label, a] of rows) {
    if (a.util < MIN_ROW_UTIL) { suppressed++; continue; }
    console.log('  ' + label.padEnd(labelWidth) + String(a.bins).padStart(6) + a.util.toFixed(1).padStart(8)
      + K(a.weighted / a.util).padStart(10) + K(a.requests > 0 ? a.weighted / a.requests : 0).padStart(9)
      + P(a.ccW, a.weighted).padStart(8) + P(a.crW, a.weighted).padStart(8) + P(a.outW, a.weighted).padStart(8)
      + K(a.requests > 0 ? a.cc / a.requests : 0).padStart(9) + K(a.requests > 0 ? a.cr / a.requests : 0).padStart(9));
  }
  if (suppressed > 0) console.log(`  (${suppressed} row${suppressed === 1 ? '' : 's'} under Σutil ${MIN_ROW_UTIL} suppressed)`);
}

function colHeader(label: string, width: number): void {
  console.log('  ' + label.padEnd(width) + '  bins    Σutil  w/1%      w/req    cc%     cr%     out%    cc/req   cr/req');
}

/** `weekday 08–20`, `weekday night` or `weekend`, in `TZ`. */
const tzParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
function period(ms: number): string {
  const parts = tzParts.formatToParts(new Date(ms));
  const wd = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  if (wd === 'Sat' || wd === 'Sun') return 'weekend';
  return hour >= 8 && hour < 20 ? 'weekday 08-20' : 'weekday night';
}

function printDrift(label: string, row: DriftRow): void {
  const f = (n: number | null): string => (n === null ? '-' : K(n));
  const d = (n: number | null): string => (n === null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%');
  console.log(`  ${label.padEnd(10)} baseline ${f(row.baselineWeightedPerPct)}/1%  current ${f(row.weightedPerPct)}/1%  `
    + `pooled ${d(row.deviationPct)}  mix-adjusted ${d(row.mixAdjustedDeviationPct)}  verdict ${row.verdict}`);
}

function runSurfaces(): number {
  const sinceMs = NOW - BASELINE_MS;
  const files = walkTranscripts(ROOT, sinceMs);
  const all = readRecords(files);
  // Every model goes into the rebuild — an interval's owner is judged on its
  // whole spend — and only this model's records label a bin's surface.
  const records = all.filter(r => r.model === MODEL && rawTokens(r.tok) > 0).sort((a, b) => a.ts - b.ts);
  const ticks = readLedgerSince(sinceMs, DIR);
  const rebuild = rebuildLedger(all, ticks);
  const samples = readRecentSamples(DIR, RATES_HISTORY_BYTES);
  const start = ledgerStartMs(DIR);
  const synthetic: Interval[] = joinIntervals(samples, rebuild.lines, start);
  const real: Interval[] = joinIntervals(samples, ticks, start);
  header(`surfaces — ${MODEL}, bins by dominant entrypoint (tz ${TZ})`, files.length, all.length);
  console.log(`  ${ticks.length} ledger ticks, ${all.length - rebuild.outsideTick} records placed, `
    + `${rebuild.outsideTick} outside every tick\n`);

  // Bins are sorted by `toT` and never overlap, so one forward pointer over
  // the sorted records assigns each record to at most one bin.
  const windows = [['baseline', baselineRange(NOW)], ['current', currentRange(NOW)]] as const;
  const byWindow = new Map<string, Map<string, Acc>>(windows.map(([w]) => [w, new Map()]));
  const pooled = new Map<string, Acc>(windows.map(([w]) => [w, emptyAcc()]));
  const cross = new Map<string, Acc>();
  let i = 0;
  for (const bin of mergeBins(synthetic)) {
    while (i < records.length && records[i].ts <= bin.fromT) i++;
    const byEp = new Map<string, number>();
    let requests = 0;
    for (let j = i; j < records.length && records[j].ts <= bin.toT; j++) {
      byEp.set(records[j].entrypoint, (byEp.get(records[j].entrypoint) ?? 0) + recordWeighted(records[j]));
      requests++;
    }
    if (!bin.tok[MODEL] || !modelDominates(bin, MODEL)) continue;
    const surface = surfaceLabel(byEp);
    for (const [w, range] of windows) {
      if (bin.toT < range.sinceMs || bin.toT >= range.untilMs) continue;
      const rows = byWindow.get(w)!;
      addBin(rows.get(surface) ?? rows.set(surface, emptyAcc()).get(surface)!, bin, requests);
      addBin(pooled.get(w)!, bin, requests);
    }
    const key = surface.padEnd(16) + period(bin.toT);
    addBin(cross.get(key) ?? cross.set(key, emptyAcc()).get(key)!, bin, requests);
  }

  for (const [w] of windows) {
    console.log(`  ${w} window`);
    colHeader('surface', 16);
    printAccs(byWindow.get(w)!, 16);
    printAccs(new Map([['(pooled)', pooled.get(w)!]]), 16);
    console.log('');
  }
  console.log('  driftRow — the card\'s own verdict, and the same fit on the rebuilt ledger');
  printDrift('real', driftRow(real, MODEL, NOW));
  printDrift('rebuilt', driftRow(synthetic, MODEL, NOW));
  console.log(`\n  surface × period, full ${BASELINE_MS / DAY_MS}-day range`);
  colHeader('surface         period', 30);
  printAccs(new Map([...cross].sort((a, b) => a[0].localeCompare(b[0]))), 30);
  console.log(`\n  (${MIXED_SURFACE}: no entrypoint held 80% of the bin's ${MODEL} weight)`);
  return 0;
}

// ── modifiers ──

function runModifiers(): number {
  const sinceMs = NOW - DAYS * DAY_MS;
  const files = walkTranscripts(ROOT, sinceMs);
  const records = readRecords(files).filter(r => r.ts >= sinceMs);
  header(`modifiers — ${MODEL}, per UTC day`, files.length, records.length);
  for (const r of modifierRows(records, MODEL)) {
    console.log(`  ${r.day}  ${M(r.weighted)} weighted, ${r.requests} requests, `
      + `mean context ${K(r.contextSum / r.requests)}, mean output ${K(r.outputSum / r.requests)}, `
      + `>200k context ${P(r.longContext, r.weighted)}`);
    console.log(`    speed   ${formatShares(r.bySpeed)}`);
    console.log(`    tier    ${formatShares(r.byTier)}`);
    console.log(`    effort  ${formatShares(r.byEffort)}`);
  }
  return 0;
}

// ── offbook ──

interface Offbook {
  sessions: Set<string>;
  assistant: number;
  noUsage: number;
  apiErrors: number;
  errorPrefixes: Map<string, number>;
  stopReasons: Map<string, number>;
  types: Map<string, number>;
  /** `system` / `compact_boundary` lines, by `compactMetadata.trigger`. */
  compactions: Map<string, number>;
  /** The user-role summary line a compaction writes after its boundary. */
  compactSummaries: number;
}

function count(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function top(m: Map<string, number>, n = Infinity): string {
  const e = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return e.length === 0 ? '-' : e.map(([k, v]) => `${k}=${v}`).join(' ');
}

function errorText(raw: Record<string, any>): string {
  const c = raw.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(b => (typeof b?.text === 'string' ? b.text : '')).join(' ') : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 50) || '(empty)';
}

function runOffbook(): number {
  const sinceMs = NOW - DAYS * DAY_MS;
  const files = walkTranscripts(ROOT, sinceMs);
  const byEp = new Map<string, Offbook>();
  let lines = 0;
  scanFiles(files, (raw) => {
    const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
    if (Number.isFinite(ts) && ts < sinceMs) return;
    lines++;
    const ep = typeof raw.entrypoint === 'string' && raw.entrypoint ? raw.entrypoint : '(none)';
    let o = byEp.get(ep);
    if (!o) {
      byEp.set(ep, o = {
        sessions: new Set(), assistant: 0, noUsage: 0, apiErrors: 0, errorPrefixes: new Map(),
        stopReasons: new Map(), types: new Map(), compactions: new Map(), compactSummaries: 0
      });
    }
    if (typeof raw.sessionId === 'string') o.sessions.add(raw.sessionId);
    count(o.types, typeof raw.type === 'string' ? raw.type : '(none)');
    if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
      count(o.compactions, String(raw.compactMetadata?.trigger ?? '(none)'));
    }
    if (raw.isCompactSummary === true) o.compactSummaries++;
    if (raw.message?.role !== 'assistant') return;
    o.assistant++;
    if (!raw.message.usage || typeof raw.message.usage !== 'object') o.noUsage++;
    count(o.stopReasons, typeof raw.message.stop_reason === 'string' ? raw.message.stop_reason : '(none)');
    if (raw.isApiErrorMessage === true) {
      o.apiErrors++;
      count(o.errorPrefixes, errorText(raw));
    }
  });
  header(`offbook — last ${DAYS} days, raw lines per entrypoint`, files.length, lines);
  for (const [ep, o] of [...byEp].sort((a, b) => b[1].assistant - a[1].assistant)) {
    console.log(`  ${ep}: ${o.sessions.size} sessions, ${o.assistant} assistant lines, ${o.noUsage} without usage, `
      + `${o.apiErrors} API errors`);
    if (o.apiErrors > 0) console.log(`    errors      ${top(o.errorPrefixes, 5)}`);
    console.log(`    stop_reason ${top(o.stopReasons)}`);
    console.log(`    type        ${top(o.types)}`);
    console.log(`    compactions ${top(o.compactions)} (boundaries by trigger), ${o.compactSummaries} summaries`);
  }
  return 0;
}

// ── gap ──

/** How far either side of a bin an `external` interval counts as "near" it. */
const NEAR_EXTERNAL_MS = 30 * 60_000;

function runGap(): number {
  const sinceMs = NOW - BASELINE_MS;
  const seenFiles = new Set<string>();
  const files: AuditFile[] = [];
  for (const root of ROOTS) {
    for (const f of walkTranscripts(root, sinceMs)) if (!seenFiles.has(f.file)) { seenFiles.add(f.file); files.push(f); }
  }
  const all = readRecords(files);
  const records = all.filter(r => r.model === MODEL && rawTokens(r.tok) > 0).sort((a, b) => a.ts - b.ts);
  const ticks = readLedgerSince(sinceMs, DIR);
  const rebuild = rebuildLedger(all, ticks);
  const samples = readRecentSamples(DIR, RATES_HISTORY_BYTES);
  const intervals: Interval[] = joinIntervals(samples, rebuild.lines, ledgerStartMs(DIR))
    .filter(iv => iv.toT >= sinceMs);
  const utilAt = new Map(samples.map(s => [s.t, s.utilization]));
  const offbook = readOffbookMarks(files);
  header(`gap — ${MODEL}, interactive vs headless window cost, full ${BASELINE_MS / DAY_MS}-day range (tz ${TZ})`,
    files.length, all.length, ROOTS);
  console.log(`  ${ticks.length} ledger ticks, ${samples.length} usage samples, ${all.length - rebuild.outsideTick} records placed, `
    + `${rebuild.outsideTick} outside every tick\n`);

  const labelled: LabelledBin[] = [];
  let i = 0;
  for (const bin of mergeBins(intervals, utilAt)) {
    while (i < records.length && records[i].ts <= bin.fromT) i++;
    const inBin: AuditRecord[] = [];
    for (let j = i; j < records.length && records[j].ts <= bin.toT; j++) inBin.push(records[j]);
    if (!bin.tok[MODEL] || !modelDominates(bin, MODEL)) continue;
    const cov = binCovariates(inBin, bin, offbook);
    if (cov) labelled.push({ bin, cov, requests: inBin.length });
  }

  // 1. The gap itself.
  const bySurface = new Map<string, Acc>();
  for (const { bin, cov, requests } of labelled) {
    addBin(bySurface.get(cov.surface) ?? bySurface.set(cov.surface, emptyAcc()).get(cov.surface)!, bin, requests);
  }
  const sideOf = (surface: string): 'interactive' | 'headless' | null =>
    surface === MIXED_SURFACE ? null : isInteractive(surface) ? 'interactive' : 'headless';
  const sides = { interactive: new Map<string, Acc>(), headless: new Map<string, Acc>() };
  for (const [surface, a] of bySurface) { const s = sideOf(surface); if (s) sides[s].set(surface, a); }
  const pool = (m: Map<string, Acc>): Map<string, Acc> =>
    new Map([['(pooled)', mergeLevels([...m.values()].map(a => new Map([['(pooled)', a]]))).get('(pooled)') ?? emptyAcc()]]);
  const pooledI = pool(sides.interactive), pooledH = pool(sides.headless);
  // A side under Σutil 3 is rounding noise; its ratio prints but no verdict is fitted on it.
  const thin = [pooledI, pooledH].some(m => m.get('(pooled)')!.util < MIN_ROW_UTIL);
  const rawRatio = gapRatio(pooledI, pooledH);
  const ratio = thin ? null : rawRatio;
  console.log('  1. the gap, re-measured');
  colHeader('surface', 16);
  printAccs(new Map([...bySurface].sort((a, b) => a[0].localeCompare(b[0]))), 16);
  const rate = (m: Map<string, Acc>): string => {
    const a = m.get('(pooled)')!;
    return a.util > 0 ? `${K(a.weighted / a.util)}/1% over ${a.bins} bins` : 'no bins';
  };
  console.log(`  interactive ${rate(pooledI)} (${[...sides.interactive.keys()].join(', ') || 'none'})`);
  console.log(`  headless    ${rate(pooledH)} (${[...sides.headless.keys()].join(', ') || 'none'})`);
  console.log(`  ratio       ${rawRatio === null ? '-' : rawRatio.toFixed(2) + 'x'} (interactive w/1% over headless w/1%; `
    + `${MIXED_SURFACE} bins are on neither side)${thin ? ` — a side is under Σutil ${MIN_ROW_UTIL}, so no verdict` : ''}\n`);

  // 2. Hypothesis 0: foreign spend.
  const external = intervals.filter(iv => iv.kind === 'external');
  const byPeriod = new Map<string, { ext: number; all: number }>();
  for (const iv of intervals) {
    if (iv.kind === 'idle') continue;
    const p = period(iv.toT);
    const e = byPeriod.get(p) ?? byPeriod.set(p, { ext: 0, all: 0 }).get(p)!;
    e.all += iv.dUtil;
    if (iv.kind === 'external') e.ext += iv.dUtil;
  }
  console.log(`  2. hypothesis 0, foreign spend — 'external' intervals: utilization rose, local weight < ${K(EXTERNAL_WEIGHTED_MAX)}`);
  console.log('  period          Σutil   external   share');
  for (const [p, e] of [...byPeriod].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log('  ' + p.padEnd(14) + e.all.toFixed(1).padStart(7) + e.ext.toFixed(1).padStart(11) + P(e.ext, e.all).padStart(8));
  }
  const near = new Map<string, { bins: number; near: number }>();
  for (const { bin, cov } of labelled) {
    const n = near.get(cov.surface) ?? near.set(cov.surface, { bins: 0, near: 0 }).get(cov.surface)!;
    n.bins++;
    if (external.some(x => x.toT >= bin.fromT - NEAR_EXTERNAL_MS && x.fromT <= bin.toT + NEAR_EXTERNAL_MS)) n.near++;
  }
  console.log('  surface           bins   near external   share');
  for (const [s, n] of [...near].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log('  ' + s.padEnd(16) + String(n.bins).padStart(6) + String(n.near).padStart(16) + P(n.near, n.bins).padStart(8));
  }
  console.log('  Foreign spend inside a priced bin cannot be split out on one machine: it raises utilization with no local');
  console.log('  transcript, so every per-machine rate is a lower bound. Join the other machine\'s transcripts with a second --root.\n');

  // 3. One stratified table per covariate.
  const shares: Partial<Record<Covariate, number | null>> = {};
  COVARIATES.forEach((c, n) => {
    const table = stratify(labelled, c, MODEL);
    const rows = new Map<string, Acc>();
    for (const [surface, levels] of [...table].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const [level, a] of [...levels].sort((x, y) => x[0].localeCompare(y[0]))) rows.set(surface.padEnd(16) + level, a);
    }
    const sideLevels = (side: 'interactive' | 'headless'): Map<string, Acc> =>
      mergeLevels([...table].filter(([s]) => sideOf(s) === side).map(([, levels]) => levels));
    const share = thin ? null : explainedShare(sideLevels('interactive'), sideLevels('headless'));
    shares[c] = share;
    console.log(`  3.${n + 1} ${c}`);
    colHeader('surface         level', 30);
    printAccs(rows, 30);
    console.log(`  explained share: ${share === null
      ? `null (a side under Σutil ${MIN_ROW_UTIL}, the gap under 1.3x, or covered levels under 80% of headless weight)`
      : share.toFixed(2)}\n`);
  });

  // 4. Verdict.
  console.log(`  verdict: ${gapVerdict(ratio, shares)}`);
  return 0;
}

const SUBCOMMANDS: Record<string, () => number> = {
  ledger: runLedger, surfaces: runSurfaces, modifiers: runModifiers, offbook: runOffbook, gap: runGap
};

const run = SUB === undefined ? undefined : SUBCOMMANDS[SUB];
if (!run) {
  console.error(`usage: tsx scripts/rates-audit.ts <${Object.keys(SUBCOMMANDS).join('|')}> `
    + '[--root <dir>] [--dir <repo root>] [--days N] [--model <id>] [--tz <zone>]');
  process.exit(2);
}
process.exit(run());

