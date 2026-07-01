/**
 * agents.ts — enumerate the subagents a session launched, from its transcript.
 *
 * The main agent launches a subagent with the `Task` tool (stock Claude Code) or
 * `Agent` tool (some harnesses). Two completion patterns exist:
 *
 *  - Synchronous: the assistant `tool_use` (id `toolu_…`) is answered by a user
 *    `tool_result` with the matching `tool_use_id` — that result IS the agent's
 *    output. use→result timestamps give the real duration.
 *
 *  - Background (async): the immediate `tool_result` is only a launch ack
 *    ("Async agent launched successfully. agentId: <hex>"). The real completion
 *    arrives later as a `<task-notification>` user message keyed by that `<hex>`
 *    agentId (not the tool_use_id), carrying `<status>completed</status>`.
 *
 * Both are derived from the PARENT transcript alone. Unlike transcript.ts (256KB
 * tail, newest tool only) this walks the WHOLE file, so it runs on demand (only
 * for a selected session), never in the 3s poll loop.
 */

import fs from 'node:fs';

import type { AgentJob } from '../../shared/types.js';

/**
 * A subagent launch tool_use? `Task` (stock) or `Agent` (FleetView); both carry
 * a `subagent_type`. Fall back to that field so a future rename still matches.
 */
function isAgentLaunch(b: any): boolean {
  if (!b || b.type !== 'tool_use') return false;
  if (b.name === 'Task' || b.name === 'Agent') return true;
  return !!(b.input && typeof b.input.subagent_type === 'string');
}

/** Flatten a message.content (array of blocks | string) into plain text. */
function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (typeof b === 'string') out += b;
    else if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
    else if (b && b.type === 'tool_result') out += toolResultText(b);
  }
  return out;
}

/** Text of a tool_result block (its content is itself string | block[]). */
function toolResultText(b: any): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return b.content.map((x: any) => (x && typeof x.text === 'string' ? x.text : '')).join('');
  }
  return '';
}

const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9]+)/;
const TASK_ID_RE = /<task-id>\s*([A-Za-z0-9]+)\s*<\/task-id>/;
const STATUS_RE = /<status>\s*([a-z_]+)\s*<\/status>/i;

interface Launch {
  id: string;                 // tool_use id (toolu_…)
  type: string;
  description: string;
  startedAt: string | null;
  /** The immediate tool_result was a background launch ack (not completion). */
  background: boolean;
  /** agentId from the ack, used to pair the later task-notification (null if unparsable). */
  agentId: string | null;
  /** Timestamp of a synchronous tool_result (null for background / unanswered). */
  syncEndedAt: string | null;
}

/**
 * Read a transcript and return its subagents, newest-first.
 * Returns null if the file can't be read.
 */
export function readAgents(filePath: string): AgentJob[] | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const launches: Launch[] = [];
  const resultById = new Map<string, { ts: string | null; text: string }>(); // tool_use_id → first result
  const completedByAgentId = new Map<string, string>();                       // agentId → completion ts

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;

    // Background completion: a task-notification user message keyed by agentId.
    const flat = contentText(content);
    if (flat.includes('<task-notification>')) {
      const idM = flat.match(TASK_ID_RE);
      const stM = flat.match(STATUS_RE);
      if (idM && stM && stM[1].toLowerCase() === 'completed' && !completedByAgentId.has(idM[1])) {
        if (ts) completedByAgentId.set(idM[1], ts);
      }
    }

    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (isAgentLaunch(b) && typeof b.id === 'string') {
        const input = b.input || {};
        launches.push({
          id: b.id,
          type: typeof input.subagent_type === 'string' ? input.subagent_type : '',
          description: typeof input.description === 'string' ? input.description : '',
          startedAt: ts,
          background: false,
          agentId: null,
          syncEndedAt: null
        });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (!resultById.has(b.tool_use_id)) {
          resultById.set(b.tool_use_id, { ts, text: toolResultText(b) });
        }
      }
    }
  }

  // Link each launch to its immediate tool_result: sync completion vs async ack.
  for (const l of launches) {
    const res = resultById.get(l.id);
    if (!res) continue;
    if (/Async agent launched/i.test(res.text)) {
      // Background: the ack is NOT completion. Completion (if any) is a later
      // task-notification keyed by agentId; unparsable id → stays running.
      l.background = true;
      const m = res.text.match(AGENT_ID_RE);
      l.agentId = m ? m[1] : null;
    } else {
      l.syncEndedAt = res.ts;    // synchronous: the result is the completion
    }
  }

  const agents: AgentJob[] = launches.map(l => {
    const asyncEnd = l.background && l.agentId ? completedByAgentId.get(l.agentId) || null : null;
    const endedAt = asyncEnd || l.syncEndedAt;
    const startMs = l.startedAt ? Date.parse(l.startedAt) : NaN;
    const endMs = endedAt ? Date.parse(endedAt) : NaN;
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null;
    return {
      id: l.id,
      type: l.type,
      description: l.description,
      status: endedAt ? 'done' : 'running',
      startedAt: l.startedAt,
      endedAt,
      durationMs
    };
  });

  agents.reverse(); // file order is oldest→newest; return newest-first
  return agents;
}
