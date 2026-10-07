/**
 * tasks.ts — rebuild a session's task list by folding every `TaskCreate` / `TaskUpdate` call in its transcript with the result that confirmed it.
 *
 * Not `record-cache.ts`: that finds the one newest record of a kind, while a task list needs every Task record from the session's first line, and the
 * creates are usually written far below `readTranscript`'s 256 KB tail. So the whole file is folded once, the byte offset reached is remembered, and every
 * later poll reads only what was appended. Transcripts are append-only; a file that shrank was rotated or truncated and starts over.
 *
 * Bytes are split on `0x0A` before decoding (as in `chat.ts`), since a multibyte sequence can straddle any chunk boundary. A chunk's tail after its last
 * newline is carried into the next chunk rather than dropped, because single records run past a whole chunk (1.36 MB seen, 2026-10-07); only the file's
 * own unterminated last line is deferred to the next poll.
 *
 * Design: docs/superpowers/specs/2026-10-07-task-progress-design.md §2.
 */

import fs from 'node:fs';

import type { SessionTask, TaskStatus } from '../../shared/types.js';

/** Most bytes read per `readSync` (MiB, as `record-cache.ts`). */
export const CHUNK_BYTES = 1024 * 1024;
const MAX_ENTRIES = 64;

const CREATE = 'TaskCreate';
const UPDATE = 'TaskUpdate';
const CALL_MARKERS = [`"${CREATE}"`, `"${UPDATE}"`];
const STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

interface PendingCall {
  name: typeof CREATE | typeof UPDATE;
  input: Record<string, unknown>;
}

interface Entry {
  /** Everything before this byte has been folded; it always sits just past a newline. */
  offset: number;
  /** File size at the last call — a smaller size later means the file was replaced. */
  size: number;
  /** Calls whose result has not been seen yet, by tool_use id. */
  pending: Map<string, PendingCall>;
  /** Insertion order is creation order: a re-created id is replaced in place, never re-appended. */
  tasks: Map<string, SessionTask>;
  /** A create was confirmed at some point, so an emptied list reads `[]`, not null. */
  created: boolean;
}

const cache = new Map<string, Entry>();
let bytesRead = 0;

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function apply(entry: Entry, call: PendingCall, result: unknown): void {
  const res = isObject(result) ? result : null;
  const { input } = call;

  if (call.name === CREATE) {
    const id = nonEmpty(res?.task?.id);
    if (id === null) return;
    entry.tasks.set(id, { id, subject: typeof input.subject === 'string' ? input.subject : '', status: 'pending', activeForm: nonEmpty(input.activeForm) });
    entry.created = true;
    return;
  }

  if (res?.success !== true) return;
  const id = nonEmpty(input.taskId);
  const task = id === null ? undefined : entry.tasks.get(id);
  if (!task) return;

  const next: unknown = res?.statusChange?.to ?? input.status;
  if (next === 'deleted') { entry.tasks.delete(task.id); return; }
  // Replaced, not mutated: a list already handed out stays a snapshot.
  entry.tasks.set(task.id, {
    ...task,
    status: typeof next === 'string' && STATUSES.has(next) ? (next as TaskStatus) : task.status,
    subject: nonEmpty(input.subject) ?? task.subject,
    activeForm: nonEmpty(input.activeForm) ?? task.activeForm
  });
}

function foldLine(entry: Entry, line: Buffer): void {
  // Most lines are neither a Task call nor an answer to one; skip them without decoding.
  let hit = CALL_MARKERS.some((m) => line.includes(m));
  if (!hit && entry.pending.size > 0) for (const id of entry.pending.keys()) if (line.includes(id)) { hit = true; break; }
  if (!hit) return;

  let rec: any;
  try { rec = JSON.parse(line.toString('utf8')); } catch { return; }
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return;

  // The substring hit is not trusted: the words also turn up in message text and a pending id in progress records, so only the exact block shape counts.
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'tool_use' && (block.name === CREATE || block.name === UPDATE) && typeof block.id === 'string') {
      entry.pending.set(block.id, { name: block.name, input: isObject(block.input) ? block.input : {} });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = entry.pending.get(block.tool_use_id);
      if (!call) continue;
      entry.pending.delete(block.tool_use_id);
      apply(entry, call, rec.toolUseResult);
    }
  }
}

/** Fold `[entry.offset, size)`; `entry.offset` advances chunk by chunk, so a read error leaves it at the last fully folded line. */
function foldFrom(fd: number, entry: Entry, size: number): void {
  let pos = entry.offset;
  let carry: Buffer | null = null;
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos));
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    pos += n;
    bytesRead += n;

    const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      foldLine(entry, buf.subarray(start, nl));
      start = nl + 1;
    }
    entry.offset += start;
    carry = start < buf.length ? buf.subarray(start) : null;
  }
}

function snapshot(entry: Entry): SessionTask[] | null {
  return entry.created ? [...entry.tasks.values()] : null;
}

/**
 * The session's task list in creation order; null when the transcript holds no confirmed `TaskCreate` (an all-deleted list is `[]`). Never throws: a
 * missing file is null, any other I/O error returns what was remembered and retries next call.
 */
export function readSessionTasks(filePath: string): SessionTask[] | null {
  let entry = cache.get(filePath);
  if (entry) { cache.delete(filePath); cache.set(filePath, entry); }

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return null; }
    return entry ? snapshot(entry) : null;
  }

  if (entry && size < entry.size) { cache.delete(filePath); entry = undefined; }
  if (entry && size === entry.offset) return snapshot(entry);

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return null; }
    return entry ? snapshot(entry) : null;
  }

  if (!entry) {
    entry = { offset: 0, size: 0, pending: new Map(), tasks: new Map(), created: false };
    cache.set(filePath, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  try {
    foldFrom(fd, entry, size);
    entry.size = size;
  } catch {
    // Keep what was folded; offset still marks the last complete line, so the next call resumes there.
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing left to do */ }
  }
  return snapshot(entry);
}

/** Test seam: forget every file. */
export function resetTaskCache(): void {
  cache.clear();
  bytesRead = 0;
}

/** Test seam: entries held, and bytes read from disk since the last reset. */
export function taskCacheStats(): { entries: number; bytesRead: number } {
  return { entries: cache.size, bytesRead };
}
