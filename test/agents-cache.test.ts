import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAgents } from '../server/lib/agents.js';
import { readAgentsCached, _resetAgentsCache, _agentsCacheSize } from '../server/lib/agents-cache.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-agents-cache-'));
  return path.join(dir, 'x.jsonl');
}

function taskRec(id: string, type: string, description: string, iso: string) {
  return {
    timestamp: iso,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description } }] }
  };
}
function resultRec(toolUseId: string, iso: string, toolUseResult?: unknown) {
  return {
    timestamp: iso,
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }
  };
}
function ackRec(toolUseId: string, agentId: string, iso: string) {
  return {
    timestamp: iso,
    toolUseResult: { isAsync: true, status: 'async_launched', agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully.\nagentId: ' + agentId }] }
  };
}
function notifyRec(agentId: string, iso: string, usage?: { tokens: number; toolUses: number; durationMs: number }) {
  const usageXml = usage
    ? `\n<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
    : '';
  return {
    timestamp: iso,
    message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>${usageXml}\n</task-notification>` }] }
  };
}

/** Assert the cache output matches the whole-file oracle exactly. */
function assertMatchesOracle(file: string) {
  assert.deepStrictEqual(readAgentsCached(file), readAgents(file));
}

export function run(): number {
  console.log('\n=== agents-cache.ts ===\n');
  let p = 0, f = 0;

  if (test('oracle equivalence under chunked appends', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const records = [
      taskRec('t1', 'Explore', 'first', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:10Z', { status: 'completed', totalDurationMs: 9500, totalTokens: 1200, totalToolUseCount: 3 }),
      taskRec('t2', 'Plan', 'second', '2026-07-01T10:01:00Z'),
      ackRec('t2', 'bg42', '2026-07-01T10:01:00.030Z'),
      taskRec('t3', 'Explore', 'third', '2026-07-01T10:02:00Z'),
      resultRec('t3', '2026-07-01T10:02:05Z'),
      notifyRec('bg42', '2026-07-01T10:05:00Z', { tokens: 29252, toolUses: 17, durationMs: 40576 })
    ];
    const whole = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    const buf = Buffer.from(whole, 'utf8');
    // append in odd-sized chunks so lines straddle read boundaries
    let off = 0;
    const step = 37;
    while (off < buf.length) {
      const end = Math.min(off + step, buf.length);
      fs.appendFileSync(file, buf.subarray(off, end));
      off = end;
      assertMatchesOracle(file);
    }
    const final = readAgentsCached(file)!;
    assert.strictEqual(final.length, 3);
    assert.strictEqual(final.filter(a => a.status === 'done').length, 3);
    assert.strictEqual(final.find(a => a.id === 't2')!.tokens, 29252);
  })) p++; else f++;

  if (test('chunk boundary mid multibyte UTF-8 char', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const rec1 = taskRec('t1', 'Explore', 'emoji 🚀🔥 描述', '2026-07-01T10:00:00Z');
    const rec2 = resultRec('t1', '2026-07-01T10:00:10Z');
    const buf = Buffer.from(JSON.stringify(rec1) + '\n' + JSON.stringify(rec2) + '\n', 'utf8');
    // split inside the rocket emoji (find its first byte 0xF0)
    let cut = buf.indexOf(0xf0) + 2; // mid-sequence
    fs.appendFileSync(file, buf.subarray(0, cut));
    assertMatchesOracle(file);
    fs.appendFileSync(file, buf.subarray(cut));
    assertMatchesOracle(file);
    assert.strictEqual(readAgentsCached(file)![0].description, 'emoji 🚀🔥 描述');
  })) p++; else f++;

  if (test('half a JSON line buffered until completed', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const line = JSON.stringify(taskRec('t1', 'Explore', 'partial', '2026-07-01T10:00:00Z')) + '\n';
    fs.appendFileSync(file, line.slice(0, 25));
    assert.deepStrictEqual(readAgentsCached(file), []); // incomplete → nothing yet
    fs.appendFileSync(file, line.slice(25));
    assertMatchesOracle(file);
    assert.strictEqual(readAgentsCached(file)!.length, 1);
  })) p++; else f++;

  if (test('final record without trailing newline is included', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const records = [
      taskRec('t1', 'Explore', 'a', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:10Z')
    ];
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n')); // no trailing \n
    assertMatchesOracle(file);
    assert.strictEqual(readAgentsCached(file)!.length, 1);
    assert.strictEqual(readAgentsCached(file)![0].status, 'done');
  })) p++; else f++;

  if (test('out-of-order async completion resolves across incremental reads', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const first = [
      taskRec('a', 'Explore', 'async one', '2026-07-01T10:00:00Z'),
      ackRec('a', 'bgA', '2026-07-01T10:00:00.030Z'),
      taskRec('b', 'Plan', 'sync two', '2026-07-01T10:00:05Z'),
      resultRec('b', '2026-07-01T10:00:20Z')
    ];
    fs.writeFileSync(file, first.map(r => JSON.stringify(r)).join('\n') + '\n');
    let jobs = readAgentsCached(file)!;
    assert.strictEqual(jobs.find(j => j.id === 'a')!.status, 'running');
    assert.strictEqual(jobs.find(j => j.id === 'b')!.status, 'done');
    // A's completion lands far downstream, after B already settled
    fs.appendFileSync(file, JSON.stringify(notifyRec('bgA', '2026-07-01T10:09:00Z', { tokens: 555, toolUses: 4, durationMs: 540000 })) + '\n');
    assertMatchesOracle(file);
    jobs = readAgentsCached(file)!;
    const a = jobs.find(j => j.id === 'a')!;
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(a.tokens, 555);
    assert.strictEqual(a.durationMs, 540000);
  })) p++; else f++;

  if (test('truncation resets state and matches oracle of new content', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const long = [
      taskRec('t1', 'Explore', 'one', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:10Z'),
      taskRec('t2', 'Plan', 'two', '2026-07-01T10:01:00Z')
    ];
    fs.writeFileSync(file, long.map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.strictEqual(readAgentsCached(file)!.length, 3 - 1); // t1 done + t2 running = 2 jobs
    const short = [taskRec('n1', 'Explore', 'fresh', '2026-07-01T11:00:00Z')];
    fs.writeFileSync(file, short.map(r => JSON.stringify(r)).join('\n') + '\n'); // smaller file
    assertMatchesOracle(file);
    const jobs = readAgentsCached(file)!;
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].id, 'n1');
  })) p++; else f++;

  if (test('unchanged file: consecutive calls deep-equal', () => {
    _resetAgentsCache();
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify(taskRec('t1', 'Explore', 'x', '2026-07-01T10:00:00Z')) + '\n');
    const one = readAgentsCached(file);
    const two = readAgentsCached(file);
    assert.deepStrictEqual(one, two);
  })) p++; else f++;

  if (test('missing file → null', () => {
    _resetAgentsCache();
    assert.strictEqual(readAgentsCached('/no/such/transcript.jsonl'), null);
  })) p++; else f++;

  if (test('LRU cap: cache size stays bounded', () => {
    _resetAgentsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-agents-lru-'));
    for (let i = 0; i < 40; i++) {
      const file = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(file, JSON.stringify(taskRec('t' + i, 'Explore', 'x', '2026-07-01T10:00:00Z')) + '\n');
      readAgentsCached(file);
    }
    assert.ok(_agentsCacheSize() <= 32, `cache size ${_agentsCacheSize()} > 32`);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
