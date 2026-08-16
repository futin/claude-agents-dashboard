/**
 * notify.ts — server-sent ntfy pushes for "a session needs you".
 *
 * Why the server sends rather than the hooks: three of the four events already
 * arrive here as hook POSTs (`/api/questions/wait`, `/api/plans/wait`,
 * `/api/permissions/notify`), each at the moment it happens and with the
 * granularity the user picks events at. Delivering from here keeps the whole
 * policy in one testable place instead of re-implementing it in four shell
 * scripts — which is exactly what this replaces.
 *
 * Why it exists at all, given the in-browser alerts: WebKit exposes no
 * `Notification` API in a tab (Safari *and* Chrome-on-iOS), so
 * `client/src/lib/alerts.ts` can never reach an iPhone. ntfy already holds a
 * native push connection; the dashboard only has to decide when to publish.
 *
 * This is the one part of the backend that talks to the internet. It stays
 * zero-dependency (`node:https`), fire-and-forget, and can never fail or delay
 * the request that triggered it.
 *
 * See `docs/subsystems/push-notify.md`.
 */

import { execFileSync } from 'node:child_process';
import https from 'node:https';

import { getState } from './remoteState.js';
import { scanSessions } from './scan.js';
import { getSettings } from './settings.js';
import type { Config } from './config.js';
import type { NotifyEvent, NotifyPolicy } from '../../shared/types.js';

/**
 * Permission modes that count as "running unattended".
 *
 * Deliberately duplicated from `MODES` in `scripts/remote-decision-hook.sh`
 * rather than shared: one is TypeScript and the other is bash, and three words
 * of rule is not worth coupling a shell script to a module. The same call was
 * made for `NEEDS_YOU` across `alertStream.ts` and `client/src/lib/alerts.ts`.
 * Change one, change the other.
 */
export const AUTO_MODES: ReadonlySet<string> = new Set(['auto', 'bypassPermissions', 'dontAsk']);

export interface PredicateContext {
  /** `remoteState.getState().remoteAnswer` — the env gate AND the UI toggle. */
  remoteAnswer: boolean;
  /** `settings.idleSecs` — the same threshold the remote-answer hooks use. */
  thresholdSecs: number;
  /** From the hook payload. Absent on paths that cannot see it. */
  permissionMode?: string;
  /**
   * Seconds since the last HID event, or null when unreadable. A thunk, not a
   * value: reading it spawns `ioreg`, and the whole point of the clause order
   * below is that a policy without `requireAfk` never pays for that.
   */
  readIdle: () => number | null;
}

/**
 * The whole policy. Clauses are ordered cheapest-first and short-circuit, so
 * `readIdle` is called only when every free check has already passed.
 */
export function shouldNotify(event: NotifyEvent, policy: NotifyPolicy, ctx: PredicateContext): boolean {
  if (!policy.enabled) return false;
  if (!policy.events[event]) return false;
  if (policy.requireRemoteAnswer && !ctx.remoteAnswer) return false;
  if (policy.requireAutoMode && !AUTO_MODES.has(ctx.permissionMode ?? '')) return false;

  if (policy.requireAfk) {
    const idle = ctx.readIdle();
    // Unreadable (Docker, non-macOS) → push anyway. Failing silent here would
    // reintroduce the missed-notification bug this feature exists to fix, and a
    // wrong guess costs one extra push rather than a hidden dialog — which is
    // why this fails the opposite way to `ask-remote-hook.sh`.
    if (idle !== null && idle < ctx.thresholdSecs) return false;
  }
  return true;
}

/* -------------------------------------------------- delivery */

/**
 * What reaches ntfy. Deliberately has no field that could carry work content —
 * `click` is the single exception, and carries only a session id and this
 * dashboard's own address so the notification can be tapped through.
 */
export interface NotifyPayload {
  title: string;
  body: string;
  tags: string;
  /** Tap-through URL, or '' when no public URL is configured. */
  click: string;
}

export type Sender = (payload: NotifyPayload, config: Config) => void;

/** One phrase per event. The only prose the user receives. */
const PHRASE: Record<NotifyEvent, string> = {
  question: 'question waiting',
  plan: 'plan waiting for review',
  permission: 'permission dialog open',
  stop: 'task finished'
};

const TAGS: Record<NotifyEvent, string> = {
  question: 'question',
  plan: 'clipboard',
  permission: 'lock',
  stop: 'white_check_mark'
};

let sender: Sender | null = null;
let labelResolver: ((config: Config, sessionId: string) => string) | null = null;

/** Test seam: swap the transport so no test opens a socket. `null` restores https. */
export function setSender(fn: Sender | null): void {
  sender = fn;
}

/**
 * Test seam: swap the label lookup. Without it every delivery test would run a
 * real scan of `~/.claude/projects` — slow, and dependent on whatever sessions
 * the developer happens to have on disk.
 */
export function setLabelResolver(fn: ((config: Config, sessionId: string) => string) | null): void {
  labelResolver = fn;
}

export function resetNotify(): void {
  sender = null;
  labelResolver = null;
}

/**
 * Seconds since the last keyboard/mouse event, or null when unreadable.
 *
 * Same source `ask-remote-hook.sh` uses. Unreadable means non-macOS or a
 * container, and the predicate treats that as "push anyway" — see
 * {@link shouldNotify}.
 */
export function readIdleSecs(): number | null {
  try {
    const out = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8', timeout: 1000 });
    const match = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return null;
    return Math.floor(Number(match[1]) / 1_000_000_000);
  } catch {
    return null;
  }
}

/**
 * Human label for a session. Every caller has an id and none has a name — the
 * hooks cannot know it and the registration handlers never needed it — so it is
 * resolved the way the rest of the app does. Called only after the predicate has
 * passed, so the scan is never paid for a push that will not be sent.
 */
export function resolveLabel(config: Config, sessionId: string): string {
  if (labelResolver) return labelResolver(config, sessionId);
  try {
    const found = scanSessions(config).sessions.find(s => s.id === sessionId);
    if (found) return found.sessionName || found.project;
  } catch {
    /* scan failed — a poor label beats no push */
  }
  return sessionId.slice(0, 8);
}

/**
 * Where tapping the notification lands: this session's chat drawer, which is
 * where every action surface already lives (`QuestionPanel`, `PlanPanel`,
 * `PermissionBanner`). Consumed once on load by `client/src/lib/deepLink.ts`.
 *
 * Empty when no public URL is configured, which drops the header rather than
 * shipping a localhost link a phone cannot follow.
 */
export function clickUrl(config: Config, sessionId: string): string {
  if (!config.publicUrl) return '';
  return `${config.publicUrl}/?session=${encodeURIComponent(sessionId)}`;
}

/** The default transport. Fire-and-forget: nothing awaits it, nothing throws out of it. */
function httpsSend(payload: NotifyPayload, config: Config): void {
  try {
    const url = new URL(`${config.ntfyServer}/${config.ntfyTopic}`);
    const headers: Record<string, string> = {
      Title: payload.title,
      Tags: payload.tags,
      'Content-Type': 'text/plain'
    };
    // ntfy opens this when the notification is tapped. Omitted rather than sent
    // empty: an empty Click is a malformed header, not a no-op.
    if (payload.click) headers.Click = payload.click;

    const req = https.request(url, { method: 'POST', timeout: 2000, headers }, res => res.resume());
    req.on('error', () => { /* offline, DNS, TLS — never surfaces */ });
    req.on('timeout', () => req.destroy());
    req.end(payload.body);
  } catch {
    /* malformed URL from a hand-edited .env */
  }
}

function deliver(payload: NotifyPayload, config: Config): void {
  (sender ?? httpsSend)(payload, config);
}

/**
 * Evaluate the policy and, if it passes, send. Returns immediately and never
 * throws: every caller is a request handler that must not be delayed or failed
 * by a notification.
 */
export function maybeSend(
  config: Config,
  event: NotifyEvent,
  ctx: { sessionId: string; permissionMode?: string }
): void {
  try {
    if (!config.ntfyTopic) return;
    const settings = getSettings();
    const passes = shouldNotify(event, settings.notify, {
      remoteAnswer: getState(config).remoteAnswer,
      thresholdSecs: settings.idleSecs,
      permissionMode: ctx.permissionMode,
      readIdle: readIdleSecs
    });
    if (!passes) return;

    deliver(
      {
        title: 'Claude Code',
        body: `${resolveLabel(config, ctx.sessionId)} — ${PHRASE[event]}`,
        tags: TAGS[event],
        click: clickUrl(config, ctx.sessionId)
      },
      config
    );
  } catch {
    /* a notification must never break the request that triggered it */
  }
}

/**
 * Fire one push regardless of policy and say what happened.
 *
 * Every failure in this feature is invisible from the outside — an off switch, a
 * missing topic and a dropped packet all look identical — so the only honest
 * answer to "is this working?" is to fire one and report. Mirrors
 * `fireTestAlert` in `client/src/hooks/useSessionAlerts.ts`.
 */
export async function sendTest(config: Config): Promise<string> {
  if (!config.ntfyTopic) return 'no NTFY_TOPIC set in .env — nothing to send to';
  try {
    deliver(
      { title: 'Claude Code', body: 'Test push — notifications are working', tags: 'robot', click: config.publicUrl },
      config
    );
    return config.publicUrl
      ? `sent to ${config.ntfyServer} · taps open ${config.publicUrl}`
      : `sent to ${config.ntfyServer} · no DASHBOARD_PUBLIC_URL, so taps won't open the dashboard`;
  } catch (err) {
    return `send failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
