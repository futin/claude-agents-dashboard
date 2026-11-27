import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentJob } from '../../shared/types.js';
import { readAgents } from '../../server/lib/agents.js';
import {
  readAgentsCached, readAgentsCachedAsync, readSessionFold, readSessionFoldAsync, _resetAgentsCache, _agentsCacheSize, _setFoldSliceBytes
} from '../../server/lib/agents-cache.js';
import { bytesRead, withReadFaultAsync } from '../fs-bytes.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** An async case on emptied caches; the slice budget is reset with them, so a case that shrinks it cannot leak into the next. */
async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  _resetAgentsCache();
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally { _resetAgentsCache(); }
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
function notifyRec(agentId: string, iso: string, usage?: { tokens: number; toolUses: number; durationMs: number }, status = 'completed') {
  const usageXml = usage
    ? `\n<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
    : '';
  return {
    timestamp: iso,
    message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>${usageXml}\n</task-notification>` }] }
  };
}

/** The message-less shapes a notification takes when absorbed mid-turn (bug-11). */
function absorbedRecs(agentId: string, iso: string, usage: { tokens: number; toolUses: number; durationMs: number }) {
  const body = `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>\n</task-notification>`;
  return [
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso, sessionId: 's1', content: body },
    { type: 'attachment', timestamp: iso, attachment: { type: 'queued_command', commandMode: 'prompt', timestamp: iso, prompt: body } },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: iso, sessionId: 's1', content: body }
  ];
}

/** Assert the cache output matches the whole-file oracle exactly. */
function assertMatchesOracle(file: string) {
  assert.deepStrictEqual(readAgentsCached(file), readAgents(file));
}

export async function run(): Promise<number> {
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

  if (test('SendMessage call and its resume result split across incremental reads', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const sm = { timestamp: '2026-07-01T10:05:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'syncA', summary: 'again' } }] } };
    fs.writeFileSync(file, [taskRec('a', 'Plan', 'sync one', '2026-07-01T10:00:00Z'),
      resultRec('a', '2026-07-01T10:01:00Z', { agentId: 'syncA' }), sm].map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.strictEqual(readAgentsCached(file)!.length, 1);
    fs.appendFileSync(file, JSON.stringify(resultRec('sm', '2026-07-01T10:05:01Z', { success: true, resumedAgentId: 'syncA' })) + '\n');
    assertMatchesOracle(file);
    const jobs = readAgentsCached(file)!;
    assert.deepStrictEqual(jobs.map(j => [j.id, j.status]), [['sm', 'running'], ['a', 'done']]);
    fs.appendFileSync(file, JSON.stringify(notifyRec('syncA', '2026-07-01T10:09:00Z')) + '\n');
    assertMatchesOracle(file);
    assert.strictEqual(readAgentsCached(file)!.find(j => j.id === 'sm')!.status, 'done');
  })) p++; else f++;

  if (test('absorbed mid-turn completion: byte-split appends still match the oracle', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const head = [
      taskRec('a', 'general-purpose', 'work', '2026-07-01T10:00:00Z'),
      ackRec('a', 'bgZ', '2026-07-01T10:00:00.030Z')
    ];
    fs.writeFileSync(file, head.map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.strictEqual(readAgentsCached(file)![0].status, 'running');

    // Append the three message-less records one byte-chunk at a time, so the
    // notification itself straddles read boundaries.
    const tail = absorbedRecs('bgZ', '2026-07-01T10:14:50Z', { tokens: 146111, toolUses: 71, durationMs: 872048 })
      .map(r => JSON.stringify(r)).join('\n') + '\n';
    for (let i = 0; i < tail.length; i += 37) {
      fs.appendFileSync(file, tail.slice(i, i + 37));
      readAgentsCached(file);
    }
    assertMatchesOracle(file);
    const a = readAgentsCached(file)![0];
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(a.endedAt, '2026-07-01T10:14:50Z');
    assert.strictEqual(a.tokens, 146111);
    assert.strictEqual(a.durationMs, 872048);
  })) p++; else f++;

  if (test('compaction replay: byte-split appends across the replayed half still match the oracle', () => {
    _resetAgentsCache();
    const file = tmpFile();
    const sm = { timestamp: '2026-07-01T10:03:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'smR', name: 'SendMessage', input: { to: 'syncR', summary: 'again' } }] } };
    const prefix = [
      taskRec('r1', 'Explore', 'sync', '2026-07-01T10:00:00Z'),
      resultRec('r1', '2026-07-01T10:00:30Z', { status: 'completed', agentId: 'syncR', totalTokens: 1200 }),
      taskRec('r2', 'Plan', 'background', '2026-07-01T10:01:00Z'),
      ackRec('r2', 'bgR', '2026-07-01T10:01:01Z'),
      notifyRec('bgR', '2026-07-01T10:02:00Z', { tokens: 500, toolUses: 4, durationMs: 59000 }),
      sm,
      resultRec('smR', '2026-07-01T10:03:01Z', { success: true, resumedAgentId: 'syncR' }),
      notifyRec('syncR', '2026-07-01T10:04:00Z')
    ];
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-01T11:00:00Z', compactMetadata: { trigger: 'auto', preTokens: 999 } };
    const summary = { type: 'user', isCompactSummary: true, timestamp: '2026-07-01T11:00:01Z', message: { role: 'user', content: 'Summary.' } };
    fs.writeFileSync(file, [...prefix, boundary, summary].map(r => JSON.stringify(r)).join('\n') + '\n');
    assertMatchesOracle(file);
    // The replayed half arrives in odd-sized chunks, so replayed records straddle reads.
    const tail = prefix.map(r => JSON.stringify(r)).join('\n') + '\n';
    for (let i = 0; i < tail.length; i += 37) {
      fs.appendFileSync(file, tail.slice(i, i + 37));
      assertMatchesOracle(file);
    }
    const jobs = readAgentsCached(file)!;
    assert.deepStrictEqual(jobs.map(j => [j.id, j.status, !!j.resumed]), [['smR', 'done', true], ['r2', 'done', false], ['r1', 'done', false]]);
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

  // A hit on an unchanged file returns the entry's stored `jobs` array itself, while a miss re-reads and builds a new one — so reference identity tells
  // a cached entry from an evicted one.
  if (test('LRU cap: 33rd insert stays cached and evicts the oldest entry', () => {
    _resetAgentsCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-agents-lru-'));
    const files: string[] = [];
    const first: (AgentJob[] | null)[] = [];
    for (let i = 0; i < 33; i++) {
      const file = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(file, JSON.stringify(taskRec('t' + i, 'Explore', 'x', '2026-07-01T10:00:00Z')) + '\n');
      files.push(file);
      first.push(readAgentsCached(file));
    }
    assert.strictEqual(readAgentsCached(files[32]), first[32], '33rd transcript was not cached — it evicted itself');
    assert.strictEqual(readAgentsCached(files[1]), first[1], 'second-oldest entry was evicted instead of the oldest');
    assert.notStrictEqual(readAgentsCached(files[0]), first[0], 'oldest entry was not evicted');
  })) p++; else f++;

  if (test('killed notification in a later append closes the run, matching the oracle (#420)', () => {
    _resetAgentsCache();
    const file = tmpFile();
    fs.writeFileSync(file, [taskRec('k', 'Explore', 'async', '2026-07-01T10:00:00Z'),
      ackRec('k', 'bgK', '2026-07-01T10:00:00.030Z')].map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.strictEqual(readAgentsCached(file)![0].status, 'running');
    fs.appendFileSync(file, JSON.stringify(notifyRec('bgK', '2026-07-01T10:03:00Z', undefined, 'killed')) + '\n');
    assertMatchesOracle(file);
    const k = readAgentsCached(file)![0];
    assert.strictEqual(k.status, 'done');
    assert.strictEqual(k.endedAt, '2026-07-01T10:03:00Z');
  })) p++; else f++;

  if (test('#588 endStatus facts: D2 "didn\'t finish" and D5 resume-close, split mid-file across two appends, match the oracle', () => {
    const dnf = `<task-notification>\n<task-id>bgD</task-id>\n<status>stopped</status>\n<summary>Background agent "x" didn\u2019t finish before the previous session ended</summary>\n</task-notification>`;
    const recs = [
      taskRec('d', 'Explore', 'async', '2026-07-01T10:00:00Z'),
      { ...ackRec('d', 'bgD', '2026-07-01T10:00:00.030Z'), toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bgD', resolvedModel: 'm1' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-01T10:30:00Z', sessionId: 's1', content: dnf },
      taskRec('r', 'Explore', 'async', '2026-07-01T10:31:00Z'),
      ackRec('r', 'bgR', '2026-07-01T10:31:00.030Z'),
      { timestamp: '2026-07-01T10:40:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'bgR', message: 'again' } }] } },
      { timestamp: '2026-07-01T10:40:01Z', toolUseResult: { success: true, resumedAgentId: 'bgR' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sm', content: 'Resuming' }] } }
    ];
    const text = recs.map(r => JSON.stringify(r)).join('\n') + '\n';
    const file = tmpFile();
    const cut = Math.floor(text.length / 2);
    fs.writeFileSync(file, text.slice(0, cut));
    readAgentsCached(file);
    fs.appendFileSync(file, text.slice(cut));
    assertMatchesOracle(file);
    const byId = new Map(readAgentsCached(file)!.map(j => [j.id, j]));
    assert.deepStrictEqual([byId.get('d')!.endStatus, byId.get('d')!.model], ['killed', 'm1']);
    assert.strictEqual(byId.get('r')!.endStatus, 'stopped');
    assert.deepStrictEqual([byId.get('sm')!.status, byId.get('sm')!.background], ['running', true]);
  })) p++; else f++;

  /* --------------------------------------------- the async, sliced fold (#563) */

  const SAMPLE = [
    taskRec('t1', 'Explore', 'first 🚀 描述', '2026-07-01T10:00:00Z'),
    resultRec('t1', '2026-07-01T10:00:10Z', { status: 'completed', totalDurationMs: 9500, totalTokens: 1200, totalToolUseCount: 3 }),
    taskRec('t2', 'Plan', 'second', '2026-07-01T10:01:00Z'),
    ackRec('t2', 'bg42', '2026-07-01T10:01:00.030Z'),
    taskRec('t3', 'Explore', 'third', '2026-07-01T10:02:00Z'),
    resultRec('t3', '2026-07-01T10:02:05Z'),
    ...absorbedRecs('bg42', '2026-07-01T10:05:00Z', { tokens: 29252, toolUses: 17, durationMs: 40576 }),
    taskRec('k', 'Explore', 'async', '2026-07-01T10:06:00Z'),
    ackRec('k', 'bgK', '2026-07-01T10:06:00.030Z'),
    notifyRec('bgK', '2026-07-01T10:07:00Z', undefined, 'killed')
  ];
  const jsonl = (recs: unknown[], trailingNewline = true): string => recs.map(r => JSON.stringify(r)).join('\n') + (trailingNewline ? '\n' : '');
  const written = (text: string): string => { const file = tmpFile(); fs.writeFileSync(file, text); return file; };
  const sizeOf = (file: string): number => fs.statSync(file).size;

  const parityFixtures = (): string[] => [
    written(jsonl(SAMPLE)),
    written(jsonl(SAMPLE, false)),
    written(jsonl(SAMPLE.slice(0, 4)) + JSON.stringify(SAMPLE[4]).slice(0, 30)),
    written('')
  ];

  for (const budget of [0, 64]) {
    const label = budget ? `${budget}-byte slices` : 'the default slice';
    if (await testAsync(`async parity with the oracle, ${label}`, async () => {
      for (const file of parityFixtures()) {
        _resetAgentsCache();
        if (budget) _setFoldSliceBytes(budget);
        assert.deepStrictEqual(await readAgentsCachedAsync(file), readAgents(file), file);
      }
    })) p++; else f++;
  }

  if (await testAsync('async: missing file → null', async () => {
    assert.strictEqual(await readAgentsCachedAsync('/no/such/transcript.jsonl'), null);
    assert.strictEqual(await readSessionFoldAsync('/no/such/transcript.jsonl'), null);
  })) p++; else f++;

  if (await testAsync('async: the fold yields to the event loop between slices', async () => {
    _setFoldSliceBytes(64);
    const file = written(jsonl(SAMPLE));
    assert.ok(sizeOf(file) >= 4 * 64, 'fixture must span at least 4 slices');
    const order: string[] = [];
    const fold = readSessionFoldAsync(file).then(r => { order.push('resolved'); return r; });
    setImmediate(() => order.push('ran'));
    const result = await fold;
    assert.deepStrictEqual(order, ['ran', 'resolved']);
    assert.deepStrictEqual(result!.jobs, readAgents(file));
  })) p++; else f++;

  if (await testAsync('async: a sync read between slices advances the same tail — nothing delivered twice', async () => {
    _setFoldSliceBytes(64);
    const file = written(jsonl(SAMPLE));
    const fold = readSessionFoldAsync(file);
    const sync = readSessionFold(file);
    assert.deepStrictEqual(sync!.jobs, readAgents(file));
    assert.deepStrictEqual((await fold)!.jobs, readAgents(file));
  })) p++; else f++;

  if (await testAsync('async: a record longer than a slice is delivered once', async () => {
    _setFoldSliceBytes(64);
    const long = taskRec('big', 'Explore', 'x'.repeat(5 * 64), '2026-07-01T10:03:00Z');
    const file = written(jsonl([SAMPLE[0], long, SAMPLE[1], resultRec('big', '2026-07-01T10:04:00Z')]));
    const jobs = await readAgentsCachedAsync(file);
    assert.deepStrictEqual(jobs, readAgents(file));
    assert.strictEqual(jobs!.filter(j => j.id === 'big').length, 1);
  })) p++; else f++;

  if (await testAsync('async: a newline-less record at the real EOF is consumed; an unparseable one stays buffered until its newline', async () => {
    _setFoldSliceBytes(64);
    const whole = written(jsonl(SAMPLE, false));
    assert.strictEqual((await readAgentsCachedAsync(whole))!.find(j => j.id === 'k')!.status, 'done');

    const lastLine = JSON.stringify(resultRec('t3', '2026-07-01T10:02:05Z'));
    const file = written(jsonl(SAMPLE.slice(0, 5)) + lastLine.slice(0, 40));
    const before = await readAgentsCachedAsync(file);
    assert.deepStrictEqual(before, readAgents(file));
    assert.strictEqual(before!.find(j => j.id === 't3')!.status, 'running');
    fs.appendFileSync(file, lastLine.slice(40) + '\n');
    const after = await readAgentsCachedAsync(file);
    assert.deepStrictEqual(after, readAgents(file));
    assert.strictEqual(after!.find(j => j.id === 't3')!.status, 'done');
  })) p++; else f++;

  if (await testAsync('async: truncation resets state and matches the oracle of the new content', async () => {
    _setFoldSliceBytes(64);
    const file = written(jsonl(SAMPLE));
    await readAgentsCachedAsync(file);
    fs.writeFileSync(file, jsonl([taskRec('n1', 'Explore', 'fresh', '2026-07-01T11:00:00Z')]));
    const jobs = await readAgentsCachedAsync(file);
    assert.deepStrictEqual(jobs, readAgents(file));
    assert.deepStrictEqual(jobs!.map(j => j.id), ['n1']);
  })) p++; else f++;

  if (await testAsync('async: a read failure on the second slice rejects, drops the entry, and the next read recovers', async () => {
    _setFoldSliceBytes(64);
    const file = written(jsonl(SAMPLE));
    const onFile = (q: string): boolean => q === file;
    await assert.rejects(withReadFaultAsync(() => readSessionFoldAsync(file), onFile, 1), /injected read failure/);
    assert.strictEqual(_agentsCacheSize(), 0, 'the failed entry must be dropped');
    assert.deepStrictEqual((await readSessionFoldAsync(file))!.jobs, readAgents(file));
    _resetAgentsCache();
    _setFoldSliceBytes(64);
    assert.deepStrictEqual(await withReadFaultAsync(() => readAgentsCachedAsync(file), onFile, 1), readAgents(file));
  })) p++; else f++;

  if (await testAsync('async: an entry evicted mid-fold still answers its own file, and is not re-inserted', async () => {
    _setFoldSliceBytes(64);
    const file = written(jsonl(SAMPLE));
    const fold = readSessionFoldAsync(file);
    for (let i = 0; i < 32; i++) readSessionFold(written(jsonl([taskRec('o' + i, 'Explore', 'x', '2026-07-01T10:00:00Z')])));
    assert.deepStrictEqual((await fold)!.jobs, readAgents(file));
    assert.ok(_agentsCacheSize() <= 32, `cache size ${_agentsCacheSize()} > 32`);
    assert.strictEqual(bytesRead(() => readSessionFold(file), q => q === file).bytes, sizeOf(file), 'the orphan entry was re-inserted');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
