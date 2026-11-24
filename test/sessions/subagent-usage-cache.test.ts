import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeSession } from '../../server/lib/analyze.js';
import { _resetAgentsCache } from '../../server/lib/agents-cache.js';
import { readSessionSpend, readSubagentUsage, _resetSessionSpendCache } from '../../server/lib/session-spend.js';
import { bytesRead as countBytes } from '../fs-bytes.js';

function test(name: string, fn: () => void): boolean {
  _resetAgentsCache();
  _resetSessionSpendCache();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';

/** One assistant record; usage is input/output/cacheCreation/cacheRead. */
function turn(id: string, i: number, o = 0, cc = 0, cr = 0) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant', id, content: [],
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr }
    }
  };
}

function launch(toolUseId: string) {
  return {
    type: 'assistant', timestamp: '2026-11-16T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { subagent_type: 'Explore', description: 'd' } }] }
  };
}
function done(toolUseId: string, agentId: string, totalTokens: number) {
  return {
    type: 'user', timestamp: '2026-11-16T10:01:00Z', toolUseResult: { agentId, totalTokens, totalDurationMs: 1000, totalToolUseCount: 1 },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }
  };
}

const SESSION = '22222222-2222-4222-8222-222222222222';

interface Fixture { main: string; subDir: string; file(agentId: string): string }

function fixture(mainRecs: unknown[] = []): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-subagent-usage-cache-'));
  const main = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(main, mainRecs.map(line).join(''));
  const subDir = path.join(dir, SESSION, 'subagents');
  return { main, subDir, file: agentId => path.join(subDir, `agent-${agentId}.jsonl`) };
}

function writeAgent(f: Fixture, agentId: string, text: string): string {
  fs.mkdirSync(f.subDir, { recursive: true });
  const file = f.file(agentId);
  fs.writeFileSync(file, text);
  return file;
}

/** Bytes `fs.readSync` returned for subagent transcripts (`subagents/…jsonl`) while `fn` ran. */
const bytesRead = <T>(fn: () => T) => countBytes(fn, p => p.includes(`${path.sep}subagents${path.sep}`) && p.endsWith('.jsonl'));

const inputOf = (main: string, agentId: string): number | undefined => readSubagentUsage(main).find(s => s.agentId === agentId)?.usage.input;

export function run(): number {
  console.log('\n=== subagent usage through the session-spend cache ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('keeps the per-class split', () => {
    const f = fixture();
    writeAgent(f, 'x', line(turn('m1', 1, 2, 3, 4)));
    assert.deepStrictEqual(readSubagentUsage(f.main), [{
      agentId: 'x', toolUseId: null,
      usage: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, combined: 10, billableApprox: 6 }
    }]);
  });

  t('a second call with no new bytes reads nothing', () => {
    const f = fixture();
    writeAgent(f, 'x', line(turn('m1', 1, 2, 3, 4)) + line(turn('m2', 5)));
    const first = bytesRead(() => readSubagentUsage(f.main));
    assert.ok(first.bytes > 0, 'first call reads the file');
    const second = bytesRead(() => readSubagentUsage(f.main));
    assert.equal(second.bytes, 0);
    assert.deepStrictEqual(second.result, first.result);
  });

  t('an append costs only the appended bytes and dedupes by message id', () => {
    const f = fixture();
    const file = writeAgent(f, 'x', line(turn('m1', 5)));
    assert.equal(inputOf(f.main, 'x'), 5);
    const appended = line(turn('m2', 7));
    fs.appendFileSync(file, appended);
    const second = bytesRead(() => readSubagentUsage(f.main));
    assert.equal(second.result[0].usage.input, 12);
    assert.equal(second.bytes, Buffer.byteLength(appended));
    fs.appendFileSync(file, line(turn('m2', 7)));
    assert.equal(inputOf(f.main, 'x'), 12);
  });

  t('a newline-less tail counts once, before and after the line is finished', () => {
    const f = fixture();
    const file = writeAgent(f, 'x', line(turn('m1', 5)) + JSON.stringify(turn('m2', 7)));
    assert.equal(inputOf(f.main, 'x'), 12);
    fs.appendFileSync(file, '\n' + line(turn('m3', 1)));
    assert.equal(inputOf(f.main, 'x'), 13);
  });

  t('a truncated file is recomputed from what remains', () => {
    const f = fixture();
    const file = writeAgent(f, 'x', line(turn('m1', 5)) + line(turn('m2', 7)));
    assert.equal(inputOf(f.main, 'x'), 12);
    fs.writeFileSync(file, line(turn('x1', 3)));
    assert.equal(inputOf(f.main, 'x'), 3);
  });

  t('a sidecar that lands later is picked up without re-reading the transcript', () => {
    const f = fixture();
    writeAgent(f, 'x', line(turn('m1', 5)));
    assert.equal(readSubagentUsage(f.main)[0].toolUseId, null);
    fs.writeFileSync(path.join(f.subDir, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }));
    const second = bytesRead(() => readSubagentUsage(f.main));
    assert.equal(second.result[0].toolUseId, 'toolu_1');
    assert.equal(second.bytes, 0);
  });

  t('a file no launch claims is still listed', () => {
    const f = fixture([turn('main1', 1)]);
    writeAgent(f, 'orphan', line(turn('m1', 9)));
    assert.deepStrictEqual(readSubagentUsage(f.main).map(s => [s.agentId, s.usage.input]), [['orphan', 9]]);
  });

  t('an unreadable entry is skipped, not thrown', () => {
    const f = fixture();
    writeAgent(f, 'a', line(turn('m1', 4)));
    fs.mkdirSync(f.file('b'));
    assert.deepStrictEqual(readSubagentUsage(f.main).map(s => s.agentId), ['a']);
  });

  t('no subagents dir reads as no subagents', () => {
    const f = fixture();
    assert.deepStrictEqual(readSubagentUsage(f.main), []);
  });

  t('shares its tallies with readSessionSpend', () => {
    const f = fixture([turn('main1', 1), launch('t1'), done('t1', 'a1', 10)]);
    writeAgent(f, 'a1', line(turn('s1', 40, 30, 30, 7)));
    const spend = readSessionSpend(f.main)!;
    assert.equal(spend.subagents, 100);
    const after = bytesRead(() => readSubagentUsage(f.main));
    assert.equal(after.bytes, 0);
    assert.equal(after.result[0].usage.billableApprox, 100);
    assert.equal(readSessionSpend(f.main)!.subagents, analyzeSession(f.main)!.subagentTotals.usage.billableApprox);
  });

  t('readSubagentUsage first leaves readSessionSpend unchanged', () => {
    const f = fixture([turn('main1', 1), launch('t1'), done('t1', 'a1', 10)]);
    writeAgent(f, 'a1', line(turn('s1', 40, 30, 30, 7)));
    writeAgent(f, 'orphan', line(turn('s2', 1000)));
    readSubagentUsage(f.main);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 100);
    assert.equal(s.main, 1);
  });

  t('the reset hook drops the cached tallies', () => {
    const f = fixture();
    const file = writeAgent(f, 'x', line(turn('m1', 1, 2, 3, 4)));
    readSubagentUsage(f.main);
    assert.equal(bytesRead(() => readSubagentUsage(f.main)).bytes, 0);
    _resetSessionSpendCache();
    assert.equal(bytesRead(() => readSubagentUsage(f.main)).bytes, fs.statSync(file).size);
  });

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} passed`);
  return results.length - ok;
}
