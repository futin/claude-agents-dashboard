/**
 * chat.ts — the chat-history tail behind `GET /api/sessions/:id/chat`.
 *
 * A transcript is append-only JSONL, so paging is pure byte arithmetic: a fixed
 * `CHAT_WINDOW_BYTES` window ending at EOF is the first page, `cursor` walks
 * forward for the live tail (O(new bytes) per poll), and `headOffset` walks
 * backward one window at a time for older history. No cache is needed — unlike
 * agents-cache.ts there is no accumulated reducer state to keep, every call is
 * already O(window) or O(appended bytes).
 *
 * Correctness notes (same rules as agents-cache.ts):
 *  - Offsets are BYTES and lines are split on 0x0A *before* decoding — a
 *    multibyte UTF-8 sequence can straddle a window boundary, so string lengths
 *    must never drive an offset. That's also why this file reads Buffers itself
 *    instead of using transcript.ts `readTail` (which returns decoded text).
 *  - A window that doesn't start at byte 0 begins mid-line; that fragment is
 *    dropped (`dropFirstPartial`).
 *  - The newline-less final line of a growing file may still be a complete
 *    record: if it parses as JSON it is consumed (a strict prefix of a JSON
 *    document never parses), otherwise `consumed` stops before it and the next
 *    poll re-reads it.
 *
 * See `.claude/rules/chat-tail.md`.
 */

import fs from 'node:fs';

import { describeTool } from './transcript.js';
import type { ChatMessage, ChatToolCall, SessionChat } from '../../shared/types.js';

/** Messages per page (tail and each older page). */
export const CHAT_PAGE_MESSAGES = 100;
/** Bytes read per page — ~300 records at the observed p50 record size. */
export const CHAT_WINDOW_BYTES = 512 * 1024;
/** Per-message text cap; the drawer is a monitor, not a full transcript viewer. */
export const TEXT_CAP = 2000;
/** Cap for a tool body (a proposed plan runs 2–10 KB; this bounds pathological ones). */
export const TOOL_BODY_CAP = 20_000;

/** Injected context the CLI appends to user turns — noise in a chat view. */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** A page, minus the `id` the API handler owns. */
export type ChatPage = Omit<SessionChat, 'id'>;

/**
 * Markdown body for the two tools whose input IS conversational content —
 * ExitPlanMode (the proposed plan) and AskUserQuestion (the questions asked).
 * Everything else (and any shape mismatch) → null, i.e. the plain tool line.
 */
function toolBody(b: any): string | null {
  const input = b.input;
  if (!input || typeof input !== 'object') return null;
  if (b.name === 'ExitPlanMode') {
    return typeof input.plan === 'string' && input.plan.trim() ? input.plan : null;
  }
  if (b.name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const parts: string[] = [];
    for (const q of input.questions) {
      if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question) continue;
      const head = typeof q.header === 'string' && q.header ? `**${q.header}** — ${q.question}` : q.question;
      const opts = Array.isArray(q.options)
        ? q.options
            .filter((o: any) => o && typeof o === 'object' && typeof o.label === 'string' && o.label)
            .map((o: any) => `- **${o.label}**${typeof o.description === 'string' && o.description ? ` — ${o.description}` : ''}`)
        : [];
      parts.push([head, ...opts].join('\n'));
    }
    return parts.length ? parts.join('\n\n') : null;
  }
  return null;
}

/**
 * One JSONL record → a chat message, or null when there's nothing to show.
 * Pure — the unit-tested core.
 *
 * Dropped: records with no user/assistant `message.role` (`last-prompt`,
 * `custom-title`, `queue-operation`, `attachment`, `system`), sidechain records
 * (subagent traffic — SessionDetail already summarizes it), meta records, and
 * anything left empty after filtering (a user record holding only tool_results,
 * an assistant record holding only thinking).
 */
export function parseChatRecord(rec: any): ChatMessage | null {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.isSidechain === true || rec.isMeta === true) return null;

  const m = rec.message;
  if (!m || typeof m !== 'object') return null;
  const role = m.role;
  if (role !== 'user' && role !== 'assistant') return null;

  let text = '';
  const tools: ChatToolCall[] = [];
  const content = m.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        text += (text ? '\n' : '') + b.text;
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const tool: ChatToolCall = { name: b.name, detail: describeTool(b) };
        // body/bodyTruncated attach conditionally — most tools never carry them.
        const body = toolBody(b);
        if (body) {
          tool.body = body.slice(0, TOOL_BODY_CAP);
          if (body.length > TOOL_BODY_CAP) tool.bodyTruncated = true;
        }
        tools.push(tool);
      }
      // thinking + tool_result blocks are intentionally dropped
    }
  }

  text = text.replace(SYSTEM_REMINDER_RE, '').trim();
  if (!text && tools.length === 0) return null;

  const textTruncated = text.length > TEXT_CAP;
  if (textTruncated) text = text.slice(0, TEXT_CAP);

  return {
    uuid: typeof rec.uuid === 'string' ? rec.uuid : '',
    role,
    ts: typeof rec.timestamp === 'string' ? rec.timestamp : null,
    text,
    textTruncated,
    tools
  };
}

export interface WindowParse {
  /** Kept messages with the absolute byte offset of the line each came from. */
  items: Array<{ offset: number; msg: ChatMessage }>;
  /** Absolute offset up to which the window is fully consumed. */
  consumed: number;
}

/**
 * Parse a byte window into messages + the offset consumed. Pure.
 * `windowStart` is the window's absolute offset; pass `dropFirstPartial` when
 * the window began mid-line (i.e. `windowStart > 0`).
 */
export function parseChatWindow(buf: Buffer, windowStart: number, dropFirstPartial: boolean): WindowParse {
  const items: WindowParse['items'] = [];
  let start = 0;

  if (dropFirstPartial) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return { items, consumed: windowStart + buf.length };
    start = nl + 1;
  }

  let consumed = windowStart + start;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(start, end).toString('utf8').trim();
    if (line) {
      let rec: any;
      let parsed = true;
      try { rec = JSON.parse(line); } catch { parsed = false; }
      if (parsed) {
        const msg = parseChatRecord(rec);
        if (msg) {
          // Older records predate `uuid`; keep keys unique for the client.
          if (!msg.uuid) msg.uuid = 'off:' + (windowStart + start);
          items.push({ offset: windowStart + start, msg });
        }
        // An unterminated final line that parses IS a complete record.
        if (nl === -1) consumed = windowStart + buf.length;
      }
    } else if (nl === -1) {
      // Trailing whitespace only — nothing left to wait for.
      consumed = windowStart + buf.length;
    }
    if (nl === -1) break;
    start = nl + 1;
    consumed = windowStart + start;
  }

  return { items, consumed };
}

function statSize(file: string): number | null {
  try { return fs.statSync(file).size; } catch { return null; }
}

/** Read `[start, end)` as bytes. Never decodes — see the header note. */
function readRange(file: string, start: number, end: number): Buffer | null {
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Keep the newest `limit` messages of a window and shape the page. */
function page(parse: WindowParse, windowStart: number, limit: number, cursor: number): ChatPage {
  const { items } = parse;
  const kept = items.slice(Math.max(0, items.length - limit));
  const headOffset = kept.length ? kept[0].offset : windowStart;
  return {
    messages: kept.map(i => i.msg),
    cursor,
    headOffset,
    hasMore: headOffset > 0
  };
}

/** The first page: the newest `limit` messages in the last window of the file. */
export function readChatTail(file: string, limit = CHAT_PAGE_MESSAGES): ChatPage | null {
  const size = statSize(file);
  if (size === null) return null;
  const start = Math.max(0, size - CHAT_WINDOW_BYTES);
  const buf = readRange(file, start, size);
  if (!buf) return null;
  const parse = parseChatWindow(buf, start, start > 0);
  return page(parse, start, limit, parse.consumed);
}

/**
 * An older page: the newest `limit` messages in the window ending at `before`
 * (a `headOffset` from a previous page, so always a line start). `cursor` is 0
 * — backward pages never move the client's live-tail cursor.
 */
export function readChatBefore(file: string, before: number, limit = CHAT_PAGE_MESSAGES): ChatPage | null {
  const size = statSize(file);
  if (size === null) return null;
  const end = Math.min(before, size);
  if (end <= 0) return { messages: [], cursor: 0, headOffset: 0, hasMore: false };
  const start = Math.max(0, end - CHAT_WINDOW_BYTES);
  const buf = readRange(file, start, end);
  if (!buf) return null;
  return page(parseChatWindow(buf, start, start > 0), start, limit, 0);
}

/**
 * The live tail: everything appended past `after`. Unlimited by design — the
 * span is one poll interval of appends. `after > size` means the file was
 * truncated/rotated, so the cursor is meaningless → `reset`.
 */
export function readChatAfter(file: string, after: number): ChatPage | null {
  const size = statSize(file);
  if (size === null) return null;
  if (after > size) return { messages: [], cursor: 0, headOffset: 0, hasMore: false, reset: true };
  if (after === size) return { messages: [], cursor: after, headOffset: after, hasMore: after > 0 };
  const buf = readRange(file, after, size);
  if (!buf) return null;
  const parse = parseChatWindow(buf, after, false);
  return {
    messages: parse.items.map(i => i.msg),
    cursor: parse.consumed,
    headOffset: after,
    hasMore: after > 0
  };
}
