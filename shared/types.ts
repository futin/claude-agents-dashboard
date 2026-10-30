/**
 * types.ts — the API contract shared by server and client.
 *
 * `GET /api/sessions` returns a {@link SessionsResponse}. `scanSessions` (server)
 * produces it; `useSessions` (client) consumes it. One definition, both sides.
 */

import type { JobError } from './routine-file.js';

/** The session's most-recent tool call. */
export interface Activity {
  tool: string;
  /**
   * The tool's argument (`describeTool` in transcript.ts) — file path, pattern,
   * command — capped at 200 chars. The collapsed rows show `tool` alone; this
   * is what the open body wraps, so it is sent long enough to be read.
   */
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

/** A task's state as the client sees it. `deleted` is not one: a deleted task leaves the list. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the session's own task list, folded from its `TaskCreate` / `TaskUpdate` calls (`server/lib/tasks.ts`). */
export interface SessionTask {
  id: string;
  subject: string;
  status: TaskStatus;
  /** Present-tense label ("Building the sidecar"); null when the create carried none (14 of 445 creates, 2026-10-07). */
  activeForm: string | null;
}

/** A single Claude Code session, as shown in one dashboard row. */
export interface Session {
  id: string;
  project: string;
  /**
   * Absolute cwd the session was *launched* in — its stable identity, and what
   * `project` is derived from. Not the newest transcript record's cwd, which a
   * `cd` inside a tool call drifts away from the process (bug-7). Null only
   * when no record in the transcript's head window carried one.
   */
  projectPath: string | null;
  /**
   * Name of the main checkout when `projectPath` is a linked git worktree (`zen-joliot-19719c` → `backlog-manager`), else null. `project` stays the
   * worktree folder, because pinned projects and the chat drawer key on it; the Sessions project filter files the row under `repo ?? project` instead
   * (`filterProjectOf`), so a worktree comes with its repo's chip. See `server/lib/worktree-repo.ts`.
   */
  repo: string | null;
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
  /**
   * Whether this session can be stopped from the dashboard, and whether a stop
   * is already under way — see {@link StopState}.
   *
   * **Absent means not stoppable**, and that is the honest encoding rather than
   * a missing case. Only a session this server spawned *and* still holds a live
   * `ChildProcess` handle for can be signalled, so the field is absent for a
   * terminal-started session (nothing here ever had its pid), for a resumed one
   * inside its first launch-TTL window, and for anything spawned before the last
   * dashboard restart — the handle died with the old process. The UI renders no
   * Stop control in any of those cases, which is exactly right: offering one
   * that could not work would be worse than offering none.
   */
  stopState?: StopState;
  /**
   * `true` when a live `claude` process carries this session's id (`--session-id`/`--resume` in its argv, read from `ps`) that this server holds no handle
   * for: a `dashboard` row with no {@link Session.stopState}. It exists because the transcript cannot say the process outlived its turn (a pending
   * background Monitor keeps a headless run alive) and the launch store forgets its children on a restart, so without it the drawer offers a resume that
   * `POST /api/spawn` then refuses with 409. **Absent, never `false`**, the encoding `stopState` uses, and absent whenever the `ps` probe was skipped or
   * failed. Display only: this server cannot signal that process, so it offers no Stop for it.
   */
  processLive?: true;
  /**
   * `true` when the desktop app owns this session's live process: it was launched there, or resumed there, and the server holds no handle for it. **Absent,
   * never `false`**, the encoding `processLive` uses. The drawer shows it in place of a resume the server would refuse.
   */
  desktopOwned?: true;
  activity: Activity | null;
  lastTimestamp: string | null;
  updatedMs: number;
  version: string | null;
  /** The `/kaizen` lesson logged for this session, or null if never inspected. */
  kaizenLesson: string | null;
  /** The session's task checklist: the executed plan's tasks when a plan resolves, else the confirmed `TaskCreate` list; null when neither exists. `[]` (all
   *  deleted) renders the same as null. */
  tasks: SessionTask[] | null;
  /** Basename (no `.md`) of the superpowers plan `tasks` was read from; null when `tasks` is the `TaskCreate` list or absent. */
  taskPlan: string | null;
}

/**
 * A spawned session's stoppability. `'ready'` — a live handle is held and no
 * stop has been asked for. `'stopping'` — SIGTERM has gone to its process
 * group and the server will escalate to SIGKILL once the grace elapses.
 *
 * There is deliberately no `'stopped'`: a session that stopped has no handle
 * and no live process, so it carries no `stopState` at all (see
 * {@link Session.stopState}).
 */
export type StopState = 'ready' | 'stopping';

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
  /**
   * Where the weekly window stands right now, 0–100, or null when the account
   * limits have not been read.
   *
   * Reported rather than left for the client to recover as
   * `walk[0].cum - walk[0].gain`: that identity holds only while there *is* a
   * walk, and the figure is the first thing the forecast page states — it has
   * to survive every reason the walk is absent.
   */
  utilizationPct: number | null;
  /** ISO 8601 end of the weekly window. Null under the same condition. */
  resetsAt: string | null;
  /**
   * Share of the remaining window's hours the profile expects to be active,
   * 0–1 — the walk's own `weightedMs / totalMs`. Null whenever there is no walk.
   *
   * The server already computes it to project with; recovering it in the client
   * would mean re-deriving each slice's length from timestamp deltas, and the
   * final slice is short by however much the reset is not on the hour.
   */
  dutyCycle: number | null;
}

/**
 * What the drift comparison concluded for one model. `surface-shift` is the
 * pooled rate crossing the drift band while the rate surface by surface did not
 * — the headless/interactive proportion moved, not the price (bug-23).
 */
export type ModelRateVerdict = 'drift' | 'stable' | 'mix-shift' | 'surface-shift' | 'thin';

/**
 * The session surface a model's tokens were spent from: headless `claude -p`
 * (transcript `entrypoint` `sdk-cli`) or anything a person drives. The two are
 * not the same goods — a headless token has measured ~1.8× the window cost of
 * an interactive one — so a rate is only comparable within one.
 */
export type ModelRateSurface = 'interactive' | 'headless';

/** One surface's slice of a model's rate. Nulls mean too thin to say, never zero. */
export interface ModelSurfaceRate {
  surface: ModelRateSurface;
  /** Weighted tokens per 1% over the current window, intervals this surface dominates only. */
  weightedPerPct: number | null;
  /** The same over the baseline window. */
  baselineWeightedPerPct: number | null;
  /** Current-window points behind it — evidence, reported whatever the rate. */
  utilSum: number;
}

/**
 * Whether the two-term (tokens + requests) split is reported for one model.
 *
 * Separate from {@link ModelRateVerdict} on purpose: that verdict is about
 * drift of the single pooled rate and means the same thing it always has.
 * `thin` here is the only failure mode — no counts recorded yet, too little
 * evidence, regressors that cannot be told apart, or a fit that came back
 * physically impossible all reduce to "not enough evidence to separate them".
 */
export type ModelSplitVerdict = 'fitted' | 'thin';

/**
 * Whether the one-term joint fit — the rate measured across the windows the
 * pooled dominance rate discards — is reported for one model.
 *
 * Collapses that fit's **three** refusals the same way {@link ModelSplitVerdict}
 * collapses the split's four: too little evidence, a model this data cannot
 * single out from the ones it always runs beside, and a physically impossible
 * coefficient all reduce to "not enough evidence to say". Three and not four
 * because the split's `collinear` has no counterpart here — it compares a
 * model's own two regressors, and this fit gives a model one. Which gate refused
 * stays diagnostic-only (`scripts/probe-usage-split.ts`); the API carries the
 * verdict, not the reason.
 */
export type ModelFitVerdict = 'fitted' | 'thin';

/**
 * What one percentage point of the **weekly** limit costs one model.
 *
 * The same two estimators as the 5-hour figures beside it — a pooled ratio over
 * the intervals this model owns outright, and the one-term joint fit — read off
 * a *different* interval set: weekly ticks paired tick to tick rather than
 * sample to sample, because the history log writes several lines between two
 * weekly ticks and consecutive pairing hands almost every tick's tokens to
 * intervals whose weekly utilization did not move. Measured on this machine's
 * logs that error is 6.5×–10.4× **low**, with every evidence counter looking
 * healthy (`docs/subsystems/usage-limits.md`).
 *
 * There is deliberately **no drift verdict and no baseline** here: `DRIFT_PCT`
 * was set from a measured day-to-day dispersion of the 5-hour rates, and no
 * such measurement exists for the weekly series yet. `verdict` says only
 * whether the pooled weekly rate is reported at all.
 */
export interface ModelWeeklyRate {
  /** Type-weighted tokens per 1% of the weekly window, pooled. Null when thin. */
  weightedPerPct: number | null;
  /** Raw tokens per 1%, the courtesy translation. Null under the same condition. */
  rawPerPct: number | null;
  /** The same quantity from the one-term joint fit. Null whenever `fitVerdict` is `thin`. */
  fittedWeightedPerPct: number | null;
  /** Whether the pooled weekly rate above is reported. */
  verdict: ModelFitVerdict;
  /** Whether the fitted weekly rate above is reported. */
  fitVerdict: ModelFitVerdict;
  /** Weekly intervals this model owned in the current window — evidence, shown either way. */
  intervals: number;
  /** Cumulative weekly utilization points behind them. */
  utilSum: number;
  /** Distinct UTC dates those intervals fall on. */
  days: number;
}

/**
 * Why a day cell on the token-value strip carries the figures it does, or none.
 *
 * - `pre-ledger` — the day ended before recording provably began. Nothing was
 *   measured and nothing is wrong; it ages out of the strip on its own.
 * - `none` — recording was on and this model owned no window that day.
 * - `thin` — owned windows, but under the current window's utilization floor,
 *   so the figures are carried and the cell is not coloured.
 * - `rated` — enough to colour.
 */
export type ModelDayState = 'pre-ledger' | 'none' | 'thin' | 'rated';

/**
 * One UTC day of one model's token value — a cell on the strip under the tiles.
 *
 * The same pooled ratio as the row's own rate, taken over one date of the same
 * 17-day horizon the verdict is fitted over, and no other span: the strip shows
 * the evidence the verdict rests on, so a reader can see whether "drift" is a
 * fortnight moving or one loud afternoon. Days are UTC dates because that is
 * the key the row's `days` counts are already taken on.
 */
export interface ModelDayRate {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  /** Type-weighted tokens per 1% that day. Null when `state` is `pre-ledger` or `none`. */
  weightedPerPct: number | null;
  /** Raw tokens per 1%, the courtesy translation. Null under the same condition. */
  rawPerPct: number | null;
  /** Windows this model owned that day — evidence, carried whatever the state. */
  intervals: number;
  /** Utilization points those windows moved. */
  utilSum: number;
  /**
   * Signed percent of the day's weighted rate against the row's baseline.
   * Null without a baseline or without a rate — the strip then shows the days
   * and judges none of them.
   */
  deviationPct: number | null;
  state: ModelDayState;
}

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
  /**
   * The same change with the headless/interactive mix held fixed: the current
   * window's points against what its tokens would have cost at each surface's
   * baseline rate. What `verdict` judges drift on whenever it is non-null;
   * null until enough of the current window has a surface with a baseline.
   */
  mixAdjustedDeviationPct: number | null;
  verdict: ModelRateVerdict;
  /** Both surfaces, `interactive` then `headless`, whatever the evidence. */
  surfaces: ModelSurfaceRate[];
  /** Intervals behind the current-window fit — the evidence, shown either way. */
  intervals: number;
  /** Cumulative utilization points behind it. */
  utilSum: number;
  /**
   * Distinct UTC dates those intervals fall on. Evidence, so it is reported
   * whatever the verdict — a rate needs days behind it as well as intervals,
   * and this is the figure that says whether it has them.
   */
  days: number;
  /**
   * The same count for the **baseline** window, reported whatever the verdict.
   * The one baseline number that survives a refusal: with every baseline rate
   * null, this is what separates "no baseline yet" from "still forming".
   */
  baselineDays: number;
  /**
   * Utilization points per 1M weighted tokens, from the two-term fit over the
   * same current window — the token half of the cost, with per-request spend
   * held out of it. Null whenever `splitVerdict` is `thin`.
   */
  pctPerMWeighted: number | null;
  /**
   * Utilization points per request, from the same fit — the half a single ratio
   * has nowhere to put, and hands to the token term instead. Null under the
   * same condition.
   */
  pctPerRequest: number | null;
  /**
   * Whether the split above is reported. The fields beside it — every rate,
   * the deviation and the verdict — are the single-ratio numbers either way,
   * unchanged by this fit.
   */
  splitVerdict: ModelSplitVerdict;
  /**
   * Weighted tokens per 1%, fitted **jointly** across every model over the
   * same current window — including the mixed windows `weightedPerPct` throws
   * away for want of a dominant model. Null whenever `fitVerdict` is `thin`.
   *
   * Published beside the pooled rate rather than instead of it, and no more
   * comparable across models than the pooled rate is: a model that fires more
   * requests per token still carries that per-request window cost inside this
   * number too.
   */
  fittedWeightedPerPct: number | null;
  /**
   * Whether the fitted rate above is reported. A model can carry this and
   * nothing else — a model that never dominates a window has no pooled rate,
   * and this is the only figure the card can show for it.
   */
  fitVerdict: ModelFitVerdict;
  /**
   * Signed percent of the fitted rate against the pooled one — the disclosure
   * that the two estimators disagree. Null when either rate is null.
   *
   * Computed here rather than in the card so the comparison lives in one
   * place; the client formats it and owns no threshold. **Not** an input to
   * `verdict` or `deviationPct`: drift is still judged on the pooled rate
   * alone, which is the only quantity with a measured baseline dispersion.
   */
  fitDeviationPct: number | null;
  /**
   * What a point of the **weekly** limit costs this model — the number that
   * actually constrains a week of work.
   *
   * **Always present.** A model with no weekly evidence carries `thin` verdicts,
   * null rates and zeroed counters, the shape this file already uses for the
   * 5-hour fit — not an absent key the card has to null-check.
   */
  weekly: ModelWeeklyRate;
  /**
   * One cell per UTC date of the 17-day horizon, oldest first — the days the
   * row's current and baseline rates were pooled from. Always present; a row
   * with no owned window carries a strip of `none` days.
   */
  daily: ModelDayRate[];
}

/** One drawn reading of a usage window: ms epoch and utilization percent. */
export interface UsageHistoryPoint {
  t: number;
  pct: number;
}

/**
 * One 5-hour or weekly window as it was recorded. Identity is the observed `resetsAt` only — never an assumed 5-hour or 7-day length.
 *
 * `segments` split wherever the series went silent for longer than the server's gap threshold, so the client never bridges an unrecorded stretch.
 */
export interface UsageHistoryWindow {
  /** The window's reset stamp, from its first sample; null when the endpoint reported the window unscoped. */
  resetsAt: string | null;
  firstT: number;
  lastT: number;
  /** Highest in-range utilization, taken before downsampling — so a thinned line never hides a peak from this figure. */
  peakPct: number;
  segments: UsageHistoryPoint[][];
}

/** A span inside the requested range with no sample at all: the server down, the token expired, or recording switched off. */
export interface UsageHistoryGap {
  fromT: number;
  toT: number;
}

/**
 * `GET /api/usage/history?days=N` — read-only, unpolled, served whenever the log has data.
 *
 * Serves downsampled utilization only: never file paths, never token counts. It is a separate endpoint precisely so that `UsageProfileResponse`'s
 * "never includes raw samples" stays true. Times are ms epoch rather than the ISO strings used elsewhere in this file, because a body carries
 * thousands of points and ms epoch is the log's own unit.
 */
export interface UsageHistoryResponse {
  /** The recording setting. False with data means the history stops where recording was switched off. */
  recording: boolean;
  days: number;
  sinceT: number;
  nowT: number;
  /** Downsampling bucket width; each bucket keeps its peak. */
  bucketMs: number;
  fiveHour: UsageHistoryWindow[];
  weekly: UsageHistoryWindow[];
  gaps: UsageHistoryGap[];
  /** Present only when the read failed; the series are then empty and one gap covers the range. */
  error?: true;
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
  /**
   * Which refusals cost what, over the same horizon as `externalSharePct`.
   * Never absent — an empty body carries a zeroed instance.
   */
  coverage: UsageCoverage;
  /**
   * Did **any** sample in the read window carry a weekly reading at all.
   *
   * The field that keeps the first fortnight honest: every line written before
   * the weekly window was recorded is legitimately weekly-less, so this
   * separates "the record predates the widening" from "the weekly counter has
   * not moved". The card says which, rather than showing empty slots.
   */
  weeklyRecorded: boolean;
  /** The same refusal breakdown over the **weekly** interval set, same horizon. */
  weeklyCoverage: UsageCoverage;
  /** Share of moved weekly utilization this machine cannot account for. */
  weeklyExternalSharePct: number | null;
  /**
   * Is a time-of-day capacity promotion running — limits raised outside weekday
   * peak hours, as they were 2026-03-13 → 2026-03-27. Always present, like
   * `weekly`: a thin reading is a `none` verdict with zeroed counters, never an
   * absent key.
   */
  boost: UsageBoost;
  /** Only set when the fit itself failed; a missing ledger is not an error. */
  error?: boolean;
}

/** What the off-peak boost detector concluded. Shared by the weekday and the weekend verdict. */
export type BoostVerdict = 'boost' | 'none' | 'inconclusive';

/**
 * Why a verdict is not `boost`, or null when it is. `thin-evidence` — too few
 * days, or a run too short to claim; `flat` — the ratio did not move;
 * `mix-shift` — weighted and raw disagreed, which a real limit change never does.
 */
export type BoostReason = 'thin-evidence' | 'flat' | 'mix-shift';

/** One ET hour that carries a detected boost, as observed rather than as announced. */
export interface BoostHour {
  /** 0–23, America/New_York. */
  hour: number;
  weightedPerPct: number;
  utilSum: number;
}

/**
 * The **weekday** verdict: each ET weekday's off-peak cells against that same
 * day's peak cells, so every day is its own control.
 */
export interface UsageBoost {
  verdict: BoostVerdict;
  reason: BoostReason | null;
  /** The one model measured — the one holding the most owned utilization over the horizon. */
  model: string | null;
  /** Off-peak ÷ peak weighted tokens per point, pooled over the days behind it. */
  ratio: number | null;
  rawRatio: number | null;
  /** Paired days behind `ratio`: the run when `boost`, every paired day otherwise. */
  days: number;
  /** ET date (`YYYY-MM-DD`) of the oldest day in the run, or null. */
  since: string | null;
  /** The peak window under test, half-open, in ET hours — echoed so the card owns no literal. */
  peakStartHourEt: number;
  peakEndHourEt: number;
  /** Hours clearing the boost floor across the run. Empty unless `verdict` is `boost`. */
  hours: BoostHour[];
  weekend: BoostWeekend;
}

/**
 * The **weekend** verdict — the weaker instrument of the two, and never merged
 * into the weekday one. A weekend day has no unboosted hours to pair against,
 * so each is compared against the weekday *peak* rate pooled across every
 * weekday date in the horizon: a cross-day control, which a weekend-long change
 * in the work itself can move and the weekday verdict cannot.
 */
export interface BoostWeekend {
  verdict: BoostVerdict;
  reason: BoostReason | null;
  /** Weekend ÷ pooled weekday-peak weighted tokens per point. Null without a control. */
  ratio: number | null;
  rawRatio: number | null;
  /** Weekend days behind `ratio`: the run when `boost`, every qualifying weekend day otherwise. */
  days: number;
  since: string | null;
  /** How many weekday ET dates the pooled control was built from — only peak cells that clear the cell floor count — how strong the control is. */
  controlDays: number;
}

/**
 * How much of the measured spend reached a rate, and what each refusal cost.
 *
 * Every field but `recorderBreakHours` and `startProvable` is in utilization
 * percentage **points** — not percentages — so a reader can check that the
 * buckets sum to `movedPct`. Unlike the rates beside them these are
 * **counters, not fits**: there are no nulls here and a zero is a measured
 * zero, not an absence of evidence.
 *
 * `pricedPct + mixedPct + externalPct + preLedgerPct + missingPct +
 * partialPct === movedPct`. Idle intervals are in none of them and out of
 * `movedPct`: they measure nothing moving.
 */
export interface UsageCoverage {
  /** The denominator: every point the 5-hour counter moved in the horizon. */
  movedPct: number;
  /** Points in intervals one model owned — the ones a rate is fitted on. */
  pricedPct: number;
  /** No model held 90% of the tokens, so no rate could be attributed. */
  mixedPct: number;
  /** Moved on almost no local spend — another device on the same account. */
  externalPct: number;
  /** Provably before the ledger existed. Benign: it ages out of the window on its own. */
  preLedgerPct: number;
  /** The recorder was down — recording had begun and covered none of the span. */
  missingPct: number;
  /** The recorder ran but covered under 80% of the span. */
  partialPct: number;
  /**
   * **Hours**, not points: how long the ledger's own lines failed to abut
   * inside the horizon. A different measurement from `missingPct` — most such
   * breaks overlap no interval at all, because the server that writes the
   * ledger also writes the history log. The hours say how much *time* went
   * unrecorded, the points say what it cost.
   */
  recorderBreakHours: number;
  /**
   * Whether the start of recording could be proven from the ledger's first
   * line. False when there is no ledger or it may have rotated — and then
   * `preLedgerPct` is 0 and `missingPct` has absorbed it, which the card says
   * out loud rather than reporting downtime that never happened.
   */
  startProvable: boolean;
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
export type UsageStatus = 'ok' | 'token-expired' | 'signed-out' | 'unavailable';

/**
 * Who the CLI is signed in as — read from `~/.claude.json` → `oauthAccount`,
 * the profile Claude Code caches after an OAuth login. Local disk, no network:
 * the usage endpoint answers with numbers, not with a name, so this is the
 * only place the account has one.
 *
 * Every field is a display string the server has already resolved, because the
 * raw record is internal tier codes (`default_claude_max_5x`, `team_tier_1`)
 * that no client should be in the business of translating. A field the record
 * does not carry is `''` and the header simply omits it.
 */
export interface AccountProfile {
  /** `fullName`, else `displayName`. '' when neither is set. */
  name: string;
  /** `emailAddress`. '' when absent. */
  email: string;
  /** `organizationName` — '' on a personal account. */
  organization: string;
  /** `userRateLimitTier` as a plan label, e.g. `Max 5×`. '' when unrecognised. */
  plan: string;
  /** `seatTier` prettified, e.g. 'Team tier 1'. '' when absent. */
  seat: string;
  /** `hasExtraUsageEnabled` — paid usage beyond the plan's windows is on. */
  extraUsage: boolean;
}

/**
 * What a release is: `feat`, `fix` and `perf` cut one; `baseline` is the hand-cut tag versioning starts from. Four members where release-kit's own
 * `ReleaseType` has three — release-kit types `Release.type` as `ReleaseType | 'baseline'`, so the two are assignable but are not the same name.
 */
export type ReleaseType = 'feat' | 'fix' | 'perf' | 'baseline';

/** One annotated `vX.Y.Z` tag, as release-kit's `readReleases` parses it (`docs/subsystems/releases.md`). */
export interface Release {
  /** No leading `v`: `0.2.0`. */
  version: string;
  /** Tag creation time, ISO. */
  date: string;
  /** The tag subject without its trailing `(#N)` — still carrying the Conventional Commits prefix, which the client strips for display. */
  title: string;
  type: ReleaseType;
  scope?: string;
  pr?: number;
  breaking: boolean;
  /** The PR's `## What's new` section, markdown; empty when it had none. */
  notes: string;
  /** The PR page, present only when `pr` is and `origin` is a GitHub remote. */
  url?: string;
  /**
   * The PRs this release carries: none for the baseline, one for a per-PR tag, every rolled-up PR in body order for a nightly rollup tag (which has no
   * `pr`). Optional because a server on release-kit before v1.4.0 never sends it.
   */
  items?: ReleaseItem[];
}

/** One PR inside a release, as release-kit's `ReleaseItem` carries it. */
export interface ReleaseItem {
  pr: number;
  type: Exclude<ReleaseType, 'baseline'>;
  scope?: string;
  breaking: boolean;
  /** A per-PR tag's item keeps the full PR title; a rollup item has one, prefix stripped, only when it has no notes. */
  title?: string;
  notes: string;
  /** The PR page when `origin` is a GitHub remote. */
  url?: string;
}

/**
 * `GET /api/releases` — the dashboard's own release history, read from the local checkout's tags. `current` is `git describe` against those tags: on a
 * tag `ahead` is 0, three commits past one it is 3. Not a checkout, no git, or no tags → `{ current: null, releases: [] }`, never an error status.
 */
export interface ReleasesResponse {
  current: { version: string; ahead: number } | null;
  /** Newest first. */
  releases: Release[];
}

/**
 * `GET /api/account` — everything the header account chip draws, on one small
 * body it can poll on its own clock.
 *
 * Deliberately not folded into {@link SessionsResponse}: that snapshot is a
 * full transcript scan polled every 3s and only while the Sessions section is
 * mounted, and the chip is in the shell above every section. This body reads
 * one cached file and one cached usage state, so it is cheap to poll slowly
 * (30s) from anywhere in the app.
 */
export interface AccountResponse {
  /** null when `~/.claude.json` is missing, unreadable, or carries no account. */
  profile: AccountProfile | null;
  /** Same field, same meaning, as {@link SessionsResponse.usage}. */
  usage?: UsageLimits | null;
  /** Same field, same meaning, as {@link SessionsResponse.usageStatus}. */
  usageStatus?: UsageStatus;
}

/** One subagent launched via the `Task` tool, paired from the parent transcript. */
export interface AgentJob {
  /**
   * The Task tool_use id (pairs with the later tool_result.tool_use_id) — or, on a
   * `resumed` row, the id of the SendMessage call that woke the agent.
   */
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
   * The harness's own token figure (sync: toolUseResult.totalTokens; async:
   * <subagent_tokens> in the notification). It is the subagent's FINAL context
   * size, not what it spent — a many-turn subagent replays its context every
   * turn and none of that is in here. Null while running or on old transcripts
   * that lack the field. `SessionAnalysis.bySubagent` replaces it with the
   * spend summed from the subagent's own transcript where one is readable.
   */
  tokens: number | null;
  /**
   * The subagent's own id — the `<id>` in `<sessionId>/subagents/agent-<id>.jsonl`.
   * From the sync toolUseResult or the async launch ack; null on old transcripts.
   */
  agentId: string | null;
  /** Tool calls the subagent made (totalToolUseCount / <tool_uses>). Same nullability. */
  toolUses: number | null;
  /**
   * Present only on a run started by SendMessage waking a stopped subagent. It shares
   * `agentId` — and so one transcript — with the launch row it resumed.
   */
  resumed?: true;
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
  /**
   * The Desktop app's recommended next-step reply, on a `mcp__ccd_turn__wrap_up` line only: its first button's `message` (or `label` when the label is
   * the whole message). Absent when that first button is an app action — the composer offers it on Tab (`client/src/lib/composer.ts`).
   */
  suggestion?: string;
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
 * Remote answers — the first of the four session write paths (see
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

/**
 * What the calling peer may do without a token: `open` (this machine, or a tailnet device while `trustTailnet` is on), `token` (it needs
 * `Bearer <ANSWER_TOKEN>`), `none` (read-only: no token is set, so nothing it sends can unlock a write).
 */
export type WriteAccess = 'open' | 'token' | 'none';

/**
 * What a push notification can announce: four session events, a failed routine, a backlog tick that stopped grooming at its plan-review cap
 * (`tick-capped`), and the 5-hour usage window reaching its limit (`usage-limit`) or resetting after one (`usage-reset`). The last four ignore the
 * session-only `require*` conditions.
 */
export type NotifyEvent = 'question' | 'stop' | 'permission' | 'plan' | 'routine-failed' | 'tick-capped' | 'usage-limit' | 'usage-reset';

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

/** A write that answers nothing but its success: the answer, plan-answer and message-answer routes, the notify hooks, a codegraph run, a reveal. */
export interface OkResponse { ok: true }

/** `POST /api/spawn/:id/stop` and `POST /api/sessions/:id/stop`: killed outright, or a graceful stop still landing. */
export type StopResponse = { stopped: true } | { stopping: true };

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
  /**
   * Seconds between the server's own `git fetch origin` over the pinned repos; one of 0, 30, 60, 120, 300, 600, where `0` is off. Shared, not per-device:
   * one timer serves every browser, and it idles while nobody is watching the git view. See docs/subsystems/git-stats.md.
   */
  gitFetchSecs: number;
  /**
   * Which surface the launch form preselects. Shared, not per-device, and only a preselection: the form always sends its own `surface`, and a request
   * with none is a dashboard launch whatever this says (an API caller never inherits it).
   */
  launchSurfaceDefault: LaunchSurface;
  /**
   * Writes from a tailnet peer pass without `ANSWER_TOKEN`. On by default. Shared because the write gate on the server reads it; turning it off from a
   * tailnet device locks that device out of its own next write. See docs/subsystems/remote-access.md.
   */
  trustTailnet: boolean;
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
  /**
   * Whether `SHOW_USAGE` is on. Off, the server never reads usage, so the usage-limit alerts cannot fire and their Settings rows say why.
   */
  usageAvailable: boolean;
  /**
   * Names of `.env` settings that have been edited since the server started, and
   * are therefore *not* what it is running on — config is read once, at startup.
   * Empty when the file matches the process, which is the normal case.
   *
   * Names only. Two of the keys most likely to appear here (`NTFY_TOPIC`,
   * `NTFY_TOPIC_DESK`) are credentials, and this payload is served to any client
   * that can reach the dashboard. Same posture as `notifyAvailable`: report that
   * something is configured, never what.
   *
   * Detected, not fixed — the app does not reload itself — so the UI's job is to
   * say "restart to pick this up", like it does for {@link EnvOverride}.
   */
  staleEnvKeys: string[];
}

/**
 * `POST /api/settings`'s body: the {@link ServerSettings} keys the browser may change, each optional, plus a partial `notify` block. Picked from
 * `ServerSettings` so a renamed field breaks the build on both sides; the server-derived fields (`notifyAvailable`, `usageAvailable`, …) are not in it.
 */
export type ServerSettingsPatch =
  Partial<Pick<ServerSettings, 'idleSecs' | 'answerSecs' | 'recordUsageHistory' | 'gitFetchSecs' | 'trustTailnet' | 'launchSurfaceDefault'>> & { notify?: NotifyPatch };

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
/** `POST /api/remote-answer`: the switch, and how many held waits switching off released. */
export interface RemoteAnswerToggleResponse extends RemoteAnswerState { released: number }

export interface HealthResponse extends RemoteAnswerState {
  ok: true;
  origin?: ConnectionOrigin;
  /** Mirrors `ServerSettings.idleSecs`. Carried here because the hooks already probe health. */
  idleSecs?: number;
  /** Mirrors `ServerSettings.answerSecs`, read off the same probe. */
  answerSecs?: number;
  /** Write access for the calling peer, computed per request. Absent on an older server. */
  writeAccess?: WriteAccess;
  /**
   * True when this caller would need the token to write: `writeAccess === 'token'`. Health is the one endpoint the hooks can reach without a
   * token, which makes it the only place that can tell them one is needed: before this field, a hook with no `~/.claude/hooks/dashboard-token`
   * got a healthy probe and then a silent 403 on every write, indistinguishable from the feature being switched off (backlog bug-6). It announces
   * only *that* a token is required — the same thing a 403 already announces — never which. Absent on an older server, which is why
   * `remote-decision-hook.sh` treats a missing field as `false` and stays quiet rather than warning wrongly.
   */
  tokenRequired?: boolean;
  /** True when the Claude desktop app can be launched from here (macOS with `/Applications/Claude.app`). Absent on an older server. */
  desktopAvailable?: boolean;
  /** Mirrors `ServerSettings.launchSurfaceDefault`, so the launch form can preselect without a second fetch. Absent on an older server. */
  launchSurfaceDefault?: LaunchSurface;
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
  /**
   * The mode the Git Sync button launches with: `SYNC_PERMISSION_MODE` (default `'auto'`) clamped to `spawnMaxPermission`. Absent on an older server;
   * the button then sends no mode and the server's own default applies.
   */
  syncPermissionMode?: PermissionMode;
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

/** A PR's CI rollup folded into counts; `total` = passed + failed + running (skipped and neutral checks never count). */
export interface PrChecks {
  passed: number;
  failed: number;
  running: number;
  total: number;
}

/** What `gh pr view` said about a PR, folded for the chat card. */
export interface SessionPrLive {
  state: 'open' | 'draft' | 'merged' | 'closed';
  title: string;
  head: string;
  base: string;
  /** Null when the PR has no counted checks at all. */
  checks: PrChecks | null;
  review: 'approved' | 'changes' | 'required' | 'none';
  /** `unknown` while GitHub is still computing mergeability. */
  merge: 'clean' | 'conflicts' | 'unknown';
  /** When it merged or closed; null while open or draft. */
  endedAt: string | null;
}

/** The newest PR a session created: transcript facts always, live facts when `gh` answered, a reason when it didn't. */
export interface SessionPrInfo {
  url: string;
  number: number;
  /** `owner/repo`, from the URL; null when the URL does not have that shape. */
  repo: string | null;
  /** `gh`'s title when it answered, else the `--title` the create carried, else null. */
  title: string | null;
  /** Null when `gh` could not be read; `unavailable` then says why. */
  live: SessionPrLive | null;
  unavailable: string | null;
}

/** Null = the session created no PR, and the card renders nothing. */
export type SessionPr = SessionPrInfo | null;

/** Payload of `GET /api/sessions/:id/pr`. `error` = the read failed; keep the last card. */
export interface SessionPrResponse {
  id: string;
  pr: SessionPr;
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
  /**
   * `maxCombined` topped 250k (out of a 200k window's reach — it compacts near 160k; the window itself is inferred, never recorded) and the session
   * never compacted. False when any main-chain `compact_boundary` record is present; for transcripts without one, false when a turn fell below
   * half the running peak, the drop compaction leaves. A session with no turns, or one that compacted after its peak, reads false.
   */
  neverCompacted: boolean;
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
  /**
   * Tokens this tool injected into context: every matched tool_result's text
   * (error text included) sized at chars ÷ 4 and summed per call — not split
   * across a turn. Approximate in size but measured per call, so the firmer
   * of the two figures and the key `byTool` sorts by. Image blocks count 0.
   */
  resultTokens: number;
}

/** Aggregate over the subagents ({@link AgentJob}) a session launched. */
export interface SubagentTotals {
  count: number;
  /**
   * Everything the subagents moved, separate from the main-agent totals: `usage.combined`
   * plus the harness figure for each of the `fallbackCount` subagents.
   */
  tokens: number;
  /**
   * The four token classes, summed over every unique `message.id` in the subagents' own
   * `<sessionId>/subagents/agent-*.jsonl` transcripts — what they spent vs what they replayed.
   */
  usage: TokenTotals;
  /**
   * Finished subagents with no readable transcript, or one that sums below the harness figure
   * (still being written). Counted at the harness figure — their final context size, a lower bound.
   */
  fallbackCount: number;
  /** Subagents with no figure at all (still running / old transcript). */
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
  /** Per-tool main-agent usage, largest context contributor (resultTokens) first. */
  byTool: ToolStat[];
  /**
   * Subagents launched (from `readAgents`), newest-first. `tokens` is the figure counted into
   * `subagentTotals.tokens` — transcript spend, else the harness fallback.
   */
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
 * Lessons with no status line are still open — except a `none` lesson, which
 * is born closed and never gets one ({@link AnalyticsReport.lessonNone}).
 */
export interface LessonStatus {
  status: 'actioned' | 'promoted' | 'dropped';
  /** YYYY-MM-DD of the status line. */
  date: string;
  /** Free-text note after the em dash, e.g. "added to project CLAUDE.md". */
  note?: string;
}

/**
 * Whether an actioned or promoted lesson's rule worked, from the log's `verdict` lines, which only `/kaizen review` writes: the project's sessions
 * before and after the status date, compared on the field the lesson's `evidence` names. `confounded` when attribution is unclear. A verdict never
 * changes whether a lesson is open — that is still {@link LessonStatus} alone.
 */
export interface LessonVerdict {
  verdict: 'helped' | 'hurt' | 'no-effect' | 'confounded';
  /** YYYY-MM-DD of the verdict line. */
  date: string;
  /** Free-text note after the em dash: the field, the before → after medians and both session counts. */
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
  /** The session-analytics-log lesson text (always present — it's what puts the session here), without its ` ‖ ` field tail. */
  lesson: string;
  /** The lesson's structured tail, when the line carries one with at least one known key. */
  lessonFields?: LessonFields;
  /** True for a `Lesson: none — <reason>` line: the session taught nothing new, so the lesson is settled without a status line. */
  lessonNone?: boolean;
  /** Newest `status` line for this session, or null while the lesson is still open (or is a `none` lesson). */
  lessonStatus?: LessonStatus | null;
  /** Newest `verdict` line for this session, or null while none has been written. */
  lessonVerdict?: LessonVerdict | null;
}

/**
 * The fields a kaizen lesson line may carry after ` ‖ `: which situation it should fire on next time, which artifact it changes (or `habit`), what in
 * the record backs it, and how sure it is. Each is absent when the line does not carry it.
 */
export interface LessonFields {
  cue?: string;
  component?: string;
  evidence?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** The parenthesised reason after the confidence level. */
  confidenceReason?: string;
}

/** Payload of `GET /api/analytics` — the last N logged sessions, newest-first. */
export interface AnalyticsResponse {
  generatedAt: string;
  /** Display cap (default 5). `reports.length <= keep`. */
  keep: number;
  reports: AnalyticsReport[];
  /** Date of the newest `review:` marker in the log (YYYY-MM-DD), else null. */
  lastReviewAt?: string | null;
  /** True when lessons other than `none` ones exist and no review marker landed in the last 7 days. */
  reviewDue?: boolean;
  /** Set only when listing failed. */
  error?: boolean;
}

/**
 * Claude Configs section (`GET /api/configs*`) — read-only view over Claude
 * config on disk: skills, agents, commands, rules, hooks, memory, settings,
 * installed plugins and MCP servers, per scope (global `~/.claude` or one project).
 */

/** Where a config item comes from: 'user', 'project', 'local' (MCP servers only), or 'plugin:<name>'. */
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

/**
 * One declared MCP server. `source` follows Claude Code's own scope names: 'user' (root `mcpServers` in
 * `~/.claude.json`), 'local' (that file's `projects[<path>].mcpServers`), 'project' (`<root>/.mcp.json`) or
 * 'plugin:<name>'. Secret-bearing `env` and `headers` arrive as key names only — their values never leave the server.
 */
export interface McpServerInfo {
  name: string;
  source: ItemSource;
  /** Declared `type` ('stdio' | 'http' | 'sse' | …), else 'stdio'. */
  transport: string;
  command: string | null;
  /** String args only; anything else is dropped. */
  args: string[];
  url: string | null;
  /** Sorted `env` key names; values are never included. */
  envKeys: string[];
  /** Sorted `headers` key names; values are never included. */
  headerKeys: string[];
  /** Absolute path of the file that declared it. Display only — never servable by the file endpoint. */
  declaredIn: string;
  /** Plugin disabled, or the name is in the project entry's disabledMcpServers / disabledMcpjsonServers. */
  disabled: boolean;
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
  /** Global: user then plugin servers. Project: local then project servers. Env/header values are never included. */
  mcpServers: McpServerInfo[];
  error?: boolean;
}

/** A recently-active project (Claude Configs side-menu entry). */
export interface ProjectRef {
  /**
   * Encoded ~/.claude/projects dir name — the key for /api/configs/project,
   * and unique within a `projects[]`: one entry per dir, so the rail can key
   * rows by it and `resolveProject` maps it to exactly one path.
   */
  dirName: string;
  /** Basename of path. */
  name: string;
  /** Real cwd from the transcript. */
  path: string;
  lastActiveMs: number;
  /**
   * Present, and only ever `true`, when the dir is pinned (#161): listed past
   * `LOOKBACK_HOURS`. Absent otherwise — consumers that don't know pins ignore it.
   */
  pinned?: true;
}

/** One stored pin, as `GET /api/pins` reports it (#161). */
export interface PinRow {
  dirName: string;
  /** Basename of `path`, or the dirName when no transcript is left to resolve a path from. */
  name: string;
  /** The cwd the dir resolves to, or null when no transcript is left. */
  path: string | null;
  lastActiveMs: number | null;
  /**
   * False for a dead pin: its cwd is gone or is now a linked worktree, so every
   * list hides it. It stays stored until unpinned.
   */
  listed: boolean;
}

/** Body of `POST /api/open-folder`: the path of a pin listed now, compared as a string with nothing normalised. */
export interface OpenFolderRequest {
  path: string;
}

/** Payload of a successful `POST /api/open-folder`: macOS `open` launched on the server host. */
export interface OpenFolderResponse {
  ok: true;
}

/** Payload of `GET /api/pins`, and of a successful `POST /api/pins` (#161) or `POST /api/pins/order`. */
export interface PinsResponse {
  /** Every stored pin, in pin order. */
  pinned: PinRow[];
  /**
   * Unpinned projects inside the lookback, newest-first — already listed today,
   * offered so a busy project can be pinned before it ages out. Never a dir
   * Claude made for itself (a scratchpad, a scratch workspace, `~/.claude`).
   */
  recent: ProjectRef[];
  /** Projects offered for pinning: outside the lookback, inside 30 days, newest-first, same exclusion as `recent`. */
  older: ProjectRef[];
  /** The server's home dir, so the UI can show paths as `~/…`. */
  home: string;
}

/** One unmerged local branch of a pinned repo (Git Stats, `docs/superpowers/specs/2026-10-01-git-stats-design.md` §2). */
export interface GitBranch {
  name: string;
  /** Commits on the branch and not on the base (`origin/<trunk>` when it exists, else the local trunk); null only when the repo has no trunk. */
  ahead: number | null;
  /** Commits on the base and not on the branch; null only when the repo has no trunk. */
  behind: number | null;
  lastCommitMs: number;
  /** The linked worktree this branch is checked out in; null when it is checked out nowhere or only in the main worktree. */
  worktreePath: string | null;
}

/** Fields every `RepoGitStats` variant carries, copied from the pin row. */
interface RepoGitStatsPin {
  dirName: string;
  name: string;
  /** The pin's cwd, which may be a subdirectory of the repo; null for a dead pin. */
  path: string | null;
}

/**
 * Local git state of one pinned project, read-only. `missing` is a dead pin or a folder that is gone, `not-git` a folder outside any
 * repo, `error` a git call that failed or timed out.
 */
export type RepoGitStats =
  | (RepoGitStatsPin & { state: 'missing' })
  | (RepoGitStatsPin & { state: 'not-git' })
  | (RepoGitStatsPin & { state: 'error'; message: string })
  | (RepoGitStatsPin & {
      state: 'ok';
      /** `git rev-parse --show-toplevel`: the repo root, or the linked worktree's root when the pin is one. */
      toplevel: string;
      /** Current branch; null when detached, including mid-rebase. On an unborn HEAD, the name HEAD points at. */
      branch: string | null;
      /** `rev-parse --short HEAD` when detached, else null. */
      detachedSha: string | null;
      onTrunk: boolean;
      /** Entries the way `git status` lists them: a rename is one, an untracked directory is one, ignored files are none. */
      uncommitted: number;
      /** `origin/HEAD`'s branch, else `main`, else `master`; null when there is none. */
      trunk: string | null;
      hasOrigin: boolean;
      /** `git remote get-url origin` from local config (no network), with any userinfo removed so no credential leaves the server; null without an origin or when it cannot be read. */
      originUrl: string | null;
      /** Local trunk vs `origin/<trunk>`; null without an origin, a trunk, an `origin/<trunk>` or a local `<trunk>`. */
      trunkVsOrigin: { ahead: number; behind: number } | null;
      /** Which refs of the trunk exist; null exactly when `trunk` is null. Lets the client tell "<trunk> not on origin" from "<trunk> only on origin", which `trunkVsOrigin: null` alone cannot. */
      trunkRefs: { local: boolean; origin: boolean } | null;
      /**
       * The local trunk is checked out in a worktree other than this pin's `toplevel`, so a quick Pull cannot move it without a checkout. False when there
       * is no local trunk or it is checked out nowhere else.
       */
      trunkCheckedOutElsewhere: boolean;
      /**
       * The current branch against its configured upstream (`%(upstream)`), counted over local refs only. `upstream` is the short name (`origin/feat/x`);
       * `counts` is null when the upstream is configured but its ref does not resolve (gone, e.g. after `fetch --prune`). The whole field is null when
       * detached, on the trunk, on an unborn branch, or with no upstream configured. `ahead` = commits only on the branch, `behind` = commits only on the
       * upstream, the same orientation as `GitBranch`.
       */
      currentVsUpstream: { upstream: string; counts: { ahead: number; behind: number } | null } | null;
      /** Newest `FETCH_HEAD` mtime across every worktree (epoch ms); null when never fetched. The client derives the age. */
      fetchedAtMs: number | null;
      /** What this server's own last fetch said; null before it ran one. */
      lastFetch: RepoLastFetch | null;
      /** Unmerged branches, trunk excluded, newest commit first, at most 50. */
      branches: GitBranch[];
      /** Every unmerged branch, before the cap. */
      unmergedTotal: number;
      /** Branches proven merged into the base, which the page hides behind a count. */
      mergedCount: number;
    });

/** Why a `git fetch origin` failed, as far as its stderr can be told apart. */
export type FetchError = 'auth' | 'offline' | 'lock' | 'timeout' | 'other';

/** The verdict of this server's last fetch of one repo: when it ended and how (null error = it worked). */
export interface RepoLastFetch {
  atMs: number;
  error: FetchError | null;
}

/** The fetch timer's state, so the client can say when the next one is due or that one is running. Times are epoch ms; null when there is none. */
export interface FetchClock {
  /** The `gitFetchSecs` in force; 0 when fetching is off. */
  intervalSecs: number;
  nextAtMs: number | null;
  runningSinceMs: number | null;
  lastEndedMs: number | null;
}

/** `POST /api/git-fetch`: the clock once the fetch has finished. */
export interface GitFetchResponse { fetch: FetchClock }

/** Payload of `GET /api/git-stats`: one entry per pin, in pin order. */
export interface GitStatsResponse {
  repos: RepoGitStats[];
  fetch: FetchClock;
  generatedAt: number;
}

/** A quick git op from the Sync key's menu: a fast-forward pull or push, run on the server with no Claude session. */
export type GitQuickOp = 'pull' | 'push';

/** Body of `POST /api/git-quick`. `dirName` names a pin; the server never takes a path from the client. */
export interface GitQuickRequest {
  dirName: string;
  op: GitQuickOp;
}

/** `ff`: the checked-out branch (trunk or not) fast-forwarded; `move`: the local trunk moved without a checkout; `push`: the current branch pushed. */
export type GitQuickPartKind = 'ff' | 'move' | 'push';

/**
 * One ref a quick op moved, or tried to. `target` is the ref on the other side (`origin/main`, `origin/feature/x`). A failed part carries git's first
 * non-empty stderr line with any `error: ` / `fatal: ` prefix stripped (`''` when git said nothing), or `timedOut` when the call was killed.
 */
export type GitQuickPart = { kind: GitQuickPartKind; branch: string; target: string } & (
  | { ok: true; commits: number }
  | { ok: false; timedOut: boolean; detail: string }
);

/** Why a quick op did nothing at all. `fetch-running` and `busy` answer 409; the rest 200. */
export type GitQuickRefusal = 'not-ok' | 'no-origin' | 'detached' | 'in-progress' | 'fetch-running' | 'busy' | 'nothing' | 'fetch-failed';

/** Answer of `POST /api/git-quick`: either parts (some may have failed) or one refusal. `detail` and `timedOut` describe a `fetch-failed`. */
export interface GitQuickResponse {
  op: GitQuickOp;
  /** The pin's display name, which every result line starts with. */
  repo: string;
  parts: GitQuickPart[];
  refusal: GitQuickRefusal | null;
  detail: string | null;
  timedOut: boolean;
}

/** What a codegraph run does: `sync` applies pending changes, `reindex` rebuilds the whole graph. */
export type CodegraphRunKind = 'sync' | 'reindex';

/** A run in flight on one repo: ours, or a rebuild started from a terminal. */
export interface CodegraphRun {
  kind: CodegraphRunKind;
  startedAtMs: number;
}

/** How the last run on a repo ended, so a failed sync stays visible after it is over. */
export interface CodegraphLastRun {
  kind: CodegraphRunKind;
  ok: boolean;
  endedAtMs: number;
  message: string;
}

/** The CLI's `index.state`; a CLI `null` (index older than the marker) is read as `complete`. */
export type CodegraphIndexState = 'indexing' | 'complete' | 'partial' | 'failed';

/** The fields of `codegraph status --json` the view uses; the client never sees raw CLI output. */
export interface CodegraphStats {
  lastIndexedMs: number | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  dbSizeBytes: number;
  nodesByKind: Record<string, number>;
  languages: string[];
  pending: { added: number; modified: number; removed: number };
  worktreeMismatch: { worktreeRoot: string; indexRoot: string } | null;
  version: string;
  indexState: CodegraphIndexState;
  reindexRecommended: boolean;
  /** Null for an index built before the CLI stamped its version. */
  builtWithVersion: string | null;
  builtWithExtractionVersion: number | null;
  currentExtractionVersion: number | null;
}

/** One pinned project's codegraph state: `ok` carries stats, `building` is a rebuild with no good stats yet. */
export type CodegraphRepo = {
  dirName: string;
  name: string;
  path: string | null;
  watching: boolean;
  watcherSinceMs: number | null;
  rebuildLive: boolean;
  run: CodegraphRun | null;
  lastRun: CodegraphLastRun | null;
} & (
  | { state: 'ok'; root: string; stats: CodegraphStats }
  | { state: 'building'; root: string }
  | { state: 'none' }
  | { state: 'missing' }
  | { state: 'error'; root: string; message: string }
);

/** Payload of `GET /api/codegraph`: one entry per pin, in pin order; `cli: 'missing'` is said once for the page. */
export interface CodegraphResponse {
  generatedAt: number;
  cli: 'ok' | 'missing';
  repos: CodegraphRepo[];
}

/** Body of `POST /api/codegraph/run`. */
export interface CodegraphRunRequest {
  dirName: string;
  kind: CodegraphRunKind;
}

/** Payload of `GET /api/configs`. */
export interface ManagementIndex {
  generatedAt: string;
  global: ScopeConfig;
  /** Newest-first. */
  projects: ProjectRef[];
  error?: boolean;
}

/** Payload of `GET /api/configs/file`. */
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

/** Where a launch runs: the dashboard's own headless `claude`, or the Claude desktop app opened through its `claude://` URL. */
export type LaunchSurface = 'dashboard' | 'desktop';

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
  /** Where to launch. Absent means `dashboard` — never the `launchSurfaceDefault` setting, which only preselects the form. */
  surface?: LaunchSurface;
  /**
   * Launch with `--remote-control`: the session registers with the account, so
   * the phone app can see and drive it. Anything but literal `true` means off.
   * Forced off on a resume (unverified CLI combo).
   */
  remoteControl?: boolean;
  /**
   * Close when done: the child is launched with `CLAUDE_DASHBOARD_ONESHOT=1`,
   * and the Stop hook then lets the session end instead of holding for a
   * reply. Anything but literal `true` means off. Forced off on a resume —
   * resuming is the act of wanting a conversation.
   */
  oneShot?: boolean;
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
   * Every project with a transcript in the lookback window, sorted — what the Sessions toolbar's project picker offers. A linked worktree is listed
   * under its repo, and a dir Claude made for itself (scratchpad, scratch workspace, `~/.claude`) not at all (`scan.ts` `pickerProjectOf`). A superset
   * of the projects in `sessions`: with `?project=` set, `sessions` holds only the chosen ones, and the picker still has to offer the rest. Absent on
   * the error snapshot, where the client falls back to the projects of the rows it has.
   */
  projects?: string[];
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
   * 'signed-out' → the stored credential is present but blank, i.e. the CLI is
   * logged out (header shows a hint naming `claude auth login`);
   * 'unavailable' → any other fail-open cause (no token, network, bad payload).
   * Absent when SHOW_USAGE is off; attached on both success and error snapshots.
   */
  usageStatus?: UsageStatus;
  /** Set only when the scan failed and an empty snapshot is returned. */
  error?: boolean;
}

/** One routine as `shared/routine-file.ts` parses it from `<name>.md` in the routines folder. */
export interface RoutineJob {
  /** The filename without `.md`; also the launchd label suffix and the log key. */
  name: string;
  /** Five-field cron or `manual`, local time of the machine that runs it. */
  cron: string;
  machines: ('mac' | 'wsl')[];
  run: 'shell' | 'claude';
  /** `pinned` = every pinned repo, a list = only those pins (by name or dirName), null = one step in `cwd`. */
  foreach: 'pinned' | string[] | null;
  cwd: string | null;
  enabled: boolean;
  model: string | null;
  effort: string | null;
  permissionMode: 'plan' | 'acceptEdits' | 'auto' | null;
  allowedTools: string[] | null;
  maxTurns: number | null;
  timeoutMs: number;
  /** Everything after the frontmatter, trimmed: the prompt for `claude`, the whole body for `shell`. */
  body: string;
  /** `shell` only: the inner text of the body's first ```bash fence. */
  script: string | null;
}

/** One step of a routine run, folded from its `step-start` / `step-end` log records. `outcome` is null while the step is in flight (or its run was lost). */
export interface RoutineStep {
  index: number;
  /** The pin name for a `foreach:` job, null for a single-cwd job. */
  repo: string | null;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: 'ok' | 'failed' | 'skipped' | 'timeout' | 'stopped' | null;
  ms: number | null;
  exit: number | null;
  why: string | null;
  /** Shell steps only: the last lines of combined output. */
  tail: string | null;
  /** Claude steps only; null for shell steps and steps still running. */
  costUsd: number | null;
  /** input + cache creation + cache read, summed by the wrapper — never re-derived. */
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number | null;
  model: string | null;
  /** Claude steps only: the id `--session-id` gave the child, what `GET /api/sessions/:id/row` opens. */
  sessionId: string | null;
}

/** One run of a routine, or a refusal, as the server folds them from `~/.claude/routines/runs/*.jsonl`. */
export interface RoutineRun {
  /** The wrapper's uuid; a refusal has none in the log, so its id is `refused-<machine>-<job>-<epoch ms>`. */
  id: string;
  job: string;
  machine: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  endedAt: string | null;
  ms: number | null;
  late: boolean;
  /** `lost` is derived at read time, never logged: a start with no end whose wrapper is gone or past the age rule. */
  state: 'running' | 'ok' | 'failed' | 'lost' | 'refused';
  /** Step counts: the `end` record's, or counted from the step records so far when the run has none. */
  ok: number;
  failed: number;
  skipped: number;
  /** How many steps the wrapper planned (`start.steps`); `steps` may hold fewer while it runs or after a stop. */
  total: number;
  stopped: boolean;
  /** Set only when the run failed before its first step. */
  error: string | null;
  /** A refusal's reason, or why a run reads lost. */
  why: string | null;
  steps: RoutineStep[];
}

/** The Jobs band over a window of whole local days ending today, plus the cost and run count of the window before it. */
export interface RoutineStats {
  runs: number;
  ok: number;
  failed: number;
  lost: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  /** Exactly `days` local days, oldest first, `YYYY-MM-DD`; a lost run counts as failed here. */
  byDay: Array<{ day: string; ok: number; failed: number }>;
  prev: { costUsd: number; runs: number };
}

/**
 * The `error` of a 409 from `POST /api/routines/<name>/run` (`server/lib/routine-run.ts`). One union for both sides, so a code the server adds is a type
 * error in the client's `writeFailureText` rather than a bare "failed (HTTP 409)".
 */
export type RoutineRunConflict = 'already-running' | 'no-plugin' | 'invalid' | 'not-this-machine';

/** Reconcile's verdict, as the toolbar chip reads it; `not-owner` is what every server but the owner reports (spec §Owning server). */
export type ReconcileState = 'in-sync' | 'drift' | 'failed' | 'pending' | 'not-owner' | 'no-plugin' | 'cron-down' | 'bad-machine' | 'no-claude';
/** One job's difference between its file and the OS scheduler. `pending` is a change deferred (a running job) or blocked (`why` says which). */
export interface ReconcileChange { name: string; action: 'install' | 'update' | 'remove' | 'pending'; why: string }
export interface ReconcileReport { state: ReconcileState; changes: ReconcileChange[]; unchanged: number; error: string | null; at: string }

/** One job file as `GET /api/routines/:name` serves it to the editor: the raw text, and the parse of it. `job` is null when `errors` is not empty. */
export interface RoutineFile {
  name: string;
  text: string;
  job: RoutineJob | null;
  errors: JobError[];
  mtimeMs: number;
}

/** One ledger row of `GET /api/routines`: the file plus what this machine knows about it. */
export interface RoutineJobRow extends RoutineFile {
  /** The job names this machine in `machines:`. */
  onThisMachine: boolean;
  /** The OS scheduler holds a job for it now (an older version counts). Only an owner can tell: false whenever the report could not be planned. */
  installed: boolean;
  /** The next fire, ISO; null for an invalid, paused or other-machine job. */
  nextAt: string | null;
  /** The newest run that is not running (a refusal included). */
  last: RoutineRun | null;
  running: RoutineRun | null;
}

export interface RoutinesResponse {
  machine: 'mac' | 'wsl';
  /** The routines folder, `~` expanded. */
  dir: string;
  /** `ownedBy` is `<cwd>:<port>` of the live owner, or `''` when this server never opted in (`ROUTINES_OWNER`), or `seam` under the test seam. */
  owner: 'owner' | { ownedBy: string };
  reconcile: ReconcileReport;
  /** Sorted by name. */
  jobs: RoutineJobRow[];
}

/** `GET /api/routines/runs`: the filtered runs of the window, newest first, and the stats for the window (job and runner filters applied, outcome not). */
export interface RoutineRunsResponse {
  runs: RoutineRun[];
  stats: RoutineStats;
}

/** A routine create, save, toggle or delete: the job as it now parses (absent on a delete), and the reconcile that followed. */
export interface RoutineWriteResponse { job?: RoutineJob | null; reconcile: ReconcileReport }

/** The 422 a routine create, save or run answers when the file does not parse: every error, each naming its line. */
export interface RoutineErrorsResponse {
  errors: JobError[];
}

/** `POST /api/routines/validate`: what the drawer shows under the textarea. `summary` is the one-line reading of a valid file, null otherwise. */
export interface RoutineValidateResponse {
  errors: JobError[];
  summary: string | null;
}
