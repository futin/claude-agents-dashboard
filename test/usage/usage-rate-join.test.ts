import assert from 'node:assert';

import { HEADLESS_ENTRYPOINT } from '../../server/lib/entrypoint.js';
import type { UsageSample } from '../../server/lib/usage-history.js';
import { addCounts, emptyCounts, scaleCounts } from '../../server/lib/usage-ledger.js';
import type { LedgerLine, TokenCounts } from '../../server/lib/usage-ledger.js';
import type { Interval } from '../../server/lib/usage-rate.js';
import { gather, indexLedger, joinIntervals, joinWeeklyIntervals, rateSurface } from '../../server/lib/usage-rate.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;

/**
 * The full-scan join as it stood before the windowed walk (#540), copied verbatim so the differential cases compare against an independent reference rather
 * than against the fallback path of the code under test.
 */
function referenceGather(ledger: LedgerLine[], fromT: number, toT: number) {
  const tok: Record<string, TokenCounts> = {};
  const req: Record<string, number> = {};
  const sur: Record<string, Partial<Record<string, TokenCounts>>> = {};
  let reqUsable = true;
  let coveredMs = 0;
  for (const line of ledger) {
    const span = line.t - line.prevT;
    if (span <= 0) continue;
    const overlapMs = Math.min(toT, line.t) - Math.max(fromT, line.prevT);
    if (overlapMs <= 0) continue;
    coveredMs += overlapMs;
    const share = overlapMs / span;
    for (const [model, counts] of Object.entries(line.tok)) {
      const bucket = tok[model] ?? (tok[model] = emptyCounts());
      addCounts(bucket, share === 1 ? counts : scaleCounts(counts, share));
      const n = line.req?.[model];
      if (n === undefined) reqUsable = false;
      else req[model] = (req[model] ?? 0) + n * share;
    }
    for (const [model, bySurface] of Object.entries(line.sur ?? {})) {
      const into = sur[model] ?? (sur[model] = {});
      for (const [entrypoint, counts] of Object.entries(bySurface)) {
        const cls = rateSurface(entrypoint);
        addCounts(into[cls] ?? (into[cls] = emptyCounts()), share === 1 ? counts : scaleCounts(counts, share));
      }
    }
  }
  return { tok, req, reqUsable, sur, coveredMs };
}

/** mulberry32 — a fixed seed, so a failure reproduces. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6'];
const T0 = 1_000 * MIN;

function buildLedger(rand: () => number): LedgerLine[] {
  const counts = (): TokenCounts => ({
    in: Math.floor(rand() * 5000), out: Math.floor(rand() * 900), cc: Math.floor(rand() * 20000), cr: Math.floor(rand() * 90000)
  });
  const out: LedgerLine[] = [];
  let t = T0;
  for (let i = 0; i < 1000; i++) {
    const prev = t;
    if (i === 500) t += 120 * MIN; // a recording gap
    else if (i % 97 === 0) t += 0; // a duplicate `t`
    else t += Math.floor(30_000 + rand() * 150_000);
    let prevT = i === 500 ? t - 90_000 : prev;
    const roll = rand();
    if (i === 501) prevT = t - 40 * MIN; // a long line reaching back into the gap
    else if (roll < 0.03) prevT = t; // zero span
    else if (roll < 0.08) prevT = t - Math.floor(rand() * 15 * MIN); // overlaps earlier lines
    const tok: Record<string, TokenCounts> = {};
    const req: Record<string, number> = {};
    const sur: Record<string, Record<string, TokenCounts>> = {};
    for (const model of MODELS) {
      if (rand() < 0.4) continue;
      tok[model] = counts();
      req[model] = Math.floor(rand() * 12);
      if (rand() < 0.7) sur[model] = { [rand() < 0.5 ? HEADLESS_ENTRYPOINT : 'cli']: counts() };
    }
    const line: LedgerLine = { t, prevT, tok };
    if (rand() < 0.7) line.req = req;
    if (rand() < 0.5) line.sur = sur;
    out.push(line);
  }
  return out;
}

function buildSamples(rand: () => number, ledger: LedgerLine[]): UsageSample[] {
  const start = ledger[0].t - 90 * MIN; // samples before the first ledger line
  const end = ledger[ledger.length - 1].t + 40 * MIN; // and after the last
  const step = (end - start) / 300;
  const windows = ['2026-11-20T05:00:00.000Z', '2026-11-20T10:00:00.000Z', '2026-11-20T15:00:00.000Z'];
  const out: UsageSample[] = [];
  let util = 0;
  let week = 10;
  for (let i = 0; i < 300; i++) {
    const w = Math.floor(i / 100);
    if (i % 100 === 0) util = 0; // the reset into the next window
    let t = Math.floor(start + i * step + rand() * step * 0.5);
    if (i === 150) t = out[out.length - 1].t; // a duplicate `t`
    if (i === 77) util -= 3; // a falling pair
    else util += Math.floor(rand() * 3);
    if (i === 220) week = 2; // the weekly mid-window reset
    else if (rand() < 0.3) week += 1;
    out.push({ t, utilization: util, resetsAt: windows[w], week: { utilization: week, resetsAt: '2026-11-25T00:00:00.000Z' } });
  }
  return out;
}

/** Every interval's ledger-derived fields equal the reference join over its own span. */
function assertJoinMatchesReference(intervals: Interval[], ledger: LedgerLine[]): void {
  for (const iv of intervals) {
    const ref = referenceGather(ledger, iv.fromT, iv.toT);
    assert.deepStrictEqual(iv.tok, ref.tok, `tok over [${iv.fromT}, ${iv.toT}]`);
    assert.deepStrictEqual(iv.req, ref.req, `req over [${iv.fromT}, ${iv.toT}]`);
    assert.strictEqual(iv.reqUsable, ref.reqUsable, `reqUsable over [${iv.fromT}, ${iv.toT}]`);
  }
}

/** Every span the joins can ask for — each sample pair, the weekly runs, and random windows — gathers bit for bit what the reference gathers. */
function assertGatherMatchesReference(ledger: LedgerLine[], samples: UsageSample[], rand: () => number): number {
  const index = indexLedger(ledger);
  const spans: [number, number][] = [];
  for (let i = 1; i < samples.length; i++) spans.push([samples[i - 1].t, samples[i].t]);
  for (const iv of joinWeeklyIntervals(samples, ledger)) spans.push([iv.fromT, iv.toT]);
  const lo = samples[0].t;
  const hi = samples[samples.length - 1].t;
  for (let i = 0; i < 300; i++) {
    const a = lo + rand() * (hi - lo);
    spans.push([a, a + rand() * 6 * 60 * MIN]);
  }
  for (const [fromT, toT] of spans) {
    assert.deepStrictEqual(gather(ledger, index, fromT, toT), referenceGather(ledger, fromT, toT), `gather over [${fromT}, ${toT}]`);
  }
  return spans.length;
}

export function run(): number {
  let p = 0;
  let f = 0;
  console.log('usage-rate join (windowed walk vs full scan)');

  const rand = seeded(540);
  const ledger = buildLedger(rand);
  const samples = buildSamples(rand, ledger);

  if (test('fixture ledger is sorted by t and carries overlapping and zero-span lines', () => {
    for (let i = 1; i < ledger.length; i++) assert.ok(ledger[i].t >= ledger[i - 1].t);
    assert.ok(ledger.some((l) => l.t === l.prevT));
    assert.ok(ledger.some((l, i) => i > 0 && l.prevT < ledger[i - 1].t && l.t > l.prevT));
    assert.strictEqual(indexLedger(ledger).sorted, true);
  })) p++; else f++;

  if (test('sorted ledger: gather equals the full-scan reference over every span', () => {
    assert.ok(assertGatherMatchesReference(ledger, samples, seeded(1)) > 600);
  })) p++; else f++;

  if (test('sorted ledger: joinIntervals and joinWeeklyIntervals equal the reference', () => {
    const fiveHour = joinIntervals(samples, ledger);
    const weekly = joinWeeklyIntervals(samples, ledger);
    assert.ok(fiveHour.length > 200 && weekly.length > 20, `${fiveHour.length} / ${weekly.length} intervals`);
    assertJoinMatchesReference(fiveHour, ledger);
    assertJoinMatchesReference(weekly, ledger);
  })) p++; else f++;

  if (test('a line ending after the interval still counts when it began inside it (the toT + maxSpan stop)', () => {
    const tok = { m: { in: 2500, out: 0, cc: 0, cr: 0 } };
    const overlap: LedgerLine[] = [{ prevT: 0, t: 10 * MIN, tok: {} }, { prevT: 5 * MIN, t: 30 * MIN, tok, req: { m: 25 } }];
    const out = joinIntervals([{ t: 20 * MIN, utilization: 1, resetsAt: null }, { t: 25 * MIN, utilization: 2, resetsAt: null }], overlap);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].tok, { m: { in: 2500 * (5 / 25), out: 0, cc: 0, cr: 0 } });
    assert.deepStrictEqual(out[0].req, { m: 25 * (5 / 25) });
    assert.strictEqual(gather(overlap, indexLedger(overlap), 20 * MIN, 25 * MIN).coveredMs, 5 * MIN);
  })) p++; else f++;

  if (test('unsorted ledger: falls back to the full scan and still equals the reference', () => {
    const unsorted = ledger.slice();
    [unsorted[100], unsorted[900]] = [unsorted[900], unsorted[100]];
    assert.strictEqual(indexLedger(unsorted).sorted, false);
    assertGatherMatchesReference(unsorted, samples, seeded(2));
    assertJoinMatchesReference(joinIntervals(samples, unsorted), unsorted);
    assertJoinMatchesReference(joinWeeklyIntervals(samples, unsorted), unsorted);
  })) p++; else f++;

  if (test('edges: empty ledger, one line, a pair before the ledger and one after it', () => {
    const one = [ledger[10]];
    const before = [samples[0], { ...samples[1], utilization: samples[0].utilization + 1 }];
    const last = ledger[ledger.length - 1].t;
    const after: UsageSample[] = [{ t: last + MIN, utilization: 1, resetsAt: null }, { t: last + 5 * MIN, utilization: 2, resetsAt: null }];
    assert.ok(before[1].t < ledger[0].t);
    for (const l of [[], one, ledger]) {
      for (const pair of [before, after, samples]) {
        assertJoinMatchesReference(joinIntervals(pair, l), l);
        assertGatherMatchesReference(l, pair, seeded(3));
      }
    }
    assert.deepStrictEqual(indexLedger([]), { sorted: true, maxSpan: 0 });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
