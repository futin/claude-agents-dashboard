import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readAgents } from '../server/lib/agents.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Write records to a tmp .jsonl and return its path. */
function fixture(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-agents-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n'));
  return file;
}

function taskRec(id: string, type: string, description: string, iso: string, toolName = 'Task') {
  return {
    timestamp: iso,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input: { subagent_type: type, description } }] }
  };
}
function resultRec(toolUseId: string, iso: string, toolUseResult?: unknown) {
  return {
    timestamp: iso,
    ...(toolUseResult !== undefined ? { toolUseResult } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }
  };
}
/** The launch-ack tool_result a background Agent gets immediately (not completion). */
function ackRec(toolUseId: string, agentId: string, iso: string, opts: { structured?: boolean; text?: string } = {}) {
  const text = opts.text ?? `Async agent launched successfully.\nagentId: ${agentId} (internal)`;
  return {
    timestamp: iso,
    ...(opts.structured ? { toolUseResult: { isAsync: true, status: 'async_launched', agentId } } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }
  };
}
/** The later task-notification that reports a background agent finished. */
function notifyRec(agentId: string, status: string, iso: string, usage?: { tokens: number; toolUses: number; durationMs: number }) {
  const usageXml = usage
    ? `\n<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
    : '';
  return {
    timestamp: iso,
    message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>${usageXml}\n</task-notification>` }] }
  };
}

export function run(): number {
  console.log('\n=== agents.ts ===\n');
  let p = 0, f = 0;

  if (test('finished Task: done status + duration', () => {
    const file = fixture([
      taskRec('t1', 'Explore', 'map', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z')
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].status, 'done');
    assert.strictEqual(agents[0].type, 'Explore');
    assert.strictEqual(agents[0].description, 'map');
    assert.strictEqual(agents[0].durationMs, 30000);
    assert.strictEqual(agents[0].endedAt, '2026-07-01T10:00:30Z');
  })) p++; else f++;

  if (test('unmatched Task: running status, null end/duration', () => {
    const file = fixture([taskRec('t1', 'general-purpose', 'do', '2026-07-01T10:00:00Z')]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].status, 'running');
    assert.strictEqual(agents[0].endedAt, null);
    assert.strictEqual(agents[0].durationMs, null);
  })) p++; else f++;

  if (test('mixed set: counts correct, newest-first order', () => {
    const file = fixture([
      taskRec('t1', 'Explore', 'first', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:10Z'),
      taskRec('t2', 'Plan', 'second', '2026-07-01T10:01:00Z'),   // still running
      taskRec('t3', 'Explore', 'third', '2026-07-01T10:02:00Z'),
      resultRec('t3', '2026-07-01T10:02:05Z')
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 3);
    // newest-first: t3, t2, t1
    assert.deepStrictEqual(agents.map(a => a.id), ['t3', 't2', 't1']);
    const running = agents.filter(a => a.status === 'running').length;
    const done = agents.filter(a => a.status === 'done').length;
    assert.strictEqual(running, 1);
    assert.strictEqual(done, 2);
  })) p++; else f++;

  if (test('concurrent background Tasks, all unmatched → all running', () => {
    const file = fixture([
      taskRec('a', 'Explore', 'one', '2026-07-01T10:00:00Z'),
      taskRec('b', 'Explore', 'two', '2026-07-01T10:00:01Z'),
      taskRec('c', 'Explore', 'three', '2026-07-01T10:00:02Z')
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 3);
    assert.ok(agents.every(a => a.status === 'running'));
  })) p++; else f++;

  if (test('Agent-named launch is detected (FleetView harness)', () => {
    const file = fixture([
      taskRec('g1', 'Explore', 'scan', '2026-07-01T10:00:00Z', 'Agent'),
      resultRec('g1', '2026-07-01T10:00:12Z')
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].type, 'Explore');
    assert.strictEqual(agents[0].status, 'done');
  })) p++; else f++;

  if (test('background agent: ack is NOT completion; task-notification finishes it', () => {
    const file = fixture([
      taskRec('toolu_1', 'Explore', 'scan', '2026-07-01T10:00:00Z', 'Agent'),
      ackRec('toolu_1', 'abc123def', '2026-07-01T10:00:00.030Z'),   // +30ms launch ack
      notifyRec('abc123def', 'completed', '2026-07-01T10:00:58Z')   // real end ~58s
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].status, 'done');
    assert.strictEqual(agents[0].endedAt, '2026-07-01T10:00:58Z');
    assert.strictEqual(agents[0].durationMs, 58000); // from the notification, not the 30ms ack
  })) p++; else f++;

  if (test('background agent still running: ack but no completion notification', () => {
    const file = fixture([
      taskRec('toolu_2', 'Plan', 'design', '2026-07-01T10:00:00Z', 'Agent'),
      ackRec('toolu_2', 'zzz999', '2026-07-01T10:00:00.030Z')
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents[0].status, 'running');
    assert.strictEqual(agents[0].endedAt, null);
    assert.strictEqual(agents[0].durationMs, null);
  })) p++; else f++;

  if (test('no Task calls → empty list', () => {
    const file = fixture([
      { timestamp: '2026-07-01T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'ls' } }] } },
      { timestamp: '2026-07-01T10:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'ok' }] } }
    ]);
    const agents = readAgents(file)!;
    assert.strictEqual(agents.length, 0);
  })) p++; else f++;

  if (test('missing file → null', () => {
    assert.strictEqual(readAgents('/no/such/transcript.jsonl'), null);
  })) p++; else f++;

  if (test('sync toolUseResult metrics: tokens, toolUses, exact duration beats timestamps', () => {
    const file = fixture([
      taskRec('t1', 'Explore', 'map', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z', {
        status: 'completed', totalDurationMs: 52631, totalTokens: 37885, totalToolUseCount: 14,
        usage: { input_tokens: 5, output_tokens: 3146 }
      })
    ]);
    const a = readAgents(file)![0];
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(a.tokens, 37885);
    assert.strictEqual(a.toolUses, 14);
    assert.strictEqual(a.durationMs, 52631); // exact value, not the 30s timestamp diff
  })) p++; else f++;

  if (test('async ack via structured toolUseResult alone (no ack text) → running', () => {
    const file = fixture([
      taskRec('toolu_9', 'Explore', 'scan', '2026-07-01T10:00:00Z'),
      ackRec('toolu_9', 'hex42', '2026-07-01T10:00:00.030Z', { structured: true, text: 'launch ok' })
    ]);
    const a = readAgents(file)![0];
    assert.strictEqual(a.status, 'running');
    assert.strictEqual(a.endedAt, null);
  })) p++; else f++;

  if (test('async completion carries usage block → tokens, toolUses, exact duration', () => {
    const file = fixture([
      taskRec('toolu_9', 'Explore', 'scan', '2026-07-01T10:00:00Z'),
      ackRec('toolu_9', 'hex42', '2026-07-01T10:00:00.030Z', { structured: true, text: 'launch ok' }),
      notifyRec('hex42', 'completed', '2026-07-01T10:01:00Z', { tokens: 29252, toolUses: 17, durationMs: 40576 })
    ]);
    const a = readAgents(file)![0];
    assert.strictEqual(a.status, 'done');
    assert.strictEqual(a.tokens, 29252);
    assert.strictEqual(a.toolUses, 17);
    assert.strictEqual(a.durationMs, 40576); // exact, not the 60s timestamp diff
  })) p++; else f++;

  if (test('old-style records without metrics → null tokens/toolUses, timestamp-diff duration', () => {
    const file = fixture([
      taskRec('t1', 'Explore', 'map', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z')
    ]);
    const a = readAgents(file)![0];
    assert.strictEqual(a.tokens, null);
    assert.strictEqual(a.toolUses, null);
    assert.strictEqual(a.durationMs, 30000);
  })) p++; else f++;

  if (test('running agent → all metric fields null', () => {
    const file = fixture([taskRec('t1', 'Plan', 'design', '2026-07-01T10:00:00Z')]);
    const a = readAgents(file)![0];
    assert.strictEqual(a.tokens, null);
    assert.strictEqual(a.toolUses, null);
    assert.strictEqual(a.durationMs, null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
