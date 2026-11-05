import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeSession } from '../server/lib/analyze.js';
import { _resetAgentsCache } from '../server/lib/agents-cache.js';
import { readSessionSpend, _resetSessionSpendCache } from '../server/lib/session-spend.js';

function test(name: string, fn: () => void): boolean {
  _resetAgentsCache();
  _resetSessionSpendCache();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';

/** One assistant record; usage is input/output/cacheCreation/cacheRead. */
function turn(id: string | null, i: number, o: number, cc: number, cr: number, extra: object = {}) {
  return {
    type: 'assistant',
    ...extra,
    message: {
      role: 'assistant', ...(id ? { id } : {}), content: [],
      usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr }
    }
  };
}
const SIDE = { isSidechain: true };
const BOUNDARY = { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 200000 } };
const SUMMARY = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } };

function launch(toolUseId: string) {
  return {
    type: 'assistant', timestamp: '2026-11-05T10:00:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Task', input: { subagent_type: 'Explore', description: 'd' } }] }
  };
}
function result(toolUseId: string, toolUseResult: object) {
  return {
    type: 'user', timestamp: '2026-11-05T10:01:00Z', toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }
  };
}
const done = (toolUseId: string, agentId: string | null, totalTokens: number) =>
  result(toolUseId, { ...(agentId ? { agentId } : {}), totalTokens, totalDurationMs: 1000, totalToolUseCount: 1 });

interface Fixture { main: string; agent(agentId: string, recs: unknown[], toolUseId?: string): string }

function fixture(recs: unknown[] = []): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-session-spend-'));
  const main = path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl');
  fs.writeFileSync(main, recs.map(line).join(''));
  const subDir = path.join(dir, '11111111-1111-4111-8111-111111111111', 'subagents');
  return {
    main,
    agent(agentId, agentRecs, toolUseId) {
      fs.mkdirSync(subDir, { recursive: true });
      const file = path.join(subDir, `agent-${agentId}.jsonl`);
      fs.writeFileSync(file, agentRecs.map(line).join(''));
      if (toolUseId) fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId }));
      return file;
    }
  };
}

const M1 = turn('m1', 10, 20, 30, 1000);
const M2 = turn('m2', 1, 2, 3, 500);
const M3 = turn('m3', 5, 5, 5, 0);

export function run(): number {
  console.log('\n=== session spend (main + subagents) ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('counts one turn once across its records and leaves cache reads out', () => {
    const f = fixture([M1, M1, M2]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.main, 66);
    assert.equal(s.total, 66);
    assert.equal(s.compactions, 0);
  });

  t('a compaction never lowers the total, and its replay and summary add nothing', () => {
    const f = fixture([M1, M1, M2]);
    const before = readSessionSpend(f.main)!.total;
    fs.appendFileSync(f.main, [BOUNDARY, SUMMARY, M1, M3].map(line).join(''));
    const after = readSessionSpend(f.main)!;
    assert.equal(after.main, 81);
    assert.equal(after.compactions, 1);
    assert.ok(after.total >= before, 'the total must not fall');
  });

  t('main skips a sidechain record that an older transcript replays', () => {
    const f = fixture([M2, turn('side', 100, 100, 100, 0, SIDE)]);
    assert.equal(readSessionSpend(f.main)!.main, 6);
  });

  t('main counts each record with no message.id on its own', () => {
    const f = fixture([turn(null, 1, 1, 1, 0), turn(null, 1, 1, 1, 0)]);
    assert.equal(readSessionSpend(f.main)!.main, 6);
  });

  t('a subagent matched by agentId adds its transcript to the total', () => {
    const f = fixture([M1, M1, M2, BOUNDARY, SUMMARY, M1, M3, launch('t1'), done('t1', 'a1', 100)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.main, 81);
    assert.equal(s.subagents, 100);
    assert.equal(s.total, 181);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('two subagents each resolve to their own file, by agentId and by toolUseId, with sidechain records counted', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 100), launch('t2')]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    f.agent('a2', [turn('s2', 10, 10, 20, 3, SIDE)], 't2');
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 140);
    assert.equal(s.main, 0);
    assert.equal(s.total, 140);
  });

  t('two sessions read alternately keep their own figures', () => {
    const a = fixture([M2]);
    const b = fixture([M3]);
    assert.equal(readSessionSpend(a.main)!.main, 6);
    assert.equal(readSessionSpend(b.main)!.main, 15);
    fs.appendFileSync(a.main, line(turn('m9', 1, 0, 0, 0)));
    assert.equal(readSessionSpend(a.main)!.main, 7);
    assert.equal(readSessionSpend(b.main)!.main, 15);
  });

  t('a running subagent counts so far and grows as it writes', () => {
    const f = fixture([launch('t1')]);
    const file = f.agent('a1', [turn('s1', 10, 10, 20, 0, SIDE)], 't1');
    assert.equal(readSessionSpend(f.main)!.subagents, 40);
    fs.appendFileSync(file, line(turn('s2', 5, 5, 0, 0, SIDE)));
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 50);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('a running launch with no file yet is not uncounted', () => {
    const f = fixture([launch('t1')]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 0);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('a transcript no launch claims adds nothing and is not uncounted', () => {
    const f = fixture([M2]);
    f.agent('orphan', [turn('s1', 100, 100, 100, 0, SIDE)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 0);
    assert.equal(s.total, 6);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('a finished launch with no transcript is uncounted, and its harness figure is not added', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 5000)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 0);
    assert.equal(s.uncountedSubagents, 1);
  });

  t('a finished transcript below the harness figure counts its own sum and is uncounted', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 5000)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 0, SIDE)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 100);
    assert.equal(s.uncountedSubagents, 1);
  });

  t('a resumed row sharing a transcript counts that transcript once', () => {
    const f = fixture([
      launch('t1'), done('t1', 'a1', 100),
      { type: 'assistant', timestamp: '2026-11-05T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'send1', name: 'SendMessage', input: { to: 'a1', summary: 'more' } }] } },
      result('send1', { resumedAgentId: 'a1' })
    ]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 100);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('a finished resumed row is not measured against the harness, because its figure is not the launch row\'s', () => {
    const f = fixture([
      launch('t1'), done('t1', 'a1', 100),
      { type: 'assistant', timestamp: '2026-11-05T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'send1', name: 'SendMessage', input: { to: 'a1', summary: 'more' } }] } },
      result('send1', { resumedAgentId: 'a1' }),
      {
        type: 'user', timestamp: '2026-11-05T10:03:00Z',
        message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<usage><subagent_tokens>5000</subagent_tokens><tool_uses>1</tool_uses><duration_ms>9</duration_ms></usage>\n</task-notification>' }] }
      }
    ]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.subagents, 100);
    assert.equal(s.uncountedSubagents, 0);
  });

  t('two launches claiming one transcript count it once', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 100), launch('t2'), done('t2', 'a1', 100)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    assert.equal(readSessionSpend(f.main)!.subagents, 100);
  });

  t('a subagent turn written as several records counts once', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 100)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE), turn('s1', 40, 30, 30, 7, SIDE)]);
    assert.equal(readSessionSpend(f.main)!.subagents, 100);
  });

  t('a boundary inside a subagent transcript counts as a compaction', () => {
    const f = fixture([launch('t1'), done('t1', 'a1', 100)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE), { ...BOUNDARY, ...SIDE }]);
    const s = readSessionSpend(f.main)!;
    assert.equal(s.compactions, 1);
    assert.equal(s.subagents, 100);
  });

  t('an unfinished last line counts only once the rest of it arrives, a split multibyte character included', () => {
    const f = fixture([M2]);
    const whole = Buffer.from(JSON.stringify({ ...turn('m7', 1, 1, 1, 0), note: 'é€😀' }) + '\n');
    const cut = whole.indexOf(Buffer.from('€')) + 1; // inside the three bytes of the euro sign
    fs.appendFileSync(f.main, whole.subarray(0, cut));
    assert.equal(readSessionSpend(f.main)!.main, 6);
    fs.appendFileSync(f.main, whole.subarray(cut));
    assert.equal(readSessionSpend(f.main)!.main, 9);
    assert.equal(readSessionSpend(f.main)!.main, 9);
  });

  t('a truncated file is recomputed from what remains', () => {
    const f = fixture([M1, M2]);
    assert.equal(readSessionSpend(f.main)!.main, 66);
    fs.writeFileSync(f.main, line(M3));
    assert.equal(readSessionSpend(f.main)!.main, 15);
  });

  t('bytes already consumed are not read again', () => {
    const f = fixture([M2]);
    assert.equal(readSessionSpend(f.main)!.main, 6);
    const same = JSON.stringify(M2).replace('"input_tokens":1', '"input_tokens":9');
    fs.writeFileSync(f.main, same + '\n');
    assert.equal(readSessionSpend(f.main)!.main, 6);
  });

  t('an unreadable session is null', () => {
    assert.equal(readSessionSpend(path.join(os.tmpdir(), 'cad-session-spend-gone', 'x.jsonl')), null);
  });

  t('agrees with analyzeSession once every subagent has finished', () => {
    const f = fixture([M1, M1, M2, BOUNDARY, SUMMARY, M1, M3, launch('t1'), done('t1', 'a1', 100), launch('t2'), done('t2', null, 40)]);
    f.agent('a1', [turn('s1', 40, 30, 30, 7, SIDE)]);
    f.agent('a2', [turn('s2', 10, 10, 20, 3, SIDE)], 't2');
    const a = analyzeSession(f.main)!;
    const s = readSessionSpend(f.main)!;
    assert.equal(s.main, a.totals.billableApprox);
    assert.equal(s.subagents, a.subagentTotals.usage.billableApprox);
    assert.equal(s.main, 81);
    assert.equal(s.subagents, 140);
  });

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} passed`);
  return results.length - ok;
}
