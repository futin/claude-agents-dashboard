'use strict';

/**
 * transcript.js — read token usage, metadata, and current activity from a
 * Claude Code session transcript (JSONL). Self-contained, zero dependencies.
 */

const fs = require('fs');

const STANDARD_WINDOW = 200000;
const LARGE_WINDOW = 1000000;
const LARGE_MARKER = '[1m]';
const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Read the trailing `tailBytes` of a file as UTF-8, tolerant of big files. */
function readTail(filePath, tailBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const start = size > tailBytes ? size - tailBytes : 0;
    const length = size - start;
    if (length <= 0) return { text: '', truncated: false };
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Sum the context-contributing token fields from a record's usage block. */
function usageTokens(record) {
  const u = record && record.message && record.message.usage;
  if (!u || typeof u !== 'object') return 0;
  const total =
    (Number.isFinite(u.input_tokens) ? u.input_tokens : 0) +
    (Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0) +
    (Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0);
  return total > 0 ? total : 0;
}

/** Pick a context window size for a model / observed token count. */
function resolveWindow(tokens, model, env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const override = Number.parseInt(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW || e.CLAUDE_OBS_CONTEXT_WINDOW || '', 10);
  if (Number.isInteger(override) && override > 0) return override;
  if (typeof model === 'string' && model.includes(LARGE_MARKER)) return LARGE_WINDOW;
  if (Number.isFinite(tokens) && tokens > STANDARD_WINDOW) return LARGE_WINDOW;
  return STANDARD_WINDOW;
}

function windowLabel(win) {
  if (win >= 1000000) return (win / 1000000) + 'M';
  if (win >= 1000) return Math.round(win / 1000) + 'k';
  return String(win);
}

/** Short human label describing what a tool_use block is doing. */
function describeTool(block) {
  const input = (block && block.input) || {};
  switch (block && block.name) {
    case 'Task':
      return [input.subagent_type, input.description].filter(Boolean).join(': ');
    case 'Bash':
      return String(input.description || input.command || '').slice(0, 80);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return String(input.file_path || input.notebook_path || '').slice(0, 80);
    case 'Grep':
    case 'Glob':
      return String(input.pattern || '').slice(0, 80);
    case 'Skill':
      return String(input.skill || '');
    default: {
      const first = Object.values(input).find(v => typeof v === 'string');
      return first ? String(first).slice(0, 80) : '';
    }
  }
}

/**
 * Read a transcript and return usage, metadata, and current activity.
 * @returns {object|null}
 */
function readTranscript(filePath, options = {}) {
  const tailBytes = Number.isInteger(options.tailBytes) && options.tailBytes > 0 ? options.tailBytes : DEFAULT_TAIL_BYTES;
  const tail = readTail(filePath, tailBytes);
  if (!tail) return null;

  const lines = tail.text.split('\n');
  const first = tail.truncated ? 1 : 0;

  let tokens = 0;
  let model = '';
  let activity = null;
  let cwd = null, gitBranch = null, version = null, lastTs = null;

  // Single newest-first scan gathers everything we need.
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (!gitBranch && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch;
    if (!version && typeof rec.version === 'string') version = rec.version;
    if (!lastTs && typeof rec.timestamp === 'string') lastTs = rec.timestamp;

    if (!tokens) {
      const t = usageTokens(rec);
      if (t > 0) {
        tokens = t;
        model = (rec.message && typeof rec.message.model === 'string') ? rec.message.model : model;
      }
    }

    if (!activity) {
      const content = rec.message && rec.message.content;
      if (Array.isArray(content)) {
        for (let j = content.length - 1; j >= 0; j--) {
          const b = content[j];
          if (b && b.type === 'tool_use' && b.name) {
            activity = { tool: b.name, detail: describeTool(b) };
            break;
          }
        }
      }
    }

    if (tokens && activity && cwd && lastTs && version) break;
  }

  const win = resolveWindow(tokens, model);
  const contextPct = win > 0 ? Math.min(100, Math.round((tokens / win) * 1000) / 10) : 0;

  return {
    tokens,
    model,
    contextWindow: win,
    contextWindowLabel: windowLabel(win),
    contextPct,
    activity,
    cwd,
    gitBranch,
    version,
    lastTimestamp: lastTs
  };
}

module.exports = {
  STANDARD_WINDOW,
  LARGE_WINDOW,
  DEFAULT_TAIL_BYTES,
  readTail,
  usageTokens,
  resolveWindow,
  windowLabel,
  describeTool,
  readTranscript
};
