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
  /** endedAt - startedAt in ms, when both are known. */
  durationMs: number | null;
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
  /** Set only when the scan failed and an empty snapshot is returned. */
  error?: boolean;
}
