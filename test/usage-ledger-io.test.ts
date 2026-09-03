import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetSettings, setSettings } from '../server/lib/settings.js';
import {
  LEDGER_FILE,
  LEDGER_UNROTATED_MAX_BYTES,
  MAX_LEDGER_BYTES,
  ledgerStartMs,
  readLedgerSince,
  recordLedgerTick,
  resetLedgerRecorder
} from '../server/lib/usage-ledger.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** One assistant transcript record, as Claude Code writes them. */
function assistantLine(
  tsMs: number, model: string, id: string,
  u: { in: number; out: number; cc: number; cr: number },
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    ...extra,
    message: {
      role: 'assistant',
      id,
      model,
      usage: {
        input_tokens: u.in,
        output_tokens: u.out,
        cache_creation_input_tokens: u.cc,
        cache_read_input_tokens: u.cr
      }
    }
  });
}

interface Fixture {
  /** Throwaway dir: the ledger's home, the fake `$HOME/.claude/projects`, and cwd. */
  dir: string;
  root: string;
  transcript: string;
  ledgerPath: string;
  ledgerLines(): string[];
  cleanup(): void;
}

function fixture(recording = true): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-io-'));
  const root = path.join(dir, 'projects');
  const projectDir = path.join(root, '-Users-x-proj');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, 'sess-1.jsonl');
  fs.writeFileSync(transcript, '', 'utf8');

  const prevCwd = process.cwd();
  process.chdir(dir);          // settings.ts resolves its file from cwd
  resetSettings();
  setSettings({ recordUsageHistory: recording });
  resetLedgerRecorder();

  const ledgerPath = path.join(dir, LEDGER_FILE);
  return {
    dir, root, transcript, ledgerPath,
    ledgerLines: () => {
      if (!fs.existsSync(ledgerPath)) return [];
      return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(l => l.trim() !== '');
    },
    cleanup: () => {
      process.chdir(prevCwd);
      resetSettings();
      resetLedgerRecorder();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function withFixture(fn: (f: Fixture) => void, recording = true): void {
  const f = fixture(recording);
  try { fn(f); } finally { f.cleanup(); }
}

export function run(): number {
  console.log('\n=== usage-ledger.ts (recorder I/O) ===\n');
  let p = 0, f = 0;

  if (test('first tick after start only seeds offsets — no line written', () => {
    withFixture(fx => {
      fs.appendFileSync(fx.transcript, assistantLine(T0 - 30_000, 'opus-5', 'm1', { in: 1, out: 1, cc: 1, cr: 1 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      assert.deepStrictEqual(fx.ledgerLines(), [], 'the seeding tick must write nothing');
    });
  })) p++; else f++;

  if (test('one line per tick, summed per model per type, stamped prevT→t', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      fs.appendFileSync(fx.transcript,
        assistantLine(T0 + 10_000, 'opus-5', 'm1', { in: 10, out: 20, cc: 30, cr: 40 }) + '\n' +
        assistantLine(T0 + 20_000, 'opus-5', 'm2', { in: 1, out: 2, cc: 3, cr: 4 }) + '\n' +
        assistantLine(T0 + 30_000, 'fable-5', 'm3', { in: 5, out: 6, cc: 7, cr: 8 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });

      const lines = fx.ledgerLines();
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(JSON.parse(lines[0]), {
        t: T0 + MIN,
        prevT: T0,
        tok: {
          'opus-5': { in: 11, out: 22, cc: 33, cr: 44 },
          'fable-5': { in: 5, out: 6, cc: 7, cr: 8 }
        },
        req: { 'opus-5': 2, 'fable-5': 1 }
      });
    });
  })) p++; else f++;

  if (test('a quiet minute writes an empty line — a measured zero is data', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });
      const lines = fx.ledgerLines();
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(JSON.parse(lines[0]), { t: T0 + MIN, prevT: T0, tok: {}, req: {} },
        'an empty `req` is the tell that counts were recorded and nothing was spent');
    });
  })) p++; else f++;

  if (test('a truncated transcript is re-read from 0, and its line counted once', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      fs.appendFileSync(fx.transcript, assistantLine(T0 + 10_000, 'opus-5', 'm1', { in: 100, out: 0, cc: 0, cr: 0 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });

      // Rotated away under us: the file is now shorter than the stored offset.
      fs.writeFileSync(fx.transcript, assistantLine(T0 + MIN + 10_000, 'opus-5', 'm2', { in: 7, out: 0, cc: 0, cr: 0 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + 2 * MIN });

      const lines = fx.ledgerLines().map(l => JSON.parse(l));
      assert.strictEqual(lines.length, 2);
      assert.deepStrictEqual(lines[1].tok, { 'opus-5': { in: 7, out: 0, cc: 0, cr: 0 } });
    });
  })) p++; else f++;

  if (test('junk, user turns and usage-less records are skipped; a repeated message id counts once', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      const dup = assistantLine(T0 + 10_000, 'opus-5', 'm1', { in: 10, out: 5, cc: 0, cr: 0 });
      fs.appendFileSync(fx.transcript,
        'not json at all\n' +
        JSON.stringify({ type: 'user', timestamp: new Date(T0 + 5_000).toISOString(), message: { role: 'user', content: 'hi' } }) + '\n' +
        JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 6_000).toISOString(), message: { role: 'assistant', model: 'opus-5' } }) + '\n' +
        dup + '\n' + dup + '\n' +
        assistantLine(T0 + 20_000, 'opus-5', 'm2', { in: 1, out: 1, cc: 0, cr: 0 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });

      const line = JSON.parse(fx.ledgerLines()[0]);
      assert.deepStrictEqual(line.tok, { 'opus-5': { in: 11, out: 6, cc: 0, cr: 0 } });
      assert.deepStrictEqual(line.req, { 'opus-5': 2 },
        'the duplicated message id is one request, not two');
    });
  })) p++; else f++;

  if (test('subagent (sidechain) turns are counted — they spend real tokens', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      fs.appendFileSync(fx.transcript,
        assistantLine(T0 + 10_000, 'opus-5', 'm1', { in: 3, out: 0, cc: 0, cr: 0 }, { isSidechain: true }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });
      assert.deepStrictEqual(JSON.parse(fx.ledgerLines()[0]).tok, {
        'opus-5': { in: 3, out: 0, cc: 0, cr: 0 }
      });
    });
  })) p++; else f++;

  if (test('recording off → nothing is written at all', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      fs.appendFileSync(fx.transcript, assistantLine(T0 + 10_000, 'opus-5', 'm1', { in: 9, out: 9, cc: 9, cr: 9 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + MIN });
      assert.deepStrictEqual(fx.ledgerLines(), []);
      assert.strictEqual(fs.existsSync(fx.ledgerPath), false);
    }, false);
  })) p++; else f++;

  if (test('switching recording back on reseeds rather than dumping the backlog', () => {
    withFixture(fx => {
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 });
      setSettings({ recordUsageHistory: false });
      fs.appendFileSync(fx.transcript, assistantLine(T0 + 70_000, 'opus-5', 'm1', { in: 500, out: 0, cc: 0, cr: 0 }) + '\n');
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + 2 * MIN });

      setSettings({ recordUsageHistory: true });
      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + 3 * MIN });   // reseeding tick
      assert.deepStrictEqual(fx.ledgerLines(), [], 'the first tick back on must reseed, not backfill');

      recordLedgerTick({ dir: fx.dir, root: fx.root, nowMs: T0 + 4 * MIN });
      const lines = fx.ledgerLines().map(l => JSON.parse(l));
      assert.strictEqual(lines.length, 1);
      assert.deepStrictEqual(lines[0], { t: T0 + 4 * MIN, prevT: T0 + 3 * MIN, tok: {}, req: {} });
    });
  })) p++; else f++;

  if (test('readLedgerSince: from the cutoff, oldest first, junk skipped', () => {
    withFixture(fx => {
      fs.writeFileSync(fx.ledgerPath,
        JSON.stringify({ t: T0, prevT: T0 - MIN, tok: {} }) + '\n' +
        'garbage\n' +
        JSON.stringify({ t: T0 + MIN, prevT: T0, tok: { A: { in: 1, out: 2, cc: 3, cr: 4 } } }) + '\n' +
        JSON.stringify({ prevT: T0 + MIN, tok: {} }) + '\n' +
        JSON.stringify({ t: T0 + 2 * MIN, prevT: T0 + MIN, tok: {} }) + '\n', 'utf8');

      const out = readLedgerSince(T0 + MIN, fx.dir);
      assert.deepStrictEqual(out, [
        { t: T0 + MIN, prevT: T0, tok: { A: { in: 1, out: 2, cc: 3, cr: 4 } } },
        { t: T0 + 2 * MIN, prevT: T0 + MIN, tok: {} }
      ]);
    });
  })) p++; else f++;

  if (test('readLedgerSince: a missing file reads as no data, not a throw', () => {
    withFixture(fx => {
      assert.deepStrictEqual(readLedgerSince(0, path.join(fx.dir, 'nope')), []);
    });
  })) p++; else f++;

  // ── ledgerStartMs: when recording provably began ──

  if (test('the never-rotated ceiling is exactly half the maximum', () => {
    // Tied to the constant rather than to a literal: `rotateLedgerIfNeeded`
    // trims to `floor(MAX_LEDGER_BYTES / 2)`, so moving either alone would
    // silently make the guard wrong.
    assert.strictEqual(LEDGER_UNROTATED_MAX_BYTES, MAX_LEDGER_BYTES / 2);
  })) p++; else f++;

  if (test('ledgerStartMs is the first line\'s prevT, not its t', () => {
    withFixture(fx => {
      fs.writeFileSync(fx.ledgerPath,
        JSON.stringify({ t: T0, prevT: T0 - MIN, tok: {} }) + '\n' +
        JSON.stringify({ t: T0 + MIN, prevT: T0, tok: {} }) + '\n' +
        JSON.stringify({ t: T0 + 2 * MIN, prevT: T0 + MIN, tok: {} }) + '\n', 'utf8');
      assert.strictEqual(ledgerStartMs(fx.dir), T0 - MIN,
        'the first line covers (prevT, t], so prevT is the instant before recording');
    });
  })) p++; else f++;

  if (test('ledgerStartMs: absent, empty and junk-headed files', () => {
    withFixture(fx => {
      assert.strictEqual(ledgerStartMs(path.join(fx.dir, 'nope')), null, 'absent');
      fs.writeFileSync(fx.ledgerPath, '', 'utf8');
      assert.strictEqual(ledgerStartMs(fx.dir), null, 'empty');
      fs.writeFileSync(fx.ledgerPath, 'garbage\n{"t":1}\n' +
        JSON.stringify({ t: T0 + MIN, prevT: T0, tok: {} }) + '\n', 'utf8');
      assert.strictEqual(ledgerStartMs(fx.dir), T0, 'junk at the head is skipped, exactly as readLedgerSince skips it');
      fs.writeFileSync(fx.ledgerPath, 'garbage\nmore garbage\n', 'utf8');
      assert.strictEqual(ledgerStartMs(fx.dir), null, 'nothing parseable at all');
    });
  })) p++; else f++;

  if (test('a file big enough to have rotated proves nothing, however good its first line', () => {
    withFixture(fx => {
      const first = JSON.stringify({ t: T0, prevT: T0 - MIN, tok: {} }) + '\n';
      const filler = JSON.stringify({ t: T0 + MIN, prevT: T0, tok: {} }) + '\n';
      const repeats = Math.ceil(LEDGER_UNROTATED_MAX_BYTES / filler.length);
      fs.writeFileSync(fx.ledgerPath, first + filler.repeat(repeats), 'utf8');
      assert.ok(fs.statSync(fx.ledgerPath).size >= LEDGER_UNROTATED_MAX_BYTES);
      assert.strictEqual(ledgerStartMs(fx.dir), null,
        'past half the maximum the first surviving line is a floor, not a start');
    });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
