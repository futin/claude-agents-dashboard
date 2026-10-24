/**
 * cron.ts — five-field cron in the machine's local time: parse, next/last occurrence, launchd's calendar intervals, and the row's one-line description
 * (zero deps). Shared because the server validates and installs it, the client shows it live in the drawer, and the plugin wrapper (this file
 * transpiled to `.mjs`) computes which slot a fire belongs to — so no imports but types, and nothing Node-only.
 */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  /** Day of month, 1-31. */
  dom: Set<number>;
  /** 1-12. */
  month: Set<number>;
  /** Weekday, 0 = Sunday .. 6 = Saturday; a written 7 is already folded into 0. */
  dow: Set<number>;
  /** Whether the day field was written as something other than `*...`; cron ORs dom and dow only when both are, and ANDs them otherwise. */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The expression with whitespace normalised, so `describeCron` can fall back to it. */
  source: string;
}

export type CronParse = { ok: true; cron: Cron } | { ok: false; error: string };

export interface CalendarInterval { Minute?: number; Hour?: number; Day?: number; Month?: number; Weekday?: number }

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 7 is accepted as a second spelling of Sunday and folded to 0 below.
  { name: 'weekday', min: 0, max: 7 },
] as const;

const MINUTE_MS = 60_000;
const SEARCH_YEARS = 5;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isInt = (s: string): boolean => /^\d+$/.test(s);

function parseField(text: string, f: (typeof FIELDS)[number]): { set: Set<number> } | { error: string } {
  const bad = (why: string) => ({ error: `${f.name} "${text}": ${why}` });
  const set = new Set<number>();
  for (const item of text.split(',')) {
    const [range, step, ...extra] = item.split('/');
    if (extra.length > 0 || range === '') return bad('not a valid expression');
    let stepN = 1;
    if (step !== undefined) {
      if (!isInt(step) || Number(step) === 0) return bad('step must be a positive integer');
      stepN = Number(step);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      // A star over weekday stops at 6: 7 is only a spelling of 0, and including it would add nothing.
      hi = f.name === 'weekday' ? 6 : f.max;
    } else {
      const [a, b, ...more] = range.split('-');
      if (more.length > 0 || !isInt(a ?? '') || (b !== undefined && !isInt(b))) return bad('not a valid expression');
      lo = Number(a);
      hi = b === undefined ? lo : Number(b);
      // A bare `5/15` is a vixie-ism with a different reading per implementation; refuse rather than guess.
      if (b === undefined && step !== undefined) return bad('a step needs * or a range');
      for (const n of [lo, hi]) if (n < f.min || n > f.max) return bad(`${n} is out of range ${f.min}-${f.max}`);
      if (lo > hi) return bad('range runs backwards');
    }
    for (let n = lo; n <= hi; n += stepN) set.add(f.name === 'weekday' && n === 7 ? 0 : n);
  }
  return { set };
}

/** The file's schedule value for a routine that never installs and runs only through Run now. Case-sensitive on purpose: `Manual` stays a broken cron. */
export function isManualCron(cron: string): boolean {
  return cron.trim() === 'manual';
}

export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/).filter((s) => s !== '');
  if (parts.length !== 5) return { ok: false, error: `cron needs five fields (minute hour day month weekday); got ${parts.length}` };
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], FIELDS[i]);
    if ('error' in r) return { ok: false, error: r.error };
    sets.push(r.set);
  }
  return {
    ok: true,
    cron: {
      minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4],
      domRestricted: !parts[2].startsWith('*'),
      dowRestricted: !parts[4].startsWith('*'),
      source: parts.join(' '),
    },
  };
}

// Epoch arithmetic, not setSeconds: inside the repeated fall-back hour a local-field write resolves to the first pass and moves the time back an hour.
const floorToMinute = (d: Date): number => Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS;

function dayMatches(c: Cron, t: Date): boolean {
  const dom = c.dom.has(t.getDate());
  const dow = c.dow.has(t.getDay());
  return c.domRestricted && c.dowRestricted ? dom || dow : dom && dow;
}

/** First minute strictly after `from` that the expression fires at, or null when none falls within five years. */
export function nextAfter(cron: Cron, from: Date): Date | null {
  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + SEARCH_YEARS);
  let t = new Date(floorToMinute(from) + MINUTE_MS);
  while (t.getTime() <= limit.getTime()) {
    const y = t.getFullYear(), mo = t.getMonth(), d = t.getDate(), h = t.getHours();
    // The hour jump steps by epoch: a local constructor resolves the repeated fall-back hour to its first pass and would skip the second.
    let next: Date;
    if (!cron.month.has(mo + 1)) next = new Date(y, mo + 1, 1, 0, 0);
    else if (!dayMatches(cron, t)) next = new Date(y, mo, d + 1, 0, 0);
    else if (!cron.hour.has(h)) next = new Date(t.getTime() + (60 - t.getMinutes()) * MINUTE_MS);
    else if (!cron.minute.has(t.getMinutes())) next = new Date(t.getTime() + MINUTE_MS);
    else return t;
    // A DST gap can resolve a wall-clock jump to a time that is not later; one minute always makes progress.
    t = next.getTime() > t.getTime() ? next : new Date(t.getTime() + MINUTE_MS);
  }
  return null;
}

/** Last minute strictly before `from` that the expression fires at, or null when none falls within five years back. */
export function lastBefore(cron: Cron, from: Date): Date | null {
  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() - SEARCH_YEARS);
  const floor = floorToMinute(from);
  let t = new Date(floor === from.getTime() ? floor - MINUTE_MS : floor);
  while (t.getTime() >= limit.getTime()) {
    const y = t.getFullYear(), mo = t.getMonth(), d = t.getDate(), h = t.getHours();
    let prev: Date;
    if (!cron.month.has(mo + 1)) prev = new Date(y, mo, 0, 23, 59);
    else if (!dayMatches(cron, t)) prev = new Date(y, mo, d - 1, 23, 59);
    else if (!cron.hour.has(h)) prev = new Date(t.getTime() - (t.getMinutes() + 1) * MINUTE_MS);
    else if (!cron.minute.has(t.getMinutes())) prev = new Date(t.getTime() - MINUTE_MS);
    else return t;
    t = prev.getTime() < t.getTime() ? prev : new Date(t.getTime() - MINUTE_MS);
  }
  return null;
}

/**
 * launchd's `StartCalendarInterval` dicts: one per combination of the restricted fields (an unrestricted field is omitted, which launchd reads as
 * "any"). Null when day-of-month and weekday are both restricted — cron ORs them, launchd ANDs every key in a dict, so no list reproduces it.
 */
export function toCalendarIntervals(cron: Cron): CalendarInterval[] | null {
  if (cron.domRestricted && cron.dowRestricted) return null;
  const axes: Array<[keyof CalendarInterval, Set<number>, number]> = [
    ['Minute', cron.minute, 60], ['Hour', cron.hour, 24], ['Day', cron.dom, 31], ['Month', cron.month, 12], ['Weekday', cron.dow, 7],
  ];
  let out: CalendarInterval[] = [{}];
  for (const [key, set, size] of axes) {
    if (set.size === size) continue;
    const values = [...set].sort((a, b) => a - b);
    out = out.flatMap((base) => values.map((v) => ({ ...base, [key]: v })));
  }
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);
const isRun = (v: number[]): boolean => v[v.length - 1] - v[0] === v.length - 1;
const clock = (h: number, m: number): string => `${pad2(h)}:${pad2(m)}`;

/**
 * N when the values are exactly min, min+N, min+2N ... up to the field's end (so `*` over `/N` and `0-59/N` read alike), else null. N below 2 is
 * not a step: it is every value, which callers already name.
 */
function stepOf(v: number[], min: number, max: number): number | null {
  if (v.length < 2 || v[0] !== min) return null;
  const n = v[1] - v[0];
  if (n < 2 || v[v.length - 1] + n <= max) return null;
  return v.every((x, i) => x === min + i * n) ? n : null;
}

/** N when the values are evenly N apart (N ≥ 2) without spanning the whole field from `min` — `10-18/2`, the shape `stepOf` leaves out. */
function spacedBy(v: number[]): number | null {
  if (v.length < 3) return null;
  const n = v[1] - v[0];
  return n >= 2 && v.every((x, i) => x === v[0] + i * n) ? n : null;
}

/** First and last hour of an hour set that is one contiguous run shorter than the whole day, else null. */
function hourSpan(hours: number[]): [number, number] | null {
  return hours.length < 24 && isRun(hours) ? [hours[0], hours[hours.length - 1]] : null;
}

/** The time part, or null when the rules cannot phrase the minute and hour fields together. */
function describeTime(cron: Cron): string | null {
  const minutes = sorted(cron.minute);
  const hours = sorted(cron.hour);
  if (minutes.length === 1) {
    const m = minutes[0];
    if (hours.length === 1) return clock(hours[0], m);
    if (hours.length === 24) return `Every hour at :${pad2(m)}`;
    const n = stepOf(hours, 0, 23);
    if (n !== null) return `Every ${n}h at :${pad2(m)}`;
    const span = hourSpan(hours);
    if (span) return `Every hour ${clock(span[0], m)}–${clock(span[1], m)}`;
    if (hours.length <= 4) return hours.map((h) => clock(h, m)).join(', ');
    const spaced = spacedBy(hours);
    return spaced !== null ? `Every ${spaced}h ${clock(hours[0], m)}–${clock(hours[hours.length - 1], m)}` : null;
  }
  const step = stepOf(minutes, 0, 59);
  const every = minutes.length === 60 ? 'Every minute' : step !== null ? `Every ${step} minutes` : null;
  if (every === null) return null;
  if (hours.length === 24) return every;
  const span = hourSpan(hours);
  return span ? `${every}, ${clock(span[0], 0)}–${clock(span[1], minutes[minutes.length - 1])}` : null;
}

/** The day part ('' for every day), or null when day-of-month and weekday cannot be read as one restriction. */
function describeDays(cron: Cron): string | null {
  const domFull = cron.dom.size === 31;
  const dowFull = cron.dow.size === 7;
  if (domFull && dowFull) return '';
  // Cron ORs the two fields only when both were written restricted, and no single list says that.
  if (cron.domRestricted && cron.dowRestricted) return null;
  if (dowFull) {
    const days = sorted(cron.dom);
    const first = ordinal(days[0]);
    if (days.length === 1) return `${first} of month`;
    return isRun(days) ? `${first}–${ordinal(days[days.length - 1])} of month` : `${days.map(ordinal).join('/')} of month`;
  }
  if (domFull) {
    const days = sorted(cron.dow);
    if (days.length === 1) return DAY_NAMES[days[0]];
    return isRun(days) ? `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}` : days.map((d) => DAY_NAMES[d]).join('/');
  }
  return null;
}

function describeMonths(cron: Cron): string {
  if (cron.month.size === 12) return '';
  const months = sorted(cron.month);
  if (months.length > 1 && isRun(months)) return `${MONTH_NAMES[months[0] - 1]}–${MONTH_NAMES[months[months.length - 1] - 1]}`;
  return months.map((m) => MONTH_NAMES[m - 1]).join('/');
}

/** The four plain shapes read as a sentence ("07:00 Mon–Fri"); everything else goes through the part-by-part reading below. */
function describeNamedShape(cron: Cron): string | null {
  if (cron.minute.size !== 1 || cron.hour.size !== 1 || cron.month.size !== 12) return null;
  const time = clock([...cron.hour][0], [...cron.minute][0]);
  const everyDom = cron.dom.size === 31;
  const everyDow = cron.dow.size === 7;
  if (everyDom && everyDow) return `${time} daily`;
  if (everyDom && !cron.domRestricted) {
    const days = sorted(cron.dow);
    if (days.length === 1) return `${DAY_NAMES[days[0]]} ${time}`;
    if (isRun(days)) return `${time} ${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}`;
  }
  if (cron.dom.size === 1 && everyDow && !cron.dowRestricted) return `${ordinal([...cron.dom][0])} of month ${time}`;
  return null;
}

/** The row's one-line reading ("07:00 Mon–Fri", "Every 15 minutes, 09:00–17:45, Mon–Fri"); a part the rules cannot phrase makes it the source as written. */
export function describeCron(cron: Cron): string {
  const named = describeNamedShape(cron);
  if (named !== null) return named;
  const time = describeTime(cron);
  const days = describeDays(cron);
  if (time === null || days === null) return cron.source;
  return [time, days, describeMonths(cron)].filter(Boolean).join(', ');
}
