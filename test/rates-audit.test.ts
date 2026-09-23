/**
 * `scripts/rates-audit.ts` and its pipeline, `scripts/lib/transcript-audit.ts`
 * — the audit that re-derives the Token-value card's inputs from transcripts.
 *
 * The pipeline functions are driven directly against tmpdir fixtures. Only the
 * `ledger` gate goes through a subprocess, because its exit code is what
 * `pnpm check:ledger` promises: a ledger that does not reconcile has to *fail
 * the command*, not merely print a lower ratio.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEDGER_FILE, serializeLedgerLine } from '../server/lib/usage-ledger.js';
import type { LedgerLine, TokenCounts } from '../server/lib/usage-ledger.js';
import type { Interval } from '../server/lib/usage-rate.js';
import {
  binCovariates, DAY_MS, emptyAcc, explainedShare, formatShares, gapVerdict, gateFailures, ledgerRows, mergeBins,
  MIXED_SURFACE, modifierRows, readRecords, rebuildLedger, recordWeighted, surfaceLabel, walkTranscripts
} from '../scripts/lib/transcript-audit.js';
import type { Acc, AuditRecord } from '../scripts/lib/transcript-audit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'rates-audit.ts');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const tc = (i: number, o: number, cc: number, cr: number): TokenCounts => ({ in: i, out: o, cc, cr });

/** One assistant transcript line. `id` omitted → a line with no `message.id`. */
function line(model: string, tsMs: number, tok: TokenCounts, id?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    entrypoint: 'claude-desktop',
    message: {
      role: 'assistant', model, ...(id ? { id } : {}),
      usage: {
        input_tokens: tok.in, output_tokens: tok.out,
        cache_creation_input_tokens: tok.cc, cache_read_input_tokens: tok.cr
      }
    }
  });
}

function rec(over: Partial<AuditRecord>): AuditRecord {
  return {
    ts: 0, model: 'claude-opus-5', tok: tc(0, 0, 0, 0), entrypoint: '', effort: '', nested: false,
    session: '', permissionMode: '', speed: '', serviceTier: '', isApiError: false, stopReason: '', ...over
  };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MIN = 60_000;

function iv(fromMin: number, toMin: number): Interval {
  return {
    fromT: fromMin * MIN, toT: toMin * MIN, dUtil: 1, tok: { 'claude-opus-5': tc(1000, 0, 0, 0) },
    req: {}, reqUsable: false, kind: { model: 'claude-opus-5' }
  };
}

/** A projects root with one transcript, and a repo dir with one ledger line covering it. */
function gateFixture(diskIn: number, ledgerIn: number): { root: string; dir: string } {
  const ts = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS / 2; // yesterday 12:00 UTC
  const root = tmp('ra-root-');
  fs.mkdirSync(path.join(root, '-tmp-proj'));
  fs.writeFileSync(path.join(root, '-tmp-proj', 's1.jsonl'), line('claude-opus-5', ts, tc(diskIn, 0, 0, 0), 'm1') + '\n');
  const dir = tmp('ra-dir-');
  const ledger: LedgerLine = { t: ts + 30_000, prevT: ts - 30_000, tok: { 'claude-opus-5': tc(ledgerIn, 0, 0, 0) } };
  fs.writeFileSync(path.join(dir, LEDGER_FILE), serializeLedgerLine(ledger) + '\n');
  return { root, dir };
}

/** A `user` prompt line carrying `permissionMode`. */
function modeLine(tsMs: number, mode: string): string {
  return JSON.stringify({
    type: 'user', timestamp: new Date(tsMs).toISOString(), permissionMode: mode,
    message: { role: 'user', content: 'go' }
  });
}

/** A per-level table from `[level, weighted, util]` triples — pre-weighted, so no token fixture is needed. */
function levels(...rows: [string, number, number][]): Map<string, Acc> {
  return new Map(rows.map(([level, weighted, util]) => [level, { ...emptyAcc(), bins: 1, weighted, util }]));
}

/** Records per session for `binCovariates`: `in` tokens weigh 1 on opus, so `w` is the weighted figure. */
const wrec = (w: number, over: Partial<AuditRecord> = {}): AuditRecord => rec({ tok: tc(w, 0, 0, 0), ...over });
const covBin = { fromT: 0, toT: 30 * 60_000, fromUtil: 50 };

function runLedgerGate(root: string, dir: string): { status: number; out: string } {
  const r = spawnSync('npx', ['tsx', SCRIPT, 'ledger', '--root', root, '--dir', dir, '--days', '7'], {
    cwd: REPO, encoding: 'utf8'
  });
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

export function run(): number {
  console.log('\n=== rates-audit.ts (transcript audit) ===\n');
  let p = 0, f = 0;

  // ── walk ──

  if (test('walk: top-level and subagent transcripts, nested flagged, non-jsonl and old files excluded', () => {
    const root = tmp('ra-walk-');
    const proj = path.join(root, '-tmp-proj');
    fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, 's1.jsonl'), '');
    fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-1.jsonl'), '');
    fs.writeFileSync(path.join(proj, 'notes.json'), '');
    const old = path.join(proj, 'old.jsonl');
    fs.writeFileSync(old, '');
    const since = Date.now() - DAY_MS;
    fs.utimesSync(old, new Date(since - DAY_MS), new Date(since - DAY_MS));

    const files = walkTranscripts(root, since).map(x => [path.relative(root, x.file), x.nested]);
    assert.deepStrictEqual(files.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      [path.join('-tmp-proj', 's1', 'subagents', 'agent-1.jsonl'), true],
      [path.join('-tmp-proj', 's1.jsonl'), false]
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  })) p++; else f++;

  // ── dedupe ──

  if (test('dedupe: two lines sharing message.id → one record; two lines with no id → two', () => {
    const root = tmp('ra-dedupe-');
    fs.mkdirSync(path.join(root, '-p'));
    const file = path.join(root, '-p', 's.jsonl');
    const t = Date.now();
    fs.writeFileSync(file, [
      line('claude-opus-5', t, tc(1, 0, 0, 0), 'dup'),
      line('claude-opus-5', t, tc(1, 0, 0, 0), 'dup'),
      line('claude-opus-5', t, tc(2, 0, 0, 0)),
      line('claude-opus-5', t, tc(2, 0, 0, 0))
    ].join('\n') + '\n');
    const records = readRecords([{ file, nested: false, session: 's', mtimeMs: t }]);
    assert.deepStrictEqual(records.map(r => r.tok.in), [1, 2, 2]);
  })) p++; else f++;

  // ── rebuild ──

  if (test('rebuild: a record lands in the tick with prevT < ts ≤ t; one outside every tick is counted', () => {
    const ticks: LedgerLine[] = [{ t: 60_000, prevT: 0, tok: {} }, { t: 120_000, prevT: 60_000, tok: {} }];
    const records = [
      rec({ ts: 60_000, tok: tc(1, 0, 0, 0) }),
      rec({ ts: 60_001, tok: tc(10, 0, 0, 0) }),
      rec({ ts: -1_000, tok: tc(100, 0, 0, 0) })
    ];
    const { lines, outsideTick } = rebuildLedger(records, ticks);
    assert.strictEqual(lines[0].tok['claude-opus-5'].in, 1);
    assert.strictEqual(lines[1].tok['claude-opus-5'].in, 10);
    assert.strictEqual(outsideTick, 1);
  })) p++; else f++;

  // ── weights ──

  if (test('weights: 1M Fable 5.1 cache-read tokens weigh 25 000, not 100 000', () => {
    assert.strictEqual(recordWeighted(rec({ model: 'claude-fable-5-1', tok: tc(0, 0, 0, 1_000_000) })), 25_000);
  })) p++; else f++;

  // ── gate ──

  const gateDay = Date.UTC(2026, 8, 10, 12);
  const gateRows = (diskIn: number, ledgerIn: number) => ledgerRows(
    [rec({ ts: gateDay, tok: tc(diskIn, 0, 0, 0) })],
    [{ t: gateDay + 30_000, prevT: gateDay - 30_000, tok: ledgerIn > 0 ? { 'claude-opus-5': tc(ledgerIn, 0, 0, 0) } : {} }],
    gateDay - DAY_MS, gateDay + DAY_MS
  );

  if (test('gate: disk 100M / ledger 90M fails; 96M passes; 110M fails; 2M / 0 prints but does not gate', () => {
    assert.strictEqual(gateFailures(gateRows(100e6, 90e6)).length, 1);
    assert.strictEqual(gateFailures(gateRows(100e6, 96e6)).length, 0);
    assert.strictEqual(gateFailures(gateRows(100e6, 110e6)).length, 1);
    const thin = gateRows(2e6, 0);
    assert.strictEqual(thin.length, 1, 'the under-floor row is still reported');
    assert.strictEqual(thin[0].ratio, 0);
    assert.strictEqual(gateFailures(thin).length, 0);
  })) p++; else f++;

  if (test('gate (CLI): 100M on disk, 90M recorded → exit 1 naming the row; 96M → exit 0', () => {
    const bad = gateFixture(100e6, 90e6);
    const r1 = runLedgerGate(bad.root, bad.dir);
    assert.strictEqual(r1.status, 1, r1.out);
    assert.ok(/✗ \d{4}-\d{2}-\d{2} claude-opus-5: recorded 90\.00M of 100\.00M/.test(r1.out), r1.out);
    const ok = gateFixture(100e6, 96e6);
    const r2 = runLedgerGate(ok.root, ok.dir);
    assert.strictEqual(r2.status, 0, r2.out);
  })) p++; else f++;

  // ── bins ──

  if (test('bins: contiguous intervals merge up to 30 min; the one that would exceed it, or a gap, starts a new bin', () => {
    assert.strictEqual(mergeBins([iv(0, 10), iv(10, 20), iv(20, 30)]).length, 1);
    const four = mergeBins([iv(0, 10), iv(10, 20), iv(20, 30), iv(30, 40)]);
    assert.deepStrictEqual(four.map(b => [b.fromT / MIN, b.toT / MIN, b.intervals]), [[0, 30, 3], [30, 40, 1]]);
    // The gap alone must split it: the third one ends inside 30 min of the first.
    assert.strictEqual(mergeBins([iv(0, 10), iv(10, 20), iv(21, 25)]).length, 2);
  })) p++; else f++;

  // ── surface label ──

  if (test('surface label: 85% claude-desktop → claude-desktop; 70/30 → mixed-surface', () => {
    assert.strictEqual(surfaceLabel(new Map([['claude-desktop', 85], ['sdk-cli', 15]])), 'claude-desktop');
    assert.strictEqual(surfaceLabel(new Map([['claude-desktop', 70], ['sdk-cli', 30]])), MIXED_SURFACE);
  })) p++; else f++;

  // ── modifiers ──

  if (test('modifiers: fast carrying 3M weighted beside standard carrying 1M → fast=75.0%', () => {
    const rows = modifierRows([
      rec({ ts: gateDay, speed: 'fast', tok: tc(3_000_000, 0, 0, 0) }),
      rec({ ts: gateDay, speed: 'standard', tok: tc(1_000_000, 0, 0, 0) })
    ], 'claude-opus-5');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(formatShares(rows[0].bySpeed), 'fast=75.0% standard=25.0%');
  })) p++; else f++;

  // ── gap ──

  if (test('gap mode: a record inherits the latest preceding user-line mode in its file; none before it → \'\'', () => {
    const root = tmp('ra-mode-');
    fs.mkdirSync(path.join(root, '-p'));
    const t0 = Date.now() - 3_600_000;
    fs.writeFileSync(path.join(root, '-p', 'sA.jsonl'), [
      line('claude-opus-5', t0 - 5_000, tc(1, 0, 0, 0), 'm-5'),
      modeLine(t0, 'auto'),
      line('claude-opus-5', t0 + 10_000, tc(2, 0, 0, 0), 'm10'),
      modeLine(t0 + 20_000, 'default'),
      line('claude-opus-5', t0 + 30_000, tc(3, 0, 0, 0), 'm30')
    ].join('\n') + '\n');
    const records = readRecords(walkTranscripts(root, 0)).sort((a, b) => a.ts - b.ts);
    assert.deepStrictEqual(records.map(r => [r.tok.in, r.permissionMode, r.session]),
      [[1, '', 'sA'], [2, 'auto', 'sA'], [3, 'default', 'sA']]);
  })) p++; else f++;

  if (test('gap mode: a nested file with no mode line inherits its parent session\'s; one with its own uses its own', () => {
    const root = tmp('ra-nested-');
    const proj = path.join(root, '-p');
    fs.mkdirSync(path.join(proj, 'sA', 'subagents'), { recursive: true });
    const t0 = Date.now() - 3_600_000;
    fs.writeFileSync(path.join(proj, 'sA.jsonl'), [modeLine(t0, 'auto'), modeLine(t0 + 20_000, 'acceptEdits')].join('\n') + '\n');
    fs.writeFileSync(path.join(proj, 'sA', 'subagents', 'agent-1.jsonl'),
      line('claude-opus-5', t0 + 10_000, tc(1, 0, 0, 0), 'n1') + '\n');
    fs.writeFileSync(path.join(proj, 'sA', 'subagents', 'agent-2.jsonl'),
      [modeLine(t0 + 5_000, 'plan'), line('claude-opus-5', t0 + 30_000, tc(2, 0, 0, 0), 'n2')].join('\n') + '\n');
    const records = readRecords(walkTranscripts(root, 0)).sort((a, b) => a.ts - b.ts);
    assert.deepStrictEqual(records.map(r => [r.tok.in, r.permissionMode, r.session, r.nested]),
      [[1, 'auto', 'sA', true], [2, 'plan', 'sA', true]]);
  })) p++; else f++;

  if (test('gap mode dominance: 900 auto / 100 default → auto; 700 / 300 → mixed; 850 \'\' / 150 auto → (none)', () => {
    const mode = (...rs: AuditRecord[]) => binCovariates(rs, covBin)!.mode;
    assert.strictEqual(mode(wrec(900, { permissionMode: 'auto' }), wrec(100, { permissionMode: 'default' })), 'auto');
    assert.strictEqual(mode(wrec(700, { permissionMode: 'auto' }), wrec(300, { permissionMode: 'default' })), 'mixed');
    assert.strictEqual(mode(wrec(850, { permissionMode: '' }), wrec(150, { permissionMode: 'auto' })), '(none)');
    assert.strictEqual(binCovariates([], covBin), null);
  })) p++; else f++;

  if (test('gap concurrency: top-level + nested of session A plus B → 2; three sessions → 3+', () => {
    const conc = (...rs: AuditRecord[]) => binCovariates(rs, covBin)!.concurrency;
    assert.strictEqual(conc(wrec(1, { session: 'A' }), wrec(1, { session: 'A', nested: true }), wrec(1, { session: 'B' })), '2');
    assert.strictEqual(conc(wrec(1, { session: 'A' }), wrec(1, { session: 'B' }), wrec(1, { session: 'C' })), '3+');
  })) p++; else f++;

  if (test('gap utilBand: from the first merged interval\'s sample — 96 then 97 → >=95; 94 then 96 → 80-94; 79 → <80', () => {
    const band = (utils: number[]) => {
      const ivs = utils.map((_, n) => iv(n * 10, n * 10 + 10));
      const bins = mergeBins(ivs, new Map(utils.map((u, n) => [n * 10 * MIN, u])));
      assert.strictEqual(bins.length, 1);
      return binCovariates([wrec(1)], bins[0])!.utilBand;
    };
    assert.strictEqual(band([96, 97]), '>=95');
    assert.strictEqual(band([94, 96]), '80-94', 'the first interval\'s sample, not the last');
    assert.strictEqual(band([94]), '80-94');
    assert.strictEqual(band([79]), '<80');
  })) p++; else f++;

  if (test('gap offbook: an unpriced line of a bin\'s session inside (fromT, toT] → errors; another session\'s → clean', () => {
    const marks = new Map([['A', [10 * 60_000]], ['B', [5 * 60_000]]]);
    assert.strictEqual(binCovariates([wrec(1, { session: 'A' })], covBin, marks)!.offbook, 'errors');
    assert.strictEqual(binCovariates([wrec(1, { session: 'C' })], covBin, marks)!.offbook, 'clean');
    assert.strictEqual(binCovariates([wrec(1, { session: 'A' })], { ...covBin, fromT: 10 * 60_000 }, marks)!.offbook, 'clean');
  })) p++; else f++;

  if (test('gap explainedShare: a covariate that explains the whole gap → exactly 1', () => {
    const share = explainedShare(levels(['a', 400e3, 1], ['b', 100e3, 1]), levels(['a', 200e3, 0.5], ['b', 400e3, 4]));
    assert.ok(share !== null && Math.abs(share - 1) < 1e-12, String(share));
  })) p++; else f++;

  if (test('gap explainedShare: a covariate with no effect → exactly 0', () => {
    const share = explainedShare(levels(['a', 400e3, 1], ['b', 400e3, 1]), levels(['a', 200e3, 1], ['b', 600e3, 3]));
    assert.ok(share !== null && Math.abs(share) < 1e-12, String(share));
  })) p++; else f++;

  if (test('gap explainedShare: covered headless weight 800k of 1150k (0.70) → null', () => {
    assert.strictEqual(explainedShare(levels(['a', 400e3, 1], ['b', 400e3, 1]),
      levels(['a', 200e3, 1], ['b', 600e3, 3], ['c', 350e3, 1])), null);
  })) p++; else f++;

  if (test('gap explainedShare: pooled 260k vs 220k (1.18x) → null', () => {
    assert.strictEqual(explainedShare(levels(['a', 260e3, 1]), levels(['a', 220e3, 1])), null);
  })) p++; else f++;

  if (test('gap verdict: 1.2x → artefact; mode 0.62 → named; best 0.41 → not on disk; all null → best none', () => {
    assert.strictEqual(gapVerdict(1.2, { mode: 0.9 }), 'artefact');
    assert.strictEqual(gapVerdict(1.8, { mode: 0.62, concurrency: 0.3 }), 'named: mode (0.62)');
    assert.strictEqual(gapVerdict(1.8, { mode: 0.41, utilBand: null }), 'not on disk (best: mode 0.41)');
    assert.strictEqual(gapVerdict(1.8, { mode: null, concurrency: null }), 'not on disk (best: none)');
    assert.ok(gapVerdict(null, { mode: 0.9 }).startsWith('insufficient data'));
  })) p++; else f++;

  if (test('gap (CLI): the same transcript under two --roots counts its record once', () => {
    const a = tmp('ra-rootA-'), b = tmp('ra-rootB-'), dir = tmp('ra-gapdir-');
    for (const r of [a, b]) {
      fs.mkdirSync(path.join(r, '-p'));
      fs.writeFileSync(path.join(r, '-p', 's1.jsonl'), line('claude-opus-5', Date.now() - 60_000, tc(5, 0, 0, 0), 'g1') + '\n');
    }
    const gap = (...roots: string[]) => {
      const res = spawnSync('npx', ['tsx', SCRIPT, 'gap', ...roots.flatMap(x => ['--root', x]), '--dir', dir], {
        cwd: REPO, encoding: 'utf8'
      });
      assert.strictEqual(res.status, 0, res.stdout + res.stderr);
      const m = /(\d+) transcripts, (\d+) records/.exec(res.stdout);
      assert.ok(m, res.stdout);
      return { files: Number(m![1]), records: Number(m![2]), out: res.stdout };
    };
    const one = gap(a), two = gap(a, b);
    assert.strictEqual(one.records, 1);
    assert.strictEqual(two.files, 2, 'both roots are walked');
    assert.strictEqual(two.records, one.records);
    assert.ok(/verdict: /.test(two.out), two.out);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
