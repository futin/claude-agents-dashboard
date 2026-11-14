#!/usr/bin/env node
/**
 * kaizen.mjs — self-contained whole-session token/tool post-mortem.
 *
 * Pure Node (zero deps, no tsx, no repo) so the global `/kaizen` skill works in
 * ANY project. Prints a SessionAnalysis JSON to stdout.
 *
 *   node kaizen.mjs <session-id>            resolve id under ~/.claude/projects
 *   node kaizen.mjs /abs/path/to/x.jsonl    analyze a transcript directly
 *   node kaizen.mjs --latest                newest transcript for the current cwd
 *   node kaizen.mjs --trend [/abs/log.md]   ctx trend over the analytics log (default ~/.claude/session-analytics-log.md)
 *   node kaizen.mjs --budget [<file>] [<heading>] [<bytes>]   section size vs budget (default ~/.claude/CLAUDE.md, ## Learnings, 4000)
 *   node kaizen.mjs --compare <project> <since YYYY-MM-DD> <field.path>
 *                                           one analysis field's median over the project's sessions before vs after a date
 *   node kaizen.mjs --skill <name> [N] [--outcome <regex>]
 *                                           the newest N (default 50) finished sessions whose first prompt ran the skill, per session and summed
 *
 * PROVENANCE: ported from claude-agents-dashboard server/lib/{analyze,agents,subagent-usage,scan}.ts.
 * That repo holds the unit-tested source of truth; keep this in sync if it changes.
 * Exception: `--trend` is kaizen-only, has no TS twin, and is tested by spawning this file (test/analytics/kaizen-trend.test.ts); so are `--compare`, tested in
 * test/compare.test.mjs, `--budget`, tested in test/budget.test.mjs, and `--skill`, tested in test/skill-review.test.mjs.
 * Counting compaction replays once (#174), skipping compact summaries and reading compact_boundary for neverCompacted are in that
 * source too (#226), pinned by its parity tests. Kaizen-only by decision: the `compactions` block — a lesson input with no dashboard
 * consumer — tested in test/compactions.test.mjs (`node --test test/*.test.mjs`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------ transcript enumeration */

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function listTranscripts(root) {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      out.push({ file: full, id: name.replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

function normCwd(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/* ------------------------------------------------ subagent parsing (agents.ts) */

function isAgentLaunch(b) {
  if (!b || b.type !== 'tool_use') return false;
  if (b.name === 'Task' || b.name === 'Agent') return true;
  return !!(b.input && typeof b.input.subagent_type === 'string');
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const b of content) {
    if (typeof b === 'string') s += b;
    else if (b && b.type === 'text' && typeof b.text === 'string') s += b.text;
    else if (b && b.type === 'tool_result') s += toolResultText(b);
  }
  return s;
}
function toolResultText(b) {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('');
  return '';
}
const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9]+)/;
const TASK_ID_RE = /<task-id>\s*([A-Za-z0-9]+)\s*<\/task-id>/;
const STATUS_RE = /<status>\s*([a-z_]+)\s*<\/status>/i;
const SUBAGENT_TOKENS_RE = /<subagent_tokens>\s*(\d+)\s*<\/subagent_tokens>/;
const TOOL_USES_RE = /<tool_uses>\s*(\d+)\s*<\/tool_uses>/;
const DURATION_MS_RE = /<duration_ms>\s*(\d+)\s*<\/duration_ms>/;

// Untyped records (fixtures, older transcripts) still count.
function isConversationRecord(rec) { return typeof rec.type !== 'string' || rec.type === 'user' || rec.type === 'assistant'; }
function finiteOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function intFromMatch(text, re) { const m = text.match(re); return m ? parseInt(m[1], 10) : null; }

// A notification landing mid-turn is absorbed into the running turn as message-less
// `queue-operation` (top-level `content`) / `attachment` (`attachment.prompt`) records (bug-11).
function notificationText(rec, content) {
  let out = contentText(content);
  if (typeof rec.content === 'string') out += '\n' + rec.content;
  const prompt = rec.attachment && rec.attachment.prompt;
  if (typeof prompt === 'string') out += '\n' + prompt;
  return out;
}

function parseRecordEvents(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const content = rec.message ? rec.message.content : undefined;
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const events = [];
  const flat = notificationText(rec, content);
  if (flat.includes('<task-notification>')) {
    const idM = flat.match(TASK_ID_RE), stM = flat.match(STATUS_RE);
    if (idM && stM) events.push({
      kind: 'notify', agentId: idM[1], completed: stM[1].toLowerCase() === 'completed', ts,
      tokens: intFromMatch(flat, SUBAGENT_TOKENS_RE), toolUses: intFromMatch(flat, TOOL_USES_RE),
      exactDurationMs: intFromMatch(flat, DURATION_MS_RE)
    });
  }
  if (!Array.isArray(content)) return events;
  let tur = rec.toolUseResult;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (isAgentLaunch(b) && typeof b.id === 'string') {
      const input = b.input || {};
      events.push({
        kind: 'launch', id: b.id,
        type: typeof input.subagent_type === 'string' ? input.subagent_type : '',
        description: typeof input.description === 'string' ? input.description : '', ts
      });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const text = toolResultText(b);
      const t = tur && typeof tur === 'object' ? tur : null;
      tur = undefined;
      const isAsyncAck = (t && (t.isAsync === true || t.status === 'async_launched')) || /Async agent launched/i.test(text);
      let agentId = t && typeof t.agentId === 'string' ? t.agentId : null;
      if (isAsyncAck && !agentId) { const m = text.match(AGENT_ID_RE); agentId = m ? m[1] : null; }
      events.push({
        kind: 'result', toolUseId: b.tool_use_id, ts, isAsyncAck: !!isAsyncAck, agentId,
        tokens: isAsyncAck ? null : finiteOrNull(t && t.totalTokens),
        toolUses: isAsyncAck ? null : finiteOrNull(t && t.totalToolUseCount),
        exactDurationMs: isAsyncAck ? null : finiteOrNull(t && t.totalDurationMs)
      });
    }
  }
  return events;
}

function readAgents(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const launches = [], byToolUseId = new Map(), byAgentId = new Map();
  // Both indexes are emptied as they are consumed, so only this set recognizes a launch replayed after a compaction (#174).
  const seenLaunch = new Set();
  const apply = (ev) => {
    if (ev.kind === 'launch') {
      if (seenLaunch.has(ev.id)) return;
      seenLaunch.add(ev.id);
      const l = { id: ev.id, type: ev.type, description: ev.description, startedAt: ev.ts, endedAt: null, exactDurationMs: null, tokens: null, toolUses: null, agentId: null };
      launches.push(l);
      if (!byToolUseId.has(ev.id)) byToolUseId.set(ev.id, l);
      return;
    }
    if (ev.kind === 'result') {
      const l = byToolUseId.get(ev.toolUseId);
      if (!l) return;
      byToolUseId.delete(ev.toolUseId);
      l.agentId = ev.agentId;
      if (ev.isAsyncAck) { if (ev.agentId && !byAgentId.has(ev.agentId)) byAgentId.set(ev.agentId, l); }
      else { l.endedAt = ev.ts; l.tokens = ev.tokens; l.toolUses = ev.toolUses; l.exactDurationMs = ev.exactDurationMs; }
      return;
    }
    if (!ev.completed || !ev.ts) return;
    const l = byAgentId.get(ev.agentId);
    if (!l) return;
    byAgentId.delete(ev.agentId);
    l.endedAt = ev.ts; l.tokens = ev.tokens; l.toolUses = ev.toolUses; l.exactDurationMs = ev.exactDurationMs;
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    for (const ev of parseRecordEvents(rec)) apply(ev);
  }
  const agents = launches.map(l => {
    const startMs = l.startedAt ? Date.parse(l.startedAt) : NaN;
    const endMs = l.endedAt ? Date.parse(l.endedAt) : NaN;
    const diff = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null;
    return {
      id: l.id, type: l.type, description: l.description, status: l.endedAt ? 'done' : 'running',
      startedAt: l.startedAt, endedAt: l.endedAt, durationMs: l.exactDurationMs ?? diff, tokens: l.tokens, toolUses: l.toolUses, agentId: l.agentId
    };
  });
  agents.reverse();
  return agents;
}

/* ------------------------------------------------ subagent spend (subagent-usage.ts) */

// The harness figure (totalTokens / <subagent_tokens>) is a subagent's FINAL context size,
// not its spend; the spend is in its own transcript, summed once per message.id (bug-27).
function emptyTotals() { return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, combined: 0, billableApprox: 0 }; }
function addTotals(a, b) {
  a.input += b.input; a.output += b.output; a.cacheCreation += b.cacheCreation; a.cacheRead += b.cacheRead;
  a.combined += b.combined; a.billableApprox += b.billableApprox;
}
function sumSubagentTranscript(text) {
  const t = emptyTotals();
  const seen = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    const msg = rec && rec.message;
    if (!msg || msg.role !== 'assistant' || !msg.usage || typeof msg.usage !== 'object') continue;
    if (typeof msg.id === 'string' && msg.id) { if (seen.has(msg.id)) continue; seen.add(msg.id); }
    const u = msg.usage;
    t.input += num(u.input_tokens); t.output += num(u.output_tokens);
    t.cacheCreation += num(u.cache_creation_input_tokens); t.cacheRead += num(u.cache_read_input_tokens);
  }
  t.combined = t.input + t.output + t.cacheCreation + t.cacheRead;
  t.billableApprox = t.input + t.output + t.cacheCreation;
  return t;
}
function readSubagentUsage(mainPath) {
  const dir = path.join(mainPath.replace(/\.jsonl$/, ''), 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    let toolUseId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${m[1]}.meta.json`), 'utf8'));
      if (meta && typeof meta.toolUseId === 'string') toolUseId = meta.toolUseId;
    } catch { /* no sidecar */ }
    out.push({ agentId: m[1], toolUseId, usage: sumSubagentTranscript(text) });
  }
  return out;
}
// A finished launch takes its transcript sum unless that sums below the harness figure (file
// still being written) — then the harness figure, as a lower bound. Unclaimed files are left out.
function subagentSpend(filePath) {
  const files = readSubagentUsage(filePath);
  const byAgentId = new Map(files.map(f => [f.agentId, f]));
  const byToolUseId = new Map(files.filter(f => f.toolUseId).map(f => [f.toolUseId, f]));
  const usage = emptyTotals();
  let tokens = 0, fallbackCount = 0, unknownTokenCount = 0;
  const added = new Set();
  const agents = (readAgents(filePath) || []).map(a => {
    const file = (a.agentId && byAgentId.get(a.agentId)) || byToolUseId.get(a.id);
    let figure = null;
    if (a.status === 'done') {
      if (file && file.usage.combined > 0 && file.usage.combined >= (a.tokens ?? 0)) { figure = file.usage.combined; if (!added.has(file)) { added.add(file); addTotals(usage, file.usage); } }
      else if (a.tokens != null) { figure = a.tokens; fallbackCount++; }
    }
    if (figure == null) unknownTokenCount++; else tokens += figure;
    return { ...a, tokens: figure };
  });
  return { agents, subagentTotals: { count: agents.length, tokens, usage, fallbackCount, unknownTokenCount } };
}

/* ------------------------------------------------ analysis (analyze.ts) */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
// chars ÷ 4 — rough token size of a tool_result's text. Unrounded; sum first, round once.
function approxTokens(text) { return text.length / 4; }
function isErrorResult(b) { return b.is_error === true || /<tool_use_error>/i.test(toolResultText(b)); }
function userText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}
const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not (?:what|right|correct)|actually|instead|revert|undo|don'?t|that'?s not)\b/i;

// Peak context that proves auto-compaction never fired: a 200k window compacts near 160k, so only a larger one (1M puts compaction out of reach)
// gets a turn past 250k — and every turn replays the whole context, so total input grows with the square of it. Inferred: the transcript records
// no window. Compaction itself is read from main-chain compact_boundary records (the COMPACTIONS block below); for transcripts that predate the
// marker, a turn below half the running peak counts as one — context only grows between them.
const NEVER_COMPACTED_PEAK = 250_000;
const COMPACTION_DROP_RATIO = 0.5;

export function analyzeSession(filePath, id) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  const models = new Set();
  const toolMap = new Map();
  const pendingTool = new Map();
  // pendingTool forgets a call once its result lands, so these two catch the copies a compaction replays (#174).
  const seenToolUse = new Set(), seenToolResult = new Set();
  const errorOutstanding = new Set();
  let serverWebSearch = 0, serverWebFetch = 0;
  let toolErrors = 0, retries = 0, userCorrections = 0;
  let turnCount = 0, sumCombined = 0, maxCombined = 0, maxTurnIndex = -1;
  let compacted = false;
  let cwd = null, minTs = null, maxTs = null;

  const getTool = (name) => {
    let s = toolMap.get(name);
    if (!s) { s = { tool: name, count: 0, durationMs: 0, errors: 0, approxOutputTokens: 0, resultTokens: 0 }; toolMap.set(name, s); }
    return s;
  };

  // ONE TURN IS NOT ONE RECORD. Claude Code writes one record per content block
  // and every one carries a full copy of the turn's usage under the same
  // message.id, so usage is summed once per message.id (1.5-2.3x inflation
  // otherwise) and a turn's output_tokens is split across ALL of its tool
  // blocks — buffered here, settled after the walk. No message.id (old or
  // malformed transcript) → each record is its own turn.
  const turns = new Map();
  const getTurn = (key) => {
    let t = turns.get(key);
    if (!t) { t = { out: 0, tools: [] }; turns.set(key, t); }
    return t;
  };
  const countedTurns = new Set();
  let anonTurnSeq = 0;

  // COMPACTIONS. Each main-chain compact_boundary is one row: the context of
  // the last turn before it and the first turn after it. A resumed session can
  // replay an old boundary (same timestamp, same summary) — counted once.
  const boundaries = [];
  const boundaryKeys = new Set();
  let duplicatesSkipped = 0, awaitingPost = null, skipSummary = false, lastCtx = null;
  const turnCtx = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts) { if (!minTs || ts < minTs) minTs = ts; if (!maxTs || ts > maxTs) maxTs = ts; }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (rec.isSidechain === true) continue;

    if (rec.compactMetadata && typeof rec.compactMetadata === 'object') {
      const key = ts ?? `#b${boundaries.length + duplicatesSkipped}`;
      if (boundaryKeys.has(key)) { duplicatesSkipped++; skipSummary = true; continue; }
      boundaryKeys.add(key); skipSummary = false;
      const m = rec.compactMetadata;
      const b = {
        at: ts, trigger: typeof m.trigger === 'string' ? m.trigger : 'unknown', preTokens: finiteOrNull(m.preTokens), durationMs: finiteOrNull(m.durationMs),
        turnIndex: turnCount, preCtx: lastCtx, postCtx: null, postCacheCreation: null, dropped: null, turnsAfter: 0, summaryChars: null
      };
      boundaries.push(b); awaitingPost = b;
      continue;
    }
    // The summary quotes the user's earlier messages, so it must not reach the
    // correction heuristic below.
    if (rec.isCompactSummary === true) {
      const last = boundaries[boundaries.length - 1];
      if (!skipSummary && last && last.summaryChars == null) last.summaryChars = contentText(rec.message?.content).length;
      skipSummary = false;
      continue;
    }

    // Claude Code 2.1.302 replays each API request's turns as `type: "api-request-blob"` records with the same role and content. Mirrors
    // server/lib/transcript.ts `isConversationRecord`; it sits below the boundary handling because a boundary is a `type: "system"` record.
    if (!isConversationRecord(rec)) continue;
    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;

    if (msg.role === 'assistant') {
      // No message.id → fail open: this record is its own turn. `#` cannot
      // collide with a real id (they are all `msg_…`).
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
          const ctx = inp + cc + cr;
          turnCtx.push(ctx); lastCtx = ctx;
          if (awaitingPost) { awaitingPost.postCtx = ctx; awaitingPost.postCacheCreation = cc; awaitingPost = null; }
          sumCombined += combined;
          if (combined < maxCombined * COMPACTION_DROP_RATIO) compacted = true;
          if (combined > maxCombined) { maxCombined = combined; maxTurnIndex = idx; }
        }
        const stu = u.server_tool_use;
        if (stu && typeof stu === 'object' && firstOfTurn) { serverWebSearch += num(stu.web_search_requests); serverWebFetch += num(stu.web_fetch_requests); }
      }
      if (Array.isArray(content)) {
        const toolBlocks = content.filter(b => b && b.type === 'tool_use' && typeof b.name === 'string');
        for (const b of toolBlocks) {
          if (typeof b.id === 'string') { if (seenToolUse.has(b.id)) continue; seenToolUse.add(b.id); }
          const s = getTool(b.name);
          // count/duration/retries are per tool CALL — parallel calls really do
          // land in separate records. Only the token split is per turn.
          s.count++;
          turn.tools.push(b.name);
          if (errorOutstanding.has(b.name)) { retries++; errorOutstanding.delete(b.name); }
          if (typeof b.id === 'string') pendingTool.set(b.id, { name: b.name, ts });
        }
      }
    } else if (msg.role === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          if (seenToolResult.has(b.tool_use_id)) continue;
          seenToolResult.add(b.tool_use_id);
          const p = pendingTool.get(b.tool_use_id);
          const err = isErrorResult(b);
          if (p) {
            pendingTool.delete(b.tool_use_id);
            const s = getTool(p.name);
            // Per call, error text included — independent of the errors count.
            s.resultTokens += approxTokens(toolResultText(b));
            if (p.ts && ts) { const d = Date.parse(ts) - Date.parse(p.ts); if (Number.isFinite(d) && d >= 0) s.durationMs += d; }
            if (err) { s.errors++; toolErrors++; errorOutstanding.add(p.name); } else errorOutstanding.delete(p.name);
          } else if (err) { toolErrors++; }
        }
      }
      const t = userText(msg);
      // <agent-message> is a subagent's hand-back delivered as a user turn — its prose is not the user correcting anything.
      if (t && !t.includes('<task-notification>') && !t.includes('<agent-message') && CORRECTION_RE.test(t)) userCorrections++;
    }
  }

  // Settle the per-tool split: one turn's output_tokens across all its tools.
  for (const t of turns.values()) {
    if (t.tools.length === 0) continue;
    const share = t.out / t.tools.length;
    for (const name of t.tools) getTool(name).approxOutputTokens += share;
  }

  const combined = input + output + cacheCreation + cacheRead;
  const byTool = [...toolMap.values()]
    .map(s => ({ ...s, approxOutputTokens: Math.round(s.approxOutputTokens), resultTokens: Math.round(s.resultTokens) }))
    // resultTokens leads: measured per call, and it is what every later turn replays.
    .sort((a, b) => b.resultTokens - a.resultTokens || b.approxOutputTokens - a.approxOutputTokens || b.count - a.count);

  const { agents, subagentTotals } = subagentSpend(filePath);

  let cum = 0, bi = 0, hypotheticalPeakCtx = turnCtx.length ? 0 : null;
  for (const b of boundaries) {
    b.turnsAfter = turnCount - b.turnIndex;
    b.dropped = b.preCtx != null && b.postCtx != null ? b.preCtx - b.postCtx : null;
  }
  for (let j = 0; j < turnCtx.length; j++) {
    while (bi < boundaries.length && boundaries[bi].turnIndex <= j) cum += boundaries[bi++].dropped ?? 0;
    hypotheticalPeakCtx = Math.max(hypotheticalPeakCtx, turnCtx[j] + cum);
  }
  const compactions = {
    count: boundaries.length,
    auto: boundaries.filter(b => b.trigger === 'auto').length,
    manual: boundaries.filter(b => b.trigger === 'manual').length,
    duplicatesSkipped,
    turnsAfterFirst: boundaries.length ? boundaries[0].turnsAfter : 0,
    counterfactualExtraCacheRead: boundaries.reduce((sum, b) => sum + (b.dropped ?? 0) * b.turnsAfter, 0),
    postCompactCacheCreation: boundaries.reduce((sum, b) => sum + (b.postCacheCreation ?? 0), 0),
    durationMs: boundaries.reduce((sum, b) => sum + (b.durationMs ?? 0), 0),
    hypotheticalPeakCtx,
    boundaries
  };

  const notes = [
    'combined includes cache_read (replayed cached prompt, billed ~10%); lead with billableApprox for real cost.',
    "byTool.approxOutputTokens splits each turn's output tokens evenly across its tool calls — approximate; the transcript has no per-tool token field.",
    "byTool.resultTokens is what each tool injected into context: its tool_result text sized at chars ÷ 4, summed per call (not split), error text included, images not counted. The firmer per-tool figure and byTool's sort key — but it is context growth, not assistant output; cite both and never add them.",
    'errorSignals.userCorrections is a keyword heuristic — a noisy lower bound, not an accuracy score.',
    'perTurn.neverCompacted: true when the peak turn tops 250k combined (a 200k window compacts near 160k — the transcript records no window, so that part is inferred) and the session never compacted. Compaction is read from main-chain compact_boundary records; for transcripts without them, a turn below half the running peak counts as one.'
  ];
  if (subagentTotals.count > 0) notes.push("Subagent tokens are summed from each subagent's own transcript and are separate from main-agent totals; whole-session total = totals.combined + subagentTotals.tokens. subagentTotals.usage splits them by class — lead with its billableApprox for cost.");
  if (subagentTotals.fallbackCount > 0) notes.push(`${subagentTotals.fallbackCount} subagent(s) have no complete transcript and are counted at the harness figure (their final context size) — a lower bound.`);
  if (subagentTotals.unknownTokenCount > 0) notes.push(`${subagentTotals.unknownTokenCount} subagent(s) have unknown token totals (still running or old transcript).`);
  if (compactions.count > 0) notes.push('compactions.counterfactualExtraCacheRead assumes an unbounded window (dropped context × turns after each boundary); a real window would have stopped the session at the first boundary. postCompactCacheCreation is billable and already inside totals.cacheCreation.');

  const durationMs = minTs && maxTs ? Date.parse(maxTs) - Date.parse(minTs) : null;

  return {
    id: id || filePath.replace(/^.*\//, '').replace(/\.jsonl$/, ''),
    file: filePath, cwd, models: [...models],
    startedAt: minTs, endedAt: maxTs, durationMs: Number.isFinite(durationMs) ? durationMs : null,
    totals: { input, output, cacheCreation, cacheRead, combined, billableApprox: input + output + cacheCreation },
    perTurn: { count: turnCount, avgCombined: turnCount > 0 ? Math.round(sumCombined / turnCount) : 0, maxCombined, maxTurnIndex, neverCompacted: maxCombined > NEVER_COMPACTED_PEAK && !compacted && boundaries.length === 0 },
    byTool, bySubagent: agents, subagentTotals,
    serverTools: { webSearch: serverWebSearch, webFetch: serverWebFetch },
    errorSignals: { toolErrors, retries, userCorrections },
    compactions,
    notes
  };
}

/* ------------------------------------------------ context trend over the analytics log (`--trend`) */

// Reads the `N billable (M ctx)` figures back out of lesson lines already in ~/.claude/session-analytics-log.md and compares them as a series, so
// `/kaizen review` can see a cost drift no single post-mortem can: one run sees one big session, never the cohort it is an outlier against.
// Kaizen-only — the dashboard does not consume it, so there is no TS source of truth to keep in sync with (unlike everything above).

// - <date> [<project>] <id>: <billable> billable (<ctx> ctx…  — the lesson shape of the log grammar; status/review lines and prose never match it.
const TREND_LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(\S+?):\s+~?([\d.,]+)\s*([kMB]?)\s+billable\b(.*)$/;
const TREND_CTX_RE = /^[^(]*\(\s*~?([\d.,]+)\s*([kMB]?)\s+ctx\b/;
const SUFFIX = { '': 1, k: 1e3, M: 1e6, B: 1e9 };

// Drift = the median of the newest TREND_WINDOW sessions is ≥ TREND_RATIO × the median of every session before them, in the same group.
// Medians on both sides are the point: a single spike cannot move a 3-session median, so one big session is never a trend — it takes at least two of
// the newest three. The baseline is the group's own history, so a project that always runs large is not flagged for being large.
const TREND_WINDOW = 3;
const TREND_MIN_BASELINE = 3;
const TREND_RATIO = 1.5;

function parseFigure(digits, suffix) {
  const n = parseFloat(digits.replace(/,/g, ''));
  return Number.isFinite(n) ? n * SUFFIX[suffix] : null;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Lesson lines carrying both figures, file order. A later line for the same `[project] id` replaces the earlier one (newest-wins, as every log
 *  consumer reads it) — in memory only; the file is never touched. `withoutCtx` counts lesson lines with a billable figure but no `(N ctx)`. */
function parseTrendLines(text) {
  const bySession = new Map();
  let withoutCtx = 0;
  for (const raw of String(text).split('\n')) {
    const m = TREND_LINE_RE.exec(raw.trim());
    if (!m) continue;
    const billable = parseFigure(m[4], m[5]);
    const c = TREND_CTX_RE.exec(m[6]);
    const ctx = c ? parseFigure(c[1], c[2]) : null;
    if (billable == null || ctx == null) { withoutCtx++; continue; }
    const key = `${m[2]}\u0000${m[3]}`;
    bySession.delete(key);
    bySession.set(key, { date: m[1], project: m[2], id: m[3], billable, ctx });
  }
  return { points: [...bySession.values()], withoutCtx };
}

function trendGroup(name, points) {
  const series = points.map(p => p.ctx);
  const g = { name, sessions: points.length, firstDate: points[0]?.date ?? null, lastDate: points.at(-1)?.date ?? null, series,
    baselineMedian: null, recentMedian: null, ratio: null, drift: false };
  if (points.length < TREND_WINDOW + TREND_MIN_BASELINE) return g;
  g.baselineMedian = median(series.slice(0, -TREND_WINDOW));
  g.recentMedian = median(series.slice(-TREND_WINDOW));
  g.ratio = g.baselineMedian > 0 ? Math.round((g.recentMedian / g.baselineMedian) * 100) / 100 : null;
  g.drift = g.ratio != null && g.ratio >= TREND_RATIO;
  return g;
}

/** Per-project series plus an overall one, each with its drift verdict. Groups too short to judge carry null medians and `drift: false`. */
function contextTrend(text) {
  const { points, withoutCtx } = parseTrendLines(text);
  const byProject = new Map();
  for (const p of points) {
    if (!byProject.has(p.project)) byProject.set(p.project, []);
    byProject.get(p.project).push(p);
  }
  const projects = [...byProject].map(([name, ps]) => trendGroup(name, ps)).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  return {
    rule: `drift = median ctx of the newest ${TREND_WINDOW} sessions >= ${TREND_RATIO}x the median of the earlier ones, same group; needs ${TREND_WINDOW + TREND_MIN_BASELINE}+ sessions`,
    sessions: points.length,
    withoutCtx,
    overall: trendGroup('overall', points),
    projects,
    drifting: projects.filter(g => g.drift).map(g => g.name)
  };
}

/* ------------------------------------------------ before/after comparison for one project (`--compare`) */

// `/kaizen review` judges an actioned/promoted lesson by re-running analyzeSession over the project's sessions on each side of the status date and
// comparing one field's median. Kaizen-only, like `--trend`: the dashboard reads the verdict line review writes, never this output.

const COMPARE_CAP = 10;
const COMPARE_MIN_BEFORE = 3;
const DAY_MS = 86400000;
const HEAD_BYTES = 64 * 1024;

// Claude Code names a project dir after the cwd with every non-alphanumeric character turned into `-`; normalising both sides the same way keeps
// the prefilter from depending on exactly which characters it replaces. It only narrows the candidates — the cwd basename still decides.
const dirKey = (s) => s.replace(/[^A-Za-z0-9]/g, '-');

/** First timestamp and first cwd from the head of a transcript, without reading the rest; null when the head has neither. */
function sessionHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
    let ts = null, cwd = null;
    for (const line of text.split('\n')) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!ts && typeof rec.timestamp === 'string') ts = rec.timestamp;
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (ts && cwd) break;
    }
    return ts && cwd ? { ts, cwd } : null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * A dotted path into a SessionAnalysis. An array segment is a numeric index or, for the keyed lists, the element whose `tool` (byTool) or `type`
 * (bySubagent) equals it — `byTool.Bash.count`. Null unless it lands on a finite number, so a tool the session never called is missing, never 0.
 */
export function resolveField(obj, fieldPath) {
  let cur = obj;
  for (const seg of fieldPath.split('.')) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : cur.find(e => e && (e.tool === seg || e.type === seg));
    else cur = cur && typeof cur === 'object' ? cur[seg] : undefined;
    if (cur === undefined || cur === null) return null;
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

/**
 * The project's main-session transcripts on each side of `since` (YYYY-MM-DD, UTC), with `fieldPath` read from each. After = sessions starting
 * after the end of that day, oldest first, capped at COMPARE_CAP; before = as many sessions as after has (at least COMPARE_MIN_BEFORE, same cap)
 * immediately preceding it — a session starting on `since` itself is before. Throws when no session yields a number for the path.
 *
 * Only `<root>/<dir>/*.jsonl` is listed, so subagent transcripts (under `<dir>/<session>/subagents/`) never count. The dir-name prefilter and
 * the head read keep it to one full analysis per selected session: for claude-agents-dashboard (353 of 2,291 transcripts on this machine) 0.7–2.5 s warm,
 * 12 s on a cold disk cache, measured 2026-10-28.
 */
export function compareSessions({ root, project, since, fieldPath }) {
  const sinceEnd = Date.parse(`${since}T00:00:00Z`) + DAY_MS;
  const key = '-' + dirKey(project);
  const sessions = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { dirs = []; }
  for (const d of dirs) {
    if (!d.isDirectory() || !dirKey(d.name).endsWith(key)) continue;
    const dir = path.join(root, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const head = sessionHead(file);
      const start = head ? Date.parse(head.ts) : NaN;
      if (!head || !Number.isFinite(start) || path.basename(normCwd(head.cwd)) !== project) continue;
      sessions.push({ file, id: name.replace(/\.jsonl$/, ''), start, startedAt: head.ts });
    }
  }
  sessions.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const afterAll = sessions.filter(s => s.start >= sinceEnd);
  const beforeAll = sessions.filter(s => s.start < sinceEnd);
  const after = afterAll.slice(0, COMPARE_CAP);
  const before = beforeAll.slice(-Math.min(COMPARE_CAP, Math.max(after.length, COMPARE_MIN_BEFORE)));

  const side = (picked) => {
    const values = [], missing = [];
    for (const s of picked) {
      const a = analyzeSession(s.file, s.id);
      const v = a ? resolveField(a, fieldPath) : null;
      if (v == null) missing.push({ session: s.id, date: s.startedAt.slice(0, 10) });
      else values.push({ session: s.id, date: s.startedAt.slice(0, 10), value: v });
    }
    return { n: values.length, median: values.length ? median(values.map(v => v.value)) : null, values, missing };
  };
  const result = { project, since, field: fieldPath, cap: COMPARE_CAP, before: side(before), after: side(after) };
  if (!result.before.n && !result.after.n) {
    throw new Error(sessions.length
      ? `field path ${fieldPath} resolved to a number in none of the ${before.length + after.length} sessions compared`
      : `no main-session transcripts found for project ${project}`);
  }
  return result;
}

/* ------------------------------------------------ section size against a byte budget (`--budget`) */

// Measures one section of a CLAUDE.md — by default the global §Learnings, the surface every session of every project pays for — so a promotion can see
// whether it fits before it lands, and name what to merge or displace when it does not. Kaizen-only and read-only, like `--trend`.

const BUDGET_DEFAULTS = { heading: '## Learnings', bytes: 4000 };
const HEADING_RE = /^(#{1,6})\s/;
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

/** The section is the heading line through the line before the next heading of the same or higher level (fewer or equal `#`), or EOF; a heading inside
 *  a fenced code block is not a heading. `rules` are its top-level bullets, each running to the next top-level bullet, heading or section end with
 *  trailing blank lines dropped, largest first — so a displacement candidate can be named without re-reading the file. */
function measureSection(text, heading, budget) {
  const lines = String(text).split(/(?<=\n)/);
  const want = heading.trim();
  const level = HEADING_RE.exec(want)[1].length;
  const start = lines.findIndex(l => l.trimEnd() === want);
  if (start < 0) return { section: false, bytes: 0, budget, remaining: budget, over: false, rules: [] };
  let end = lines.length, fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    const h = !fenced && HEADING_RE.exec(lines[i]);
    if (h && h[1].length <= level) { end = i; break; }
  }
  const body = lines.slice(start, end);
  const rules = [];
  let cur = null;
  for (const l of body.slice(1)) {
    if (/^[-*+]\s/.test(l)) { cur = [l]; rules.push(cur); }
    else if (HEADING_RE.test(l)) cur = null;
    else if (cur) cur.push(l);
  }
  const sized = rules.map(r => {
    while (r.length > 1 && !r.at(-1).trim()) r.pop();
    return { first: r[0].replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 60), bytes: bytesOf(r.join('')) };
  }).sort((a, b) => b.bytes - a.bytes);
  const bytes = bytesOf(body.join(''));
  return { section: true, bytes, budget, remaining: budget - bytes, over: bytes > budget, rules: sized };
}

/* ------------------------------------------------ the last N runs of one skill (`--skill`) */

// `/kaizen skill <name>` improves a skill from evidence: the newest finished sessions that ran it, each read with analyzeSession plus one more walk
// for what a single post-mortem does not need — what loaded before the first turn, which errors repeat, which tool output fed the context, and an
// optional outcome the skill's own contract prints. Kaizen-only, like `--trend`. The judgement (classifying outcomes, ranking fixes) stays in SKILL.md.

const SKILL_DEFAULT_LIMIT = 50;
// A transcript written this recently may be a session still running — possibly the one asking — so it is not a finished run yet.
const SKILL_ACTIVE_MS = 5 * 60_000;
// The first prompt sits a few records in, but a hook's output or an older transcript's preload can come first; past 1 MiB it is not a skill run.
const SKILL_HEAD_CAP = 1024 * 1024;
const SKILL_HEAD_CHUNK = 64 * 1024;
const SKILL_TOP = 20;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const SLASH_RE = /^\s*\/([A-Za-z0-9_.:-]+)(?:\s+([\s\S]*))?$/;
// Harness-written user turns that no person typed.
const NOT_TYPED_RE = /^\s*(?:<task-notification>|<agent-message|<local-command-|<bash-stdout>|<bash-stderr>|\[Request interrupted)/;
// Attachment fields that carry the text the model sees; the rest (names, digests, hook commands, stdout already folded into `content`) is bookkeeping.
const PRELOAD_TEXT_KEYS = new Set(['content', 'addedLines', 'systemPrompt', 'context', 'snapshot', 'text', 'date', 'prompt']);

/** The text a person typed, or null for anything else: a meta record, a tool result, a compaction summary, a subagent's turn, a harness notice. */
function typedPrompt(rec) {
  if (!rec || rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true || !isConversationRecord(rec)) return null;
  const msg = rec.message;
  if (!msg || msg.role !== 'user') return null;
  if (Array.isArray(msg.content) && msg.content.some(b => b && b.type === 'tool_result')) return null;
  const t = userText(msg);
  return t.trim() && !NOT_TYPED_RE.test(t) ? t : null;
}

/** The first typed prompt, read in chunks from the head; null when an assistant turn or the cap comes first. */
function firstPrompt(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(SKILL_HEAD_CHUNK);
    let pos = 0, carry = '';
    for (;;) {
      const n = pos < SKILL_HEAD_CAP ? fs.readSync(fd, buf, 0, buf.length, pos) : 0;
      pos += n;
      const lines = (carry + (n > 0 ? decoder.write(buf.subarray(0, n)) : decoder.end())).split('\n');
      carry = n > 0 ? lines.pop() : '';
      for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec && rec.message && rec.message.role === 'assistant' && rec.isSidechain !== true && isConversationRecord(rec)) return null;
        const t = typedPrompt(rec);
        if (t != null) return t;
      }
      if (n <= 0) return null;
    }
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** `<command-name>/x</command-name>` (a slash command the harness expanded) or plain `/x args` text. */
function parseInvocation(text) {
  const m = COMMAND_NAME_RE.exec(text);
  if (m) { const a = COMMAND_ARGS_RE.exec(text); return { command: m[1], args: a ? a[1].trim() : '' }; }
  const s = SLASH_RE.exec(text);
  return s ? { command: s[1], args: (s[2] ?? '').trim() } : null;
}

const bareName = (s) => s.slice(s.lastIndexOf(':') + 1);
/** `plugin:skill` matches itself and the bare `/skill`; a bare name matches it under any plugin. */
function invokesSkill(command, skill) {
  return skill.includes(':') ? command === skill || command === bareName(skill) : bareName(command) === skill;
}

function leafChars(v) {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((s, x) => s + leafChars(x), 0);
  return v && typeof v === 'object' ? Object.values(v).reduce((s, x) => s + leafChars(x), 0) : 0;
}
function attachmentChars(a) {
  if (Array.isArray(a)) return a.reduce((s, x) => s + attachmentChars(x), 0);
  if (!a || typeof a !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(a)) n += PRELOAD_TEXT_KEYS.has(k) ? leafChars(v) : typeof v === 'object' ? attachmentChars(v) : 0;
  return n;
}

/** Digits and digit-bearing hex runs fold to N so `Exit code 1` and `Exit code 2` are one error; the first 100 characters are the group key. */
function normalizeError(text) {
  return text.replace(/<\/?tool_use_error>/g, '').replace(/\s+/g, ' ').trim()
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{4,}\b/gi, 'N').replace(/\d+/g, 'N').slice(0, 100);
}

function sinkKey(call) {
  if (!call) return 'unknown';
  const input = call.input || {};
  if (call.name === 'Read' && typeof input.file_path === 'string') return `Read:${path.basename(input.file_path)}`;
  if (call.name === 'Skill' && typeof input.skill === 'string') return `Skill:${input.skill}`;
  return call.name;
}

/** The walk analyzeSession does not do: preload before the first turn, typed prompts, error messages, output per sink, and the outcome capture. */
function skillSessionFacts(text, outcomeRe) {
  const preload = new Map();
  const addPreload = (kind, chars) => {
    const p = preload.get(kind) ?? { kind, count: 0, chars: 0 };
    p.count++; p.chars += chars; preload.set(kind, p);
  };
  const pending = new Map(), seenUse = new Set(), seenResult = new Set(), sinks = new Map(), errors = [];
  let firstTurnCtx = null, userPrompts = 0, outcome = null;
  const capture = (t) => {
    if (!outcomeRe || outcome !== null) return;
    const m = outcomeRe.exec(t);
    if (m) outcome = m[1] ?? m[0];
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || typeof rec !== 'object' || rec.isSidechain === true || rec.compactMetadata || rec.isCompactSummary === true) continue;
    const before = firstTurnCtx === null;
    if (rec.type === 'attachment' && rec.attachment && typeof rec.attachment === 'object') {
      if (!before) continue;
      const a = rec.attachment;
      const kind = typeof a.type === 'string' ? a.type : 'unknown';
      addPreload(kind.startsWith('hook_') && typeof a.hookName === 'string' ? `${kind}:${a.hookName}` : kind, attachmentChars(a));
      continue;
    }
    // Claude Code 2.1.302+ writes each request's system prompt as a blob; only the first request's counts as preload.
    if (rec.type === 'api-request-blob' && rec.message && rec.message.role === 'system') {
      if (before && !preload.has('system_prompt')) addPreload('system_prompt', contentText(rec.message.content).length);
      continue;
    }
    if (!isConversationRecord(rec) || !rec.message) continue;
    const msg = rec.message;
    if (msg.role === 'assistant') {
      const u = msg.usage;
      if (before && u && typeof u === 'object') {
        const ctx = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
        if (ctx > 0) firstTurnCtx = ctx;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b && b.type === 'tool_use' && typeof b.id === 'string' && !seenUse.has(b.id)) { seenUse.add(b.id); pending.set(b.id, { name: b.name, input: b.input }); }
        else if (b && b.type === 'text' && typeof b.text === 'string') capture(b.text);
      }
    } else if (msg.role === 'user') {
      if (rec.isMeta === true) {
        if (before) { const t = contentText(msg.content); addPreload(t.startsWith('Base directory for this skill') ? 'skill_body' : 'meta', t.length); }
        continue;
      }
      if (typedPrompt(rec) != null) { userPrompts++; continue; }
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string' || seenResult.has(b.tool_use_id)) continue;
        seenResult.add(b.tool_use_id);
        const call = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        const out = toolResultText(b);
        const key = sinkKey(call);
        const s = sinks.get(key) ?? { key, tool: call ? call.name : 'unknown', calls: 0, chars: 0 };
        s.calls++; s.chars += out.length; sinks.set(key, s);
        if (isErrorResult(b)) errors.push({ tool: call ? call.name : 'unknown', message: normalizeError(out) });
        capture(out);
      }
    }
  }
  return { preload: [...preload.values()], firstTurnCtx, userPrompts, errors, sinks: [...sinks.values()], outcome };
}

function skillRun(t, outcomeRe) {
  const a = analyzeSession(t.file, t.id);
  let text;
  try { text = fs.readFileSync(t.file, 'utf8'); } catch { return null; }
  if (!a) return null;
  const f = skillSessionFacts(text, outcomeRe);
  const subs = readSubagentUsage(t.file);
  const sub = emptyTotals();
  for (const s of subs) addTotals(sub, s.usage);
  const main = { input: a.totals.input, cacheCreation: a.totals.cacheCreation, cacheRead: a.totals.cacheRead, output: a.totals.output, billableApprox: a.totals.billableApprox, combined: a.totals.combined };
  const preload = f.preload.map(p => ({ kind: p.kind, count: p.count, approxTokens: Math.round(p.chars / 4) })).sort((x, y) => y.approxTokens - x.approxTokens || x.kind.localeCompare(y.kind));
  const sinks = f.sinks.map(s => ({ key: s.key, tool: s.tool, calls: s.calls, approxTokens: Math.round(s.chars / 4) })).sort((x, y) => y.approxTokens - x.approxTokens || x.key.localeCompare(y.key));
  const row = {
    id: t.id, project: a.cwd ? path.basename(normCwd(a.cwd)) : null, startedAt: a.startedAt, durationMs: a.durationMs, args: t.args,
    userPrompts: f.userPrompts, humanContinued: f.userPrompts > 1, models: a.models, turns: a.perTurn.count,
    tokens: {
      main, subagents: { count: subs.length, input: sub.input, cacheCreation: sub.cacheCreation, cacheRead: sub.cacheRead, output: sub.output, billableApprox: sub.billableApprox, combined: sub.combined },
      billableApprox: main.billableApprox + sub.billableApprox, combined: main.combined + sub.combined
    },
    firstTurnCtx: f.firstTurnCtx, preload, preloadApproxTokens: preload.reduce((s, p) => s + p.approxTokens, 0),
    toolCalls: Object.fromEntries(a.byTool.map(x => [x.tool, x.count])), errors: f.errors.length,
    topSinks: sinks.slice(0, 3).map(s => ({ key: s.key, approxTokens: s.approxTokens }))
  };
  if (outcomeRe) row.outcome = f.outcome;
  return { row, errors: f.errors, sinks };
}

const medianOrNull = (xs) => { const v = xs.filter(x => typeof x === 'number'); return v.length ? median(v) : null; };
const tally = (keys) => keys.reduce((m, k) => (m[k] = (m[k] ?? 0) + 1, m), {});

function skillSummary(runs, withOutcome) {
  const rows = runs.map(r => r.row);
  const starts = rows.map(r => r.startedAt).filter(Boolean).sort();
  const sumKinds = (pick) => {
    const t = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, billableApprox: 0, combined: 0 };
    for (const r of rows) for (const k of Object.keys(t)) t[k] += pick(r)[k];
    return t;
  };
  const toolCalls = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.toolCalls)) toolCalls[k] = (toolCalls[k] ?? 0) + n;

  const preloadKinds = new Map();
  for (const r of rows) for (const p of r.preload) { if (!preloadKinds.has(p.kind)) preloadKinds.set(p.kind, []); preloadKinds.get(p.kind).push(p.approxTokens); }

  const errors = new Map();
  for (const { row, errors: es } of runs) for (const e of es) {
    const key = `${e.tool}\u0000${e.message}`;
    const g = errors.get(key) ?? { tool: e.tool, message: e.message, count: 0, ids: [] };
    g.count++;
    if (!g.ids.includes(row.id)) g.ids.push(row.id);
    errors.set(key, g);
  }
  const sinks = new Map();
  for (const { sinks: ss } of runs) for (const s of ss) {
    const g = sinks.get(s.key) ?? { key: s.key, tool: s.tool, calls: 0, approxTokens: 0 };
    g.calls += s.calls; g.approxTokens += s.approxTokens; sinks.set(s.key, g);
  }

  const summary = {
    sessions: rows.length, firstStartedAt: starts[0] ?? null, lastStartedAt: starts.at(-1) ?? null,
    projects: tally(rows.map(r => r.project ?? '(unknown)')), models: tally(rows.flatMap(r => r.models)),
    humanContinued: rows.filter(r => r.humanContinued).length,
    tokens: {
      main: sumKinds(r => r.tokens.main), subagents: { count: rows.reduce((s, r) => s + r.tokens.subagents.count, 0), ...sumKinds(r => r.tokens.subagents) },
      billableApprox: rows.reduce((s, r) => s + r.tokens.billableApprox, 0), combined: rows.reduce((s, r) => s + r.tokens.combined, 0)
    },
    median: {
      durationMs: medianOrNull(rows.map(r => r.durationMs)), billableApprox: medianOrNull(rows.map(r => r.tokens.billableApprox)),
      combined: medianOrNull(rows.map(r => r.tokens.combined)), firstTurnCtx: medianOrNull(rows.map(r => r.firstTurnCtx)),
      preloadApproxTokens: medianOrNull(rows.map(r => r.preloadApproxTokens)), turns: medianOrNull(rows.map(r => r.turns)),
      toolCalls: medianOrNull(rows.map(r => Object.values(r.toolCalls).reduce((s, n) => s + n, 0)))
    },
    preload: [...preloadKinds].map(([kind, xs]) => ({ kind, sessions: xs.length, medianApproxTokens: median(xs) }))
      .sort((a, b) => b.medianApproxTokens - a.medianApproxTokens || a.kind.localeCompare(b.kind)),
    toolCalls,
    errors: [...errors.values()]
      .sort((a, b) => b.count - a.count || b.ids.length - a.ids.length || a.tool.localeCompare(b.tool) || a.message.localeCompare(b.message))
      .slice(0, SKILL_TOP).map(g => ({ tool: g.tool, message: g.message, count: g.count, sessions: g.ids.length, examples: g.ids.slice(0, 3) })),
    sinks: [...sinks.values()].sort((a, b) => b.approxTokens - a.approxTokens || a.key.localeCompare(b.key)).slice(0, SKILL_TOP)
  };
  if (withOutcome) {
    const key = (r) => r.outcome ?? '(none)';
    summary.outcomes = tally(rows.map(key));
    summary.byOutcome = {};
    for (const k of Object.keys(summary.outcomes)) {
      const rs = rows.filter(r => key(r) === k);
      summary.byOutcome[k] = {
        sessions: rs.length, medianDurationMs: medianOrNull(rs.map(r => r.durationMs)), medianBillable: medianOrNull(rs.map(r => r.tokens.billableApprox)),
        medianCombined: medianOrNull(rs.map(r => r.tokens.combined)), medianFirstTurnCtx: medianOrNull(rs.map(r => r.firstTurnCtx))
      };
    }
  }
  return summary;
}

/**
 * The newest `limit` finished sessions under `root` whose first typed prompt invokes `skill`, by transcript mtime, newest first. A transcript written in
 * the last five minutes is left out as possibly live (`skippedActive`). `outcome` is a regex source: each row's `outcome` is its first capture group
 * (or the whole match) from the first tool result or assistant text that matches, and the summary tallies them.
 */
export function reviewSkill({ root, skill, limit = SKILL_DEFAULT_LIMIT, outcome = null, now = Date.now() }) {
  const outcomeRe = outcome == null ? null : new RegExp(outcome);
  const cands = listTranscripts(root).sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const picked = [];
  let scanned = 0, skippedActive = 0;
  for (const t of cands) {
    if (picked.length >= limit) break;
    scanned++;
    const p = firstPrompt(t.file);
    const inv = p == null ? null : parseInvocation(p);
    if (!inv || !invokesSkill(inv.command, skill)) continue;
    if (now - t.mtimeMs < SKILL_ACTIVE_MS) { skippedActive++; continue; }
    picked.push({ ...t, args: inv.args });
  }
  const runs = picked.map(t => skillRun(t, outcomeRe)).filter(Boolean);
  return {
    skill, limit, outcome, scanned, skippedActive,
    summary: skillSummary(runs, outcomeRe != null),
    sessions: runs.map(r => r.row),
    notes: [
      'tokens.billableApprox = input + output + cacheCreation, main plus subagents; combined adds cacheRead. Subagents are every transcript under <session>/subagents/, each summed once per message.id.',
      'firstTurnCtx is measured (input + cache_creation + cache_read of the first assistant turn). preload[].approxTokens is estimated — the text-bearing fields of each record before that turn at chars ÷ 4 — so firstTurnCtx minus preloadApproxTokens is roughly the tool schemas and any system prompt the transcript did not record.',
      'durationMs runs from the first to the last record, so a session a person continued (humanContinued) reads long; judge time on the others.',
      'sinks and topSinks size each tool result at chars ÷ 4; errors fold digits and hex runs to N and key on the first 100 characters.'
    ]
  };
}

/* ------------------------------------------------ CLI (kaizen.ts) */

const ID_RE = /^[A-Za-z0-9._-]+$/;
const PROJECT_RE = /^(?!\.\.?$)[^/\s\]]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SKILL_NAME_RE = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;
const SKILL_USAGE = 'usage: node kaizen.mjs --skill <name | plugin:name> [N 1-9999] [--outcome <regex>]';
const USAGE = 'usage: node kaizen.mjs <session-id | /abs/path.jsonl | --latest | --trend [/abs/log.md] | --compare <project> <since YYYY-MM-DD> <field.path> | --budget [<file>] [<heading>] [<bytes>] | --skill <name> [N] [--outcome <regex>]>';
function die(msg) { console.error(msg); process.exit(1); }

function main() {
  const arg = process.argv[2];
  if (!arg) die(USAGE);

  if (arg === '--compare') {
    const [project, since, fieldPath] = process.argv.slice(3);
    if (!project || !since || !fieldPath) die('usage: node kaizen.mjs --compare <project> <since YYYY-MM-DD> <field.path>');
    if (!PROJECT_RE.test(project)) die(`invalid project tag: ${project}`);
    if (!DATE_RE.test(since) || !Number.isFinite(Date.parse(`${since}T00:00:00Z`))) die(`invalid date (want YYYY-MM-DD): ${since}`);
    if (!FIELD_PATH_RE.test(fieldPath)) die(`invalid field path: ${fieldPath}`);
    let result;
    try { result = compareSessions({ root: projectsRoot(), project, since, fieldPath }); } catch (e) { die(e.message); }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (arg === '--skill') {
    const rest = process.argv.slice(3);
    let name, limit = SKILL_DEFAULT_LIMIT, outcome = null, sawLimit = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--outcome') { if (i + 1 >= rest.length) die(SKILL_USAGE); outcome = rest[++i]; }
      else if (name === undefined) name = rest[i];
      else if (!sawLimit && /^[1-9]\d{0,3}$/.test(rest[i])) { limit = Number(rest[i]); sawLimit = true; }
      else die(SKILL_USAGE);
    }
    if (!name || !SKILL_NAME_RE.test(name)) die(SKILL_USAGE);
    if (outcome != null) { try { new RegExp(outcome); } catch (e) { die(`invalid --outcome regex: ${e.message}`); } }
    process.stdout.write(JSON.stringify(reviewSkill({ root: projectsRoot(), skill: name, limit, outcome }), null, 2) + '\n');
    return;
  }

  if (arg === '--trend') {
    const log = process.argv[3] ?? path.join(os.homedir(), '.claude', 'session-analytics-log.md');
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* absent log = empty series, not an error */ }
    process.stdout.write(JSON.stringify(contextTrend(text), null, 2) + '\n');
    return;
  }

  if (arg === '--budget') {
    const [file = path.join(os.homedir(), '.claude', 'CLAUDE.md'), heading = BUDGET_DEFAULTS.heading, raw = String(BUDGET_DEFAULTS.bytes)] = process.argv.slice(3);
    if (!/^[1-9]\d*$/.test(raw) || !HEADING_RE.test(heading.trim())) die(USAGE);
    const abs = path.resolve(file);
    let text = null;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* absent file = a fresh machine, under budget, not an error */ }
    const budget = Number(raw);
    const m = text == null
      ? { section: false, bytes: 0, budget, remaining: budget, over: false, rules: [] }
      : measureSection(text, heading, budget);
    process.stdout.write(JSON.stringify({ file: abs, heading: heading.trim(), exists: text != null, ...m }, null, 2) + '\n');
    return;
  }

  let file, id;
  if (arg === '--latest') {
    const here = normCwd(process.cwd());
    const cands = listTranscripts(projectsRoot()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const match = cands.find(t => { const a = analyzeSession(t.file, t.id); return a && a.cwd && normCwd(a.cwd) === here; });
    if (!match) die(`no transcript found for cwd ${here}`);
    file = match.file; id = match.id;
    console.error(`[kaizen] --latest resolved to session ${id}`);
  } else if (arg.startsWith('/')) {
    if (arg.includes('..') || !arg.endsWith('.jsonl')) die('path must be an absolute .jsonl file');
    file = arg;
  } else {
    if (!ID_RE.test(arg)) die('invalid session id');
    const ref = listTranscripts(projectsRoot()).find(t => t.id === arg);
    if (!ref) die(`session not found: ${arg}`);
    file = ref.file; id = ref.id;
  }

  const analysis = analyzeSession(file, id);
  if (!analysis) die(`could not read transcript: ${file}`);
  process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
}

// Run only as a CLI, so tests can import analyzeSession. argv[1] may reach this file through a symlink; import.meta.url is the real path.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
