/**
 * usage-history.ts — learn which hours of the week you actually work.
 *
 * `usage-forecast.ts` walks forward over 168 hour-of-week weights. This module
 * is where those weights come from: a stream of (time, utilization, resetsAt)
 * samples of the **5-hour** window, classified pairwise into active / idle /
 * ambiguous / reset intervals, accumulated per hour-of-week bucket, and folded
 * once a week through an EWMA.
 *
 * Three things about the classification are counter-intuitive enough that each
 * was gotten backwards once:
 *
 * 1. **A flat interval is a measurement of idleness, not missing data.**
 *    Utilization is cumulative within a window, so two samples bracketing a gap
 *    with the same `resetsAt` and the same utilization *prove* nothing was
 *    spent in between. "No data means unknown" would defeat the whole feature:
 *    the laptop sleeps at night, night is exactly what the profile needs to
 *    learn, and those buckets would never collect evidence. A sleeping laptop is
 *    the best teacher this module has.
 * 2. **Ambiguity is a function of duration, not direction.** Two samples a
 *    minute apart with utilization rising pin that activity to that minute —
 *    it is the only way `activeMin` ever grows. Only a *long* rising interval is
 *    unattributable. Get this backwards and every hour learns as idle.
 * 3. **The trust floor is lifetime, not per-week.** A bucket gathers at most 60
 *    minutes per week, so a per-week floor at an hour could never be met. Trust
 *    accrues across weeks; the weight itself is what tracks recency.
 *
 * And a quiet bucket must *decay*, not freeze: a weight only moves when its
 * bucket folds, so an abandoned hour would otherwise keep its old weight forever
 * while lifetime evidence kept it trusted. `observedWeeks` records the weeks we
 * were recording at all, so a month of server downtime ages nothing while a
 * month of ordinary use with that hour idle ages it at the normal half-life.
 *
 * See `docs/subsystems/usage-limits.md`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getSettings } from './settings.js';
import { HOURS_PER_WEEK, hourOfWeek, localOffsetMinutes } from './usage-forecast.js';
import type { DutyProfile } from './usage-forecast.js';
import { seedSamples, setActiveTimeSource, setForecastProfile } from './usage-pace.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * How much of a week's ratio replaces the standing weight on each fold. 0.3
 * gives a half-life of about two weeks — quick enough to follow a change of
 * habit, slow enough that one unusual week doesn't rewrite the profile.
 */
export const EWMA_ALPHA = 0.3;

/** Lifetime observed minutes before a bucket's weight is used at all. */
export const TRUST_FLOOR_MIN = 60;

/**
 * Longest rising interval whose activity can still be pinned to it. Comfortably
 * above the one-minute sampling cadence, well below any real gap. A rise across
 * anything longer is discarded rather than spread — spreading it by existing
 * weights would train the profile on its own output.
 */
export const MAX_ATTRIBUTABLE_MS = 300_000;

/** Matches the utilization-drop epsilon `recordAndPace` already uses. */
const MOVE_EPSILON = 0.5;

/**
 * How far two `resetsAt` stamps may differ and still be the same window.
 *
 * **Not string equality, and this was measured, not guessed.** The upstream
 * endpoint recomputes the stamp per request, so four consecutive real fetches of
 * one unchanged 5-hour window returned `21:19:59.657311`, `21:20:00.387292`,
 * `21:20:00.404859`, `21:20:00.508567` — sub-second jitter, ~0.85s across the
 * set. Comparing the strings would classify *every* interval as a `reset`, so
 * the profile would never learn a single minute, and `shouldWrite` would append
 * a line every tick. Two minutes is three orders of magnitude above the observed
 * jitter and three orders below a genuine window change (+5h, or +7d).
 */
const SAME_WINDOW_MS = 120_000;

/** Same window? Compares parsed stamps with {@link SAME_WINDOW_MS} of slack. */
function sameWindow(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false; // scoped ⇄ unscoped is a real change
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return Math.abs(ta - tb) <= SAME_WINDOW_MS;
}

/** Observed weeks retained for the decay count. Half a year is plenty. */
const MAX_OBSERVED_WEEKS = 26;

/** One reading of the 5-hour window, as recorded. */
export interface UsageSample {
  /** Sample time, ms epoch. */
  t: number;
  /** Utilization percent at that time (0–100). */
  utilization: number;
  /** The window's reset time; a change means a different window. */
  resetsAt: string | null;
}

/** One hour-of-week bucket. Indexed 0–167, 0 = Sunday 00:00 local. */
export interface Bucket {
  /** Learned expected active share, 0–1. Null until the first fold. */
  weight: number | null;
  /** ISO week the pending accumulators belong to. Null when never touched. */
  weekStamp: string | null;
  /** Minutes observed **this** week. Zeroed on fold. */
  observedMin: number;
  /** Of those, minutes attributed to activity. Zeroed on fold. */
  activeMin: number;
  /** Minutes observed ever. Never reset — the trust floor's input. */
  lifetimeObservedMin: number;
}

export interface ProfileState {
  buckets: Bucket[];
  /**
   * ISO week keys in which *any* bucket was observed, ascending, pruned to the
   * newest {@link MAX_OBSERVED_WEEKS}. A bucket that sits out one of these
   * decays by it; weeks we weren't recording are absent and cost nothing.
   */
  observedWeeks: string[];
}

export type IntervalKind = 'active' | 'idle' | 'ambiguous' | 'reset';

/** A fresh state. Always a new array — a shared constant would leak across calls. */
export function emptyState(): ProfileState {
  const buckets: Bucket[] = [];
  for (let i = 0; i < HOURS_PER_WEEK; i++) {
    buckets.push({
      weight: null,
      weekStamp: null,
      observedMin: 0,
      activeMin: 0,
      lifetimeObservedMin: 0
    });
  }
  return { buckets, observedWeeks: [] };
}

/**
 * What a pair of consecutive samples tells us about the span between them.
 *
 * `reset` and `ambiguous` are both discarded — the first spans two different
 * windows, the second cannot be attributed to any particular hour inside it.
 */
export function classifyInterval(
  a: UsageSample,
  b: UsageSample,
  maxAttributableMs: number = MAX_ATTRIBUTABLE_MS
): IntervalKind {
  if (!sameWindow(a.resetsAt, b.resetsAt)) return 'reset';
  const delta = b.utilization - a.utilization;
  if (delta < -MOVE_EPSILON) return 'reset';
  if (delta > MOVE_EPSILON) {
    return b.t - a.t <= maxAttributableMs ? 'active' : 'ambiguous';
  }
  return 'idle'; // flat at any duration — the sleep measurement
}

/**
 * `YYYY-Www` for the ISO-8601 week containing `ms` in local time.
 *
 * Real Thursday-anchored numbering, not `dayOfYear / 7`: only equality is ever
 * compared, but a wrong boundary would fold twice in one week or skip one
 * entirely. Note ISO weeks start on Monday while `hourOfWeek` counts from
 * Sunday — bucket indexing and fold grouping are independent axes.
 */
export function isoWeekKey(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  // Move to the Thursday of this ISO week; its calendar year is the ISO year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(d.getTime());
  thursday.setUTCDate(d.getUTCDate() - dayNum + 3);
  thursday.setUTCHours(0, 0, 0, 0);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstDayNum = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const week1Monday = firstThursday - firstDayNum * 24 * HOUR_MS;
  const week = Math.round((thursday.getTime() - week1Monday) / (7 * 24 * HOUR_MS)) + 1;
  return year + '-W' + String(week).padStart(2, '0');
}

/** Observed weeks strictly between `from` and `to`, i.e. the ones sat out. */
function skippedWeeks(observedWeeks: string[], from: string, to: string): number {
  let n = 0;
  for (const wk of observedWeeks) if (wk > from && wk < to) n++;
  return n;
}

/**
 * Fold the pending week into the standing weight, then age it by the weeks this
 * bucket sat out.
 *
 * **The order is load-bearing.** The pending accumulators belong to the bucket's
 * `weekStamp` week and the skipped weeks came *after* it, so they age that
 * week's contribution. Decaying first would age a weight the skipped weeks
 * predate, and a first-ever fold would skip the decay entirely and leave a stale
 * seed at full strength.
 */
function foldBucket(bucket: Bucket, weekKey: string, observedWeeks: string[]): void {
  if (bucket.weekStamp === null || bucket.weekStamp === weekKey) return;
  if (bucket.observedMin <= 0) return; // nothing pending: nothing folds, nothing decays

  const ratio = bucket.activeMin / bucket.observedMin;
  const folded = bucket.weight === null
    ? ratio
    : (1 - EWMA_ALPHA) * bucket.weight + EWMA_ALPHA * ratio;
  const k = skippedWeeks(observedWeeks, bucket.weekStamp, weekKey);
  bucket.weight = folded * Math.pow(1 - EWMA_ALPHA, k);
  bucket.observedMin = 0;
  bucket.activeMin = 0;
}

/**
 * Credit one classified interval to every hour-of-week bucket it spans.
 *
 * Never mutates `state` — callers hold onto earlier states. An interval can
 * cross hour and week boundaries, so it is split at local hour boundaries and
 * each slice stamps and folds with **its own** week key: one key per interval
 * would misfile the Sunday side of a week-boundary interval into the new week.
 */
export function accumulate(
  state: ProfileState,
  a: UsageSample,
  b: UsageSample,
  offsetMinutes: number
): ProfileState {
  const kind = classifyInterval(a, b);
  if (kind !== 'active' && kind !== 'idle') return state; // discarded
  if (b.t <= a.t) return state;

  const buckets = state.buckets.map((x) => ({ ...x }));
  const observedWeeks = [...state.observedWeeks];

  let t = a.t;
  while (t < b.t) {
    const shift = offsetMinutes * 60_000;
    const nextHour = Math.floor((t + shift) / HOUR_MS) * HOUR_MS + HOUR_MS - shift;
    const sliceEnd = Math.min(nextHour, b.t);
    const mins = (sliceEnd - t) / MINUTE_MS;
    const weekKey = isoWeekKey(t, offsetMinutes);
    const bucket = buckets[hourOfWeek(t, offsetMinutes)];

    foldBucket(bucket, weekKey, observedWeeks);
    bucket.weekStamp = weekKey;
    bucket.observedMin += mins;
    bucket.lifetimeObservedMin += mins;
    if (kind === 'active') bucket.activeMin += mins;

    if (!observedWeeks.includes(weekKey)) {
      observedWeeks.push(weekKey);
      observedWeeks.sort();
      if (observedWeeks.length > MAX_OBSERVED_WEEKS) {
        observedWeeks.splice(0, observedWeeks.length - MAX_OBSERVED_WEEKS);
      }
    }
    t = sliceEnd;
  }

  return { buckets, observedWeeks };
}

/**
 * The profile the forecast walk consumes: weights for the trusted buckets, and
 * the mean of those as the fallback for the rest.
 *
 * `globalMean` is 1 when nothing is trusted yet — the pessimistic default, which
 * reproduces today's flat-rate behaviour rather than inventing an optimistic one.
 */
export function deriveProfile(state: ProfileState): DutyProfile {
  const weights: (number | null)[] = state.buckets.map((b) =>
    b.lifetimeObservedMin >= TRUST_FLOOR_MIN ? b.weight : null
  );
  const trusted = weights.filter((w): w is number => typeof w === 'number');
  return {
    weights,
    globalMean: trusted.length > 0 ? trusted.reduce((a, w) => a + w, 0) / trusted.length : 1,
    trustedCount: trusted.length
  };
}

// ───────────────────────── the I/O shell ─────────────────────────
//
// Two files, both gitignored and both at the repo root: the raw append-only
// sample log, and the derived profile. The log is for charts and for
// rehydrating the pace ring; the profile is the profile's source of truth —
// rebuilding it from the log alone would be lossy (see `recordTick`).

/** Append-only raw samples. Replayable, rotated, never authoritative. */
export const HISTORY_FILE = '.usage-history.jsonl';
/** The learned profile — derived state, written atomically, authoritative. */
export const PROFILE_FILE = '.usage-profile.json';

/** Longest silence before an unchanged sample is written anyway. */
export const HEARTBEAT_MS = 900_000;
/** ~32 MB, roughly two years of write-on-change samples. */
export const MAX_HISTORY_BYTES = 33_554_432;
/** Tail window for a read — the same 256 KB `transcript.ts` uses. */
export const TAIL_BYTES = 262_144;

/**
 * The repo root, found by walking up for `package.json`.
 *
 * **Deliberately not `settings.ts`'s `process.cwd()`.** A settings file that
 * resets when you start the server from another directory is a nuisance; a
 * *history* file that does is weeks of learning silently replaced by an empty
 * one, with no error. Same rule the guide tooling already follows — walk up,
 * never a fixed `../..` hop count.
 */
export function repoRoot(startDir: string = import.meta.dirname): string {
  let dir = startDir;
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      /* unreadable — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd(); // hit the filesystem root
    dir = parent;
  }
}

function historyPath(dir?: string): string {
  return path.join(dir ?? repoRoot(), HISTORY_FILE);
}

function profilePath(dir?: string): string {
  return path.join(dir ?? repoRoot(), PROFILE_FILE);
}

/**
 * Write-on-change plus a heartbeat.
 *
 * Per-minute density would buy the profile nothing — the gap rule already reads
 * sparse records correctly — and the heartbeat doubles as the liveness marker
 * that separates server downtime from a quiet machine.
 */
export function shouldWrite(
  prev: UsageSample | null,
  next: UsageSample,
  heartbeatMs: number = HEARTBEAT_MS
): boolean {
  if (prev === null) return true;
  if (Math.abs(next.utilization - prev.utilization) > 0.01) return true;
  if (!sameWindow(prev.resetsAt, next.resetsAt)) return true;
  return next.t - prev.t >= heartbeatMs;
}

/** One compact JSON object per line. Swallows failures — a read-only fs must
 * not break the poll. */
export function appendSample(sample: UsageSample, dir?: string): void {
  try {
    fs.appendFileSync(historyPath(dir), JSON.stringify(sample) + '\n', 'utf8');
  } catch {
    /* read-only fs / missing dir — recording is best-effort by design */
  }
}

/** Parse one log line, or null when it isn't a usable sample. */
function parseSample(line: string): UsageSample | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw?.t !== 'number' || typeof raw?.utilization !== 'number') return null;
    return {
      t: raw.t,
      utilization: raw.utilization,
      resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null
    };
  } catch {
    return null;
  }
}

/**
 * The trailing `maxBytes` of the log as samples, oldest first.
 *
 * A tail read almost always starts mid-line, so the first fragment is dropped
 * whenever the window didn't reach the top of the file. Malformed lines are
 * skipped individually rather than failing the read.
 */
export function readRecentSamples(dir?: string, maxBytes: number = TAIL_BYTES): UsageSample[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(historyPath(dir), 'r');
    const { size } = fs.fstatSync(fd);
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    const out: UsageSample[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      const sample = parseSample(line);
      if (sample) out.push(sample);
    }
    return out;
  } catch {
    return []; // absent / unreadable — nothing to rehydrate from
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Trim the log to its newest half once it passes `maxBytes`.
 *
 * The learned profile lives in its own file, so throwing away old raw samples
 * costs nothing the forecast depends on — which is the whole reason the EWMA
 * never needs the raw history.
 */
export function rotateIfNeeded(dir?: string, maxBytes: number = MAX_HISTORY_BYTES): void {
  const file = historyPath(dir);
  try {
    if (fs.statSync(file).size <= maxBytes) return;
    const keep = readRecentSamples(dir, Math.floor(maxBytes / 2));
    fs.writeFileSync(file, keep.map((x) => JSON.stringify(x) + '\n').join(''), 'utf8');
  } catch {
    /* absent / unreadable / read-only — leave it alone */
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The persisted profile, or a fresh one.
 *
 * Absent, malformed, and wrong-shaped all fall back silently to `emptyState()`:
 * a torn 168-bucket array is the one input that would render a broken grid and
 * misweight every walk, so the length is checked rather than trusted.
 */
export function loadProfileState(dir?: string): ProfileState {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(dir), 'utf8')) as Record<string, unknown>;
    const buckets = raw?.buckets;
    if (!Array.isArray(buckets) || buckets.length !== HOURS_PER_WEEK) return emptyState();
    const weeks = Array.isArray(raw?.observedWeeks)
      ? (raw.observedWeeks as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
    return {
      buckets: buckets.map((b) => {
        const x = (b ?? {}) as Record<string, unknown>;
        return {
          weight: typeof x.weight === 'number' && Number.isFinite(x.weight) ? x.weight : null,
          weekStamp: typeof x.weekStamp === 'string' ? x.weekStamp : null,
          observedMin: num(x.observedMin, 0),
          activeMin: num(x.activeMin, 0),
          lifetimeObservedMin: num(x.lifetimeObservedMin, 0)
        };
      }),
      observedWeeks: weeks
    };
  } catch {
    return emptyState();
  }
}

/**
 * Write the profile atomically: tmp file, then rename over the real path.
 *
 * Returns false rather than throwing, mirroring `settings.ts`'s `persisted`
 * flag — a failed write costs this week's fold, not the process.
 */
export function saveProfileState(state: ProfileState, dir?: string): boolean {
  const target = profilePath(dir);
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return false;
  }
}

// ───────────────────────── the recorder ─────────────────────────
//
// One entry point, `recordTick`, owns everything that happens per sample: the
// write decision, the live fold into the profile, the periodic save, and the
// classifier ring the weekly active rate is measured against.
//
// **Learning is live; the log is not a replayable substitute for it.** The
// profile learns at full one-minute sampling resolution against the in-memory
// previous sample. The log is deliberately sparser (write-on-change plus a
// heartbeat), which is fine for charts and for rehydrating the pace ring, but
// rebuilding a profile from the log alone would be lossy: a flat stretch that
// ends in a rise gets written as one long rising interval, which classifies as
// `ambiguous` and is discarded. The profile file is the profile's source of
// truth.

/** One classified interval, kept in RAM only. Feeds `observedActiveMs`. */
interface ClassifiedInterval {
  endMs: number;
  spanMs: number;
  kind: IntervalKind;
}

/** How much classified history the ring keeps — twice the weekly lookback. */
const RING_MS = 12 * HOUR_MS;

/**
 * How far behind `untilMs` the newest ring entry may be and still count as
 * covering it. A stale ring (recording toggled off, then a rise, then on again)
 * must not be read as "no active time in that span".
 */
const RING_FRONT_TOLERANCE_MS = MAX_ATTRIBUTABLE_MS;

let lastWritten: UsageSample | null = null;
let lastSample: UsageSample | null = null;
let liveState: ProfileState | null = null;
let lastSavedAt = 0;
let ring: ClassifiedInterval[] = [];

/** One minute — the cadence the profile learns at. */
const SAMPLE_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Test seam: forget everything the recorder holds in memory. */
export function resetRecorder(): void {
  lastWritten = null;
  lastSample = null;
  liveState = null;
  lastSavedAt = 0;
  ring = [];
}

/**
 * Record one sample of the 5-hour window: append it if it says anything new,
 * fold the interval since the previous sample into the profile, and save.
 *
 * `dir` exists so tests can point at a tmpdir; production omits it. Never
 * throws — recording must not be able to break the usage fetch.
 */
export function recordTick(sample: UsageSample, dir?: string): void {
  try {
    if (liveState === null) liveState = loadProfileState(dir);

    if (shouldWrite(lastWritten, sample)) {
      appendSample(sample, dir);
      lastWritten = sample;
    }

    if (lastSample !== null && sample.t > lastSample.t) {
      ring.push({
        endMs: sample.t,
        spanMs: sample.t - lastSample.t,
        kind: classifyInterval(lastSample, sample)
      });
      const cutoff = sample.t - RING_MS;
      if (ring[0] && ring[0].endMs <= cutoff) ring = ring.filter((x) => x.endMs > cutoff);
      // The profile must be learned on the same local clock the walk queries;
      // passing 0 here would silently shift every bucket by the UTC offset.
      liveState = accumulate(liveState, lastSample, sample, localOffsetMinutes(sample.t));
    }
    lastSample = sample;

    if (lastSavedAt === 0 || sample.t - lastSavedAt >= HEARTBEAT_MS) {
      if (saveProfileState(liveState, dir)) rotateIfNeeded(dir);
      lastSavedAt = sample.t;
    }
  } catch {
    /* fail open — a broken recorder must never break the usage fetch */
  }
}

/**
 * Active time the recorder actually observed inside `[sinceMs, untilMs]`, or
 * null when the ring does not cover that whole span.
 *
 * Null rather than a partial sum on purpose: a half-covered lookback would
 * undercount active time, and the caller divides by it — so the rate would come
 * out too high, in the pessimistic direction, silently. Coverage is walked
 * backwards from the newest entry and stops at the first hole, so a gap in the
 * middle disqualifies the answer too, not just a short back edge.
 */
export function observedActiveMs(sinceMs: number, untilMs: number): number | null {
  if (ring.length === 0) return null;
  const sorted = [...ring].sort((a, b) => a.endMs - b.endMs);
  const newest = sorted[sorted.length - 1];
  if (untilMs - newest.endMs > RING_FRONT_TOLERANCE_MS) return null;

  // Walk back through contiguous entries; the first gap ends the coverage.
  let coveredFrom = newest.endMs - newest.spanMs;
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i].endMs < coveredFrom) break; // a hole
    coveredFrom = Math.min(coveredFrom, sorted[i].endMs - sorted[i].spanMs);
  }
  if (coveredFrom > sinceMs) return null;

  let total = 0;
  for (const x of sorted) {
    if (x.kind !== 'active') continue;
    const start = Math.max(x.endMs - x.spanMs, sinceMs);
    const end = Math.min(x.endMs, untilMs);
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * The live profile state, loading it from disk on first use. Read-only — the
 * caller derives a `DutyProfile` from it or maps it into the inspector's cells.
 */
export function profileSnapshot(dir?: string): ProfileState {
  if (liveState === null) liveState = loadProfileState(dir);
  return liveState;
}

/**
 * Turn on recording: rehydrate what can be rehydrated, wire the active-time
 * seam, and start sampling on our own interval.
 *
 * The interval exists because sampling is otherwise **request-driven** — the
 * `/api/sessions` handler is the only caller of `getCachedUsageState`, so with
 * no browser open nothing is sampled and the recorded history would describe
 * when the dashboard was *watched* rather than when work happened.
 *
 * `refresh` is injected rather than imported: `usage.ts` imports this module for
 * `recordTick`, so importing it back would be a cycle. Production passes
 * `getCachedUsageState`, which is the same non-blocking refresh the poll uses —
 * one code path to Anthropic, not two.
 */
export function startUsageRecording(refresh: () => void, dir?: string): void {
  try {
    if (getSettings().recordUsageHistory) {
      liveState = loadProfileState(dir);
      setForecastProfile(deriveProfile(liveState));
      // **The 5h ring only.** The log records the 5h sensor series, and the two
      // windows' utilization are different series — a weekly ring seeded from it
      // either poisons the slope for up to the 6h lookback or gets wiped by the
      // drop check. Wrong either way; the weekly pace returns after ~30 minutes
      // of live sampling, exactly as today.
      const samples = readRecentSamples(dir);
      if (samples.length > 0) {
        seedSamples('fiveHour', samples.map((x) => ({ t: x.t, utilization: x.utilization })));
      }
    }
    // Re-read the setting per call so toggling recording off also retires the
    // rate correction, with no restart.
    setActiveTimeSource((a, b) =>
      getSettings().recordUsageHistory ? observedActiveMs(a, b) : null
    );

    stopUsageRecording();
    timer = setInterval(() => {
      // Re-read on every tick: flipping the toggle in Settings takes effect
      // immediately, and while off this costs nothing and touches no network.
      if (!getSettings().recordUsageHistory) return;
      try { refresh(); } catch { /* the refresh path fails open on its own */ }
    }, SAMPLE_INTERVAL_MS);
    // Never hold the process open for a sample.
    timer.unref();
  } catch {
    /* recording is best-effort; the dashboard works without it */
  }
}

/** Stop sampling. The interval is already unref'd, so this is for shutdown. */
export function stopUsageRecording(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
