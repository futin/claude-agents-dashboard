/**
 * trace.ts — fold a session's transcript records into Trace steps: every user prompt and every tool call, with what the model said it was doing, what came
 * back, and (Task 4) which earlier steps led to it.
 *
 * `TraceBuilder` holds no file state: it folds records already parsed, in the order given, and remembers per step the revision it last changed at so a
 * poll can ask only for what moved. Claude Code writes each assistant content block (text, thinking, tool_use) as its own record sharing `message.id`, and
 * a tool's result arrives later as a `user` record holding a `tool_result` block; a record holding several blocks folds the same way.
 *
 * Field rules and the contract are documented in `docs/subsystems/trace.md`.
 *
 * `readTrace` (end of file) is the file side: a small LRU of builders keyed by transcript path, each advanced over the complete new lines of the main
 * file and of every linked subagent file (Decisions 1-4 and 9).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SessionTrace, TraceKind, TraceStep, TraceWhy } from '../../shared/types.js';
import { DEFAULT_CAPS, parseChatRecord } from './chat.js';
import { COMMIT_RE, inferWhy } from './trace-why.js';
import { SUBAGENT_DIR } from './subagent-usage.js';
import { CHUNK_BYTES, foldTaskRecord, liveTaskSubject, newTaskFold, type TaskFold } from './tasks.js';
import { describeTool, LOCAL_PLUMBING } from './transcript.js';

/** Most steps a full trace response carries (the newest ones). */
export const TRACE_STEP_CAP = 500;

const PROMPT_CAP = 300;
const INTENT_CAP = 160;
const RESULT_CAP = 160;
/** An AskUserQuestion answer line; a cut one ends with `…` inside the cap. */
const ANSWER_CAP = 160;
const THINKING_CAP = 1200;
/** Result text kept server-side for the `informed` rule (read- and agent-kind steps only). */
const RESULT_TEXT_CAP = 16 * 1024;

const KINDS: Record<string, TraceKind> = {
  Task: 'agent', Agent: 'agent',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'bash', BashOutput: 'bash', KillShell: 'bash', KillBash: 'bash',
  AskUserQuestion: 'decide', ExitPlanMode: 'decide', EnterPlanMode: 'decide'
};

const SHA_RE = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;
const ANSWER_RE = /"([^"]*)"="([^"]*)"/g;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TOOL_ERROR_TAG_RE = /<\/?tool_use_error>/g;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const INTERRUPT_PREFIX = '[Request interrupted by user';
const TASK_NOTIFICATION_PREFIX = '<task-notification>';
/** A line worth showing as a result: one with a letter or digit, so an MCP JSON result does not read `[`. */
const WORDY_RE = /[\p{L}\p{N}]/u;

/**
 * A step as the builder keeps it: the public `TraceStep` plus what the `why` rules read. None of the extra fields reach a response (`toPublic`).
 */
export interface StepRecord extends TraceStep {
  /** `'main'`, or the id of the Task/Agent step whose subagent made this call. */
  scope: string;
  /** Absolute path from `input.file_path` / `notebook_path` / `path` (a relative one resolved against `cwd`); null when the call names none. */
  file: string | null;
  /** The record's shell cwd, else the newest one seen. */
  cwd: string | null;
  /** A bash-kind step's `input.command`. */
  command: string | null;
  /** ExitPlanMode's `input.plan`. */
  planText: string | null;
  /** The flattened result, capped at 16 KB; kept for read- and agent-kind steps only, null otherwise and while running. */
  resultText: string | null;
  /** Builder revision this step last changed at. */
  rev: number;
}

interface Think { text: string; signed: boolean }

/** What a scope's assistant said since its last tool_use, and what that use took (carried to later uses of the same message). */
interface ScopeState {
  msgId: unknown;
  text: string[];
  think: Think[];
  intent: string | null;
  thinking: { kind: 'text' | 'signature' | null; text: string | null };
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The first sentence (up to the first `. `, `.\n` or newline), capped. Null when nothing is left. */
function firstSentence(s: string): string | null {
  const t = s.trim();
  const cut = t.search(/\. |\.\n|\n/);
  const out = (cut === -1 ? t : t.slice(0, cut)).trim().slice(0, INTENT_CAP);
  return out || null;
}

/** `tool_result.content` as text: a string, or an array of text blocks (an image block reads `[image]`). */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!isObject(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

function summarize(thinks: Think[]): ScopeState['thinking'] {
  const texts = thinks.map((t) => t.text).filter((t) => t.trim() !== '');
  if (texts.length > 0) return { kind: 'text', text: texts.join('\n\n').slice(0, THINKING_CAP) };
  return { kind: thinks.some((t) => t.signed) ? 'signature' : null, text: null };
}

/**
 * A user record's text as a prompt step's detail, or null when it is CLI plumbing rather than the user's turn. A slash command or skill invocation is a
 * turn: its echo reads `/<name> <args>`. The CLI writes it as `<command-message>` then `<command-name>` then `<command-args>` (20 of 23 such records in
 * the 60 newest transcripts, 2026-10-16), so the name is looked for anywhere in the plumbing, not only as the prefix. Any other plumbing (a lone
 * `<command-message>` / `<command-args>`, `<local-command-*>`, `<bash-*>`), the interrupt marker and a background task's `<task-notification>` (the
 * CLI injects one when the task completes) are not turns.
 */
export function promptDetail(text: string): string | null {
  if (LOCAL_PLUMBING.test(text)) {
    const name = COMMAND_NAME_RE.exec(text)?.[1].trim().replace(/^\//, '');
    if (!name) return null;
    const args = COMMAND_ARGS_RE.exec(text)?.[1].trim();
    return args ? `/${name} ${args}` : `/${name}`;
  }
  if (text.trimStart().startsWith(TASK_NOTIFICATION_PREFIX)) return null;
  return text.startsWith(INTERRUPT_PREFIX) ? null : text;
}

function toPublic(s: StepRecord): TraceStep {
  const { scope: _s, file: _f, cwd: _c, command: _cmd, planText: _p, resultText: _r, rev: _rev, ...pub } = s;
  for (const k of ['answer', 'sha', 'agent', 'task', 'thinkingText'] as const) if (pub[k] === undefined) delete pub[k];
  return pub;
}

export class TraceBuilder {
  readonly epoch = randomBytes(8).toString('hex');
  rev = 0;

  /** Every step in fold order: what `why` reads as "earlier". */
  protected readonly order: StepRecord[] = [];
  protected readonly byId = new Map<string, StepRecord>();
  /** Each turn's prompt step. */
  protected readonly prompts = new Map<number, StepRecord>();
  protected turn = 0;

  private readonly projectPath: string | null;
  private readonly fold: TaskFold = newTaskFold();
  private liveTask: string | null = null;
  private lastAt = '';
  private lastCwd: string | null = null;
  private readonly scopes = new Map<string, ScopeState>();
  private recorded = 0;
  private readable = 0;
  /** The revision the ingest in progress stamps; `changed` says whether it touched anything. */
  private next = 0;
  private changed = false;

  constructor(projectPath: string | null) {
    this.projectPath = projectPath;
  }

  /** Fold records already parsed, in the order given. `scope` is `'main'` or the Task step id whose subagent wrote the record. */
  ingest(records: { rec: any; scope: string }[]): void {
    this.next = this.rev + 1;
    this.changed = false;
    for (const { rec, scope } of records) this.record(rec, scope);
    if (this.changed) this.rev = this.next;
  }

  /** Steps in `at` order (stable over fold order). */
  steps(): TraceStep[] {
    return this.sorted().map(toPublic);
  }

  changedSince(rev: number): TraceStep[] {
    return this.sorted().filter((s) => s.rev > rev).map(toPublic);
  }

  /** Thinking blocks ingested: each block counted once, `readable` when it carried text. */
  thinking(): { recorded: number; readable: number } {
    return { recorded: this.recorded, readable: this.readable };
  }

  /** The single call site for a step's causes: every step folded so far, as the rules read them. */
  protected why(draft: StepRecord): TraceWhy[] {
    return inferWhy(draft, this.order, this.prompts.get(draft.turn) ?? null);
  }

  private sorted(): StepRecord[] {
    // Array.prototype.sort is stable, so equal `at` keeps fold order.
    return [...this.order].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  private touch(s: StepRecord): void {
    s.rev = this.next;
    this.changed = true;
  }

  private scopeState(scope: string, msgId: unknown): ScopeState {
    let st = this.scopes.get(scope);
    if (!st || st.msgId !== msgId) {
      st = { msgId, text: [], think: [], intent: null, thinking: { kind: null, text: null } };
      this.scopes.set(scope, st);
    }
    return st;
  }

  private record(rec: unknown, scope: string): void {
    if (!isObject(rec)) return;
    const main = scope === 'main';
    // Subagent traffic in the main file is a copy of what the subagent files hold.
    if (main && rec.isSidechain === true) return;
    const cwd = nonEmpty(rec.cwd);
    if (cwd) this.lastCwd = cwd;

    // The live task list is the main file's, the same list the session's Tasks card reads. A call only parks; its result is what moves the list.
    if (main && foldTaskRecord(this.fold, rec)) {
      this.liveTask = liveTaskSubject(this.fold, this.projectPath ?? this.lastCwd) || null;
    }

    const m = rec.message;
    if (!isObject(m)) return;
    const at = nonEmpty(rec.timestamp);

    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (isObject(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') this.resolve(b);
      }
      // Subagent user text is the dispatch prompt, not a turn; a compaction summary is the CLI's, not the user's.
      if (main && rec.isCompactSummary !== true) {
        const msg = parseChatRecord(rec, DEFAULT_CAPS);
        const detail = msg && msg.role === 'user' && msg.text ? promptDetail(msg.text) : null;
        if (detail) this.prompt(rec, detail, at);
      }
      return;
    }

    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!isObject(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        this.scopeState(scope, m.id).text.push(b.text);
      } else if (b.type === 'thinking') {
        const t = typeof b.thinking === 'string' ? b.thinking : '';
        this.recorded++;
        if (t.trim() !== '') this.readable++;
        this.changed = true;
        this.scopeState(scope, m.id).think.push({ text: t, signed: nonEmpty(b.signature) !== null });
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        this.toolUse(b, scope, m.id, at, cwd ?? this.lastCwd);
      }
    }
  }

  private stamp(at: string | null): string {
    if (at !== null) this.lastAt = at;
    return this.lastAt;
  }

  private prompt(rec: Record<string, any>, text: string, at: string | null): void {
    const id = nonEmpty(rec.uuid) ?? `prompt:${this.order.length}`;
    if (this.byId.has(id)) return;
    this.turn++;
    const s: StepRecord = {
      id, turn: this.turn, kind: 'prompt', tool: 'Prompt', detail: text.slice(0, PROMPT_CAP),
      intent: null, intentFrom: null, at: this.stamp(at), status: null, result: null, why: [], thinking: null,
      scope: 'main', file: null, cwd: nonEmpty(rec.cwd) ?? this.lastCwd, command: null, planText: null, resultText: null, rev: 0
    };
    this.prompts.set(this.turn, s);
    this.add(s);
  }

  private toolUse(b: Record<string, any>, scope: string, msgId: unknown, at: string | null, cwd: string | null): void {
    if (this.byId.has(b.id)) return;
    const name: string = b.name;
    const input = isObject(b.input) ? b.input : {};
    const kind = KINDS[name] ?? 'read';

    // Text and thinking since the previous tool_use go to this one, and carry to later uses of the same message.
    const st = this.scopeState(scope, msgId);
    if (st.text.length > 0) { st.intent = firstSentence(st.text.join('\n')); st.text = []; }
    if (st.think.length > 0) { st.thinking = summarize(st.think); st.think = []; }

    const description = nonEmpty(input.description);
    const descIntent = description === null ? null : firstSentence(description);
    const intent = descIntent ?? st.intent;
    const subagentType = kind === 'agent' ? nonEmpty(input.subagent_type) : null;
    const rawFile = nonEmpty(input.file_path) ?? nonEmpty(input.notebook_path) ?? nonEmpty(input.path);
    const file = rawFile === null ? null : path.isAbsolute(rawFile) ? rawFile : cwd ? path.resolve(cwd, rawFile) : null;
    const parent = scope === 'main' ? undefined : this.byId.get(scope);

    const s: StepRecord = {
      id: b.id,
      turn: parent ? parent.turn : this.turn,
      kind,
      tool: subagentType ? `${name} · ${subagentType}` : name,
      detail: kind === 'agent' && description !== null ? description : describeTool(b),
      intent,
      intentFrom: descIntent !== null ? 'description' : intent !== null ? 'text' : null,
      at: this.stamp(at),
      status: 'running',
      result: null,
      why: [],
      thinking: st.thinking.kind,
      scope, file, cwd,
      command: kind === 'bash' ? nonEmpty(input.command) : null,
      planText: name === 'ExitPlanMode' ? nonEmpty(input.plan) : null,
      resultText: null,
      rev: 0
    };
    if (st.thinking.text !== null) s.thinkingText = st.thinking.text;
    if (scope !== 'main') s.agent = scope;
    if (this.liveTask) s.task = this.liveTask;
    s.why = this.why(s);
    this.add(s);
  }

  private add(s: StepRecord): void {
    this.order.push(s);
    this.byId.set(s.id, s);
    this.touch(s);
  }

  private resolve(b: Record<string, any>): void {
    const s = this.byId.get(b.tool_use_id);
    if (!s || s.status !== 'running') return;
    const text = flatten(b.content).replace(SYSTEM_REMINDER_RE, '');
    s.status = b.is_error === true ? 'error' : 'ok';

    if (s.tool === 'Read' && s.status === 'ok') {
      s.result = `${text.split('\n').filter((l) => l.trim() !== '').length} lines`;
    } else {
      const line = text.replace(TOOL_ERROR_TAG_RE, '').split('\n').map((l) => l.trim()).find((l) => WORDY_RE.test(l));
      s.result = (line ?? '').slice(0, RESULT_CAP);
    }
    if (s.kind === 'read' || s.kind === 'agent') s.resultText = text.slice(0, RESULT_TEXT_CAP);

    if (s.tool === 'AskUserQuestion') {
      const answers = [...text.matchAll(ANSWER_RE)].map((a) => a[2]);
      const joined = answers.join(' · ');
      if (answers.length > 0) s.answer = joined.length > ANSWER_CAP ? joined.slice(0, ANSWER_CAP - 1) + '…' : joined;
    } else if (s.tool === 'ExitPlanMode') {
      s.answer = s.status === 'ok' ? 'approved' : 'rejected';
    } else if (s.command !== null && COMMIT_RE.test(s.command)) {
      const sha = SHA_RE.exec(text);
      if (sha) s.sha = sha[1].slice(0, 7);
    }
    this.touch(s);
  }
}

/* ------------------------------------------------------------------------------------------------------------------------- files and the cache */

/** Builders kept warm, by transcript path (Decision 2). */
const TRACE_CACHE_SIZE = 8;

interface TraceEntry {
  builder: TraceBuilder;
  /** Byte offset into the main file, always just past a newline. */
  offset: number;
  /** Linked subagent files by path: the scope their records fold under and the byte offset read to. */
  subs: Map<string, { scope: string; offset: number }>;
}

const cache = new Map<string, TraceEntry>();

/** For tests: forget every builder. */
export function resetTraceCache(): void {
  cache.clear();
}

/** A parsed record, the scope it folds under, and the timestamp it sorts by. */
interface Parsed { rec: any; scope: string; key: string }

/**
 * Parse the complete lines of the open file `fd` from `offset` to `size` into `out`, and return the offset just past the last newline: a trailing partial
 * line is left for the next pass, the same rule `chat.ts` and `tasks.ts` follow. An unparsable line is skipped. A record without a timestamp sorts with
 * the record before it in the same file (`''` at the head), so it keeps file order.
 */
function readLines(fd: number, offset: number, size: number, scope: string, out: Parsed[]): number {
  let pos = offset;
  let done = offset;
  let carry: Buffer | null = null;
  let key = '';
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos));
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    pos += n;
    const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      const line = buf.toString('utf8', start, nl);
      start = nl + 1;
      if (line.trim() === '') continue;
      let rec: unknown;
      try { rec = JSON.parse(line); } catch { continue; }
      if (isObject(rec) && typeof rec.timestamp === 'string' && rec.timestamp !== '') key = rec.timestamp;
      out.push({ rec, scope, key });
    }
    done += start;
    carry = start < buf.length ? buf.subarray(start) : null;
  }
  return done;
}

/** Read one file's complete new lines; the new offset, or `'shrank'` when the file is now shorter than what was read. Throws when unreadable. */
function readFrom(file: string, offset: number, scope: string, out: Parsed[]): number | 'shrank' {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size < offset) return 'shrank';
    return readLines(fd, offset, size, scope, out);
  } finally {
    fs.closeSync(fd);
  }
}

/** Link every subagent file whose meta sidecar names its dispatching tool_use (Decision 4). A file without one stays unlinked and is looked at again next pass. */
function linkSubagents(file: string, entry: TraceEntry): void {
  const dir = path.join(file.replace(/\.jsonl$/, ''), SUBAGENT_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const sub = path.join(dir, name);
    if (entry.subs.has(sub)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${m[1]}.meta.json`), 'utf8'));
      if (isObject(meta) && nonEmpty(meta.toolUseId)) entry.subs.set(sub, { scope: meta.toolUseId, offset: 0 });
    } catch { /* no sidecar yet */ }
  }
}

/**
 * One pass: the complete new lines of the main file and of every linked subagent file, stable-sorted by timestamp, folded in one `ingest` (Decision 3).
 * Null when the main file is unreadable. A main or subagent file that shrank was rewritten: the entry is replaced and read from the start (new epoch).
 */
function advance(file: string, projectPath: string | null, fresh: boolean): TraceEntry | null {
  let entry = fresh ? undefined : cache.get(file);
  if (!entry) entry = { builder: new TraceBuilder(projectPath), offset: 0, subs: new Map() };

  const parsed: Parsed[] = [];
  let mainOffset: number | 'shrank';
  try { mainOffset = readFrom(file, entry.offset, 'main', parsed); } catch { cache.delete(file); return null; }
  if (mainOffset === 'shrank') return fresh ? null : advance(file, projectPath, true);

  linkSubagents(file, entry);
  const subOffsets = new Map<string, number>();
  for (const [sub, link] of entry.subs) {
    let n: number | 'shrank';
    try { n = readFrom(sub, link.offset, link.scope, parsed); } catch { continue; }
    if (n === 'shrank') return fresh ? null : advance(file, projectPath, true);
    subOffsets.set(sub, n);
  }

  // Array.prototype.sort is stable: equal keys keep read order (main first, then each subagent file in turn).
  parsed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // A throw mid-fold leaves the builder partly advanced: drop it so the next poll rebuilds from the start (new epoch).
  try { entry.builder.ingest(parsed.map(({ rec, scope }) => ({ rec, scope }))); } catch (e) { cache.delete(file); throw e; }
  entry.offset = mainOffset;
  for (const [sub, n] of subOffsets) entry.subs.get(sub)!.offset = n;

  cache.delete(file);
  cache.set(file, entry);
  while (cache.size > TRACE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return entry;
}

/**
 * The session's trace, advanced over whatever was appended since the last call. No `after`: the newest `TRACE_STEP_CAP` steps, the prompt of each
 * turn among them that fell outside, and `dropped` (the older steps left out). A matching `after`: the steps changed since `after.rev`. Another epoch,
 * or `after.rev` past the builder's revision: the full answer with `reset` (Decision 1). Null when the main file is unreadable.
 */
export function readTrace(file: string, projectPath: string | null, after?: { rev: number; epoch: string }): Omit<SessionTrace, 'id'> | null {
  const entry = advance(file, projectPath, false);
  if (!entry) return null;
  const b = entry.builder;
  const head = { cursor: b.rev, epoch: b.epoch, thinking: b.thinking() };
  if (after && after.epoch === b.epoch && after.rev <= b.rev) return { ...head, steps: b.changedSince(after.rev), dropped: 0 };
  const all = b.steps();
  // Past the cap, a delivered turn whose prompt fell outside still gets that prompt, so its steps keep their `asked` cause and the turn its label.
  const cut = Math.max(0, all.length - TRACE_STEP_CAP);
  const turns = new Set(all.slice(cut).map((s) => s.turn));
  const steps = cut === 0 ? all : all.filter((s, i) => i >= cut || (s.kind === 'prompt' && turns.has(s.turn)));
  return { ...head, steps, dropped: all.length - steps.length, ...(after ? { reset: true } : {}) };
}
