/**
 * pr-status.ts — a pull request's live state for the chat modal's PR card, read by launching `gh pr view`.
 *
 * `gh` does the network call and the auth; this module only launches it (no shell, 10s timeout, update notifier and prompts off) and folds its JSON. Only a
 * URL matching `GH_PR_RE` ever reaches argv, so a transcript cannot smuggle a flag in. Results are cached per URL: a busy PR (checks running, merge state not
 * yet computed) or a failure for 20s, a settled open one for 60s, a merged or closed one for good. Concurrent callers share the launch in flight.
 *
 * Design: docs/superpowers/specs/2026-10-24-chat-pr-card-design.md §Live status.
 */

import fs from 'node:fs';
import os from 'node:os';

import type { PrChecks, SessionPrLive } from '../../shared/types.js';
import { makeFetchRunner } from './git-fetch.js';
import type { FetchRunner } from './git-fetch.js';

/** A github.com PR URL and nothing else; group 1 is `owner/repo`, group 2 the number. */
export const GH_PR_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

const JSON_FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable,mergedAt,closedAt';
const GH_ENV: Record<string, string> = { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };
const TIMEOUT_MS = 10_000;
const BUSY_MS = 20_000;
const SETTLED_MS = 60_000;
const FAILURE_MS = 20_000;

type Status = { live: SessionPrLive | null; unavailable: string | null };
type RunFailure = { code: number; stderr: string; timedOut: boolean };

const realRunner = (): FetchRunner => makeFetchRunner({ bin: 'gh', timeoutMs: TIMEOUT_MS });
let runner: FetchRunner = realRunner();
let now: () => number = Date.now;

const cache = new Map<string, { value: Status; until: number }>();
const inFlight = new Map<string, Promise<Status>>();

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function foldChecks(rollup: unknown): PrChecks | null {
  if (!Array.isArray(rollup)) return null;
  const c: PrChecks = { passed: 0, failed: 0, running: 0, total: 0 };
  for (const item of rollup) {
    if (!isObject(item)) continue;
    if (item.__typename === 'CheckRun') {
      if (item.status !== 'COMPLETED') c.running++;
      else if (item.conclusion === 'SUCCESS') c.passed++;
      else if (item.conclusion !== 'NEUTRAL' && item.conclusion !== 'SKIPPED') c.failed++;
    } else if (item.__typename === 'StatusContext') {
      if (item.state === 'SUCCESS') c.passed++;
      else if (item.state === 'PENDING' || item.state === 'EXPECTED') c.running++;
      else c.failed++;
    }
  }
  c.total = c.passed + c.failed + c.running;
  return c.total === 0 ? null : c;
}

/** `gh pr view --json` → the card's live state; null when `state`, `headRefName` or `baseRefName` is not a string. */
export function foldPrView(json: unknown): SessionPrLive | null {
  if (!isObject(json)) return null;
  const rawState = str(json.state);
  const head = str(json.headRefName);
  const base = str(json.baseRefName);
  if (rawState === null || head === null || base === null) return null;

  const state: SessionPrLive['state'] =
    rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : json.isDraft === true ? 'draft' : 'open';
  const review: SessionPrLive['review'] =
    json.reviewDecision === 'APPROVED' ? 'approved'
      : json.reviewDecision === 'CHANGES_REQUESTED' ? 'changes'
        : json.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'none';
  const merge: SessionPrLive['merge'] = json.mergeable === 'MERGEABLE' ? 'clean' : json.mergeable === 'CONFLICTING' ? 'conflicts' : 'unknown';
  const endedAt = state === 'merged' ? (str(json.mergedAt) ?? str(json.closedAt)) : state === 'closed' ? str(json.closedAt) : null;

  return { state, title: str(json.title) ?? '', head, base, checks: foldChecks(json.statusCheckRollup), review, merge, endedAt };
}

/** The card's reason for a launch that rejected (an Error) or exited badly (a run result). */
export function classifyGhFailure(failure: Error | RunFailure): string {
  if (failure instanceof Error) return (failure as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh not installed' : 'gh failed';
  if (failure.timedOut) return 'timed out';
  if (failure.code !== 0 && /auth login|not logged in|authenticat/i.test(failure.stderr)) return 'gh not signed in';
  return 'gh failed';
}

function workDir(cwd: string | null): string {
  if (cwd) {
    try { if (fs.statSync(cwd).isDirectory()) return cwd; } catch { /* fall through to home */ }
  }
  return os.homedir();
}

async function launch(url: string, cwd: string | null): Promise<Status> {
  let res: Awaited<ReturnType<FetchRunner>>;
  try {
    res = await runner(workDir(cwd), ['pr', 'view', url, '--json', JSON_FIELDS], GH_ENV);
  } catch (e) {
    return { live: null, unavailable: classifyGhFailure(e instanceof Error ? e : new Error(String(e))) };
  }
  if (res.timedOut || res.code !== 0) return { live: null, unavailable: classifyGhFailure(res) };
  let live: SessionPrLive | null = null;
  try { live = foldPrView(JSON.parse(res.stdout)); } catch { /* unparsable: gh failed */ }
  return live ? { live, unavailable: null } : { live: null, unavailable: 'gh failed' };
}

function windowFor(s: Status): number {
  if (!s.live) return FAILURE_MS;
  if (s.live.state === 'merged' || s.live.state === 'closed') return Infinity;
  return (s.live.checks?.running ?? 0) > 0 || s.live.merge === 'unknown' ? BUSY_MS : SETTLED_MS;
}

/** The PR's live state, or the reason there is none. Never rejects. */
export function readPrStatus(url: string, cwd: string | null): Promise<Status> {
  if (!GH_PR_RE.test(url)) return Promise.resolve({ live: null, unavailable: 'not a GitHub PR' });
  const hit = cache.get(url);
  if (hit && now() < hit.until) return Promise.resolve(hit.value);
  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = launch(url, cwd)
    .catch((): Status => ({ live: null, unavailable: 'gh failed' }))
    .then((value) => {
      cache.set(url, { value, until: now() + windowFor(value) });
      return value;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

/** Test seam: route launches through `run`, or back to the real `gh` runner with `null`. */
export function overrideGhRunner(run: FetchRunner | null): void {
  runner = run ?? realRunner();
}

/** Test seam: a fixed clock for the cache windows, or `Date.now` again with `null`. */
export function overridePrClock(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}

/** Test seam: forget every cached status and launch in flight. */
export function resetPrStatusCache(): void {
  cache.clear();
  inFlight.clear();
}
