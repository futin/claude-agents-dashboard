/**
 * types.ts — the API contract shared by server and client.
 *
 * `GET /api/sessions` returns a {@link SessionsResponse}. `scanSessions` (server)
 * produces it; `useSessions` (client) consumes it. One definition, both sides.
 */

/** The session's most-recent tool call. */
export interface Activity {
  tool: string;
  detail: string;
}

/** A single Claude Code session, as shown in one dashboard row. */
export interface Session {
  id: string;
  project: string;
  projectPath: string | null;
  gitBranch: string | null;
  model: string;
  tokens: number;
  contextWindow: number;
  contextWindowLabel: string;
  contextPct: number;
  status: 'working' | 'idle' | 'question' | 'incomplete';
  activity: Activity | null;
  lastTimestamp: string | null;
  updatedMs: number;
  version: string | null;
}

export interface Totals {
  shown: number;
  active: number;
}

/** One rolling rate-limit window (percent used + when it resets). */
export interface RateLimit {
  /** 0–100 percent of the window consumed, or null if unknown/unscoped. */
  utilization: number | null;
  /** ISO 8601 reset time, or null if unknown. */
  resetsAt: string | null;
}

/**
 * Account usage limits fetched live from Anthropic's OAuth usage endpoint —
 * the same numbers Claude Code's `/usage` shows. Not derived from local disk.
 */
export interface UsageLimits {
  /** 5-hour rolling window ("Current session"). */
  fiveHour: RateLimit;
  /** 7-day rolling window, all models ("Current week"). */
  sevenDay: RateLimit;
}

/** Why the header usage section is (or isn't) populated. */
export type UsageStatus = 'ok' | 'token-expired' | 'unavailable';

/** Payload of `POST /api/usage/refresh`. */
export interface UsageRefreshResponse {
  ok: boolean;
  /** Set on failure (409 refresh already running, 502 spawn failed, 404 disabled). */
  error?: string;
  /** Fresh snapshot after a successful refresh. */
  usage?: UsageLimits | null;
  usageStatus?: UsageStatus;
}

/** One subagent launched via the `Task` tool, paired from the parent transcript. */
export interface AgentJob {
  /** The Task tool_use id (pairs with the later tool_result.tool_use_id). */
  id: string;
  /** subagent_type, e.g. "Explore"; '' when the record omits it. */
  type: string;
  description: string;
  /** running = no matching tool_result yet; done = result recorded. */
  status: 'running' | 'done';
  /** Timestamp of the Task tool_use record. */
  startedAt: string | null;
  /** Timestamp of the matching tool_result record (null while running). */
  endedAt: string | null;
  /**
   * Run time in ms. The transcript's exact value when reported (sync:
   * toolUseResult.totalDurationMs; async: <duration_ms> in the notification),
   * else endedAt - startedAt. Null while running or when neither is known.
   */
  durationMs: number | null;
  /**
   * Total tokens the subagent consumed (sync: toolUseResult.totalTokens;
   * async: <subagent_tokens> in the notification). Null while running or on
   * old transcripts that lack the field.
   */
  tokens: number | null;
  /** Tool calls the subagent made (totalToolUseCount / <tool_uses>). Same nullability. */
  toolUses: number | null;
}

/** Payload of `GET /api/sessions/:id` — a session's subagent activity. */
export interface SessionDetail {
  id: string;
  /** Newest-first. */
  agents: AgentJob[];
  running: number;
  finished: number;
  /** Set only when the scan failed or the id is unknown. */
  error?: boolean;
}

/** Full payload of `GET /api/sessions`. */
export interface SessionsResponse {
  generatedAt: string;
  activeWindowMin: number;
  maxSessions: number;
  runningClaudeProcs: number | null;
  totals: Totals;
  sessions: Session[];
  /**
   * Account rate-limit usage (5-hour + weekly), fetched live from Anthropic.
   * `null` when unavailable (no token, network error, or feature disabled);
   * absent on the error snapshot.
   */
  usage?: UsageLimits | null;
  /**
   * Why `usage` is or isn't populated: 'ok' → bars render; 'token-expired' →
   * stored OAuth token is past expiresAt (recoverable via POST /api/usage/refresh);
   * 'unavailable' → any other fail-open cause (no token, network, bad payload).
   * Absent when SHOW_USAGE is off and on the error snapshot.
   */
  usageStatus?: UsageStatus;
  /** Set only when the scan failed and an empty snapshot is returned. */
  error?: boolean;
}
