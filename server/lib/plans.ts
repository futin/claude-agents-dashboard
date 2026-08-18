/**
 * plans.ts — the pending-plan store behind remote plan verdicts.
 *
 * A session's `PermissionRequest[ExitPlanMode]` hook POSTs to `/api/plans/wait`,
 * which registers the proposed plan here and holds the HTTP response open. The
 * browser reads the entry, you send the plan back with feedback, and that
 * resolves the held response — the hook then denies the tool call with your
 * feedback as the message, which is what the model reads before revising.
 *
 * ⚠️ Reject-only, and that is upstream's decision, not a shortcut here. The CLI
 * drops a hook `allow` for any tool whose `requiresUserInteraction()` is true
 * ("the tool's approval card IS the user-interaction surface"), and
 * `ExitPlanMode` is such a tool. So a plan can be sent back from your phone but
 * never approved from it; approving stays on the card. Do not try to smuggle an
 * approval through `updatedInput` — that is the guard, not a gap in it.
 *
 * Everything is in memory: nothing here touches disk, so a restart drops every
 * wait and the hooks fall back to the plan card.
 *
 * Shape deliberately mirrors `pending.ts` (same state machine, same injected
 * `resolve`, same one-entry-per-session rule) — a plan and a question are the
 * same kind of wait with different payloads. They stay separate modules because
 * their payloads and verdicts share nothing.
 *
 * See `docs/subsystems/remote-plan.md`.
 */

import { randomUUID } from 'node:crypto';

import type { PendingPlan, PlanAnswerRequest, PlanWaitResult } from '../../shared/types.js';

/** A plan is markdown and can be long; cap it so a runaway tool input can't pin memory. */
export const PLAN_CAP = 20_000;
/** Cap on the feedback that reaches the model verbatim. */
export const FEEDBACK_CAP = 2_000;

/** How a submitted verdict was judged. Mirrors `pending.ts`'s outcome union. */
export type PlanOutcome = 'ok' | 'not-found' | 'mismatch' | 'malformed';

interface Entry {
  planId: string;
  sessionId: string;
  plan: string;
  askedAt: string;
  timer: NodeJS.Timeout;
  /** Completes the hook's held response. Called at most once. */
  resolve: (r: PlanWaitResult) => void;
}

const entries = new Map<string, Entry>();

/**
 * Pull the plan markdown out of an `ExitPlanMode` tool input. Tolerant like
 * `sanitizeQuestions`: anything unusable returns '', which tells the caller to
 * refuse the registration — and a refused registration means the hook falls
 * through to the plan card, which is always the safe direction.
 */
export function sanitizePlan(toolInput: unknown): string {
  const input = toolInput as { plan?: unknown } | null;
  if (!input || typeof input !== 'object' || typeof input.plan !== 'string') return '';
  return input.plan.trim().slice(0, PLAN_CAP);
}

/**
 * The prose the hook hands the model as the deny `message`. Two jobs: carry the
 * feedback, and say what to do next — a denied `ExitPlanMode` is otherwise just
 * a dead end, whereas the CLI's own rejection path explicitly tells the model to
 * revise and call it again.
 */
export function composeReason(feedback: string): string {
  const trimmed = feedback.trim();
  return 'The user reviewed this plan on the dashboard (not the plan card) and sent it back '
    + `for revision. Their feedback: ${trimmed}\n`
    + 'Revise the plan accordingly and call ExitPlanMode again. Stay in plan mode; '
    + 'do not start implementing.';
}

/** Finish an entry: fire `resolve` once, clear its timer, drop it from the map. */
function settle(entry: Entry, result: PlanWaitResult): void {
  clearTimeout(entry.timer);
  if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
  entry.resolve(result);
}

/**
 * Register a proposed plan and take ownership of the caller's held response.
 * Returns the `planId` the browser must echo when sending a verdict.
 *
 * An existing entry for the session is superseded — its waiter is released with
 * `superseded` and falls back to the plan card. That self-heals the revise loop:
 * a rejected plan comes straight back as a new `ExitPlanMode` call.
 */
export function register(
  sessionId: string,
  plan: string,
  timeoutMs: number,
  resolve: (r: PlanWaitResult) => void
): string {
  const prev = entries.get(sessionId);
  if (prev) settle(prev, { status: 'superseded' });

  const planId = randomUUID();
  const entry: Entry = {
    planId,
    sessionId,
    plan,
    askedAt: new Date().toISOString(),
    timer: setTimeout(() => settle(entry, { status: 'timeout' }), timeoutMs),
    resolve
  };
  entries.set(sessionId, entry);
  return planId;
}

/** The plan a session is waiting on, or null. */
export function getPendingPlan(sessionId: string): PendingPlan | null {
  const entry = entries.get(sessionId);
  if (!entry) return null;
  return { planId: entry.planId, askedAt: entry.askedAt, plan: entry.plan };
}

/**
 * Every session with a plan wait held right now. Read by the session scan so a
 * held plan shows on the row itself, before the `tool_use` record reaches disk.
 * A fresh Set: callers never get a handle on the store's keys.
 */
export function planSessionIds(): Set<string> {
  return new Set(entries.keys());
}

/**
 * Send a verdict on a session's pending plan. Synchronous by design, same as
 * `pending.answer`: two tabs racing means the first wins and the second sees
 * `not-found`, with no locking.
 */
export function answer(sessionId: string, body: unknown): PlanOutcome {
  const entry = entries.get(sessionId);
  if (!entry) return 'not-found';

  const req = body as PlanAnswerRequest | null;
  if (!req || typeof req !== 'object' || typeof req.planId !== 'string') return 'malformed';
  if (req.planId !== entry.planId) return 'mismatch';

  if (req.verdict === 'dismiss') {
    settle(entry, { status: 'dismissed' });
    return 'ok';
  }
  if (req.verdict !== 'reject') return 'malformed';

  // Feedback is the whole point of a remote reject: without it the model has
  // nothing to revise against, and a bare "no" is better said on the card.
  const feedback = typeof req.feedback === 'string' ? req.feedback.slice(0, FEEDBACK_CAP) : '';
  if (!feedback.trim()) return 'malformed';

  settle(entry, { status: 'rejected', reason: composeReason(feedback) });
  return 'ok';
}

/**
 * Drop a wait whose peer is gone (the hook's socket closed — session
 * interrupted, hook killed). No `resolve`: there is nobody left to answer to.
 * A stale `planId` is a no-op, so a late close can't evict a newer entry.
 */
export function cancel(sessionId: string, planId: string): void {
  const entry = entries.get(sessionId);
  if (!entry || entry.planId !== planId) return;
  clearTimeout(entry.timer);
  entries.delete(sessionId);
}

/**
 * Hand every waiting plan back to its card. Used when the remote-answer toggle
 * is switched off, alongside `pending.dismissAll()` — one switch, both stores.
 * Returns how many were released.
 */
export function dismissAll(): number {
  const waiting = [...entries.values()];
  for (const entry of waiting) settle(entry, { status: 'dismissed' });
  return waiting.length;
}

/**
 * Release every held plan whose session has moved on without us — i.e. the plan
 * was decided on the card in the terminal.
 *
 * ⚠️ This is not belt-and-braces for the `res.on('close')` cleanup, it is the
 * only signal for that case. The approval card renders *concurrently* with this
 * hook, and when the card wins the CLI does not kill the hook: it discards the
 * hook's output and moves on, leaving `curl` connected. So no socket closes, no
 * verdict arrives, and without this sweep the entry lives out its full deadline
 * — the dashboard keeps offering a send-back that the model will never see, and
 * a reject POSTed in that window settles into an orphaned response.
 *
 * `movedOn` is injected rather than read here: the store owns no disk access,
 * and the caller already parses the transcript every scan tick. It is handed
 * each entry's session id and `askedAt` in ms; the transcript growing past that
 * mark is the same "believed only until the transcript moves on" test that
 * `scan.ts` applies to a terminal permission dialog.
 *
 * Settles as `dismissed`, which is correct in both worlds: an orphaned hook
 * ignores it, and a hook still listening falls through to its card.
 */
export function sweepDecided(
  movedOn: (sessionId: string, askedAtMs: number) => boolean
): number {
  let released = 0;
  for (const entry of [...entries.values()]) {
    if (!movedOn(entry.sessionId, Date.parse(entry.askedAt))) continue;
    settle(entry, { status: 'dismissed' });
    released++;
  }
  return released;
}

/** Test seam: drop every entry without resolving. */
export function resetStore(): void {
  for (const entry of entries.values()) clearTimeout(entry.timer);
  entries.clear();
}
