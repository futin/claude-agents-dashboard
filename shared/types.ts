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

/**
 * Which surfaces a session exists on — not how it was *started*, but where it
 * can be seen and continued (the map: `docs/subsystems/session-surfaces.md`).
 * An enum rather than an `isLocalOnly` boolean because a third answer is
 * already known to exist (`cloud`), and a boolean would have to be replaced
 * rather than extended the day it arrives.
 *
 * - `local` — an ordinary terminal or desktop-app session. It has a transcript
 *   on disk *and* the surface that started it lists it too, so nothing about
 *   the row needs saying.
 * - `dashboard` — a headless `-p` spawn: this dashboard's `+ New` button, or
 *   any other SDK launcher on this machine. **No other surface lists it.** The
 *   desktop app's sidebar registry cannot be added to from outside and shows
 *   remote-control sessions nowhere; the phone app sees only the RC ones, and
 *   only while alive. So this dashboard and `claude --resume <id>` are the ways
 *   back in — which is exactly the confusion this field exists to remove.
 * - `cloud` — reserved for a session running in Anthropic's sandbox (created
 *   from the phone app / claude.ai). Nothing produces this value yet: those
 *   sessions write no transcript to this machine, so the scanner cannot see
 *   one. The value is here so the consumer that eventually can is a new
 *   producer, not a contract change.
 */
export type SessionSurface = 'local' | 'dashboard' | 'cloud';

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
   * Where this session can be seen besides here — see {@link SessionSurface}.
   * Derived from the transcript's own `entrypoint` field (`sdk-cli` ⇒ headless
   * spawn), so it needs no stored state and holds across a server restart.
   */
  surface: SessionSurface;
  /**
   * True while a remote `AskUserQuestion` wait is held for this session (the
   * in-memory pending store, not the transcript). The hook registers the wait
   * during PreToolUse — *before* the tool_use record reaches disk — so this leads
   * transcript-derived `waitingOnQuestion` by the whole length of the wait, and
   * is what makes a held question visible without opening the chat drawer.
   */
  remoteQuestion: boolean;
  /**
   * True while a remote `ExitPlanMode` wait is held for this session — the model
   * proposed a plan and the hook is holding the call open for a verdict. Same
   * mechanism and same lead over the transcript as {@link remoteQuestion}; the
   * separate flag exists so the row can say `plan?` rather than `answer?`.
   * Remotely you can only send it back for revision — see {@link PlanAnswerRequest}.
   */
  remotePlan: boolean;
  /**
   * True while a turn-end reply window is held for this session — the Stop hook
   * is holding the turn open for a follow-up. Same mechanism and same lead over
   * the transcript as {@link remoteQuestion}; the separate flag lets the row say
   * `reply?`. See {@link MessageAnswerRequest}.
   */
  remoteReply: boolean;
  /**
   * True while the CLI is believed to be showing an interactive permission
   * dialog ("allow Bash: pnpm dev?"). Fed by the PermissionRequest hook (or the
   * older Notification one) into an in-memory store — the dialog is drawn by the
   * UI and never reaches the transcript,
   * so without the hook a parked session is indistinguishable from a running
   * tool. Cleared once the transcript advances past the notify (you answered).
   * Display-only: nothing can answer that dialog remotely.
   */
  permissionWait: boolean;
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

/** One rate-limit window (percent used + when it resets). */
/**
 * How much the duty-cycle profile can be trusted. `none` = no learned buckets
 * yet (the projection is the flat-rate one, i.e. today's behaviour); `thin` =
 * some buckets but not a representative week; `ok` = enough to lead with.
 */
export type ForecastConfidence = 'none' | 'thin' | 'ok';

/** One hour-of-week bucket, as shown in the profile inspector. */
export interface UsageProfileCell {
  /** 0–167, where 0 is Sunday 00:00 in the host's local timezone. */
  hourOfWeek: number;
  /**
   * 0–1 expected active share of that hour, or null when the bucket has under
   * an hour of accumulated evidence and the forecast falls back to the mean.
   */
  weight: number | null;
  /** Accumulated observed minutes across all weeks. Caps at 60 per week. */
  observedMin: number;
  /** Observed weeks since this bucket last folded. 0 when current. */
  staleWeeks: number;
}

/** One hour of the forward walk behind the current weekly projection. */
export interface ForecastStep {
  /** ISO 8601 start of the hour. */
  t: string;
  /** Percentage points this hour is expected to add. */
  gain: number;
  /**
   * Window % consumed after this hour — the curve's y value.
   *
   * Server-side rather than a client running-sum: the response carries no
   * `utilization` for the client to seed a sum from, and `exhaustAt` is derived
   * from these same partial sums. Summing twice in two languages is exactly the
   * drift this shape is meant to make impossible.
   */
  cum: number;
  /** The weight actually used for this hour, 0–1 (globalMean when untrusted). */
  weight: number;
  /**
   * True when {@link weight} came from the bucket; false when it is the
   * fallback. Deliberately not derivable from `weight`: a measured `1.0` and a
   * fallback `1.0` are the same number and different statements, and deriving
   * it client-side would mean re-implementing `hourOfWeek` timezone arithmetic
   * in the browser.
   */
  learned: boolean;
}

/** `GET /api/usage/profile` — read-only. Never includes raw samples. */
export interface UsageProfileResponse {
  cells: UsageProfileCell[];
  /** Fallback weight for untrusted buckets. */
  globalMean: number;
  confidence: ForecastConfidence;
  /** False when the recording setting is off — the view says so rather than showing an empty grid. */
  recording: boolean;
  /** The walk from now to the weekly reset. Empty when there is no projection. */
  walk: ForecastStep[];
  /** ISO 8601 crossing time, or null when the window coasts to its reset. */
  exhaustAt: string | null;
  /**
   * Why there is no walk to draw, or `null` whenever {@link walk} is non-empty.
   *
   * The strip is a disclosure view, so "nothing to draw" is a state that gets a
   * sentence rather than an unmounted section — idle is normal, and a panel that
   * vanishes reads as a broken feature.
   */
  walkAbsent: null | 'recording-off' | 'no-rate' | 'no-window';
}

/** What the drift comparison concluded for one model. */
export type ModelRateVerdict = 'drift' | 'stable' | 'mix-shift' | 'thin';

/**
 * One model's token-value row in `GET /api/usage/rates`.
 *
 * Every rate is "tokens per one percentage point of the 5-hour window", fitted
 * from what this machine spent against what the window charged for it. Nulls
 * are load-bearing: they mean *not enough evidence to say*, never zero.
 */
export interface ModelRateRow {
  /** Model id exactly as the transcripts record it. */
  model: string;
  /** Plain tokens per 1% — the courtesy translation, at the model's recent mix. */
  rawPerPct: number | null;
  /** Type-weighted tokens per 1% — the mix-invariant quantity drift is judged on. */
  weightedPerPct: number | null;
  baselineRawPerPct: number | null;
  baselineWeightedPerPct: number | null;
  /** Signed percent change of the weighted rate against baseline. */
  deviationPct: number | null;
  verdict: ModelRateVerdict;
  /** Intervals behind the current-window fit — the evidence, shown either way. */
  intervals: number;
  /** Cumulative utilization points behind it. */
  utilSum: number;
}

/**
 * `GET /api/usage/rates` — read-only, unpolled, and honest when empty.
 *
 * `recording: false` is the leading fact: with the recorder off there is no
 * ledger, so there are no rows and the view says why rather than showing a
 * blank table.
 */
export interface UsageRatesResponse {
  /** ISO 8601 — when the fit was run. */
  generatedAt: string;
  recording: boolean;
  /** One row per model seen in an attributable interval, richest evidence first. */
  models: ModelRateRow[];
  /**
   * Percent of moved utilization that this machine cannot account for — spend
   * from another device on the same account. Null when nothing moved.
   * Disclosed because it is the one systematic bias in the measurement.
   */
  externalSharePct: number | null;
  /** Only set when the fit itself failed; a missing ledger is not an error. */
  error?: boolean;
}

export interface RateLimit {
  /** 0–100 percent of the window consumed, or null if unknown/unscoped. */
  utilization: number | null;
  /** ISO 8601 reset time, or null if unknown. The window fully resets to 0% then. */
  resetsAt: string | null;
  /**
   * Burn rate in percent per **active** hour over the server's recent
   * utilization samples, 0 when idle, or null while there isn't enough history
   * yet (the sample store is RAM-only, so it refills within minutes of a server
   * restart).
   *
   * For the weekly window that "active" is literal: with usage recording on, the
   * lookback's delta is divided by the active time the recorder actually
   * measured, so idle hours don't dilute it. Multiply by {@link dutyCycle} to
   * get a per-*wall*-hour figure — printing `ratePerHour × 24` as a daily rate
   * overstates it by `1/dutyCycle`. With recording off there is no measurement,
   * the raw wall slope stands, and `dutyCycle` is 1 — so the same arithmetic
   * still holds.
   */
  ratePerHour?: number | null;
  /**
   * ISO 8601 time the window is projected to hit 100% at the current pace, or
   * null when idle / unknown. May land after resetsAt — the client compares the
   * two to decide "wall before reset" vs "lasts to reset".
   */
  projectedExhaustAt?: string | null;
  /**
   * The same projection computed with a flat duty cycle of 1.0 — i.e. assuming
   * you work every remaining hour. The pessimistic edge of the band the strip
   * draws; `projectedExhaustAt` is the best estimate. Null under the same
   * conditions as `projectedExhaustAt`.
   */
  pessimisticExhaustAt?: string | null;
  /**
   * 0–1: the share of the hours between now and `resetsAt` that the learned
   * profile expects to be active. Null when there is no profile. Note this is
   * forward-looking over the *remaining* window, not a trailing average — the
   * whole point is that Friday evening and Monday morning differ.
   */
  dutyCycle?: number | null;
  /** How far to trust `dutyCycle` and `projectedExhaustAt`. See {@link ForecastConfidence}. */
  forecastConfidence?: ForecastConfidence;
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
 * `headOffset` walks backward (older pages). See `docs/subsystems/chat.md`.
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
 * `docs/subsystems/remote-answer.md`). A session's `AskUserQuestion` PreToolUse
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

/**
 * How a client reached the dashboard (`server/lib/origin.ts`). `unknown` means
 * off-network — a public tunnel, or an address we can't place. Display-only:
 * nothing in the app makes an access decision from it.
 */
export type ConnectionOrigin = 'local' | 'lan' | 'tailnet' | 'unknown';

/** The four session events a push notification can announce. */
export type NotifyEvent = 'question' | 'stop' | 'permission' | 'plan';

/**
 * When to send a push. Every clause is AND-ed, and every layer is independently
 * optional — adding one later means adding one clause. All fields default false:
 * this feature is opt-in.
 *
 * See `docs/subsystems/push-notify.md`.
 */
export interface NotifyPolicy {
  /** Master switch. Off → nothing is ever sent. */
  enabled: boolean;
  /** Per-event opt-in. An event absent from the user's picks is never sent. */
  events: Record<NotifyEvent, boolean>;
  /** Only push while the remote-answer toggle is on. */
  requireRemoteAnswer: boolean;
  /** Only push once you have been away from the keyboard for `idleSecs`. */
  requireAfk: boolean;
  /** Only push from sessions in an auto-ish permission mode. */
  requireAutoMode: boolean;
}

/**
 * What `POST /api/settings` accepts for `notify`. Every key is optional, `events`
 * included — the server merges the patch over the stored policy, so the UI sends
 * only the checkbox that changed rather than round-tripping the whole thing.
 */
export type NotifyPatch =
  Partial<Omit<NotifyPolicy, 'events'>> & { events?: Partial<Record<NotifyEvent, boolean>> };

/**
 * `POST /api/notify/event` — the `stop` hook's path into the notifier. The other
 * three events notify from the endpoint they were already POSTing to.
 */
export interface NotifyEventRequest {
  sessionId: string;
  event: NotifyEvent;
  /** From the hook payload; omitted where the event does not carry it. */
  permissionMode?: string;
}

/** `POST /api/notify/test` — what the Settings button reports back. */
export interface NotifyTestResponse {
  outcome: string;
}

/**
 * `GET /api/settings`, `POST /api/settings` — the settings the browser may
 * change that are *not* per-device. Only facts a separate process has to agree
 * on land here; everything a single browser owns (theme, refresh rate, row
 * count) lives in localStorage instead. See `docs/subsystems/settings.md`.
 */
export interface ServerSettings {
  /**
   * Seconds of keyboard/mouse idle before the remote-answer hooks count you as
   * away from the desk. `0` skips the check (always offer the question here).
   */
  idleSecs: number;
  /**
   * Seconds a question (or plan) stays answerable in the dashboard before the
   * hook gives up and lets the terminal dialog appear. The hooks' wait window.
   */
  answerSecs: number;
  /**
   * Record account-usage samples to disk so the duty-cycle profile can be
   * learned. Off by default: switching it on makes the server call Anthropic
   * about once a minute for as long as the process lives, with nobody
   * necessarily watching. See docs/subsystems/usage-limits.md.
   */
  recordUsageHistory: boolean;
  /** False when the value couldn't be written to disk (won't survive a restart). */
  persisted: boolean;
  /**
   * Set when an exported `CLAUDE_DASHBOARD_IDLE_SECS` will beat `idleSecs` in the
   * hooks, which would make this setting silently do nothing. Detected, not
   * fixed — the app doesn't edit `~/.claude/settings.json` — so the UI can say
   * which file to clear. `null` when nothing overrides it.
   */
  idleOverride: EnvOverride | null;
  /** Same trap, same detection, for `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` vs `answerSecs`. */
  answerOverride: EnvOverride | null;
  /** When to send ntfy pushes. See {@link NotifyPolicy}. */
  notify: NotifyPolicy;
  /**
   * Whether `NTFY_TOPIC` is configured. The topic itself is never returned:
   * ntfy topics are unauthenticated, so anyone who can read this payload could
   * both read and publish to the channel.
   */
  notifyAvailable: boolean;
}

/** Where an overriding `CLAUDE_DASHBOARD_*` variable was found. */
export interface EnvOverride {
  value: string;
  /** `settings.json` → the `env` block in ~/.claude; `environment` → the server's own shell. */
  source: 'settings.json' | 'environment';
}

/**
 * `GET /api/health`. The remote-answer switch, the caller's own connection
 * origin, and the two numbers the hooks read. `origin`, `idleSecs` and
 * `answerSecs` are optional so an older server (or a test double) that omits
 * them simply hides the badge / falls back to the hook's own defaults.
 */
export interface HealthResponse extends RemoteAnswerState {
  ok: true;
  origin?: ConnectionOrigin;
  /** Mirrors `ServerSettings.idleSecs`. Carried here because the hooks already probe health. */
  idleSecs?: number;
  /** Mirrors `ServerSettings.answerSecs`, read off the same probe. */
  answerSecs?: number;
  /**
   * True when a whisper model and CLI are both present. Engine availability
   * only — it deliberately does not fold in `remoteAnswer`, even though the
   * endpoint 404s on both, because a MessagePanel cannot be on screen with
   * remote answers off. One flag, one meaning.
   */
  transcribe?: boolean;
  /**
   * True when a `claude` binary is configured and runnable — the spawn
   * form's gate, probed the same way `transcribe` gates the mic button. See
   * `probeSpawn` in `server/lib/spawn.ts`.
   */
  spawnAvailable?: boolean;
  /**
   * The permission-mode ceiling every launch is clamped to
   * (`config.spawnMaxPermission`, see `clampPermission` in
   * `server/lib/spawn.ts`). Not a secret — a ceiling, not a credential — so
   * it rides the same probe `spawnAvailable` does. Lets the launch panel
   * offer only the permission modes it can actually deliver, instead of
   * silently clamping a choice the user made on purpose. Absent on an older
   * server that predates this field; the panel then falls back to offering
   * up to `'auto'`, today's default ceiling.
   */
  spawnMaxPermission?: PermissionMode;
}

/** `POST /api/transcribe` — text may be '' when the clip held no speech. */
export interface TranscribeResponse {
  text: string;
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
  /**
   * `released` is the idle sweep's verdict — the user came back to the keyboard,
   * so the wait was handed to the terminal dialog without anyone touching the
   * panel. It differs from `dismissed` (they tapped "answer in the terminal")
   * only in who triggered it; the hook treats every non-`answered` status alike.
   */
  status: 'answered' | 'timeout' | 'superseded' | 'dismissed' | 'released';
  /**
   * Prose the hook hands to the model verbatim (`permissionDecisionReason`).
   * Composed server-side so the injection mechanism can change without touching
   * the hook script. Set only when `status === 'answered'`.
   */
  reason?: string;
  /** The structured picks behind `reason` — for a future native answer path. */
  answers?: QuestionAnswer[];
}

/** A proposed plan waiting on a verdict, as the browser sees it. */
export interface PendingPlan {
  /** Server nonce. A verdict must echo it, so a stale tab can't answer the next plan. */
  planId: string;
  askedAt: string;
  /** The plan markdown, straight from the `ExitPlanMode` tool input (capped). */
  plan: string;
}

/** Payload of `GET /api/sessions/:id/plan`. */
export interface SessionPlan {
  id: string;
  pending: PendingPlan | null;
  error?: boolean;
}

/**
 * Body of `POST /api/sessions/:id/plan-answer`.
 *
 * `reject` sends the model back to planning carrying `feedback`; `dismiss` hands
 * the plan back to its card in the terminal.
 *
 * ⚠️ There is deliberately no `accept`. The CLI discards a hook `allow` for any
 * tool declaring `requiresUserInteraction()`, and `ExitPlanMode` is one — its
 * approval card *is* the interaction surface, by design. Approving remotely is
 * not a missing feature here; it is a refused one upstream.
 */
export interface PlanAnswerRequest {
  planId: string;
  verdict: 'reject' | 'dismiss';
  /** What to change. Reaches the model verbatim; required for `reject`. */
  feedback?: string;
}

/**
 * Body of the held `POST /api/plans/wait` response — how a plan wait ended.
 * Only `rejected` makes the hook inject anything; every other status means the
 * plan card takes over.
 */
export interface PlanWaitResult {
  /** `released` is the idle sweep's verdict — see {@link WaitResult.status}. */
  status: 'rejected' | 'timeout' | 'superseded' | 'dismissed' | 'released';
  /**
   * Prose the hook hands the model as the deny `message`. Composed server-side
   * so the injection mechanism can change without touching the hook script.
   * Set only when `status === 'rejected'`.
   */
  reason?: string;
}

/** A turn-end reply window a session is holding open, as the browser sees it. */
export interface PendingMessage {
  /** Server nonce. A send must echo it, so a stale tab can't answer the next window. */
  messageId: string;
  askedAt: string;
  /** When the window closes on its own — feeds the panel's countdown. */
  expiresAt: string;
}

/** Payload of `GET /api/sessions/:id/message`. */
export interface SessionMessage {
  id: string;
  pending: PendingMessage | null;
  error?: boolean;
}

/**
 * Body of `POST /api/sessions/:id/message-answer`.
 * `text` continues the model with your message; `dismiss` releases the hold so
 * the session stops now instead of sitting out the window.
 */
export interface MessageAnswerRequest {
  messageId: string;
  /** The follow-up, sent to the model verbatim inside a composed reason. */
  text?: string;
  dismiss?: boolean;
}

/**
 * Body of the held `POST /api/messages/wait` response — how a reply window
 * ended. Only `answered` makes the hook block the stop; every other status
 * exits 0 and the session stops normally. `released` is the auto-release: you
 * came back to the keyboard, so every hold let go.
 */
export interface MessageWaitResult {
  status: 'answered' | 'timeout' | 'superseded' | 'dismissed' | 'released';
  /** Prose the hook prints as the Stop block's `reason`. Composed server-side. */
  reason?: string;
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
 * What became of a logged lesson, from the log's own `status` lines:
 * `actioned` (written into a CLAUDE.md / memory), `promoted` (raised to global
 * config after recurring across projects), `dropped` (considered and rejected).
 * Lessons with no status line are still open.
 */
export interface LessonStatus {
  status: 'actioned' | 'promoted' | 'dropped';
  /** YYYY-MM-DD of the status line. */
  date: string;
  /** Free-text note after the em dash, e.g. "added to project CLAUDE.md". */
  note?: string;
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
  /** Newest `status` line for this session, or null while the lesson is still open. */
  lessonStatus?: LessonStatus | null;
}

/** Payload of `GET /api/analytics` — the last N logged sessions, newest-first. */
export interface AnalyticsResponse {
  generatedAt: string;
  /** Display cap (default 5). `reports.length <= keep`. */
  keep: number;
  reports: AnalyticsReport[];
  /** Date of the newest `review:` marker in the log (YYYY-MM-DD), else null. */
  lastReviewAt?: string | null;
  /** True when lessons exist and no review marker landed in the last 7 days. */
  reviewDue?: boolean;
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

/** One file inside a skill directory, relative to the directory that holds SKILL.md. */
export interface SkillFile {
  /** Path relative to the skill dir, '/'-separated (e.g. 'references/api.md'). */
  rel: string;
  /** Byte size on disk. */
  size: number;
}

/** One skill / agent / command / rule / memory file (metadata only, no body). */
export interface ConfigItem {
  /** Frontmatter name, else dir/file basename. */
  name: string;
  /** Frontmatter description (folded `>` supported), else null. */
  description: string | null;
  /** Absolute path to the .md/.toml file. */
  path: string;
  source: ItemSource;
  /**
   * Skills only: every file in the skill dir (SKILL.md first, then by rel),
   * when there is more than SKILL.md. All of them are servable.
   */
  files?: SkillFile[];
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

/**
 * Spawning a new headless session (a detached `claude -p` process). The
 * launch form picks a permission mode; the server clamps it to a configured
 * ceiling (`clampPermission` in `server/lib/spawn.ts`) so a browser can never
 * ask for more than the host allows. `PermissionMode` and `LaunchingSession`
 * are the shapes the RAM-only launch store works in; `SpawnRequest` is the
 * `POST /api/spawn` body that starts one (see `serveSpawn` in `server/api.ts`).
 */

/** The permission mode ladder, lowest to highest: plan < acceptEdits < auto < bypassPermissions. */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';

/**
 * One in-flight `claude -p` launch the RAM-only store in `server/lib/spawn.ts`
 * is still watching. Charter: explain the first ~3 seconds of a launch and
 * report ones that never became a real session — this is deliberately NOT a
 * session registry, and a launch that succeeds leaves no trace here.
 */
export interface LaunchingSession {
  sessionId: string;
  projectName: string;
  projectPath: string;
  /** First 120 characters only — a display preview, not the full request. */
  prompt: string;
  startedAtMs: number;
  state: 'launching' | 'failed';
  /** Set only when `state === 'failed'` and the child reported a numeric exit code. */
  exitCode?: number;
  /** Set only when `state === 'failed'` — the stderr tail (capped), or a synthesized reason. */
  error?: string;
  /**
   * This launch resumes an existing session (`--resume`), so its id already
   * names a real row: the client hides the `launching` phantom for it (the
   * real row is the progress indicator) and renders only a `failed` one.
   */
  resume?: boolean;
}

/**
 * Body of `POST /api/spawn` — the launch form's request. `project` is a
 * {@link ProjectRef.dirName}, resolved server-side against the enumerated
 * recent-project list — it is never treated as a filesystem path. The server
 * clamps `permissionMode` to `config.spawnMaxPermission` before anything
 * spawns, so this field alone can never request more than the host allows.
 */
export interface SpawnRequest {
  /** Required for a fresh launch; ignored when `resume` is set (the session's own cwd wins). */
  project?: string;
  prompt: string;
  name?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /**
   * Launch with `--remote-control`: the session registers with the account, so
   * the phone app can see and drive it. Anything but literal `true` means off.
   * Forced off on a resume (unverified CLI combo).
   */
  remoteControl?: boolean;
  /**
   * Resume this session id instead of starting fresh: the child runs
   * `--resume <id>` in the session's own cwd and appends to the same
   * transcript under the same id. Only sessions whose transcript says
   * `sdk-cli` (the `dashboard` pill) qualify; malformed-when-present is a 400,
   * never a silent fresh launch.
   */
  resume?: string;
}

/**
 * 200 body of `POST /api/spawn`. The id is minted before the child is spawned
 * (`--session-id <uuid>` is honored end to end, see docs/subsystems/spawn.md),
 * so it is valid the instant this response lands — the transcript it names does
 * not exist yet, which is why the client can set its chat-drawer deep link from
 * it but the drawer itself still waits for the id to appear in a poll.
 */
export interface SpawnResponse {
  sessionId: string;
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
   * In-flight `claude -p` launches the RAM-only store in `server/lib/spawn.ts`
   * is still watching (see {@link LaunchingSession}). Served alongside
   * `sessions` deliberately, on the same 3s poll, rather than a second
   * endpoint the client would have to poll on its own. Optional so an older
   * client simply ignores a field it doesn't know about. Attached on both the
   * success and error snapshots — see `serveSessions`.
   */
  launching?: LaunchingSession[];
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
