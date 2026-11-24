/**
 * session-spend.ts — what a session has spent so far, main agent plus subagents,
 * followed incrementally so the 3s drawer poll costs O(new bytes).
 *
 * The figure is `billableApprox` (input + output + cache writes; cache reads stay
 * out) with the same record rules as the session analysis: main like
 * `analyzeSession`, subagents once per `message.id`. Tests pin the two equal.
 *
 * It is also the one reader of subagent transcripts for Analytics: {@link readSubagentUsage} folds every `agent-*.jsonl` through the same per-session
 * cache (LRU over 32 sessions) the drawer poll uses, so a repeat Analytics read with no new bytes reads nothing and a grown file costs its appended bytes.
 *
 * Compaction cannot lower it. Transcripts are append-only, a replayed turn dedupes
 * by `message.id`, and the summary record is skipped. The compaction call itself is
 * written nowhere (no usage near the boundary in 3 transcripts, 0 `agent-*compact*`
 * files in 74 subagent dirs, 2026-11-05), so a compacted session's total is a
 * minimum, which `compactions` reports.
 *
 * The main figure is not followed here: it rides the agents-cache pass ({@link readSessionFold}), which folds the main transcript once for both the
 * agents list and this tally, so this cache holds subagent tallies only and an Analytics sweep evicting it costs the drawer subagent bytes, never the
 * main transcript's.
 *
 * Only a transcript a launch claims is followed, so an orphan file never counts. The
 * harness's `AgentJob.tokens` is final context size, not spend: it is never added,
 * only compared, because a finished transcript summing below it has lost turns.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SessionSpend } from '../../shared/types.js';
import { readSessionFold } from './agents-cache.js';
import { createTail, followJsonl, type JsonlTail } from './jsonl-tail.js';
import { billableOf, combinedOf, createTally, onSubagentRecord, totalsOf, type SpendTally } from './spend-tally.js';
import { subagentDirOf, type SubagentFileUsage } from './subagent-usage.js';

/** A subagent transcript's tally and how far into the file it has read. */
interface Tally extends SpendTally {
  tail: JsonlTail;
}

interface CacheEntry {
  /** Subagent transcript path to its tally. */
  files: Map<string, Tally>;
  /** Transcript name to launching tool_use id. A sidecar can appear after its transcript, so only hits are kept. */
  toolUseIds: Map<string, string>;
  lastUsed: number;
}

const MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

function follow(files: Map<string, Tally>, filePath: string, size: number, onRecord: (t: Tally, rec: any) => void): Tally {
  let t = files.get(filePath);
  if (!t || size < t.tail.offset) {
    t = { ...createTally(), tail: createTail() };
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

/** The cache entry for `mainPath`, created when absent; marks it used and evicts the least recently used one past {@link MAX_ENTRIES}. */
function entryFor(mainPath: string): CacheEntry {
  let entry = cache.get(mainPath);
  if (!entry) {
    entry = { files: new Map(), toolUseIds: new Map(), lastUsed: Date.now() };
    cache.set(mainPath, entry);
    evictIfNeeded();
  }
  entry.lastUsed = Date.now();
  return entry;
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

/** The session's spend so far, or null when its transcript can't be read. A later read failure on that transcript throws. */
export function readSessionSpend(mainPath: string): Omit<SessionSpend, 'id' | 'error'> | null {
  const fold = readSessionFold(mainPath);
  if (!fold) {
    cache.delete(mainPath);
    return null;
  }
  const { jobs: agents, main: mainTally } = fold;
  const entry = entryFor(mainPath);

  // Names come from the directory listing, never from an id in the transcript, so a hostile agentId can't reach another path.
  const dir = subagentDirOf(mainPath);
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
    let t: Tally;
    try {
      t = follow(entry.files, filePath, fs.statSync(filePath).size, onSubagentRecord);
    } catch {
      // Unreadable reads as no transcript: one lost file must not hide the session's whole figure.
      if (a.status === 'done') uncountedSubagents++;
      continue;
    }
    subagents += billableOf(t);
    compactions += t.compactions;
    if (a.status === 'done' && combinedOf(t) < (a.tokens ?? 0)) uncountedSubagents++;
  }

  const main = billableOf(mainTally);
  return { main, subagents, total: main + subagents, compactions, uncountedSubagents };
}

/**
 * Every subagent transcript beside the session transcript at `mainPath`, claimed by a launch or not — `analyzeSession` does its own pairing. Empty when
 * the session has no `subagents/` dir; an entry that is not a file, or whose read fails, is skipped for this call, never thrown. Shares
 * {@link readSessionSpend}'s per-file tallies, so each file is read once and then only by its appended bytes.
 */
export function readSubagentUsage(mainPath: string): SubagentFileUsage[] {
  const dir = subagentDirOf(mainPath);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const entry = entryFor(mainPath);
  const out: SubagentFileUsage[] = [];
  // Names come from the directory listing, never from a transcript, as in readSessionSpend.
  for (const name of names) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
    if (!agentId) continue;
    const filePath = path.join(dir, name);
    let t: Tally;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) continue;
      t = follow(entry.files, filePath, st.size, onSubagentRecord);
    } catch {
      continue;
    }
    const toolUseId = entry.toolUseIds.get(agentId) ?? readToolUseId(dir, agentId);
    if (toolUseId) entry.toolUseIds.set(agentId, toolUseId);
    out.push({ agentId, toolUseId, usage: totalsOf(t) });
  }
  return out;
}

/** Test hook. */
export function _resetSessionSpendCache(): void { cache.clear(); }
