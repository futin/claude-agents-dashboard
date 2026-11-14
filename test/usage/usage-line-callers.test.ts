/**
 * Characterization of the five readers of an assistant usage line — the ledger (`usage-ledger.ts`), the rates audit (`scripts/lib/transcript-audit.ts`),
 * subagent spend (`subagent-usage.ts`), session spend (`session-spend.ts`) and the session analysis (`analyze.ts`). They share one parse
 * (`usage-line.ts`) but keep their own gates on purpose, so each scenario pins every caller's total side by side: a change to one gate shows up as one
 * cell, never as a silent drift between readers. Every fixture puts its tokens in `input_tokens` only, so each reader's figure is that one class.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRecords } from '../../scripts/lib/transcript-audit.js';
import { _resetAgentsCache } from '../../server/lib/agents-cache.js';
import { analyzeSession } from '../../server/lib/analyze.js';
import { _resetSessionSpendCache, readSessionSpend } from '../../server/lib/session-spend.js';
import { resetSettings, setSettings } from '../../server/lib/settings.js';
import { readSubagentUsage } from '../../server/lib/subagent-usage.js';
import { LEDGER_FILE, recordLedgerTick, resetLedgerRecorder } from '../../server/lib/usage-ledger.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const SESSION = '11111111-1111-4111-8111-111111111111';

interface Opts { id?: string; model?: string; ts?: boolean }

/** One assistant record spending `input` input tokens and nothing else. */
function rec(input: number, { id, model = 'claude-opus-4-8', ts = true }: Opts = {}): unknown {
  return {
    type: 'assistant',
    ...(ts ? { timestamp: new Date(T0 + 10_000).toISOString() } : {}),
    message: {
      role: 'assistant', content: [],
      ...(id ? { id } : {}),
      ...(model ? { model } : {}),
      usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  };
}

const jsonl = (recs: unknown[]): string => recs.map(r => JSON.stringify(r) + '\n').join('');

/** The ledger's input total for `recs` appended after the seeding tick. */
function ledgerIn(recs: unknown[]): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-usage-line-ledger-'));
  const root = path.join(dir, 'projects');
  const transcript = path.join(root, '-Users-x-proj', 'sess-1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  const prevCwd = process.cwd();
  process.chdir(dir); // settings.ts resolves its file from cwd
  resetSettings();
  setSettings({ recordUsageHistory: true });
  resetLedgerRecorder();
  try {
    recordLedgerTick({ dir, root, nowMs: T0 });
    fs.appendFileSync(transcript, jsonl(recs));
    recordLedgerTick({ dir, root, nowMs: T0 + MIN });
    const file = path.join(dir, LEDGER_FILE);
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()) : [];
    let total = 0;
    for (const l of lines) for (const t of Object.values(JSON.parse(l).tok as Record<string, { in: number }>)) total += t.in;
    return total;
  } finally {
    process.chdir(prevCwd);
    resetSettings();
    resetLedgerRecorder();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface Totals { ledger: number; audit: number; subagent: number; spend: number; analyze: number }

/** Every reader's input total for one transcript holding `recs` (as a main transcript, and as a subagent's for `readSubagentUsage`). */
function totals(recs: unknown[]): Totals {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-usage-line-'));
  try {
    const main = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(main, jsonl(recs));
    const subDir = path.join(dir, SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), jsonl(recs));

    const audit = readRecords([{ file: main, nested: false, session: SESSION, mtimeMs: 0 }]).reduce((n, r) => n + r.tok.in, 0);
    const subagent = readSubagentUsage(main).reduce((n, s) => n + s.usage.input, 0);
    // Main transcript only: the subagent file is unclaimed by any launch, so session spend never follows it.
    _resetAgentsCache();
    _resetSessionSpendCache();
    const spend = readSessionSpend(main)!.main;
    fs.rmSync(path.join(dir, SESSION), { recursive: true, force: true });
    const analyze = analyzeSession(main)!.totals.input;
    return { ledger: ledgerIn(recs), audit, subagent, spend, analyze };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function run(): number {
  console.log('\n=== usage line: every caller\'s gate, side by side ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('two records sharing a message.id count once in every caller', () => {
    assert.deepStrictEqual(totals([rec(5, { id: 'm1' }), rec(5, { id: 'm1' })]), { ledger: 5, audit: 5, subagent: 5, spend: 5, analyze: 5 });
  }));

  r(test('a zero-token first copy: the ledger counts the second, every other caller lets the first consume the id', () => {
    assert.deepStrictEqual(totals([rec(0, { id: 'm1' }), rec(7, { id: 'm1' })]), { ledger: 7, audit: 0, subagent: 0, spend: 0, analyze: 0 });
  }));

  r(test('a record with no model: dropped by the ledger and the audit, counted by the rest', () => {
    assert.deepStrictEqual(totals([rec(4, { id: 'm1', model: '' })]), { ledger: 0, audit: 0, subagent: 4, spend: 4, analyze: 4 });
  }));

  r(test('a record with no timestamp: dropped by the ledger and the audit, counted by the rest', () => {
    assert.deepStrictEqual(totals([rec(2, { id: 'm1', ts: false })]), { ledger: 0, audit: 0, subagent: 2, spend: 2, analyze: 2 });
  }));

  r(test('records with no id fail open: each counts once in every caller', () => {
    assert.deepStrictEqual(totals([rec(3), rec(3)]), { ledger: 6, audit: 6, subagent: 6, spend: 6, analyze: 6 });
  }));

  r(test('a non-number token count reads as 0 in every caller', () => {
    const bad = rec(0, { id: 'm1' }) as { message: { usage: Record<string, unknown> } };
    bad.message.usage.input_tokens = '7';
    assert.deepStrictEqual(totals([bad, rec(1, { id: 'm2' })]), { ledger: 1, audit: 1, subagent: 1, spend: 1, analyze: 1 });
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
