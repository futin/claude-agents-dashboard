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
 *
 * PROVENANCE: ported from claude-agents-dashboard server/lib/{analyze,agents,scan}.ts.
 * That repo holds the unit-tested source of truth; keep this in sync if it changes.
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

function parseRecordEvents(rec) {
  const msg = rec && rec.message;
  if (!msg) return [];
  const content = msg.content;
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const events = [];
  const flat = contentText(content);
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
      let agentId = null;
      if (isAsyncAck) {
        if (t && typeof t.agentId === 'string') agentId = t.agentId;
        else { const m = text.match(AGENT_ID_RE); agentId = m ? m[1] : null; }
      }
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
      const l = { id: ev.id, type: ev.type, description: ev.description, startedAt: ev.ts, endedAt: null, exactDurationMs: null, tokens: null, toolUses: null };
      launches.push(l);
      if (!byToolUseId.has(ev.id)) byToolUseId.set(ev.id, l);
      return;
    }
    if (ev.kind === 'result') {
      const l = byToolUseId.get(ev.toolUseId);
      if (!l) return;
      byToolUseId.delete(ev.toolUseId);
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
      startedAt: l.startedAt, endedAt: l.endedAt, durationMs: l.exactDurationMs ?? diff, tokens: l.tokens, toolUses: l.toolUses
    };
  });
  agents.reverse();
  return agents;
}

/* ------------------------------------------------ analysis (analyze.ts) */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function isErrorResult(b) { return b.is_error === true || /<tool_use_error>/i.test(toolResultText(b)); }
function userText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}
const CORRECTION_RE = /\b(no|nope|wrong|incorrect|not (?:what|right|correct)|actually|instead|revert|undo|don'?t|that'?s not)\b/i;

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
  let cwd = null, minTs = null, maxTs = null;

  const getTool = (name) => {
    let s = toolMap.get(name);
    if (!s) { s = { tool: name, count: 0, durationMs: 0, errors: 0, approxOutputTokens: 0 }; toolMap.set(name, s); }
    return s;
  };

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
        if (stu && typeof stu === 'object') { serverWebSearch += num(stu.web_search_requests); serverWebFetch += num(stu.web_fetch_requests); }
      }
      if (Array.isArray(content)) {
        const toolBlocks = content.filter(b => b && b.type === 'tool_use' && typeof b.name === 'string');
        const share = toolBlocks.length > 0 ? outTokens / toolBlocks.length : 0;
        for (const b of toolBlocks) {
          const s = getTool(b.name);
          s.count++;
          s.approxOutputTokens += share;
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
            if (p.ts && ts) { const d = Date.parse(ts) - Date.parse(p.ts); if (Number.isFinite(d) && d >= 0) s.durationMs += d; }
            if (err) { s.errors++; toolErrors++; errorOutstanding.add(p.name); } else errorOutstanding.delete(p.name);
          } else if (err) { toolErrors++; }
        }
      }
      const t = userText(msg);
      if (t && !t.includes('<task-notification>') && CORRECTION_RE.test(t)) userCorrections++;
    }
  }

  const combined = input + output + cacheCreation + cacheRead;
  const byTool = [...toolMap.values()]
    .map(s => ({ ...s, approxOutputTokens: Math.round(s.approxOutputTokens) }))
    .sort((a, b) => b.approxOutputTokens - a.approxOutputTokens || b.count - a.count);

  const agents = readAgents(filePath) || [];
  const subagentTotals = {
    count: agents.length,
    tokens: agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0),
    unknownTokenCount: agents.filter(a => a.tokens == null).length
  };

  const notes = [
    'combined includes cache_read (replayed cached prompt, billed ~10%); lead with billableApprox for real cost.',
    "byTool.approxOutputTokens splits each turn's output tokens evenly across its tool calls — approximate; the transcript has no per-tool token field.",
    'errorSignals.userCorrections is a keyword heuristic — a noisy lower bound, not an accuracy score.'
  ];
  if (subagentTotals.count > 0) notes.push('Subagent tokens are exact and separate from main-agent totals; whole-session total ≈ totals.combined + subagentTotals.tokens.');
  if (subagentTotals.unknownTokenCount > 0) notes.push(`${subagentTotals.unknownTokenCount} subagent(s) have unknown token totals (still running or old transcript).`);

  const durationMs = minTs && maxTs ? Date.parse(maxTs) - Date.parse(minTs) : null;

  return {
    id: id || filePath.replace(/^.*\//, '').replace(/\.jsonl$/, ''),
    file: filePath, cwd, models: [...models],
    startedAt: minTs, endedAt: maxTs, durationMs: Number.isFinite(durationMs) ? durationMs : null,
    totals: { input, output, cacheCreation, cacheRead, combined, billableApprox: input + output + cacheCreation },
    perTurn: { count: turnCount, avgCombined: turnCount > 0 ? Math.round(sumCombined / turnCount) : 0, maxCombined, maxTurnIndex },
    byTool, bySubagent: agents, subagentTotals,
    serverTools: { webSearch: serverWebSearch, webFetch: serverWebFetch },
    errorSignals: { toolErrors, retries, userCorrections },
    notes
  };
}

/* ------------------------------------------------ CLI (kaizen.ts) */

const ID_RE = /^[A-Za-z0-9._-]+$/;
function die(msg) { console.error(msg); process.exit(1); }

function main() {
  const arg = process.argv[2];
  if (!arg) die('usage: node kaizen.mjs <session-id | /abs/path.jsonl | --latest>');

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
