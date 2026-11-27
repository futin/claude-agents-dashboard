/** `buildSessionDetail` (#588): the reducer's rows overlaid with each subagent's file facts, plus `parentLive`, without touching the cache's rows. */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetAgentsCache } from '../../server/lib/agents-cache.js';
import type { ProcProbe } from '../../server/lib/scan.js';
import { buildSessionDetail } from '../../server/lib/session-detail.js';
import { _resetSubagentFactsMemo } from '../../server/lib/subagent-facts.js';

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  _resetAgentsCache();
  _resetSubagentFactsMemo();
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const jsonl = (recs: unknown[]): string => recs.map(r => JSON.stringify(r)).join('\n') + '\n';
const launch = (id: string, iso: string) =>
  ({ timestamp: iso, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'Explore', description: 'look' } }] } });
const ack = (toolUseId: string, agentId: string | null, iso: string) => ({
  timestamp: iso,
  toolUseResult: { isAsync: true, status: 'async_launched', ...(agentId ? { agentId } : {}) },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'launched' }] }
});
const rateLimit = {
  type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
  message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 5:30pm" }] }
};
const probe = (ids: string[]): ProcProbe => ({ runningClaudeProcs: 1, liveCwds: null, liveSessionIds: new Set(ids), claudePids: new Set(['1']) });

/** A session transcript plus, optionally, one subagent's transcript and meta. */
function session(mainRecs: unknown[], sub?: { agentId: string; recs: unknown[]; meta?: unknown }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-detail-'));
  const main = path.join(root, 'S1.jsonl');
  fs.writeFileSync(main, jsonl(mainRecs));
  if (sub) {
    const dir = path.join(root, 'S1', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `agent-${sub.agentId}.jsonl`), jsonl(sub.recs));
    if (sub.meta !== undefined) fs.writeFileSync(path.join(dir, `agent-${sub.agentId}.meta.json`), JSON.stringify(sub.meta));
  }
  return main;
}

export async function run(): Promise<number> {
  console.log('\n=== session-detail.ts ===\n');
  let p = 0, f = 0;

  if (await testAsync('18: a running background subagent stuck on a rate limit, with a live parent', async () => {
    const file = session([launch('t1', '2026-11-27T10:00:00Z'), ack('t1', 'a1', '2026-11-27T10:00:01Z')],
      { agentId: 'a1', recs: [rateLimit], meta: { requestShape: 'background', model: 'm1' } });
    const d = (await buildSessionDetail('S1', file, { probe: probe(['S1']), registry: new Map() }))!;
    const a = d.agents[0];
    assert.deepStrictEqual([a.background, a.model, a.blockedReason, d.parentLive], [true, 'm1', 'rate-limit', true]);
    assert.ok(typeof a.lastWriteAt === 'string' && a.lastWriteAt.length > 0);
    assert.deepStrictEqual([d.running, d.finished], [1, 0]);
  })) p++; else f++;

  if (await testAsync('19: a row with no agentId gets null file facts and does not throw', async () => {
    const file = session([launch('t1', '2026-11-27T10:00:00Z'), ack('t1', null, '2026-11-27T10:00:01Z')]);
    const d = (await buildSessionDetail('S1', file, { probe: null, registry: null }))!;
    const a = d.agents[0];
    assert.deepStrictEqual([a.agentId, a.lastWriteAt, a.lastTool, a.blockedReason, d.parentLive], [null, null, null, null, null]);
  })) p++; else f++;

  if (await testAsync('20: meta foreground does not unset background on a resumed row; it does on the original', async () => {
    const file = session([
      launch('t1', '2026-11-27T10:00:00Z'),
      { timestamp: '2026-11-27T10:01:00Z', toolUseResult: { agentId: 'a1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } },
      { timestamp: '2026-11-27T10:05:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sm', name: 'SendMessage', input: { to: 'a1', message: 'again' } }] } },
      { timestamp: '2026-11-27T10:05:01Z', toolUseResult: { success: true, resumedAgentId: 'a1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sm', content: 'Resuming' }] } }
    ], { agentId: 'a1', recs: [rateLimit], meta: { requestShape: 'foreground' } });
    const d = (await buildSessionDetail('S1', file, { probe: null, registry: null }))!;
    const [resumed, orig] = d.agents;
    assert.deepStrictEqual([resumed.resumed, resumed.background], [true, true]);
    assert.strictEqual(orig.background, false);
  })) p++; else f++;

  if (await testAsync('21: the answer never aliases the cache — mutating it leaves the next answer intact', async () => {
    const file = session([launch('t1', '2026-11-27T10:00:00Z'), ack('t1', 'a1', '2026-11-27T10:00:01Z')],
      { agentId: 'a1', recs: [rateLimit], meta: { requestShape: 'background', model: 'm1' } });
    const deps = { probe: null, registry: null };
    const first = (await buildSessionDetail('S1', file, deps))!;
    first.agents[0].model = 'mutated';
    first.agents[0].status = 'done';
    const second = (await buildSessionDetail('S1', file, deps))!;
    assert.notStrictEqual(second.agents[0], first.agents[0]);
    assert.deepStrictEqual([second.agents[0].model, second.agents[0].status], ['m1', 'running']);
  })) p++; else f++;

  if (await testAsync('an unreadable transcript is null', async () => {
    assert.strictEqual(await buildSessionDetail('S1', '/no/such/S1.jsonl', { probe: null, registry: null }), null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
