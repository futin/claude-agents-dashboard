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
  /** User-set custom title from Claude Code (custom-title record); null when unnamed. */
  sessionName: string | null;
  gitBranch: string | null;
  model: string;
  tokens: number;
  contextWindow: number;
  contextWindowLabel: string;
  contextPct: number;
  status: 'working' | 'idle' | 'question' | 'incomplete';
  /**
   * True while a remote `AskUserQuestion` wait is held for this session (the
   * in-memory pending store, not the transcript). The hook registers the wait
   * during PreToolUse — *before* the tool_use record reaches disk — so this leads
   * transcript-derived `waitingOnQuestion` by the whole length of the wait, and
   * is what makes a held question visible without opening the chat drawer.
   */
  remoteQuestion: boolean;
  activity: Activity | null;
  lastTimestamp: string | null;
  updatedMs: number;
  version: string | null;
  /** The `/kaizen` lesson logged for this session, or null if never inspected. */
  kaizenLesson: string | null;
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

/** One tool call rendered as a compact line under an assistant message. */
export interface ChatToolCall {
  name: string;
  /** Short human label (`describeTool` in transcript.ts) — file path, pattern, command… */
  detail: string;
  /**
   * Full markdown body for tools whose input IS conversational content
   * (ExitPlanMode's plan, AskUserQuestion's questions). Capped at TOOL_BODY_CAP.
   */
  body?: string;
  bodyTruncated?: boolean;
}

/** One conversational turn in the chat tail. Noise records are dropped upstream. */
export interface ChatMessage {
  uuid: string;
  role: 'user' | 'assistant';
  ts: string | null;
  /** Concatenated text blocks, `<system-reminder>` spans stripped, capped. */
  text: string;
  textTruncated: boolean;
  tools: ChatToolCall[];
}

/**
 * Payload of `GET /api/sessions/:id/chat` — a page of the session's chat history.
 * Byte offsets are the paging currency: `cursor` walks forward (live tail),
 * `headOffset` walks backward (older pages). See `.claude/rules/chat-tail.md`.
 */
export interface SessionChat {
  id: string;
  /** Oldest-first. */
  messages: ChatMessage[];
  /** Bytes of the transcript consumed; pass back as `?after=` for the live tail. */
  cursor: number;
  /** Byte offset of `messages[0]`'s line; pass as `?before=` to load older. */
  headOffset: number;
  /** `headOffset > 0` — there is history above the first message. */
  hasMore: boolean;
  /** The file shrank/rotated: the client's cursor is meaningless, refetch the tail. */
  reset?: boolean;
  /** Set only when the read failed or the id is unknown. */
  error?: boolean;
}

/**
 * Remote answers — the one write path in the dashboard (see
 * `.claude/rules/remote-answer.md`). A session's `AskUserQuestion` PreToolUse
 * hook offers the question here and blocks; the browser answers it; the hook
 * feeds the choice back to the model. Everything below lives in memory only.
 */

/**
 * The remote-answer switch (`GET /api/health`, `POST /api/remote-answer`).
 * `available` is the `REMOTE_ANSWER` env gate; `enabled` is the UI toggle;
 * `remoteAnswer` is the conjunction and the only field the hook reads.
 */
export interface RemoteAnswerState {
  available: boolean;
  enabled: boolean;
  remoteAnswer: boolean;
  /** False when the toggle couldn't be written to disk (won't survive a restart). */
  persisted: boolean;
}

/** One selectable choice, straight from the tool call's `options[]`. */
export interface PendingOption {
  label: string;
  description?: string;
}

/** One question of an `AskUserQuestion` call, sanitized for the panel. */
export interface PendingQuestionItem {
  /** Short chip label; '' when the call omitted it. */
  header: string;
  question: string;
  multiSelect: boolean;
  options: PendingOption[];
}

/** A question waiting for an answer, as the browser sees it. */
export interface PendingQuestion {
  /** Server nonce. An answer must echo it, so a stale tab can't answer the next question. */
  questionId: string;
  askedAt: string;
  questions: PendingQuestionItem[];
}

/** Payload of `GET /api/sessions/:id/question`. */
export interface SessionQuestion {
  id: string;
  pending: PendingQuestion | null;
  error?: boolean;
}

/** One question's answer. Index-keyed — `header` is model-authored and not unique. */
export interface QuestionAnswer {
  index: number;
  /** Chosen labels, or a single free-text string for "Other". */
  selected: string[];
}

/** Body of `POST /api/sessions/:id/answer`. `dismiss` releases the hook instead. */
export interface AnswerRequest {
  questionId: string;
  /** "Answer in the terminal instead" — resolves the wait without an answer. */
  dismiss?: boolean;
  answers?: QuestionAnswer[];
}

/**
 * Body of the held `POST /api/questions/wait` response — how a wait ended.
 * Only `answered` makes the hook inject anything; every other status means the
 * terminal dialog takes over.
 */
export interface WaitResult {
  status: 'answered' | 'timeout' | 'superseded' | 'dismissed';
  /**
   * Prose the hook hands to the model verbatim (`permissionDecisionReason`).
   * Composed server-side so the injection mechanism can change without touching
   * the hook script. Set only when `status === 'answered'`.
   */
  reason?: string;
  /** The structured picks behind `reason` — for a future native answer path. */
  answers?: QuestionAnswer[];
}

/**
 * Whole-session token accounting — the kaizen post-mortem (`analyze.ts`,
 * `scripts/session-analytics.ts`, the `/kaizen` skill). Unlike {@link Session}.tokens (the
 * latest context-window occupancy), these are summed across every main-agent
 * turn in the transcript.
 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /**
   * Raw sum of all four fields. A context-pressure signal, NOT a cost figure:
   * cacheRead (replayed cached prompt) dominates it and is billed at ~10%.
   */
  combined: number;
  /**
   * input + output + cacheCreation — excludes the cheap replayed cacheRead, so
   * it tracks real cost far better than `combined`. Lead with this.
   */
  billableApprox: number;
}

/** Distribution of tokens/errors across main-agent turns. */
export interface PerTurn {
  /** Assistant turns carrying a usage block (sidechain turns excluded). */
  count: number;
  /** Mean `combined` tokens per turn. */
  avgCombined: number;
  /** Largest single-turn `combined`. */
  maxCombined: number;
  /** 0-based index (in assistant-turn order) of the `maxCombined` turn, or -1. */
  maxTurnIndex: number;
}

/** Per-tool usage in the main agent. Counts/errors are exact; tokens are approximate. */
export interface ToolStat {
  /** Tool name (Bash, Read, Edit, Task, …). */
  tool: string;
  /** Invocation count (exact). */
  count: number;
  /** Summed wall time (tool_use ts → matching tool_result ts) in ms. Includes model latency. */
  durationMs: number;
  /** tool_results flagged `is_error` / `<tool_use_error>` for this tool (exact). */
  errors: number;
  /**
   * Rough token attribution: each turn's `output_tokens` split evenly across
   * that turn's tool_use blocks, summed per tool. APPROXIMATE — the transcript
   * carries no per-tool token field. Never includes input/cache tokens.
   */
  approxOutputTokens: number;
}

/** Aggregate over the subagents ({@link AgentJob}) a session launched. */
export interface SubagentTotals {
  count: number;
  /** Sum of known `tokens` — exact, and separate from the main-agent totals. */
  tokens: number;
  /** Subagents whose token total is unknown (still running / old transcript). */
  unknownTokenCount: number;
}

/** Deterministic accuracy-adjacent signals. All are heuristics — the skill judges. */
export interface ErrorSignals {
  /** tool_result blocks with `is_error` or `<tool_use_error>` (exact). */
  toolErrors: number;
  /** A tool re-invoked after it errored — a rough rework signal. */
  retries: number;
  /** Human turns matching a correction keyword. Noisy lower bound, not a score. */
  userCorrections: number;
}

/** Payload of the session-analytics analyzer — whole-session facts, no judgment. */
export interface SessionAnalysis {
  /** Transcript filename id (UUID) analyzed. */
  id: string;
  /** Absolute transcript path. */
  file: string;
  /** Session cwd from the transcript, else null. */
  cwd: string | null;
  /** Models seen across the session (usually one). */
  models: string[];
  /** First / last record timestamps and elapsed span (null when unknown). */
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Main-agent token totals (sidechain/subagent turns excluded to avoid double-count). */
  totals: TokenTotals;
  perTurn: PerTurn;
  /** Per-tool main-agent usage, priciest (approxOutputTokens) first. */
  byTool: ToolStat[];
  /** Subagents launched (from `readAgents`), newest-first. */
  bySubagent: AgentJob[];
  subagentTotals: SubagentTotals;
  /** server_tool_use counts (Anthropic-side web search / fetch). */
  serverTools: { webSearch: number; webFetch: number };
  errorSignals: ErrorSignals;
  /** Fixed interpretation caveats (cacheRead framing, approx tokens, …). */
  notes: string[];
}

/**
 * Analytics section (`GET /api/analytics`) — a read-only view of the sessions
 * the `/kaizen` skill has logged. `~/.claude/session-analytics-log.md` (one line per
 * `/kaizen` run) is the sole trigger: for each of the last N logged sessions the
 * server pairs the human/Claude-authored `lesson` with a live re-run of
 * {@link SessionAnalysis} (the deterministic analyzer). Nothing is written — a
 * session appears here only because `/kaizen` logged it.
 */
export interface AnalyticsReport {
  sessionId: string;
  /** basename of the session cwd, else the project tag from the session-analytics-log line. */
  project: string;
  cwd: string | null;
  /** Models seen across the session (from the analysis), else []. */
  models: string[];
  /** Date the `/kaizen` run was logged (YYYY-MM-DD from the session-analytics-log line). */
  loggedAt: string;
  /** Deterministic post-mortem facts, re-run live; null if the transcript is gone. */
  analysis: SessionAnalysis | null;
  /** The session-analytics-log lesson text (always present — it's what puts the session here). */
  lesson: string;
}

/** Payload of `GET /api/analytics` — the last N logged sessions, newest-first. */
export interface AnalyticsResponse {
  generatedAt: string;
  /** Display cap (default 5). `reports.length <= keep`. */
  keep: number;
  reports: AnalyticsReport[];
  /** Set only when listing failed. */
  error?: boolean;
}

/**
 * Management section (`GET /api/management*`) — read-only view over Claude
 * config on disk: skills, agents, commands, rules, hooks, memory, settings,
 * and installed plugins, per scope (global `~/.claude` or one project).
 */

/** Where a config item comes from: 'user', 'project', or 'plugin:<name>'. */
export type ItemSource = string;

/** One skill / agent / command / rule / memory file (metadata only, no body). */
export interface ConfigItem {
  /** Frontmatter name, else dir/file basename. */
  name: string;
  /** Frontmatter description (folded `>` supported), else null. */
  description: string | null;
  /** Absolute path to the .md/.toml file. */
  path: string;
  source: ItemSource;
}

/** One hook entry, flattened from settings.json / plugin hooks.json. */
export interface HookInfo {
  /** Lifecycle event: PreToolUse | Notification | Stop | SessionStart | … */
  event: string;
  matcher: string | null;
  command: string;
  source: ItemSource;
  /** Absolute path of the settings.json / hooks.json that declared it. */
  declaredIn: string;
  /** Referenced script when resolvable inside an allowed root, else null. */
  scriptPath: string | null;
}

export interface SettingsFileInfo {
  /** 'settings.json' | 'settings.local.json' */
  label: string;
  path: string;
  exists: boolean;
}

/** One installed plugin (from installed_plugins.json). */
export interface PluginInfo {
  /** 'superpowers@claude-plugins-official' */
  key: string;
  /** plugin.json name, else the key's name half. */
  name: string;
  marketplace: string;
  version: string | null;
  description: string | null;
  installPath: string;
  /** From settings.json enabledPlugins. */
  enabled: boolean;
  /** .claude-plugin/plugin.json when present. */
  manifestPath: string | null;
  counts: { skills: number; agents: number; commands: number; rules: number; hooks: number };
}

/** All config for one scope (global or one project). Metadata only, no file bodies. */
export interface ScopeConfig {
  scope: 'global' | 'project';
  /** ~/.claude for global, the project cwd for project. */
  root: string;
  skills: ConfigItem[];
  agents: ConfigItem[];
  commands: ConfigItem[];
  rules: ConfigItem[];
  hooks: HookInfo[];
  /** CLAUDE.md files (root + .claude/CLAUDE.md). */
  memory: ConfigItem[];
  settings: SettingsFileInfo[];
  /** Populated for global only; [] for projects. */
  plugins: PluginInfo[];
  error?: boolean;
}

/** A recently-active project (management side-menu entry). */
export interface ProjectRef {
  /** Encoded ~/.claude/projects dir name — the key for /api/management/project. */
  dirName: string;
  /** Basename of path. */
  name: string;
  /** Real cwd from the transcript. */
  path: string;
  lastActiveMs: number;
}

/** Payload of `GET /api/management`. */
export interface ManagementIndex {
  generatedAt: string;
  global: ScopeConfig;
  /** Newest-first. */
  projects: ProjectRef[];
  error?: boolean;
}

/** Payload of `GET /api/management/file`. */
export interface FileContent {
  path: string;
  content: string;
  /** Real byte size on disk. */
  size: number;
  /** True when size exceeded the cap and content was cut. */
  truncated: boolean;
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
   * `null` when unavailable (no token, network error); absent when SHOW_USAGE
   * is off. Attached on both the success and error snapshots.
   */
  usage?: UsageLimits | null;
  /**
   * Why `usage` is or isn't populated: 'ok' → bars render; 'token-expired' →
   * stored OAuth token is past expiresAt (header shows a hint instead of bars);
   * 'unavailable' → any other fail-open cause (no token, network, bad payload).
   * Absent when SHOW_USAGE is off; attached on both success and error snapshots.
   */
  usageStatus?: UsageStatus;
  /** Set only when the scan failed and an empty snapshot is returned. */
  error?: boolean;
}
