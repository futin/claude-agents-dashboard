/**
 * plan-progress.ts — the pure half of plan progress: which plan a session is executing and which of its tasks are running or done, read from one
 * `tool_use` block, plus the plan file's task headings and the rows composed from both. `tasks.ts` folds the signals; nothing here touches a transcript.
 *
 * Signals come from a block's `input` only (D3): chat text, compaction summaries, skill bodies and tool results quote `Task 1: complete` freely, and
 * counting them would mark tasks done that never ran. For the same reason a Write/Edit is a ledger input on its `file_path` alone — a spec or test fixture
 * that quotes ledger lines in its `content` must not count — and an Edit's `old_string` is never read, since an Edit that turns `Task 3: dispatched` into
 * `Task 3: complete` must not re-mark 3 running.
 *
 * Design: docs/superpowers/specs/2026-10-07-plan-progress-design.md §2.1, §2.3, §2.4.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SessionTask } from '../../shared/types.js';

export type PlanSignal =
  | { kind: 'plan'; path: string; base: string | null }
  | { kind: 'done'; id: string }
  | { kind: 'live'; id: string };

export interface PlanHeading { id: string; title: string }

const MAX_PLAN_CACHE = 64;

const TASK_ID = String.raw`\d+[a-z]?`;
// The lookahead keeps `task-done p.md 5ab` and `task-done p.md 12x` from yielding a truncated id.
const SCRIPT_RE = new RegExp(String.raw`(?<![\w-])(task-brief|task-start|task-done)["']?\s+(\S+)\s+(${TASK_ID})(?![0-9A-Za-z])`, 'g');
const REVIEW_PACKAGE_RE = /(?<![\w-])review-package["']?\s+(\S+)/g;
const LEDGER_HEADER_RE = /SDD ledger — plan:[ \t]+(\S+)/g;
// A `printf 'Task 1: complete\nTask 2: complete\n'` puts the literal two characters `\n` before the second entry, and that `n` is a word character, so the
// plain lookbehind would drop every entry after the first; `(?<=\\n)` lets exactly that escape through while `xTask` / `nTask` stay blocked.
const LEDGER_DONE_RE = new RegExp(String.raw`(?:(?<![\w-])|(?<=\\n))Task (${TASK_ID}): complete`, 'g');
const AGENT_TASK_RE = new RegExp(String.raw`(?<![\w-])Task (${TASK_ID})\b`, 'g');
const LEADING_CD_RE = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+?))\s*(?:&&|;)/;
const HEADING_RE = new RegExp(String.raw`^#{2,3} Task (${TASK_ID})(?: \([^)]*\))?\s*[:.—–-]\s*(.+?)\s*$`);
const EXECUTING_SKILLS = ['subagent-driven-development', 'executing-plans'];
// A plain `NAME=value` in a command: unquoted, or quoted, with no expansion of its own in the value (that one is left unresolved).
const ASSIGN_RE = /(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s;&|'"`$()]+)(?=$|[\s;&|)])/g;
const VAR_RE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Strip what a shell quoting or printf escape leaves glued to a plan path, until nothing more comes off. */
export function stripPlanToken(raw: string): string {
  // One printf writing the header and further lines glues them on with a literal `\n` and no whitespace (4 of 119 headers, 2026-10-07).
  const nl = raw.indexOf('\\n');
  let s = nl === -1 ? raw : raw.slice(0, nl);
  for (;;) {
    const before = s;
    if (/^["'`]/.test(s)) s = s.slice(1);
    if (/["'`]$/.test(s)) s = s.slice(0, -1);
    if (s.endsWith('\\n')) s = s.slice(0, -2);
    if (s === before) return s;
  }
}

/**
 * `$NAME` and `${NAME}` in `token`, from the last plain `NAME=value` assigned before `at` in `command`: a ledger written as `SP=/abs; … plan: $SP/p.md`
 * names a file that can be read. Any other variable is left as written.
 */
function expandVars(token: string, command: string, at: number): string {
  if (!token.includes('$')) return token;
  const vars = new Map<string, string>();
  for (const m of command.matchAll(ASSIGN_RE)) {
    if ((m.index ?? 0) >= at) break;
    vars.set(m[1], m[2].replace(/^(["'])([\s\S]*)\1$/, '$2'));
  }
  return token.replace(VAR_RE, (whole, braced: string | undefined, bare: string | undefined) => vars.get(braced ?? bare ?? '') ?? whole);
}

/** A plan path from a raw token, or null when it is not a markdown path — which also rejects `$PLAN` and the skill's `<plan file path>` template as plan names (a script call carrying one still yields its task id). */
function planPath(raw: string, expand: (token: string) => string = (token) => token): string | null {
  const s = expand(stripPlanToken(raw));
  return s.endsWith('.md') ? s : null;
}

function isLedgerInput(name: string, input: Record<string, unknown>): boolean {
  if (name === 'Bash') {
    const cmd = str(input.command);
    return cmd.includes('progress.md') && cmd.includes('sdd/');
  }
  if (name === 'Write' || name === 'Edit') {
    const fp = str(input.file_path);
    return fp.includes('/sdd/') && fp.endsWith('/progress.md');
  }
  return false;
}

/** Where a relative plan path in this Bash command resolves from: a leading `cd` wins because the record's cwd is the shell's cwd *before* the command. */
function bashBase(command: string, recordCwd: string | null): string | null {
  const m = LEADING_CD_RE.exec(command);
  if (!m) return recordCwd;
  const dir = m[1] ?? m[2] ?? m[3] ?? '';
  if (!dir || dir === '-' || /^[~$]/.test(dir)) return recordCwd;
  if (path.isAbsolute(dir)) return dir;
  return recordCwd ? path.resolve(recordCwd, dir) : null;
}

/** Every plan, running and done signal in one tool_use block, plans first and done last so a task started and finished in one command ends done. */
export function planSignals(name: string, input: Record<string, unknown>, recordCwd: string | null): PlanSignal[] {
  try {
    const plans: PlanSignal[] = [];
    const running: PlanSignal[] = [];
    const finished: PlanSignal[] = [];
    // A Bash command's own assignments resolve its variables; `at` is where the token sits in `command`.
    const command = name === 'Bash' ? str(input.command) : '';
    const addPlan = (raw: string, base: string | null, at = 0): void => {
      const p = planPath(raw, (token) => expandVars(token, command, at));
      if (p) plans.push({ kind: 'plan', path: p, base });
    };

    if (name === 'Bash') {
      const base = bashBase(command, recordCwd);
      if (isLedgerInput(name, input)) {
        for (const m of command.matchAll(LEDGER_HEADER_RE)) addPlan(m[1], base, m.index);
        for (const m of command.matchAll(LEDGER_DONE_RE)) finished.push({ kind: 'done', id: m[1] });
      }
      for (const m of command.matchAll(SCRIPT_RE)) {
        // A plan passed as a shell variable (`task-done "$P" 3`) names a file only when the same command assigned it; otherwise the task id, which is
        // still literal, counts without naming a plan.
        addPlan(m[2], base, m.index);
        (m[1] === 'task-done' ? finished : running).push({ kind: m[1] === 'task-done' ? 'done' : 'live', id: m[3] });
      }
      for (const m of command.matchAll(REVIEW_PACKAGE_RE)) addPlan(m[1], base, m.index);
    } else if (name === 'Write' || name === 'Edit') {
      if (isLedgerInput(name, input)) {
        const text = str(name === 'Write' ? input.content : input.new_string);
        for (const m of text.matchAll(LEDGER_HEADER_RE)) addPlan(m[1], recordCwd);
        for (const m of text.matchAll(LEDGER_DONE_RE)) finished.push({ kind: 'done', id: m[1] });
      }
    } else if (name === 'Skill') {
      const skill = str(input.skill);
      if (EXECUTING_SKILLS.some((s) => skill.endsWith(s))) {
        for (const token of str(input.args).split(/\s+/)) {
          const p = planPath(token);
          if (p) { plans.push({ kind: 'plan', path: p, base: recordCwd }); break; }
        }
      }
    } else if (name === 'Agent') {
      for (const m of str(input.description).matchAll(AGENT_TASK_RE)) running.push({ kind: 'live', id: m[1] });
    }
    return [...plans, ...running, ...finished];
  } catch {
    return [];
  }
}

/** Integer part ascending; a bare id before its suffixed ones; suffixes alphabetical (`2, 5, 5a, 5b, 10`). */
export function compareTaskIds(a: string, b: string): number {
  const ma = /^(\d+)([a-z]?)$/.exec(a);
  const mb = /^(\d+)([a-z]?)$/.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  const n = Number(ma[1]) - Number(mb[1]);
  if (n !== 0) return n;
  return ma[2] < mb[2] ? -1 : ma[2] > mb[2] ? 1 : 0;
}

/** Task headings in plan order, outside fenced blocks (plans quote example headings); a duplicate id keeps its first heading. */
export function parsePlanHeadings(text: string): PlanHeading[] {
  const out: PlanHeading[] = [];
  const seen = new Set<string>();
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trimStart().startsWith('```')) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = HEADING_RE.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title: m[2] });
  }
  return out;
}

interface PlanCacheEntry { mtimeMs: number; size: number; headings: PlanHeading[] }
const planCache = new Map<string, PlanCacheEntry>();

export function resetPlanCache(): void {
  planCache.clear();
}

/** Headings of the plan at `absPath`, or null when it is missing, not a regular file or unreadable. Re-parsed only when mtime or size changed. */
export function readPlanHeadings(absPath: string): PlanHeading[] | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) { planCache.delete(absPath); return null; }
    const hit = planCache.get(absPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      planCache.delete(absPath);
      planCache.set(absPath, hit);
      return hit.headings;
    }
    const headings = parsePlanHeadings(fs.readFileSync(absPath, 'utf8'));
    planCache.delete(absPath);
    planCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, headings });
    if (planCache.size > MAX_PLAN_CACHE) planCache.delete(planCache.keys().next().value!);
    return headings;
  } catch {
    planCache.delete(absPath);
    return null;
  }
}

/** The first existing candidate for a plan path: `base` first, then the session's launch dir (the cwd a record carries drifts). */
export function resolvePlanFile(p: string, base: string | null, projectPath: string | null): string | null {
  const candidates = path.isAbsolute(p)
    ? [p]
    : [base, projectPath].filter((d): d is string => !!d).map((d) => path.resolve(d, p));
  for (const c of new Set(candidates)) if (readPlanHeadings(c) !== null) return c;
  return null;
}

/** Plan headings in order, then ids seen in signals that the plan does not list (a missing or amended plan), in id order. */
export function composePlanTasks(headings: readonly PlanHeading[], done: ReadonlySet<string>, live: string | null): SessionTask[] {
  const known = new Set(headings.map((h) => h.id));
  const extra = [...new Set([...done, ...(live === null ? [] : [live])])].filter((id) => !known.has(id)).sort(compareTaskIds);
  const status = (id: string): SessionTask['status'] => (done.has(id) ? 'completed' : id === live ? 'in_progress' : 'pending');
  return [
    ...headings.map((h) => ({ id: h.id, subject: h.title, status: status(h.id), activeForm: null })),
    ...extra.map((id) => ({ id, subject: `Task ${id}`, status: status(id), activeForm: null })),
  ];
}
