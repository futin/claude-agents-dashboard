/**
 * pending.ts — the pending-question store behind remote answers.
 *
 * A session's `AskUserQuestion` PreToolUse hook POSTs to `/api/questions/wait`,
 * which registers the question here and holds the HTTP response open. The
 * browser reads the entry, the user picks, and the answer resolves the held
 * response — the hook then denies the tool call with a reason naming the choice,
 * which is the only supported way to get an answer into a live session.
 *
 * Everything is in memory: nothing here ever touches disk, so a restart just
 * drops every wait (the hooks fall back to the terminal dialog).
 *
 * Design notes:
 *  - No HTTP types. The handler injects `resolve`, which is what makes the whole
 *    state machine unit-testable (see test/pending.test.ts).
 *  - One entry per session — the CLI only ever has one question open at a time.
 *    A second `register` supersedes the first rather than erroring, which
 *    self-heals a re-asked question after a deny.
 *  - Every terminal transition deletes the entry and fires `resolve` at most
 *    once. The expiry timer is the guaranteed reaper: an answer arriving after
 *    it finds nothing and 404s, which is the stale-answer guard.
 *
 * See `.claude/rules/remote-answer.md`.
 */

import { randomUUID } from 'node:crypto';

import type {
  AnswerRequest, PendingOption, PendingQuestion, PendingQuestionItem,
  QuestionAnswer, WaitResult
} from '../../shared/types.js';

/** The CLI shows at most 4 questions per call, each with at most 4 options. */
export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
/** Length caps — a hostile/runaway tool input must not pin memory. */
export const QUESTION_CAP = 2000;
export const LABEL_CAP = 200;
export const DESCRIPTION_CAP = 500;
/** Cap on one free-text ("Other") answer. */
export const SELECTED_CAP = 500;

/** Wait window bounds. Default 10min: long enough to reach a phone. */
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 1_800_000;

/** How a submitted answer was judged. */
export type AnswerOutcome = 'ok' | 'not-found' | 'mismatch' | 'malformed';

interface Entry {
  questionId: string;
  sessionId: string;
  questions: PendingQuestionItem[];
  askedAt: string;
  timer: NodeJS.Timeout;
  /** Completes the hook's held response. Called at most once. */
  resolve: (r: WaitResult) => void;
}

const entries = new Map<string, Entry>();

function str(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

/** Clamp a hook-supplied wait window into the supported range. */
export function clampTimeout(ms: unknown): number {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/**
 * Coerce an `AskUserQuestion` tool input into panel-ready questions. Tolerant in
 * the same spirit as `parseChatRecord`: anything malformed is dropped rather than
 * thrown, and an empty result tells the caller to reject the registration — which
 * makes the hook fall back to the terminal dialog.
 */
export function sanitizeQuestions(toolInput: unknown): PendingQuestionItem[] {
  const input = toolInput as { questions?: unknown } | null;
  if (!input || typeof input !== 'object' || !Array.isArray(input.questions)) return [];

  const out: PendingQuestionItem[] = [];
  for (const raw of input.questions) {
    if (out.length >= MAX_QUESTIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = str(q.question, QUESTION_CAP);
    if (!question) continue;

    const options: PendingOption[] = [];
    if (Array.isArray(q.options)) {
      for (const rawOpt of q.options) {
        if (options.length >= MAX_OPTIONS) break;
        if (!rawOpt || typeof rawOpt !== 'object') continue;
        const o = rawOpt as Record<string, unknown>;
        const label = str(o.label, LABEL_CAP);
        if (!label) continue;
        const description = str(o.description, DESCRIPTION_CAP);
        options.push(description ? { label, description } : { label });
      }
    }

    out.push({ header: str(q.header, LABEL_CAP), question, multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/**
 * Validate a submitted answer against the questions it claims to answer. Every
 * question must be answered exactly once, and a single-select question takes
 * exactly one value.
 *
 * Values are deliberately NOT checked against the option labels: the terminal
 * dialog always offers a free-text "Other", and the panel mirrors that.
 */
export function validateAnswer(questions: PendingQuestionItem[], answers: unknown): AnswerOutcome {
  if (!Array.isArray(answers) || answers.length !== questions.length) return 'malformed';

  const seen = new Set<number>();
  for (const raw of answers) {
    if (!raw || typeof raw !== 'object') return 'malformed';
    const a = raw as Record<string, unknown>;
    const index = a.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= questions.length) return 'malformed';
    if (seen.has(index as number)) return 'malformed';
    seen.add(index as number);

    const selected = a.selected;
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > MAX_OPTIONS) return 'malformed';
    if (!selected.every(s => typeof s === 'string' && s.trim() !== '' && s.length <= SELECTED_CAP)) return 'malformed';
    if (!questions[index as number].multiSelect && selected.length !== 1) return 'malformed';
  }
  return 'ok';
}

/**
 * The prose the hook hands the model as `permissionDecisionReason`. It has to do
 * two jobs: state the choice, and stop the model from re-asking (a denied
 * AskUserQuestion is otherwise an invitation to try again).
 */
export function composeReason(questions: PendingQuestionItem[], answers: QuestionAnswer[]): string {
  const byIndex = new Map(answers.map(a => [a.index, a.selected]));
  const lines = questions.map((q, i) => {
    const label = q.header || q.question;
    return `${label}: ${(byIndex.get(i) ?? []).join(', ')}`;
  });
  if (lines.length === 1) {
    return `The user answered via the dashboard (not the terminal dialog) — ${lines[0]}. `
      + 'Treat this as the user\'s selection and continue; do not ask again.';
  }
  return 'The user answered via the dashboard (not the terminal dialog). Their selections:\n'
    + lines.map(l => `- ${l}`).join('\n')
    + '\nTreat these as the user\'s answers and continue; do not ask again.';
}

/** Finish an entry: fire `resolve` once, clear its timer, drop it from the map. */
function settle(entry: Entry, result: WaitResult): void {
  clearTimeout(entry.timer);
  if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  entry.resolve(result);
}

/**
 * Register a question and take ownership of the caller's held response.
 * Returns the `questionId` the browser must echo when answering.
 *
 * `timeoutMs` is taken as given — the handler clamps hook-supplied values with
 * {@link clampTimeout} before calling, which keeps the store usable with the
 * millisecond timeouts the tests need.
 *
 * An existing entry for the session is superseded — its waiter is released with
 * `superseded` and falls back to the terminal dialog.
 */
export function register(
  sessionId: string,
  questions: PendingQuestionItem[],
  timeoutMs: number,
  resolve: (r: WaitResult) => void
): string {
  const prev = entries.get(sessionId);
  if (prev) settle(prev, { status: 'superseded' });

  const questionId = randomUUID();
  const entry: Entry = {
    questionId,
    sessionId,
    questions,
    askedAt: new Date().toISOString(),
    timer: setTimeout(
      () => settle(entry, { status: 'timeout' }),
      Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
    ),
    resolve
  };
  entries.set(sessionId, entry);
  return questionId;
}

/** The question a session is waiting on, or null. */
export function getPending(sessionId: string): PendingQuestion | null {
  const entry = entries.get(sessionId);
  if (!entry) return null;
  return { questionId: entry.questionId, askedAt: entry.askedAt, questions: entry.questions };
}

/**
 * Every session with a wait held right now. Read by the session scan so a held
 * question shows on the row itself — the transcript can't tell us (the hook
 * registers during PreToolUse, before the tool_use record is written).
 * A fresh Set: callers never get a handle on the store's keys.
 */
export function pendingSessionIds(): Set<string> {
  return new Set(entries.keys());
}

/**
 * Answer (or dismiss) a session's pending question. Synchronous by design:
 * Node is single-threaded, so two tabs submitting at once means the first wins
 * outright and the second sees `not-found`, with no locking.
 */
export function answer(sessionId: string, body: unknown): AnswerOutcome {
  const entry = entries.get(sessionId);
  if (!entry) return 'not-found';

  const req = body as AnswerRequest | null;
  if (!req || typeof req !== 'object' || typeof req.questionId !== 'string') return 'malformed';
  if (req.questionId !== entry.questionId) return 'mismatch';

  if (req.dismiss === true) {
    settle(entry, { status: 'dismissed' });
    return 'ok';
  }

  const verdict = validateAnswer(entry.questions, req.answers);
  if (verdict !== 'ok') return verdict;

  const answers = (req.answers as QuestionAnswer[]).map(a => ({ index: a.index, selected: a.selected }));
  settle(entry, { status: 'answered', reason: composeReason(entry.questions, answers), answers });
  return 'ok';
}

/**
 * Drop a wait whose peer is gone (the hook's socket closed — session
 * interrupted, hook killed). No `resolve`: there is nobody left to answer to.
 * A stale `questionId` is a no-op, so a late close can't evict a newer entry.
 */
export function cancel(sessionId: string, questionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry || entry.questionId !== questionId) return;
  clearTimeout(entry.timer);
  entries.delete(sessionId);
}

/**
 * Hand every waiting question back to its terminal dialog. Used when the toggle
 * is switched off: "stop accepting remote answers" should release the waits it
 * already owns, not leave them parked until their deadlines.
 * Returns how many were released.
 */
export function dismissAll(): number {
  const waiting = [...entries.values()];
  for (const entry of waiting) settle(entry, { status: 'dismissed' });
  return waiting.length;
}

/** Test seam: drop every entry without resolving. */
export function resetStore(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear();
}
