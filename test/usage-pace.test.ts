import assert from 'node:assert';

import * as pace from '../server/lib/usage-pace.js';
import { flatProfile } from '../server/lib/usage-forecast.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const MIN = 60_000;
const NOW = 1_800_000_000_000;

export function run(): number {
  console.log('\n=== usage-pace.ts ===\n');
  let p = 0, f = 0;

  // ── computePace ──

  if (test('computePace: 30→40 over 30min → 20%/h, exhaust in 3h', () => {
    const out = pace.computePace(
      [{ t: NOW - 30 * MIN, utilization: 30 }, { t: NOW, utilization: 40 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 20);
    assert.strictEqual(out.projectedExhaustAt, new Date(NOW + 3 * H).toISOString());
  })) p++; else f++;

  if (test('computePace: span under minSpan → null', () => {
    const out = pace.computePace(
      [{ t: NOW - 2 * MIN, utilization: 30 }, { t: NOW, utilization: 31 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    );
    assert.strictEqual(out, null);
  })) p++; else f++;

  if (test('computePace: fewer than 2 samples in lookback → null', () => {
    assert.strictEqual(
      pace.computePace([{ t: NOW, utilization: 30 }], { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }),
      null
    );
    assert.strictEqual(
      pace.computePace([], { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }),
      null
    );
  })) p++; else f++;

  if (test('computePace: flat utilization → rate 0, no exhaust projection', () => {
    const out = pace.computePace(
      [{ t: NOW - 20 * MIN, utilization: 35 }, { t: NOW, utilization: 35 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 0);
    assert.strictEqual(out.projectedExhaustAt, null);
  })) p++; else f++;

  if (test('computePace: samples older than lookback are ignored', () => {
    // The 2h-old sample would flatten the rate; only the last two count.
    const out = pace.computePace(
      [
        { t: NOW - 2 * H, utilization: 30 },
        { t: NOW - 20 * MIN, utilization: 30 },
        { t: NOW, utilization: 40 }
      ],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 30);
  })) p++; else f++;

  if (test('computePace: projection starts from the latest utilization', () => {
    // 90 → 95 over 30min = 10%/h; 5% left → 30min to exhaust.
    const out = pace.computePace(
      [{ t: NOW - 30 * MIN, utilization: 90 }, { t: NOW, utilization: 95 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.projectedExhaustAt, new Date(NOW + 30 * MIN).toISOString());
  })) p++; else f++;

  // ── prunedSamples ──

  if (test('prunedSamples: drops samples before the window anchor (resetsAt − window)', () => {
    const resetsAt = new Date(NOW + 3 * H).toISOString(); // anchor = NOW − 2h
    const kept = pace.prunedSamples(
      [
        { t: NOW - 3 * H, utilization: 50 }, // previous window
        { t: NOW - 1 * H, utilization: 10 },
        { t: NOW, utilization: 20 }
      ],
      resetsAt,
      5 * H
    );
    assert.deepStrictEqual(kept.map((s) => s.utilization), [10, 20]);
  })) p++; else f++;

  if (test('prunedSamples: null or unparseable resetsAt → unchanged', () => {
    const samples = [{ t: NOW - H, utilization: 10 }, { t: NOW, utilization: 20 }];
    assert.deepStrictEqual(pace.prunedSamples(samples, null, 5 * H), samples);
    assert.deepStrictEqual(pace.prunedSamples(samples, 'not-a-date', 5 * H), samples);
  })) p++; else f++;

  // ── recordAndPace (stateful store) ──

  if (test('recordAndPace: attaches pace fields once history spans minSpan', () => {
    pace.resetPaceStore();
    const rl = { utilization: 30, resetsAt: new Date(NOW + 4 * H).toISOString() };
    const first = pace.recordAndPace('fiveHour', rl, NOW - 30 * MIN);
    assert.strictEqual(first.ratePerHour, null); // one sample — no pace yet
    const second = pace.recordAndPace('fiveHour', { ...rl, utilization: 40 }, NOW);
    assert.strictEqual(second.ratePerHour, 20);
    assert.strictEqual(second.projectedExhaustAt, new Date(NOW + 3 * H).toISOString());
    assert.strictEqual(second.utilization, 40); // original fields pass through
  })) p++; else f++;

  if (test('recordAndPace: a utilization drop (window reset) clears history', () => {
    pace.resetPaceStore();
    const resetsAt = new Date(NOW + 4 * H).toISOString();
    pace.recordAndPace('fiveHour', { utilization: 80, resetsAt }, NOW - 30 * MIN);
    pace.recordAndPace('fiveHour', { utilization: 90, resetsAt }, NOW - 20 * MIN);
    // reset: utilization falls to 2; only post-reset samples may feed pace
    const after = pace.recordAndPace('fiveHour', { utilization: 2, resetsAt }, NOW);
    assert.strictEqual(after.ratePerHour, null);
  })) p++; else f++;

  if (test('recordAndPace: null utilization passes through without recording', () => {
    pace.resetPaceStore();
    const out = pace.recordAndPace('fiveHour', { utilization: null, resetsAt: null }, NOW);
    assert.strictEqual(out.utilization, null);
    assert.strictEqual(out.ratePerHour, null);
  })) p++; else f++;

  if (test('recordAndPace: windows keep separate histories', () => {
    pace.resetPaceStore();
    pace.recordAndPace('fiveHour', { utilization: 30, resetsAt: null }, NOW - 30 * MIN);
    pace.recordAndPace('sevenDay', { utilization: 10, resetsAt: null }, NOW - 30 * MIN);
    const five = pace.recordAndPace('fiveHour', { utilization: 40, resetsAt: null }, NOW);
    assert.strictEqual(five.ratePerHour, 20); // sevenDay's samples never mixed in
  })) p++; else f++;

  if (test('recordAndPace: sevenDay needs a longer span before showing pace', () => {
    pace.resetPaceStore();
    pace.recordAndPace('sevenDay', { utilization: 10, resetsAt: null }, NOW - 10 * MIN);
    const out = pace.recordAndPace('sevenDay', { utilization: 11, resetsAt: null }, NOW);
    assert.strictEqual(out.ratePerHour, null); // 10min < the weekly 30min min span
  })) p++; else f++;

  // ── the duty-cycle forecast handoff (sevenDay only) ──

  if (test('REGRESSION FLOOR: no profile, no active-time source → the flat closed form', () => {
    pace.resetPaceStore();
    pace.setForecastProfile(null);
    pace.setActiveTimeSource(null);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 60 * MIN);
    const rl = pace.recordAndPace('sevenDay', { utilization: 45, resetsAt }, NOW);
    assert.strictEqual(rl.forecastConfidence, 'none');
    assert.strictEqual(rl.projectedExhaustAt, rl.pessimisticExhaustAt);
  })) p++; else f++;

  if (test('no profile at all → the active-time source is ignored, wall slope stands', () => {
    pace.resetPaceStore();
    pace.setForecastProfile(null);
    pace.setActiveTimeSource(() => 1 * H);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 6 * H);
    const rl = pace.recordAndPace('sevenDay', { utilization: 43, resetsAt }, NOW);
    // 3% over 6h of wall clock — not 3 %/active-hour. (Float: 0.49999999999999994.)
    assert.ok(Math.abs(rl.ratePerHour! - 0.5) < 1e-9, `wall slope expected, got ${rl.ratePerHour}`)
  })) p++; else f++;

  if (test('an untrusted profile (the first week) keeps the wall slope, not the active rate', () => {
    pace.resetPaceStore();
    // Exactly what deriveProfile() hands over before any bucket clears the trust
    // floor: a real profile object, no weights, globalMean 1. Pairing an active
    // rate with those flat-1.0 weights projects an always-on week.
    pace.setForecastProfile({ weights: new Array(168).fill(null), globalMean: 1, trustedCount: 0 });
    pace.setActiveTimeSource(() => 1 * H);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 6 * H);
    const rl = pace.recordAndPace('sevenDay', { utilization: 43, resetsAt }, NOW);
    assert.ok(Math.abs(rl.ratePerHour! - 0.5) < 1e-9, `wall slope expected, got ${rl.ratePerHour}`);
    assert.strictEqual(rl.forecastConfidence, 'none');
  })) p++; else f++;

  if (test('the weekly rate is per ACTIVE hour when the recorder measured the span', () => {
    pace.resetPaceStore();
    // A trusted profile is what licenses the active basis — see the guard above.
    pace.setForecastProfile(flatProfile(1));
    pace.setActiveTimeSource(() => 1 * H); // a 3% rise over 6h of wall clock, 1h of it active
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 6 * H);
    const rl = pace.recordAndPace('sevenDay', { utilization: 43, resetsAt }, NOW);
    assert.strictEqual(rl.ratePerHour, 3); // 3 %/active-hour — not the 0.5 %/h wall slope
  })) p++; else f++;

  if (test('a rise the recorder saw no active time for yields no projection', () => {
    pace.resetPaceStore();
    pace.setForecastProfile(flatProfile(1)); // trusted, so the active basis is in play
    pace.setActiveTimeSource(() => 0); // the rise happened across a recording gap
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 6 * H);
    const rl = pace.recordAndPace('sevenDay', { utilization: 43, resetsAt }, NOW);
    assert.strictEqual(rl.ratePerHour, null);
    assert.strictEqual(rl.projectedExhaustAt, null);
  })) p++; else f++;

  if (test('a night-heavy profile pushes the weekly projection out past the flat one', () => {
    pace.resetPaceStore();
    pace.setActiveTimeSource(null);
    // Half the hours idle → the profile walk must reach 100% strictly later.
    pace.setForecastProfile(flatProfile(0.5));
    const resetsAt = new Date(NOW + 120 * H).toISOString();
    pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 60 * MIN);
    const rl = pace.recordAndPace('sevenDay', { utilization: 45, resetsAt }, NOW);
    assert.ok(rl.projectedExhaustAt, 'expected a projection');
    assert.ok(rl.pessimisticExhaustAt, 'expected a pessimistic edge');
    assert.ok(Date.parse(rl.projectedExhaustAt!) > Date.parse(rl.pessimisticExhaustAt!),
      'the duty-cycle projection must be the later of the two');
  })) p++; else f++;

  if (test('the 5h window gains no forecast fields and no rate correction', () => {
    pace.resetPaceStore();
    pace.setForecastProfile(flatProfile(0.5));
    pace.setActiveTimeSource(() => 1 * H); // must be ignored for fiveHour
    const resetsAt = new Date(NOW + 3 * H).toISOString();
    pace.recordAndPace('fiveHour', { utilization: 20, resetsAt }, NOW - 10 * MIN);
    const rl = pace.recordAndPace('fiveHour', { utilization: 30, resetsAt }, NOW);
    assert.strictEqual(rl.ratePerHour, 60); // 10% over 10 min — the plain slope
    assert.strictEqual(rl.dutyCycle, undefined);
    assert.strictEqual(rl.pessimisticExhaustAt, undefined);
  })) p++; else f++;

  if (test('seedSamples restores enough history to produce a pace immediately', () => {
    pace.resetPaceStore();
    pace.setForecastProfile(null);
    pace.setActiveTimeSource(null);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    pace.seedSamples('sevenDay', [
      { t: NOW - 6 * H, utilization: 30 },
      { t: NOW - 3 * H, utilization: 35 }
    ]);
    // A single fresh sample would normally be too thin for a slope.
    const rl = pace.recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW);
    assert.ok(rl.ratePerHour != null && rl.ratePerHour > 0, 'expected a rate from seeded history');
  })) p++; else f++;

  // Leave the module-level seams as the rest of the app expects to find them.
  pace.setForecastProfile(null);
  pace.setActiveTimeSource(null);

  console.log(`\n  usage-pace: ${p} passed, ${f} failed`);
  return f;
}
