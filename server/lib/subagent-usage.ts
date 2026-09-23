/**
 * subagent-usage.ts — what each subagent of a session actually spent, read from
 * its own transcript.
 *
 * The CLI writes every subagent to `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * (plus an `agent-<agentId>.meta.json` sidecar naming the launching `toolUseId`) and
 * never replays those turns into the parent transcript. The parent carries only
 * the harness's one-number summary — `toolUseResult.totalTokens` or
 * `<subagent_tokens>` — and that number is the subagent's FINAL context size:
 * measured 2026-09-23 it matches the last turn's four-class sum to within a few
 * hundred tokens, on subagents whose summed turns were 5–130x larger (bug-27).
 * So spend is summed here from the transcript, once per `message.id` — the same
 * de-duplication `analyze.ts` applies, because every record of one turn carries
 * a full copy of that turn's usage.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { TokenTotals } from '../../shared/types.js';

/** The per-session directory the CLI writes subagent transcripts into. */
export const SUBAGENT_DIR = 'subagents';

/** One subagent transcript's summed usage. */
export interface SubagentFileUsage {
  /** From the filename: `agent-<agentId>.jsonl`. */
  agentId: string;
  /** The launching tool_use id from the `.meta.json` sidecar, null when it is absent. */
  toolUseId: string | null;
  usage: TokenTotals;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, combined: 0, billableApprox: 0 };
}

/** Add `b` into `a` in place. */
export function addTotals(a: TokenTotals, b: TokenTotals): void {
  a.input += b.input; a.output += b.output; a.cacheCreation += b.cacheCreation; a.cacheRead += b.cacheRead;
  a.combined += b.combined; a.billableApprox += b.billableApprox;
}

/** Sum one subagent transcript's usage, once per `message.id`. Records without an id each count once. */
function sumTranscript(text: string): TokenTotals {
  const t = emptyTotals();
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    const msg = rec && rec.message;
    if (!msg || msg.role !== 'assistant' || !msg.usage || typeof msg.usage !== 'object') continue;
    if (typeof msg.id === 'string' && msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    const u = msg.usage;
    const inp = num(u.input_tokens), out = num(u.output_tokens);
    const cc = num(u.cache_creation_input_tokens), cr = num(u.cache_read_input_tokens);
    t.input += inp; t.output += out; t.cacheCreation += cc; t.cacheRead += cr;
  }
  t.combined = t.input + t.output + t.cacheCreation + t.cacheRead;
  t.billableApprox = t.input + t.output + t.cacheCreation;
  return t;
}

/**
 * Every subagent transcript beside the session transcript at `mainPath`. Empty when the
 * session has no `subagents/` dir. Unreadable files are skipped, never thrown.
 */
export function readSubagentUsage(mainPath: string): SubagentFileUsage[] {
  const dir = path.join(mainPath.replace(/\.jsonl$/, ''), SUBAGENT_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: SubagentFileUsage[] = [];
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    let toolUseId: string | null = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${m[1]}.meta.json`), 'utf8'));
      if (meta && typeof meta.toolUseId === 'string') toolUseId = meta.toolUseId;
    } catch { /* no sidecar — agentId matching still works */ }
    out.push({ agentId: m[1], toolUseId, usage: sumTranscript(text) });
  }
  return out;
}
