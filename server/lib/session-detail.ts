/**
 * session-detail.ts — composes `GET /api/sessions/:id` (#588): the reducer's rows from the parent transcript (`readAgentsCachedAsync`), each overlaid with
 * its subagent's own file facts (`subagent-facts.ts`), plus whether the parent process lives (`session-registry.ts`). The rows the cache returns are its
 * live state, so every row is copied, never written through.
 */

import type { AgentJob, SessionDetail } from '../../shared/types.js';
import { readAgentsCachedAsync } from './agents-cache.js';
import type { ProcProbe } from './scan.js';
import { parentLiveOf } from './session-registry.js';
import { readSubagentFacts } from './subagent-facts.js';

export interface SessionDetailDeps {
  probe: ProcProbe | null;
  registry: Map<string, string[]> | null;
}

function overlay(file: string, job: AgentJob): AgentJob {
  if (!job.agentId) return { ...job, lastWriteAt: null, lastTool: null, blockedReason: null };
  const f = readSubagentFacts(file, job.agentId, job.status === 'running');
  return {
    ...job,
    // A resumed run is background whatever the meta file says about the original launch.
    background: job.resumed ? true : f.background ?? job.background,
    model: f.model ?? job.model ?? null,
    lastWriteAt: f.lastWriteAt,
    lastTool: f.lastTool,
    blockedReason: f.blockedReason
  };
}

/** The detail body for session `id` whose transcript is `file`; null when the transcript cannot be read. */
export async function buildSessionDetail(id: string, file: string, deps: SessionDetailDeps): Promise<SessionDetail | null> {
  const jobs = await readAgentsCachedAsync(file);
  if (!jobs) return null;
  const agents = jobs.map(j => overlay(file, j));
  return {
    id,
    agents,
    running: agents.filter(a => a.status === 'running').length,
    finished: agents.filter(a => a.status === 'done').length,
    parentLive: parentLiveOf(id, deps.probe, deps.registry)
  };
}
