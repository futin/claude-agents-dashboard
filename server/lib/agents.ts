/**
 * agents.ts — enumerate the subagents a session launched, from its transcript.
 *
 * The main agent launches a subagent with the `Task` tool (stock Claude Code) or
 * `Agent` tool (some harnesses). Two completion patterns exist:
 *
 *  - Synchronous: the assistant `tool_use` (id `toolu_…`) is answered by a user
 *    `tool_result` with the matching `tool_use_id` — that result IS the agent's
 *    output. The record also carries a top-level `toolUseResult` with the exact
 *    `totalDurationMs` / `totalTokens` / `totalToolUseCount`.
 *
 *  - Background (async): the immediate `tool_result` is only a launch ack
 *    (`toolUseResult.isAsync` / "Async agent launched … agentId: <hex>"). The
 *    real completion arrives later as a `<task-notification>` user message keyed
 *    by that `<hex>` agentId (not the tool_use_id), carrying
 *    `<status>completed</status>` plus a `<usage>` block with the same metrics.
 *
 * Both are derived from the PARENT transcript alone. The interpretation is split
 * into a pure per-record event parser (`parseRecordEvents`) and a reducer over
 * `ScanState` (`applyEvent`), so the whole-file `readAgents` (the oracle) and
 * the incremental cache (agents-cache.ts) share the exact same logic. Unlike
 * transcript.ts (256KB tail, newest tool only) `readAgents` walks the WHOLE
 * file, so it runs on demand (only for a selected session), never in the 3s
 * poll loop.
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
const SUBAGENT_TOKENS_RE = /<subagent_tokens>\s*(\d+)\s*<\/subagent_tokens>/;
const TOOL_USES_RE = /<tool_uses>\s*(\d+)\s*<\/tool_uses>/;
const DURATION_MS_RE = /<duration_ms>\s*(\d+)\s*<\/duration_ms>/;

/** One agent-relevant fact extracted from a transcript record. */
export type AgentEvent =
  | { kind: 'launch'; id: string; type: string; description: string; ts: string | null }
  | { kind: 'result'; toolUseId: string; ts: string | null;
      isAsyncAck: boolean; agentId: string | null;
      tokens: number | null; toolUses: number | null; exactDurationMs: number | null }
  | { kind: 'notify'; agentId: string; completed: boolean; ts: string | null;
      tokens: number | null; toolUses: number | null; exactDurationMs: number | null };

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intFromMatch(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract agent events from one parsed JSONL record. Pure; shared by
 * `readAgents` and the incremental cache.
 */
export function parseRecordEvents(rec: any): AgentEvent[] {
  const msg = rec && rec.message;
  if (!msg) return [];
  const content = msg.content;
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const events: AgentEvent[] = [];

  // Background completion: a task-notification user message keyed by agentId.
  const flat = contentText(content);
  if (flat.includes('<task-notification>')) {
    const idM = flat.match(TASK_ID_RE);
    const stM = flat.match(STATUS_RE);
    if (idM && stM) {
      events.push({
        kind: 'notify',
        agentId: idM[1],
        completed: stM[1].toLowerCase() === 'completed',
        ts,
        tokens: intFromMatch(flat, SUBAGENT_TOKENS_RE),
        toolUses: intFromMatch(flat, TOOL_USES_RE),
        exactDurationMs: intFromMatch(flat, DURATION_MS_RE)
      });
    }
  }

  if (!Array.isArray(content)) return events;
  // The record-level toolUseResult describes the record's tool_result (records
  // carry at most one in practice; apply it to the first).
  let tur: any = rec.toolUseResult;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (isAgentLaunch(b) && typeof b.id === 'string') {
      const input = b.input || {};
      events.push({
        kind: 'launch',
        id: b.id,
        type: typeof input.subagent_type === 'string' ? input.subagent_type : '',
        description: typeof input.description === 'string' ? input.description : '',
        ts
      });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const text = toolResultText(b);
      const t = tur && typeof tur === 'object' ? tur : null;
      tur = undefined; // first tool_result consumes it
      const isAsyncAck =
        (t && (t.isAsync === true || t.status === 'async_launched')) ||
        /Async agent launched/i.test(text);
      let agentId: string | null = null;
      if (isAsyncAck) {
        if (t && typeof t.agentId === 'string') agentId = t.agentId;
        else {
          const m = text.match(AGENT_ID_RE);
          agentId = m ? m[1] : null;
        }
      }
      events.push({
        kind: 'result',
        toolUseId: b.tool_use_id,
        ts,
        isAsyncAck: !!isAsyncAck,
        agentId,
        tokens: isAsyncAck ? null : finiteOrNull(t?.totalTokens),
        toolUses: isAsyncAck ? null : finiteOrNull(t?.totalToolUseCount),
        exactDurationMs: isAsyncAck ? null : finiteOrNull(t?.totalDurationMs)
      });
    }
  }
  return events;
}

interface Launch {
  id: string;                 // tool_use id (toolu_…)
  type: string;
  description: string;
  startedAt: string | null;
  endedAt: string | null;     // sync tool_result ts, or task-notification ts
  exactDurationMs: number | null;
  tokens: number | null;
  toolUses: number | null;
}

/**
 * Reducer state. `byToolUseId` holds launches awaiting their immediate
 * tool_result; `byAgentId` holds background launches awaiting their
 * task-notification. Keeping these maps alive across incremental reads is what
 * lets an out-of-order completion (a notification landing long after younger
 * launches settled) still resolve — no re-scan needed.
 */
export interface ScanState {
  launches: Launch[];                  // file order (oldest first)
  byToolUseId: Map<string, Launch>;
  byAgentId: Map<string, Launch>;
}

export function createScanState(): ScanState {
  return { launches: [], byToolUseId: new Map(), byAgentId: new Map() };
}

/** Fold one event into the state. First result / first notification wins. */
export function applyEvent(state: ScanState, ev: AgentEvent): void {
  if (ev.kind === 'launch') {
    const l: Launch = {
      id: ev.id, type: ev.type, description: ev.description,
      startedAt: ev.ts, endedAt: null, exactDurationMs: null, tokens: null, toolUses: null
    };
    state.launches.push(l);
    if (!state.byToolUseId.has(ev.id)) state.byToolUseId.set(ev.id, l);
    return;
  }
  if (ev.kind === 'result') {
    const l = state.byToolUseId.get(ev.toolUseId);
    if (!l) return;
    state.byToolUseId.delete(ev.toolUseId);
    if (ev.isAsyncAck) {
      // Launch ack, not completion; completion (if any) is a later
      // task-notification keyed by agentId. Unparsable id → stays running.
      if (ev.agentId && !state.byAgentId.has(ev.agentId)) state.byAgentId.set(ev.agentId, l);
    } else {
      l.endedAt = ev.ts;
      l.tokens = ev.tokens;
      l.toolUses = ev.toolUses;
      l.exactDurationMs = ev.exactDurationMs;
    }
    return;
  }
  // notify — only a timestamped completion resolves the launch.
  if (!ev.completed || !ev.ts) return;
  const l = state.byAgentId.get(ev.agentId);
  if (!l) return;
  state.byAgentId.delete(ev.agentId);
  l.endedAt = ev.ts;
  l.tokens = ev.tokens;
  l.toolUses = ev.toolUses;
  l.exactDurationMs = ev.exactDurationMs;
}

/** Materialize AgentJob[] (newest-first) from state. Non-destructive. */
export function toAgentJobs(state: ScanState): AgentJob[] {
  const agents: AgentJob[] = state.launches.map(l => {
    const startMs = l.startedAt ? Date.parse(l.startedAt) : NaN;
    const endMs = l.endedAt ? Date.parse(l.endedAt) : NaN;
    const diff = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null;
    return {
      id: l.id,
      type: l.type,
      description: l.description,
      status: l.endedAt ? 'done' : 'running',
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      durationMs: l.exactDurationMs ?? diff,
      tokens: l.tokens,
      toolUses: l.toolUses
    };
  });
  agents.reverse(); // file order is oldest→newest; return newest-first
  return agents;
}

/**
 * Read a transcript and return its subagents, newest-first.
 * Returns null if the file can't be read. Whole-file pure pass — the
 * cold-start / fallback / test oracle for the incremental cache.
 */
export function readAgents(filePath: string): AgentJob[] | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const state = createScanState();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    for (const ev of parseRecordEvents(rec)) applyEvent(state, ev);
  }
  return toAgentJobs(state);
}
