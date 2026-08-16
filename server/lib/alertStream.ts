/**
 * alertStream.ts — server-pushed "a session needs you" events (SSE).
 *
 * Why this exists at all, given the client already polls: a poll is a timer,
 * and a hidden tab's timers are throttled by the browser to roughly one tick a
 * minute and may be frozen outright. The statuses worth alerting on are
 * *transient* — `incomplete` decays to `idle` as soon as the session leaves the
 * active window (`scan.ts`, `recent`). So a backgrounded tab thaws, polls, sees
 * `working → idle`, and correctly ignores it. The alert was lost, not delayed,
 * which is exactly the reported failure.
 *
 * A Node interval is never throttled. Detection moves here, to the moment the
 * transition happens, and the event is written to an already-open socket — so
 * even a frozen tab has the bytes buffered and waiting when it wakes.
 *
 * Two deliberate properties:
 *
 *  - **The scan runs only while someone is listening.** No subscribers, no
 *    timer, no disk churn. The app keeps its "no daemon" posture.
 *  - **A new subscriber seeds a baseline and alerts on nothing**, the same rule
 *    the client diff uses: a session already waiting when you connect is not
 *    news. Reconnects therefore never replay a backlog.
 *
 * See `docs/subsystems/settings.md` § Alerts.
 */

import type { ServerResponse } from 'node:http';

import type { AlertEvent, Session, SessionsResponse } from '../../shared/types.js';

/**
 * Statuses that mean a human has to do something. Deliberately duplicated from
 * `client/src/lib/alerts.ts` rather than shared: only the typed payloads in
 * `shared/types.ts` cross the FE/BE boundary, and this is ten lines of rule,
 * not a module worth coupling the two halves over.
 */
const NEEDS_YOU: ReadonlySet<Session['status']> = new Set(['question', 'incomplete']);

/** How often the scan runs while at least one client is listening. */
export const TICK_MS = 3000;

/** Comment frame every 20s so proxies and load balancers hold the socket open. */
const HEARTBEAT_MS = 20_000;

export type StatusMap = ReadonlyMap<string, Session['status']>;

export function statusMap(sessions: readonly Session[]): Map<string, Session['status']> {
  return new Map(sessions.map(s => [s.id, s.status]));
}

/**
 * Sessions that just *became* something you need to act on.
 *
 * Pure, and the same rule the client applies to its own poll: only a genuine
 * change counts, so a row that has been sitting on `question` for ten minutes
 * does not re-announce on every tick.
 */
export function transitions(prev: StatusMap, next: readonly Session[], at: string): AlertEvent[] {
  const out: AlertEvent[] = [];
  for (const s of next) {
    if (!NEEDS_YOU.has(s.status)) continue;
    if (prev.get(s.id) === s.status) continue;
    out.push({
      id: s.id,
      label: s.sessionName || s.project,
      status: s.status as AlertEvent['status'],
      at
    });
  }
  return out;
}

interface Subscriber {
  res: ServerResponse;
  /** null until the first tick, which seeds the baseline and announces nothing. */
  prev: StatusMap | null;
}

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
/** Injected by the route so this module never reaches into the pending stores. */
let scan: (() => SessionsResponse) | null = null;

function write(sub: Subscriber, frame: string): void {
  try { sub.res.write(frame); }
  catch { drop(sub); }
}

function tick(): void {
  if (!scan || subscribers.size === 0) return;
  let snapshot: SessionsResponse;
  try { snapshot = scan(); }
  catch (e) {
    // A failed scan is not worth killing live streams over — skip this tick.
    console.error('[dashboard] alert scan failed:', (e as Error).message);
    return;
  }
  if (snapshot.error) return;

  const at = snapshot.generatedAt;
  const now = statusMap(snapshot.sessions);
  for (const sub of subscribers) {
    const prev = sub.prev;
    sub.prev = now;
    if (!prev) continue; // first tick for this subscriber — baseline only
    for (const event of transitions(prev, snapshot.sessions, at)) {
      write(sub, `event: alert\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
}

function start(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  heartbeat = setInterval(() => {
    for (const sub of subscribers) write(sub, `: ping\n\n`);
  }, HEARTBEAT_MS);
  // Never hold the process open for a stream — the server's listener already does.
  timer.unref?.();
  heartbeat.unref?.();
}

function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

function drop(sub: Subscriber): void {
  subscribers.delete(sub);
  try { sub.res.end(); } catch { /* already gone */ }
  if (subscribers.size === 0) stop();
}

/**
 * Attach one SSE client. Returns a detach function; the caller wires it to the
 * request's close event.
 */
export function addSubscriber(res: ServerResponse, scanFn: () => SessionsResponse): () => void {
  scan = scanFn;
  const sub: Subscriber = { res, prev: null };
  subscribers.add(sub);
  start();
  // Seed immediately so a client that connects while a session is already
  // waiting gets its baseline now rather than on the first tick.
  tick();
  return () => drop(sub);
}

/** Live subscriber count. Test seam: proves the timer stops on last disconnect. */
export function subscriberCount(): number {
  return subscribers.size;
}

/** Test seam: drop every stream and stop the timer. */
export function resetAlertStream(): void {
  for (const sub of [...subscribers]) drop(sub);
  subscribers.clear();
  stop();
  scan = null;
}
