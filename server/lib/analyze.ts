/**
 * analyze.ts — whole-session token/tool post-mortem (the kaizen skill). Pure, zero
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
 *    are exact; per-tool output tokens are only an even split of a turn's
 *    output_tokens across its tool calls (`approxOutputTokens`). What each call
 *    injected into context is sized from its own tool_result text instead
 *    (`resultTokens`, chars ÷ 4) — per call, never split, so it is the figure
 *    that surfaces a Read-heavy session.
 *
 * Subagent turns are NOT in this file: the CLI writes them to the session's own
 * `<sessionId>/subagents/agent-*.jsonl`. `subagentTotals` sums those files
 * (`subagent-usage.ts`), matched to the launches readAgents pairs out of this
 * transcript; the harness's own figure in the Task result is only a fallback,
 * because it is the subagent's final context size, not its spend (bug-27).
 * Whole-session total = totals.combined + subagentTotals.tokens. An
 * `isSidechain:true` record is still skipped below, for the older transcripts
 * that did replay one.
 *
 * ONE TURN IS NOT ONE RECORD. Claude Code writes one record per content block —
 * a turn that thinks, talks and fires two tools is four records — and every one
 * of them carries a full copy of the same `message.usage` under the same
 * `message.id`. So usage is summed once per `message.id`, not once per record
 * (measured 1.5–2.3x inflation without it), and a turn's `output_tokens` is
 * split across ALL of that turn's tool blocks, which means buffering them and
 * settling at end of file rather than attributing per record. Records with no
 * `message.id` (old or malformed transcripts) each count as their own turn.
 */

import fs from 'node:fs';

import { readAgents } from './agents.js';
import { addTotals, emptyTotals, readSubagentUsage } from './subagent-usage.js';
import type {
  AgentJob, ErrorSignals, SessionAnalysis, SubagentTotals, ToolStat
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

/**
 * Rough token size of a text: chars ÷ 4, the usual English-and-code rule of
 * thumb. Unrounded — callers sum first and round once.
 */
function approxTokens(text: string): number {
  return text.length / 4;
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
    if (!s) { s = { tool: name, count: 0, durationMs: 0, errors: 0, approxOutputTokens: 0, resultTokens: 0 }; toolMap.set(name, s); }
    return s;
  };

  // One entry per turn (`message.id`), not per record. `out` is that turn's
  // output_tokens (first sighting wins — every copy is identical); `tools` are
  // every tool block the turn emitted, across all of its records. Settled after
  // the walk, because a turn's later records are still to come.
  const turns = new Map<string, { out: number; tools: string[] }>();
  const getTurn = (key: string) => {
    let t = turns.get(key);
    if (!t) { t = { out: 0, tools: [] }; turns.set(key, t); }
    return t;
  };
  const countedTurns = new Set<string>();
  let anonTurnSeq = 0;

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

    // Only older transcripts replay a subagent turn here; counting one would
    // double against bySubagent (readAgents). Skip for main-agent facts.
    if (rec.isSidechain === true) continue;

    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;

    if (msg.role === 'assistant') {
      // Records of one turn share a message.id. Without one, fail open: this
      // record is its own turn, which is exactly the pre-dedup behaviour. The
      // `#` prefix cannot collide with a real id (they are all `msg_…`).
      const turnKey = typeof msg.id === 'string' && msg.id ? msg.id : `#anon${anonTurnSeq++}`;
      const firstOfTurn = !countedTurns.has(turnKey);
      countedTurns.add(turnKey);
      const turn = getTurn(turnKey);

      const u = msg.usage;
      if (u && typeof u === 'object') {
        const inp = num(u.input_tokens), out = num(u.output_tokens);
        const cc = num(u.cache_creation_input_tokens), cr = num(u.cache_read_input_tokens);
        if (out > 0 && turn.out === 0) turn.out = out;
        const combined = inp + out + cc + cr;
        // Only the turn's first record contributes — the rest are copies of it.
        if (combined > 0 && firstOfTurn) {
          input += inp; output += out; cacheCreation += cc; cacheRead += cr;
          if (typeof msg.model === 'string' && msg.model) models.add(msg.model);
          const idx = turnCount++;
          sumCombined += combined;
          if (combined > maxCombined) { maxCombined = combined; maxTurnIndex = idx; }
        }
        const stu = u.server_tool_use;
        if (stu && typeof stu === 'object' && firstOfTurn) {
          serverWebSearch += num(stu.web_search_requests);
          serverWebFetch += num(stu.web_fetch_requests);
        }
      }
      if (Array.isArray(content)) {
        const toolBlocks = content.filter((b: any) => b && b.type === 'tool_use' && typeof b.name === 'string');
        for (const b of toolBlocks) {
          const s = getTool(b.name);
          // count/duration/retries are per tool CALL, and parallel calls really
          // do land in separate records — only the token split is per turn.
          s.count++;
          turn.tools.push(b.name);
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
            // Per call, error text included — independent of the errors count.
            s.resultTokens += approxTokens(toolResultText(b));
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

  // Settle the per-tool token split now that every record of every turn is in:
  // one turn's output_tokens divided across all of that turn's tool blocks.
  for (const t of turns.values()) {
    if (t.tools.length === 0) continue;
    const share = t.out / t.tools.length;
    for (const name of t.tools) getTool(name).approxOutputTokens += share;
  }

  const combined = input + output + cacheCreation + cacheRead;
  const byTool = [...toolMap.values()]
    .map(s => ({ ...s, approxOutputTokens: Math.round(s.approxOutputTokens), resultTokens: Math.round(s.resultTokens) }))
    // resultTokens leads: it is measured per call, and it is what grows the
    // context every later turn replays. approxOutputTokens is a split estimate.
    .sort((a, b) => b.resultTokens - a.resultTokens || b.approxOutputTokens - a.approxOutputTokens || b.count - a.count);

  const { agents, subagentTotals } = subagentSpend(filePath);

  const errorSignals: ErrorSignals = { toolErrors, retries, userCorrections };

  const notes: string[] = [
    'combined includes cache_read (replayed cached prompt, billed ~10%); lead with billableApprox for real cost.',
    'byTool.approxOutputTokens splits each turn\'s output tokens evenly across its tool calls — approximate; the transcript has no per-tool token field.',
    'byTool.resultTokens is what each tool injected into context: its tool_result text sized at chars ÷ 4, summed per call (not split), error text included, images not counted. The firmer per-tool figure and byTool\'s sort key — but it is context growth, not assistant output; cite both and never add them.',
    'errorSignals.userCorrections is a keyword heuristic — a noisy lower bound, not an accuracy score.'
  ];
  if (subagentTotals.count > 0) {
    notes.push('Subagent tokens are summed from each subagent\'s own transcript and are separate from main-agent totals; whole-session total = totals.combined + subagentTotals.tokens. subagentTotals.usage splits them by class — lead with its billableApprox for cost.');
  }
  if (subagentTotals.fallbackCount > 0) {
    notes.push(`${subagentTotals.fallbackCount} subagent(s) have no complete transcript and are counted at the harness figure (their final context size) — a lower bound.`);
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

/**
 * Pair each launch with its subagent transcript — by `agentId` (the filename), else by the
 * sidecar's `toolUseId` — and settle one figure per launch. A finished launch takes its
 * transcript sum unless that sums below the harness figure: a final context size larger than
 * every turn added together means the file is still being written, so the harness figure is
 * the better (lower-bound) answer. A running launch stays unknown, as does a finished one with
 * neither. A transcript no launch claims is not a subagent this session can account for, and
 * is left out rather than risk counting one twice.
 */
function subagentSpend(filePath: string): { agents: AgentJob[]; subagentTotals: SubagentTotals } {
  const files = readSubagentUsage(filePath);
  const byAgentId = new Map(files.map(f => [f.agentId, f]));
  const byToolUseId = new Map(files.filter(f => f.toolUseId).map(f => [f.toolUseId as string, f]));
  const usage = emptyTotals();
  let tokens = 0, fallbackCount = 0, unknownTokenCount = 0;
  const agents = (readAgents(filePath) || []).map(a => {
    const file = (a.agentId && byAgentId.get(a.agentId)) || byToolUseId.get(a.id);
    let figure: number | null = null;
    if (a.status === 'done') {
      if (file && file.usage.combined > 0 && file.usage.combined >= (a.tokens ?? 0)) {
        figure = file.usage.combined;
        addTotals(usage, file.usage);
      } else if (a.tokens != null) {
        figure = a.tokens;
        fallbackCount++;
      }
    }
    if (figure == null) unknownTokenCount++;
    else tokens += figure;
    return { ...a, tokens: figure };
  });
  return { agents, subagentTotals: { count: agents.length, tokens, usage, fallbackCount, unknownTokenCount } };
}
