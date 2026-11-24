/**
 * spend-tally.ts — the spend reducers over one transcript's records: the main-transcript rule (like `analyzeSession`) and the subagent rule (once per
 * `message.id`), plus the figures read off a tally. Its own module because both followers feed it: agents-cache.ts folds the main transcript in the same
 * pass as the agents list, and session-spend.ts folds the subagent files — and session-spend.ts already imports agents-cache.ts.
 */

import type { TokenTotals } from '../../shared/types.js';
import { isConversationRecord } from './transcript.js';
import { assistantUsage, type TokenCounts } from './usage-line.js';

/** Token classes and compactions seen so far; the byte cursor is the follower's, not the tally's. */
export interface SpendTally {
  seen: Set<string>;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  compactions: number;
}

export function createTally(): SpendTally {
  return { seen: new Set(), input: 0, output: 0, cacheCreation: 0, cacheRead: 0, compactions: 0 };
}

/** Input + output + cache writes: the spend figure. */
export const billableOf = (t: SpendTally): number => t.input + t.output + t.cacheCreation;
/** All four classes, the unit the harness figure is measured in. */
export const combinedOf = (t: SpendTally): number => billableOf(t) + t.cacheRead;

function addUsage(t: SpendTally, tok: TokenCounts): void {
  t.input += tok.in; t.output += tok.out; t.cacheCreation += tok.cc; t.cacheRead += tok.cr;
}

export function onMainRecord(t: SpendTally, rec: any): void {
  if (!rec || rec.isSidechain === true) return;
  if (rec.compactMetadata && typeof rec.compactMetadata === 'object') { t.compactions++; return; }
  if (rec.isCompactSummary === true || !isConversationRecord(rec)) return;
  const msg = rec.message;
  if (!msg || msg.role !== 'assistant') return;
  // `analyzeSession` spends a turn on its first record even when that record has no usage, so the id is read here, ahead of the usage parse.
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  const first = id === null || !t.seen.has(id);
  if (id !== null) t.seen.add(id);
  const line = first ? assistantUsage(rec) : null;
  if (line) addUsage(t, line.tok);
}

export function onSubagentRecord(t: SpendTally, rec: any): void {
  if (!rec) return;
  if (rec.compactMetadata && typeof rec.compactMetadata === 'object') t.compactions++;
  const line = assistantUsage(rec);
  if (!line) return;
  if (line.id) {
    if (t.seen.has(line.id)) return;
    t.seen.add(line.id);
  }
  addUsage(t, line.tok);
}

export function totalsOf(t: SpendTally): TokenTotals {
  return {
    input: t.input, output: t.output, cacheCreation: t.cacheCreation, cacheRead: t.cacheRead,
    combined: combinedOf(t), billableApprox: billableOf(t)
  };
}
