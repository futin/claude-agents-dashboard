/**
 * trace-why.ts — infer which earlier steps led to a step (the chat-trace context's Decision 10).
 *
 * Eight rules, run in this order and deduplicated by id (the first rel wins): retry, verifies, commits, informed, plan, answer, then, only when none of those
 * fired, delegated (a subagent step) or asked (a main step). A rule reads `earlier` as it stands when the step lands, so a result that arrives later never
 * rewrites an earlier step's causes, and no rule looks forward.
 */

import path from 'node:path';

import type { TraceRel, TraceWhy } from '../../shared/types.js';
import type { StepRecord } from './trace.js';

/** A `git commit` command; also what `trace.ts` reads a commit's sha for. Lives here so `trace.ts` and this module share no import cycle. */
export const COMMIT_RE = /\bgit\s+commit\b/;

export const TEST_RE = /\b(test|tests|typecheck|tsc|vitest|jest|pytest|playwright|lint|eslint|mypy|ruff)\b|\bcargo\s+(test|check|clippy)\b|\bgo\s+(test|vet)\b/;

const QUOTED_RE = /'[^']*'|"[^"]*"/g;

/**
 * Whether a bash command runs a check (tests, types, lint). TEST_RE alone reads `foo.test.ts` in a sed, `git add test/x.ts` and "tests" in a commit message
 * as a check, so it runs over the command with quoted strings removed and path-like tokens (containing `/` or `.`) dropped. A commit is never a check.
 * `node --test a/b.test.ts`, `pnpm test:visual` and `npx tsc --noEmit` still count.
 */
export function isCheck(command: string): boolean {
  if (COMMIT_RE.test(command)) return false;
  const bare = command.replace(QUOTED_RE, ' ').split(/\s+/).filter((t) => !t.includes('/') && !t.includes('.')).join(' ');
  return TEST_RE.test(bare);
}

const VERIFIES_CAP = 8;
const COMMITS_CAP = 12;

/** `file` relative to `cwd`, or null when it is not under it (or either is missing). */
function relativeTo(file: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const rel = path.relative(cwd, file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

function retry(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.scope !== step.scope || e.kind === 'prompt') continue;
    return e.status === 'error' ? [e] : [];
  }
  return [];
}

/** Edits walking back from the newest, until a marker (the previous test or commit step) is reached, at most `cap`. */
function editsSince(earlier: readonly StepRecord[], inScope: (e: StepRecord) => boolean, isMarker: (e: StepRecord) => boolean, cap: number): StepRecord[] {
  const out: StepRecord[] = [];
  for (let i = earlier.length - 1; i >= 0 && out.length < cap; i--) {
    const e = earlier[i];
    if (!inScope(e)) continue;
    if (isMarker(e)) break;
    if (e.kind === 'edit') out.push(e);
  }
  return out;
}

function verifies(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  if (step.command === null || !isCheck(step.command)) return [];
  const isTest = (e: StepRecord): boolean => e.kind === 'bash' && e.command !== null && isCheck(e.command);
  return editsSince(earlier, (e) => e.scope === step.scope, isTest, VERIFIES_CAP);
}

function commits(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  if (step.command === null || !COMMIT_RE.test(step.command)) return [];
  const isCommit = (e: StepRecord): boolean => e.kind === 'bash' && e.command !== null && COMMIT_RE.test(e.command);
  return editsSince(earlier, () => true, isCommit, COMMITS_CAP);
}

function informed(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  const file = step.file;
  if (file === null) return [];
  const rel = relativeTo(file, step.cwd);
  const out: StepRecord[] = [];

  // (a) the nearest earlier read of the same file in this scope.
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.scope === step.scope && e.kind === 'read' && e.file === file) { out.push(e); break; }
  }

  // (b) the nearest earlier finished read or agent step whose result names the file: from this scope, or an agent step when this one is in main.
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.kind !== 'read' && e.kind !== 'agent') continue;
    if (e.scope !== step.scope && !(step.scope === 'main' && e.kind === 'agent')) continue;
    if (e.resultText === null) continue;
    if (e.resultText.includes(file) || (rel !== null && e.resultText.includes(rel))) {
      if (e !== out[0]) out.push(e);
      break;
    }
  }
  return out;
}

function plan(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  const file = step.file;
  if (file === null) return [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.scope !== 'main' || e.tool !== 'ExitPlanMode' || e.status !== 'ok') continue;
    const text = e.planText;
    if (text === null) return [];
    const rel = relativeTo(file, step.cwd);
    const base = path.basename(file);
    return (rel !== null && text.includes(rel)) || (base.includes('.') && text.includes(base)) ? [e] : [];
  }
  return [];
}

function answer(step: StepRecord, earlier: readonly StepRecord[]): StepRecord[] {
  if (step.scope !== 'main') return [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i];
    if (e.scope !== 'main') continue;
    // Main-scope turns only grow in fold order: nothing earlier can be in this turn.
    if (e.turn < step.turn) break;
    // EnterPlanMode resolves without a user verdict; the other two are the user's answer.
    if (e.turn === step.turn && e.status === 'ok' && (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')) return [e];
  }
  return [];
}

/**
 * The causes of `step`. `earlier` is every step folded before it, in fold order; `turnPrompt` is the prompt step of its turn (null before the first prompt).
 */
export function inferWhy(step: StepRecord, earlier: readonly StepRecord[], turnPrompt: StepRecord | null): TraceWhy[] {
  const out: TraceWhy[] = [];
  const seen = new Set<string>();
  const add = (rel: TraceRel, steps: StepRecord[]): void => {
    for (const s of steps) if (!seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, rel }); }
  };

  add('retry', retry(step, earlier));
  add('verifies', verifies(step, earlier));
  add('commits', commits(step, earlier));
  add('informed', informed(step, earlier));
  add('plan', plan(step, earlier));
  add('answer', answer(step, earlier));
  if (out.length > 0) return out;

  if (step.scope !== 'main') {
    // The Task step is recent: look from the end.
    for (let i = earlier.length - 1; i >= 0; i--) {
      if (earlier[i].id === step.scope) { add('delegated', [earlier[i]]); break; }
    }
  } else if (turnPrompt) {
    add('asked', [turnPrompt]);
  }
  return out;
}
