/**
 * analyze.ts — whole-session token/tool post-mortem (the doctor). Pure, zero
 * runtime deps. Unlike transcript.ts (256KB tail, latest usage only) this walks
 * the WHOLE file and SUMS every main-agent turn, so it answers "how many tokens
 * did this session actually spend" — not "what's in the context window now".
 *
 * Two facts about the data shape the output (both surfaced in `notes`):
 *  - `cache_read_input_tokens` usually dwarfs `input_tokens` (prompt caching
 *    replays the whole prompt each turn) but is billed at ~10%. So we keep the
 *    four token fields separate, expose `combined` (context pressure) AND
 *    `billableApprox` (excludes cacheRead — closer to real cost).
 *  - There is NO per-tool token field on disk. Per-tool counts/errors/durations
 *    are exact; per-tool tokens are only an even split of a turn's output_tokens
 *    across its tool calls (`approxOutputTokens`).
 *
 * Subagent turns replay in the parent transcript as `isSidechain:true` records
 * with their own usage; those are skipped here so they don't double-count against
 * `bySubagent` (sourced from readAgents). Whole-session total ≈
 * totals.combined + subagentTotals.tokens.
 */

import fs from 'node:fs';

import { readAgents } from './agents.js';
import type {
  ErrorSignals, SessionAnalysis, SubagentTotals, ToolStat
} from '../../shared/types.js';

/** Finite number or 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Flatten a tool_result block's content to text (content is string | block[]). */
function toolResultText(b: any): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return b.content.map((x: any) => (x && typeof x.text === 'string' ? x.text : '')).join('');
  }
  return '';
}

/** A tool_result the model saw as a failure. */
function isErrorResult(b: any): boolean {
  return b.is_error === true || /<tool_use_error>/i.test(toolResultText(b));
}

/** Plain text of a human user turn (string content or text blocks), '' otherwise. */
function userText(msg: any): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * Looks like the human pushing back. Deliberately conservative and documented as
 * a noisy lower bound — the skill, not this heuristic, judges accuracy.
 */
const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not (?:what|right|correct)|actually|instead|revert|undo|don'?t|that'?s not)\b/i;

/**
 * Read a transcript and return whole-session facts. Null if the file can't be
 * read. Never throws on malformed lines — bad records are skipped.
 */
export function analyzeSession(filePath: string, id?: string): SessionAnalysis | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  const models = new Set<string>();
  const toolMap = new Map<string, ToolStat>();
  const pendingTool = new Map<string, { name: string; ts: string | null }>();
  const errorOutstanding = new Set<string>();
  let serverWebSearch = 0, serverWebFetch = 0;
  let toolErrors = 0, retries = 0, userCorrections = 0;
  let turnCount = 0, sumCombined = 0, maxCombined = 0, maxTurnIndex = -1;
  let cwd: string | null = null;
  let minTs: string | null = null, maxTs: string | null = null;

  const getTool = (name: string): ToolStat => {
    let s = toolMap.get(name);
    if (!s) { s = { tool: name, count: 0, durationMs: 0, errors: 0, approxOutputTokens: 0 }; toolMap.set(name, s); }
    return s;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts) {
      if (!minTs || ts < minTs) minTs = ts;
      if (!maxTs || ts > maxTs) maxTs = ts;
    }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;

    // Subagent-internal turns replay here with their own usage; counting them
    // would double against bySubagent (readAgents). Skip for main-agent facts.
    if (rec.isSidechain === true) continue;

    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;

    if (msg.role === 'assistant') {
      let outTokens = 0;
      const u = msg.usage;
      if (u && typeof u === 'object') {
        const inp = num(u.input_tokens), out = num(u.output_tokens);
        const cc = num(u.cache_creation_input_tokens), cr = num(u.cache_read_input_tokens);
        outTokens = out;
        const combined = inp + out + cc + cr;
        if (combined > 0) {
          input += inp; output += out; cacheCreation += cc; cacheRead += cr;
          if (typeof msg.model === 'string' && msg.model) models.add(msg.model);
          const idx = turnCount++;
          sumCombined += combined;
          if (combined > maxCombined) { maxCombined = combined; maxTurnIndex = idx; }
        }
        const stu = u.server_tool_use;
        if (stu && typeof stu === 'object') {
          serverWebSearch += num(stu.web_search_requests);
          serverWebFetch += num(stu.web_fetch_requests);
        }
      }
      if (Array.isArray(content)) {
        const toolBlocks = content.filter((b: any) => b && b.type === 'tool_use' && typeof b.name === 'string');
        const share = toolBlocks.length > 0 ? outTokens / toolBlocks.length : 0;
        for (const b of toolBlocks) {
          const s = getTool(b.name);
          s.count++;
          s.approxOutputTokens += share;
          // Re-invoking a tool that just errored = rework.
          if (errorOutstanding.has(b.name)) { retries++; errorOutstanding.delete(b.name); }
          if (typeof b.id === 'string') pendingTool.set(b.id, { name: b.name, ts });
        }
      }
    } else if (msg.role === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const p = pendingTool.get(b.tool_use_id);
          const err = isErrorResult(b);
          if (p) {
            pendingTool.delete(b.tool_use_id);
            const s = getTool(p.name);
            if (p.ts && ts) {
              const d = Date.parse(ts) - Date.parse(p.ts);
              if (Number.isFinite(d) && d >= 0) s.durationMs += d;
            }
            if (err) { s.errors++; toolErrors++; errorOutstanding.add(p.name); }
            else errorOutstanding.delete(p.name);
          } else if (err) {
            toolErrors++;
          }
        }
      }
      // Correction heuristic — only on human-typed turns, never task-notifications.
      const t = userText(msg);
      if (t && !t.includes('<task-notification>') && CORRECTION_RE.test(t)) userCorrections++;
    }
  }

  const combined = input + output + cacheCreation + cacheRead;
  const byTool = [...toolMap.values()]
    .map(s => ({ ...s, approxOutputTokens: Math.round(s.approxOutputTokens) }))
    .sort((a, b) => b.approxOutputTokens - a.approxOutputTokens || b.count - a.count);

  const agents = readAgents(filePath) || [];
  const subagentTotals: SubagentTotals = {
    count: agents.length,
    tokens: agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0),
    unknownTokenCount: agents.filter(a => a.tokens == null).length
  };

  const errorSignals: ErrorSignals = { toolErrors, retries, userCorrections };

  const notes: string[] = [
    'combined includes cache_read (replayed cached prompt, billed ~10%); lead with billableApprox for real cost.',
    'byTool.approxOutputTokens splits each turn\'s output tokens evenly across its tool calls — approximate; the transcript has no per-tool token field.',
    'errorSignals.userCorrections is a keyword heuristic — a noisy lower bound, not an accuracy score.'
  ];
  if (subagentTotals.count > 0) {
    notes.push('Subagent tokens are exact and separate from main-agent totals; whole-session total ≈ totals.combined + subagentTotals.tokens.');
  }
  if (subagentTotals.unknownTokenCount > 0) {
    notes.push(`${subagentTotals.unknownTokenCount} subagent(s) have unknown token totals (still running or old transcript).`);
  }

  const durationMs = minTs && maxTs ? Date.parse(maxTs) - Date.parse(minTs) : null;

  return {
    id: id || filePath.replace(/^.*\//, '').replace(/\.jsonl$/, ''),
    file: filePath,
    cwd,
    models: [...models],
    startedAt: minTs,
    endedAt: maxTs,
    durationMs: Number.isFinite(durationMs as number) ? durationMs : null,
    totals: { input, output, cacheCreation, cacheRead, combined, billableApprox: input + output + cacheCreation },
    perTurn: {
      count: turnCount,
      avgCombined: turnCount > 0 ? Math.round(sumCombined / turnCount) : 0,
      maxCombined,
      maxTurnIndex
    },
    byTool,
    bySubagent: agents,
    subagentTotals,
    serverTools: { webSearch: serverWebSearch, webFetch: serverWebFetch },
    errorSignals,
    notes
  };
}
