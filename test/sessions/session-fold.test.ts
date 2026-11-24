/**
 * The drawer's two reads of one main transcript — the agents list (`readAgentsCached`) and the spend card (`readSessionSpend`) — share one byte-offset
 * pass, so a cold open reads the file once and an Analytics sweep through the session-spend cache cannot force the main transcript to be read again.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAgents } from '../../server/lib/agents.js';
import { readAgentsCached, _resetAgentsCache } from '../../server/lib/agents-cache.js';
import { readSessionSpend, readSubagentUsage, _resetSessionSpendCache } from '../../server/lib/session-spend.js';
import { bytesRead, withReadFaultOnce } from '../fs-bytes.js';

function test(name: string, fn: () => void): boolean {
  _resetAgentsCache();
  _resetSessionSpendCache();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';

/** One assistant record; usage is input/output/cacheCreation/cacheRead. */
function turn(id: string, i: number, o: number, cc: number, cr: number, extra: object = {}) {
  return {
    type: 'assistant',
    ...extra,
    message: {
      role: 'assistant', id, content: [],
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr }
    }
  };
}
const SIDE = { isSidechain: true };
const BOUNDARY = { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 200000 } };

function launch(toolUseId: string) {
  return {
    type: 'assistant', timestamp: '2026-11-24T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { subagent_type: 'Explore', description: 'd' } }] }
  };
}
function done(toolUseId: string, agentId: string, totalTokens: number) {
  return {
    type: 'user', timestamp: '2026-11-24T10:01:00Z', toolUseResult: { agentId, totalTokens, totalDurationMs: 1000, totalToolUseCount: 1 },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }
  };
}

const SESSION = '33333333-3333-4333-8333-333333333333';

/** A main transcript of `recs` with subagent `a1` (100 billable) beside it, claimed by the launch `t1` the records carry. */
function fixture(recs: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-session-fold-'));
  const main = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(main, recs.map(line).join(''));
  const subDir = path.join(dir, SESSION, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), line(turn('s1', 40, 30, 30, 7, SIDE)));
  return main;
}

const RECS = [turn('m1', 10, 20, 30, 1000), turn('m1', 10, 20, 30, 1000), turn('m2', 1, 2, 3, 500), BOUNDARY, launch('t1'), done('t1', 'a1', 100)];

/** Bytes read from `main` itself, never its subagent files. */
const mainBytes = <T>(main: string, fn: () => T) => bytesRead(fn, p => p === main);
const sizeOf = (p: string): number => fs.statSync(p).size;

/** `readSessionSpend` on caches emptied first — what a server that never saw the file answers. */
function fresh(main: string) {
  _resetAgentsCache();
  _resetSessionSpendCache();
  return readSessionSpend(main);
}

export function run(): number {
  console.log('\n=== one main-transcript pass for agents and spend ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('a cold open, detail first, reads the main transcript once', () => {
    const main = fixture(RECS);
    const both = mainBytes(main, () => { readAgentsCached(main); return readSessionSpend(main)!; });
    assert.equal(both.bytes, sizeOf(main));
    assert.equal(both.result.main, 66);
    assert.equal(both.result.subagents, 100);
    assert.equal(both.result.compactions, 1);
  });

  t('a cold open, spend first, reads the main transcript once', () => {
    const main = fixture(RECS);
    const both = mainBytes(main, () => { const s = readSessionSpend(main)!; readAgentsCached(main); return s; });
    assert.equal(both.bytes, sizeOf(main));
    assert.equal(both.result.main, 66);
  });

  t('a repeat poll with no growth reads nothing', () => {
    const main = fixture(RECS);
    readAgentsCached(main);
    const first = readSessionSpend(main);
    const again = mainBytes(main, () => { readAgentsCached(main); return readSessionSpend(main); });
    assert.equal(again.bytes, 0);
    assert.deepStrictEqual(again.result, first);
  });

  t('an append costs its own bytes once, shared by both reads', () => {
    const main = fixture(RECS);
    readAgentsCached(main);
    readSessionSpend(main);
    const appended = line(turn('m3', 5, 5, 5, 0));
    fs.appendFileSync(main, appended);
    const spend = mainBytes(main, () => readSessionSpend(main)!);
    assert.equal(spend.bytes, Buffer.byteLength(appended));
    assert.equal(spend.result.main, 81);
    assert.equal(mainBytes(main, () => readAgentsCached(main)).bytes, 0);
  });

  t('an Analytics sweep over 33 other sessions does not make the drawer re-read its main transcript', () => {
    const main = fixture(RECS);
    const first = readSessionSpend(main);
    for (let i = 0; i < 33; i++) readSubagentUsage(fixture([turn(`o${i}`, 1, 0, 0, 0)]));
    const again = mainBytes(main, () => readSessionSpend(main));
    assert.equal(again.bytes, 0);
    assert.deepStrictEqual(again.result, first);
  });

  t('an agents-cache eviction re-reads the main transcript once and resets spend with it', () => {
    const main = fixture(RECS);
    readSessionSpend(main);
    for (let i = 0; i < 33; i++) readAgentsCached(fixture([turn(`o${i}`, 1, 0, 0, 0)]));
    const after = mainBytes(main, () => readSessionSpend(main));
    assert.equal(after.bytes, sizeOf(main));
    assert.deepStrictEqual(after.result, fresh(main));
  });

  t('a read failure mid-fold: agents fall back to the oracle, spend throws, and the next clean read recovers both', () => {
    const main = fixture(RECS);
    const onMain = (p: string): boolean => p === main;
    assert.deepStrictEqual(withReadFaultOnce(() => readAgentsCached(main), onMain), readAgents(main));
    assert.throws(() => withReadFaultOnce(() => readSessionSpend(main), onMain), /injected read failure/);
    const recovered = readSessionSpend(main);
    assert.deepStrictEqual(readAgentsCached(main), readAgents(main));
    assert.deepStrictEqual(recovered, fresh(main));
    assert.equal(recovered!.main, 66);
  });

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} passed`);
  return results.length - ok;
}
