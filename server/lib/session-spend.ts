/**
 * session-spend.ts — what a session has spent so far, main agent plus subagents,
 * followed incrementally so the 3s drawer poll costs O(new bytes).
 *
 * The figure is `billableApprox` (input + output + cache writes; cache reads stay
 * out) with the same record rules as the session analysis: main like
 * `analyzeSession`, subagents like `sumTranscript`. Tests pin the two equal.
 *
 * Compaction cannot lower it. Transcripts are append-only, a replayed turn dedupes
 * by `message.id`, and the summary record is skipped. The compaction call itself is
 * written nowhere (no usage near the boundary in 3 transcripts, 0 `agent-*compact*`
 * files in 74 subagent dirs, 2026-11-05), so a compacted session's total is a
 * minimum, which `compactions` reports.
 *
 * Only a transcript a launch claims is followed, so an orphan file never counts. The
 * harness's `AgentJob.tokens` is final context size, not spend: it is never added,
 * only compared, because a finished transcript summing below it has lost turns.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SessionSpend } from '../../shared/types.js';
import { readAgentsCached } from './agents-cache.js';
import { createTail, followJsonl, type JsonlTail } from './jsonl-tail.js';
import { SUBAGENT_DIR } from './subagent-usage.js';
import { isConversationRecord } from './transcript.js';

interface Tally {
  tail: JsonlTail;
  seen: Set<string>;
  billable: number;
  /** All four classes, the unit the harness figure is measured in. */
  combined: number;
  compactions: number;
}

interface CacheEntry {
  files: Map<string, Tally>;
  /** Transcript name to launching tool_use id. A sidecar can appear after its transcript, so only hits are kept. */
  toolUseIds: Map<string, string>;
  lastUsed: number;
}

const MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function addUsage(t: Tally, u: any): void {
  const billable = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
  t.billable += billable;
  t.combined += billable + num(u.cache_read_input_tokens);
}

function onMainRecord(t: Tally, rec: any): void {
  if (!rec || rec.isSidechain === true) return;
  if (rec.compactMetadata && typeof rec.compactMetadata === 'object') { t.compactions++; return; }
  if (rec.isCompactSummary === true || !isConversationRecord(rec)) return;
  const msg = rec.message;
  if (!msg || msg.role !== 'assistant') return;
  // `analyzeSession` spends a turn on its first record even when that record has no usage.
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  const first = id === null || !t.seen.has(id);
  if (id !== null) t.seen.add(id);
  if (first && msg.usage && typeof msg.usage === 'object') addUsage(t, msg.usage);
}

function onSubagentRecord(t: Tally, rec: any): void {
  if (!rec) return;
  if (rec.compactMetadata && typeof rec.compactMetadata === 'object') t.compactions++;
  const msg = rec.message;
  if (!msg || msg.role !== 'assistant' || !msg.usage || typeof msg.usage !== 'object') return;
  if (typeof msg.id === 'string' && msg.id) {
    if (t.seen.has(msg.id)) return;
    t.seen.add(msg.id);
  }
  addUsage(t, msg.usage);
}

function follow(files: Map<string, Tally>, filePath: string, size: number, onRecord: (t: Tally, rec: any) => void): Tally {
  let t = files.get(filePath);
  if (!t || size < t.tail.offset) {
    t = { tail: createTail(), seen: new Set(), billable: 0, combined: 0, compactions: 0 };
    files.set(filePath, t);
  }
  if (size !== t.tail.offset || t.tail.partial.length > 0) {
    const tally = t;
    followJsonl(filePath, size, tally.tail, rec => onRecord(tally, rec));
  }
  return t;
}

function readToolUseId(dir: string, agentId: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
    return meta && typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
  } catch {
    return null;
  }
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, e] of cache) {
    if (e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

/** The session's spend so far, or null when its transcript can't be read. A read failure past that point throws. */
export function readSessionSpend(mainPath: string): Omit<SessionSpend, 'id' | 'error'> | null {
  const agents = readAgentsCached(mainPath);
  if (!agents) {
    cache.delete(mainPath);
    return null;
  }
  let entry = cache.get(mainPath);
  if (!entry) {
    entry = { files: new Map(), toolUseIds: new Map(), lastUsed: Date.now() };
    cache.set(mainPath, entry);
    evictIfNeeded();
  }
  entry.lastUsed = Date.now();

  const mainTally = follow(entry.files, mainPath, fs.statSync(mainPath).size, onMainRecord);

  // Names come from the directory listing, never from an id in the transcript, so a hostile agentId can't reach another path.
  const dir = path.join(mainPath.replace(/\.jsonl$/, ''), SUBAGENT_DIR);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { /* no subagents yet */ }
  const agentIds = names.map(n => /^agent-(.+)\.jsonl$/.exec(n)?.[1]).filter((id): id is string => !!id);
  const known = new Set(agentIds);

  let byToolUseId: Map<string, string> | null = null;
  const claimedBy = (toolUseId: string): string | undefined => {
    if (!byToolUseId) {
      byToolUseId = new Map();
      for (const agentId of agentIds) {
        const found = entry.toolUseIds.get(agentId) ?? readToolUseId(dir, agentId);
        if (!found) continue;
        entry.toolUseIds.set(agentId, found);
        byToolUseId.set(found, agentId);
      }
    }
    return byToolUseId.get(toolUseId);
  };

  let subagents = 0;
  let compactions = mainTally.compactions;
  let uncountedSubagents = 0;
  const joined = new Set<string>();
  for (const a of agents) {
    if (a.resumed) continue;
    const agentId = a.agentId && known.has(a.agentId) ? a.agentId : claimedBy(a.id);
    if (!agentId) {
      if (a.status === 'done') uncountedSubagents++;
      continue;
    }
    if (joined.has(agentId)) continue;
    joined.add(agentId);
    const filePath = path.join(dir, `agent-${agentId}.jsonl`);
    const t = follow(entry.files, filePath, fs.statSync(filePath).size, onSubagentRecord);
    subagents += t.billable;
    compactions += t.compactions;
    if (a.status === 'done' && t.combined < (a.tokens ?? 0)) uncountedSubagents++;
  }

  return { main: mainTally.billable, subagents, total: mainTally.billable + subagents, compactions, uncountedSubagents };
}

/** Test hook. */
export function _resetSessionSpendCache(): void { cache.clear(); }
