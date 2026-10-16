/**
 * trace.ts — fold a session's transcript records into Trace steps: every user prompt and every tool call, with what the model said it was doing, what came
 * back, and (Task 4) which earlier steps led to it.
 *
 * `TraceBuilder` holds no file state: it folds records already parsed, in the order given, and remembers per step the revision it last changed at so a
 * poll can ask only for what moved. Claude Code writes each assistant content block (text, thinking, tool_use) as its own record sharing `message.id`, and
 * a tool's result arrives later as a `user` record holding a `tool_result` block; a record holding several blocks folds the same way.
 *
 * Field rules are the chat-trace context's Decisions 5, 6, 7 and 11-15 (`.superpowers/sdd/2026-10-16-chat-trace/context.md`).
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { TraceKind, TraceStep, TraceWhy } from '../../shared/types.js';
import { DEFAULT_CAPS, parseChatRecord } from './chat.js';
import { foldTaskRecord, liveTaskSubject, newTaskFold, type TaskFold } from './tasks.js';
import { describeTool } from './transcript.js';

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

export const COMMIT_RE = /\bgit\s+commit\b/;
const SHA_RE = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;
const ANSWER_RE = /"([^"]*)"="([^"]*)"/g;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TOOL_ERROR_TAG_RE = /<\/?tool_use_error>/g;

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

  /** The single call site for a step's causes. Task 4 fills this in; until then a step has none. */
  protected why(_draft: StepRecord): TraceWhy[] {
    return [];
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
      // Subagent user text is the dispatch prompt, not a turn.
      if (main) {
        const msg = parseChatRecord(rec, DEFAULT_CAPS);
        if (msg && msg.role === 'user' && msg.text) this.prompt(rec, msg.text, at);
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
      const line = text.replace(TOOL_ERROR_TAG_RE, '').split('\n').map((l) => l.trim()).find((l) => l !== '');
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
