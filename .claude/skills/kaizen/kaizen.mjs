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
 *
 * PROVENANCE: ported from claude-agents-dashboard server/lib/{analyze,agents,subagent-usage,scan}.ts.
 * That repo holds the unit-tested source of truth; keep this in sync if it changes.
 * Exception: `--trend` is kaizen-only, has no TS twin, and is tested by spawning this file (test/kaizen-trend.test.ts).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const apply = (ev) => {
    if (ev.kind === 'launch') {
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
  const agents = (readAgents(filePath) || []).map(a => {
    const file = (a.agentId && byAgentId.get(a.agentId)) || byToolUseId.get(a.id);
    let figure = null;
    if (a.status === 'done') {
      if (file && file.usage.combined > 0 && file.usage.combined >= (a.tokens ?? 0)) { figure = file.usage.combined; addTotals(usage, file.usage); }
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
// neither the window nor a compaction marker. A turn below half the running peak is a compaction — context only grows between them.
const NEVER_COMPACTED_PEAK = 250_000;
const COMPACTION_DROP_RATIO = 0.5;

function analyzeSession(filePath, id) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0;
  const models = new Set();
  const toolMap = new Map();
  const pendingTool = new Map();
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

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }

    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
    if (ts) { if (!minTs || ts < minTs) minTs = ts; if (!maxTs || ts > maxTs) maxTs = ts; }
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (rec.isSidechain === true) continue;

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
      if (t && !t.includes('<task-notification>') && CORRECTION_RE.test(t)) userCorrections++;
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

  const notes = [
    'combined includes cache_read (replayed cached prompt, billed ~10%); lead with billableApprox for real cost.',
    "byTool.approxOutputTokens splits each turn's output tokens evenly across its tool calls — approximate; the transcript has no per-tool token field.",
    "byTool.resultTokens is what each tool injected into context: its tool_result text sized at chars ÷ 4, summed per call (not split), error text included, images not counted. The firmer per-tool figure and byTool's sort key — but it is context growth, not assistant output; cite both and never add them.",
    'errorSignals.userCorrections is a keyword heuristic — a noisy lower bound, not an accuracy score.',
    'perTurn.neverCompacted is inferred from peak context, not read from a window field — the transcript records neither the window nor a compaction: true when the peak turn tops 250k combined (a 200k window compacts near 160k) and no turn ever fell below half the running peak.'
  ];
  if (subagentTotals.count > 0) notes.push("Subagent tokens are summed from each subagent's own transcript and are separate from main-agent totals; whole-session total = totals.combined + subagentTotals.tokens. subagentTotals.usage splits them by class — lead with its billableApprox for cost.");
  if (subagentTotals.fallbackCount > 0) notes.push(`${subagentTotals.fallbackCount} subagent(s) have no complete transcript and are counted at the harness figure (their final context size) — a lower bound.`);
  if (subagentTotals.unknownTokenCount > 0) notes.push(`${subagentTotals.unknownTokenCount} subagent(s) have unknown token totals (still running or old transcript).`);

  const durationMs = minTs && maxTs ? Date.parse(maxTs) - Date.parse(minTs) : null;

  return {
    id: id || filePath.replace(/^.*\//, '').replace(/\.jsonl$/, ''),
    file: filePath, cwd, models: [...models],
    startedAt: minTs, endedAt: maxTs, durationMs: Number.isFinite(durationMs) ? durationMs : null,
    totals: { input, output, cacheCreation, cacheRead, combined, billableApprox: input + output + cacheCreation },
    perTurn: { count: turnCount, avgCombined: turnCount > 0 ? Math.round(sumCombined / turnCount) : 0, maxCombined, maxTurnIndex, neverCompacted: maxCombined > NEVER_COMPACTED_PEAK && !compacted },
    byTool, bySubagent: agents, subagentTotals,
    serverTools: { webSearch: serverWebSearch, webFetch: serverWebFetch },
    errorSignals: { toolErrors, retries, userCorrections },
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

/* ------------------------------------------------ CLI (kaizen.ts) */

const ID_RE = /^[A-Za-z0-9._-]+$/;
function die(msg) { console.error(msg); process.exit(1); }

function main() {
  const arg = process.argv[2];
  if (!arg) die('usage: node kaizen.mjs <session-id | /abs/path.jsonl | --latest | --trend [/abs/log.md]>');

  if (arg === '--trend') {
    const log = process.argv[3] ?? path.join(os.homedir(), '.claude', 'session-analytics-log.md');
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* absent log = empty series, not an error */ }
    process.stdout.write(JSON.stringify(contextTrend(text), null, 2) + '\n');
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

main();
