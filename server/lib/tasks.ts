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
 * The same fold also collects plan signals (`plan-progress.ts`): which superpowers plan the session executes and which of its tasks are running or done.
 * Current models never call TaskCreate, so when a plan yields rows it is the list, and the TaskCreate list is the fallback.
 *
 * Design: docs/superpowers/specs/2026-10-07-task-progress-design.md §2; docs/superpowers/specs/2026-10-07-plan-progress-design.md §2.2, §2.4, §2.5.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SessionTask, TaskStatus } from '../../shared/types.js';
import { composePlanTasks, planSignals, readPlanHeadings, resetPlanCache, resolvePlanFile, type PlanSignal } from './plan-progress.js';

/** Most bytes read per `readSync` (MiB, as `record-cache.ts`). */
export const CHUNK_BYTES = 1024 * 1024;
const MAX_ENTRIES = 64;

const CREATE = 'TaskCreate';
const UPDATE = 'TaskUpdate';
// The plan markers are what the signals in plan-progress.ts need present on a line; a line with none of them cannot hold a signal. `"name":"Agent"` lines
// carry whole dispatch prompts (several KB), so parsing them is the new cost the first-call gate watches.
const CALL_MARKERS = [
  `"${CREATE}"`, `"${UPDATE}"`,
  'progress.md', 'task-brief', 'task-start', 'task-done', 'review-package', '"name":"Agent"', 'subagent-driven-development', 'executing-plans'
];
const STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

interface PendingCall {
  name: typeof CREATE | typeof UPDATE;
  input: Record<string, unknown>;
}

/**
 * The plan being executed. `key` is the plan file's basename: the same plan is named relative from whichever directory the shell sits in (`/r`, `/r/server`,
 * `/r/client`), and a lexical resolve against each of those would call it three plans and reset the run on every cwd change. `path` and `base` follow the
 * newest signal so the file still resolves from where the session is now.
 */
interface PlanState {
  path: string;
  base: string | null;
  key: string;
  done: Set<string>;
  live: string | null;
}

/**
 * The fold state for one transcript: the task list, the plan being executed and the calls still waiting on a result. `readSessionTasks` keeps one per file;
 * the chat Trace keeps one per builder and feeds it a record at a time (`foldTaskRecord`) so it can read the live task as each tool call lands.
 */
export interface TaskFold {
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
  plan: PlanState | null;
  /** Done and running signals seen before any plan: a ledger is often written before the first `task-brief`. The first plan takes them. */
  heldDone: Set<string>;
  heldLive: string | null;
}

const cache = new Map<string, TaskFold>();
let bytesRead = 0;

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** True when the result changed the task list. */
function apply(entry: TaskFold, call: PendingCall, result: unknown): boolean {
  const res = isObject(result) ? result : null;
  const { input } = call;

  if (call.name === CREATE) {
    const id = nonEmpty(res?.task?.id);
    if (id === null) return false;
    entry.tasks.set(id, { id, subject: typeof input.subject === 'string' ? input.subject : '', status: 'pending', activeForm: nonEmpty(input.activeForm) });
    entry.created = true;
    return true;
  }

  if (res?.success !== true) return false;
  const id = nonEmpty(input.taskId);
  const task = id === null ? undefined : entry.tasks.get(id);
  if (!task) return false;

  const next: unknown = res?.statusChange?.to ?? input.status;
  if (next === 'deleted') { entry.tasks.delete(task.id); return true; }
  // Replaced, not mutated: a list already handed out stays a snapshot.
  entry.tasks.set(task.id, {
    ...task,
    status: typeof next === 'string' && STATUSES.has(next) ? (next as TaskStatus) : task.status,
    subject: nonEmpty(input.subject) ?? task.subject,
    activeForm: nonEmpty(input.activeForm) ?? task.activeForm
  });
  return true;
}

/** True when the signal changed the plan state (a path or base that moved, a new plan, a task newly done or newly running). */
function applySignal(entry: TaskFold, sig: PlanSignal): boolean {
  if (sig.kind === 'plan') {
    const key = path.basename(sig.path);
    if (entry.plan?.key === key) {
      const moved = entry.plan.path !== sig.path || entry.plan.base !== sig.base;
      entry.plan.path = sig.path;
      entry.plan.base = sig.base;
      return moved;
    }
    // The held signals were consumed by the first plan, so a later plan starts empty.
    const first = entry.plan === null;
    entry.plan = {
      path: sig.path, base: sig.base, key,
      done: first ? entry.heldDone : new Set(), live: first ? entry.heldLive : null
    };
    entry.heldDone = new Set();
    entry.heldLive = null;
    return true;
  }
  const state = entry.plan ?? { done: entry.heldDone, live: entry.heldLive };
  const before = state.done.size;
  const liveBefore = state.live;
  if (sig.kind === 'done') {
    state.done.add(sig.id);
    if (state.live === sig.id) state.live = null;
  } else if (!state.done.has(sig.id)) {
    state.live = sig.id;
  }
  if (!entry.plan) entry.heldLive = state.live;
  return state.done.size !== before || state.live !== liveBefore;
}

function foldLine(entry: TaskFold, line: Buffer): void {
  // Most lines are neither a Task call nor an answer to one; skip them without decoding.
  let hit = CALL_MARKERS.some((m) => line.includes(m));
  if (!hit && entry.pending.size > 0) for (const id of entry.pending.keys()) if (line.includes(id)) { hit = true; break; }
  if (!hit) return;

  let rec: unknown;
  try { rec = JSON.parse(line.toString('utf8')); } catch { return; }
  foldTaskRecord(entry, rec);
}

/** A fresh fold: no tasks, no plan, nothing pending. */
export function newTaskFold(): TaskFold {
  return { offset: 0, size: 0, pending: new Map(), tasks: new Map(), created: false, plan: null, heldDone: new Set(), heldLive: null };
}

/**
 * Fold one parsed transcript record (the object half of `foldLine`, after `JSON.parse`). True when it changed the task list or the plan state: a call only
 * parks a pending entry, so it is the result that answers true. There is no byte prefilter here; the caller already holds the parsed record.
 */
export function foldTaskRecord(fold: TaskFold, rec: unknown): boolean {
  const content = isObject(rec) ? rec.message?.content : undefined;
  if (!isObject(rec) || !Array.isArray(content)) return false;

  // The substring hit is not trusted: the words also turn up in message text and a pending id in progress records, so only the exact block shape counts.
  let changed = false;
  const cwd = nonEmpty(rec.cwd);
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'tool_use' && (block.name === CREATE || block.name === UPDATE)) {
      if (typeof block.id === 'string') fold.pending.set(block.id, { name: block.name, input: isObject(block.input) ? block.input : {} });
    } else if (block.type === 'tool_use' && typeof block.name === 'string' && isObject(block.input)) {
      for (const sig of planSignals(block.name, block.input, cwd)) if (applySignal(fold, sig)) changed = true;
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = fold.pending.get(block.tool_use_id);
      if (!call) continue;
      fold.pending.delete(block.tool_use_id);
      if (apply(fold, call, rec.toolUseResult)) changed = true;
    }
  }
  return changed;
}

/** The subject of the task running now (the `in_progress` row of the session's list, plan rows included); null when none is. */
export function liveTaskSubject(fold: TaskFold, projectPath: string | null): string | null {
  return snapshot(fold, projectPath).tasks?.find((t) => t.status === 'in_progress')?.subject ?? null;
}

/** Fold `[entry.offset, size)`; `entry.offset` advances chunk by chunk, so a read error leaves it at the last fully folded line. */
function foldFrom(fd: number, entry: TaskFold, size: number): void {
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

/** The plan file is read here, not in the fold, so an amended plan shows on the next poll even when the transcript did not grow. */
function snapshot(entry: TaskFold, projectPath: string | null): TaskState {
  const { plan } = entry;
  if (plan) {
    const file = resolvePlanFile(plan.path, plan.base, projectPath);
    const rows = composePlanTasks((file && readPlanHeadings(file)) || [], plan.done, plan.live);
    if (rows.length > 0) return { tasks: rows, plan: path.basename(plan.path).replace(/\.md$/, '') };
  }
  return { tasks: entry.created ? [...entry.tasks.values()] : null, plan: null };
}

export interface TaskState {
  tasks: SessionTask[] | null;
  /** Basename (no `.md`) of the plan `tasks` came from; null when `tasks` is the `TaskCreate` list or absent. */
  plan: string | null;
}

/**
 * The session's task list; null when neither a plan with rows nor a confirmed `TaskCreate` exists (an all-deleted list is `[]`). A plan that yields rows
 * wins over the `TaskCreate` list, in plan order; otherwise the list is in creation order. `projectPath` is the launch dir, where a relative plan path is
 * looked for when the record's own cwd has drifted. Never throws: a missing file is null, any other I/O error returns what was remembered and retries
 * next call.
 */
export function readSessionTasks(filePath: string, projectPath: string | null): TaskState {
  const none: TaskState = { tasks: null, plan: null };
  let entry = cache.get(filePath);
  if (entry) { cache.delete(filePath); cache.set(filePath, entry); }

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return none; }
    return entry ? snapshot(entry, projectPath) : none;
  }

  if (entry && size < entry.size) { cache.delete(filePath); entry = undefined; }
  if (entry && size === entry.offset) return snapshot(entry, projectPath);

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return none; }
    return entry ? snapshot(entry, projectPath) : none;
  }

  if (!entry) {
    entry = newTaskFold();
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
  return snapshot(entry, projectPath);
}

/** Test seam: forget every file. */
export function resetTaskCache(): void {
  cache.clear();
  resetPlanCache();
  bytesRead = 0;
}

/** Test seam: entries held, and bytes read from disk since the last reset. */
export function taskCacheStats(): { entries: number; bytesRead: number } {
  return { entries: cache.size, bytesRead };
}
