/**
 * transcript.ts — read token usage, metadata, and current activity from a
 * Claude Code session transcript (JSONL). Self-contained, zero runtime deps.
 */

import fs from 'node:fs';

import type { Activity } from '../../shared/types.js';

export const STANDARD_WINDOW = 200000;
export const LARGE_WINDOW = 1000000;
const LARGE_MARKER = '[1m]';
export const DEFAULT_TAIL_BYTES = 256 * 1024;

export interface ParsedTranscript {
  tokens: number;
  model: string;
  contextWindow: number;
  contextWindowLabel: string;
  contextPct: number;
  activity: Activity | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  lastTimestamp: string | null;
  /** Newest assistant turn ended cleanly (stop_reason "end_turn"). */
  turnComplete: boolean;
  /** Newest assistant action is an unanswered AskUserQuestion. */
  waitingOnQuestion: boolean;
}

interface TailResult {
  text: string;
  truncated: boolean;
}

/** Read the trailing `tailBytes` of a file as UTF-8, tolerant of big files. */
export function readTail(filePath: string, tailBytes: number): TailResult | null {
  let fd: number | undefined;
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
export function usageTokens(record: any): number {
  const u = record && record.message && record.message.usage;
  if (!u || typeof u !== 'object') return 0;
  const total =
    (Number.isFinite(u.input_tokens) ? u.input_tokens : 0) +
    (Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0) +
    (Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0);
  return total > 0 ? total : 0;
}

/** Pick a context window size for a model / observed token count. */
export function resolveWindow(tokens: number, model: string, env?: NodeJS.ProcessEnv): number {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const override = Number.parseInt(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW || e.CLAUDE_OBS_CONTEXT_WINDOW || '', 10);
  if (Number.isInteger(override) && override > 0) return override;
  if (typeof model === 'string' && model.includes(LARGE_MARKER)) return LARGE_WINDOW;
  if (Number.isFinite(tokens) && tokens > STANDARD_WINDOW) return LARGE_WINDOW;
  return STANDARD_WINDOW;
}

export function windowLabel(win: number): string {
  if (win >= 1000000) return (win / 1000000) + 'M';
  if (win >= 1000) return Math.round(win / 1000) + 'k';
  return String(win);
}

/** Short human label describing what a tool_use block is doing. */
export function describeTool(block: any): string {
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

/** Read a transcript and return usage, metadata, and current activity. */
export function readTranscript(
  filePath: string,
  options: { tailBytes?: number } = {}
): ParsedTranscript | null {
  const tailBytes = Number.isInteger(options.tailBytes) && (options.tailBytes as number) > 0
    ? (options.tailBytes as number)
    : DEFAULT_TAIL_BYTES;
  const tail = readTail(filePath, tailBytes);
  if (!tail) return null;

  const lines = tail.text.split('\n');
  const first = tail.truncated ? 1 : 0;

  let tokens = 0;
  let model = '';
  let activity: Activity | null = null;
  let cwd: string | null = null, gitBranch: string | null = null, version: string | null = null, lastTs: string | null = null;

  // Session-state signals, taken from the newest message record only.
  let newestMessageSeen = false;
  let turnComplete = true;
  let waitingOnQuestion = false;

  // Single newest-first scan gathers everything we need.
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: any;
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

    // First (newest) record carrying a real conversational role decides turn state.
    const role = rec.message && rec.message.role;
    if (!newestMessageSeen && (role === 'user' || role === 'assistant')) {
      newestMessageSeen = true;
      const m = rec.message;
      turnComplete = role === 'assistant' && m.stop_reason === 'end_turn';
      if (role === 'assistant' && Array.isArray(m.content)) {
        waitingOnQuestion = m.content.some(
          (b: any) => b && b.type === 'tool_use' && b.name === 'AskUserQuestion'
        );
      }
    }

    if (tokens && activity && cwd && lastTs && version && newestMessageSeen) break;
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
    lastTimestamp: lastTs,
    turnComplete,
    waitingOnQuestion
  };
}
