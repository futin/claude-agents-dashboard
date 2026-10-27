/**
 * routineForm.ts — the field registry behind the job drawer's summary rows (spec `docs/superpowers/specs/2026-10-24-routine-form-design.md` §The field
 * registry, §Rows). The file's text stays the only state: each field reads its value out of the text, writes a new value back by touching only the lines it
 * owns, and says in plain words what it holds. React only renders these.
 */
import { describeCron, isManualCron, parseCron } from '../../../shared/cron';
import { scalarEnd, writeFrontmatterLine } from '../../../shared/frontmatter';
import type { JobError } from '../../../shared/routine-file';
import { readForeach, setRepos, type ForeachMode } from './routines';

export type FormKind = 'shell' | 'claude' | null;

export const UNREADABLE: unique symbol = Symbol('unreadable');
/** A field's value, or the marker for a line that exists but that the form cannot represent ("edit in File"). */
export type Read<V> = V | typeof UNREADABLE;

export type FieldId = 'schedule' | 'machines' | 'repos' | 'script' | 'prompt' | 'model' | 'permission' | 'limits' | 'tools';

export interface Summary { text: string; tone: 'set' | 'dim' | 'err' }

/** What a summary may need beyond its value: the pin count for All pinned, the kind for Limits (a shell job has no turn limit). */
export interface SummaryCtx { pinCount: number; kind: FormKind }

export interface FieldDef<V> {
  id: FieldId;
  label: string;
  /** The frontmatter keys the field owns; empty for the body fields. */
  keys: readonly string[];
  kinds: readonly FormKind[];
  read(text: string): Read<V>;
  write(text: string, v: V): string;
  summary(v: V, ctx: SummaryCtx): Summary;
}

export type Preset = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
/** `days`: 0 = Sunday .. 6, sorted and unique. */
export type Schedule =
  | { preset: 'manual' }
  | { preset: 'hourly'; minute: number; every: 1 | 2 | 3 | 6 | 12 }
  | { preset: 'daily' | 'weekdays'; hour: number; minute: number }
  | { preset: 'weekly'; days: number[]; hour: number; minute: number }
  | { preset: 'custom'; text: string };
export type Machines = { mac: boolean; wsl: boolean };
export type Repos = { mode: ForeachMode; picks: string[]; cwd: string };
export type Script = string;
export type Prompt = string;
export type ModelEffort = { model: string | null; effort: string | null };
export type Permission = string | null;
export type Limits = { maxTurns: string | null; timeout: string | null };
export type Tools = string[];

/** Where an inserted key lands: after the nearest key before it in this order that the file has. The parser's own key order. */
const KEY_ORDER = ['cron', 'machines', 'run', 'foreach', 'cwd', 'enabled', 'model', 'effort', 'permission-mode', 'allowed-tools', 'max-turns', 'timeout'];

const strip = (l: string): string => l.replace(/\r$/, '');
// The parser's own notion of a block line under a key, so "unreadable" means exactly what the validator would refuse as a nested value.
const isComment = (l: string): boolean => /^\s*#/.test(l);
const isIndented = (l: string): boolean => /^\s+\S/.test(l) && !isComment(l);

interface Doc { lines: string[]; end: number; nl: string }

/** The file split on `\n` (each line keeps its `\r`), with the closing fence's index; null when the frontmatter can't be found. */
function doc(text: string): Doc | null {
  const lines = text.split('\n');
  if (strip(lines[0] ?? '').replace(/^﻿/, '') !== '---') return null;
  const end = lines.findIndex((l, i) => i >= 1 && strip(l) === '---');
  if (end === -1) return null;
  return { lines, end, nl: lines[0].endsWith('\r') ? '\r\n' : '\n' };
}

/** Index of the first top-level `key:` line inside the frontmatter, or -1. The same prefix test `writeFrontmatterLine` uses, so both find one line. */
function keyIndex(d: Doc, key: string): number {
  for (let i = 1; i < d.end; i++) if (d.lines[i].startsWith(`${key}:`)) return i;
  return -1;
}

/** True when indented lines follow line `i` before the next key: a nested list or map the form cannot show. */
function blockFollows(d: Doc, i: number): boolean {
  for (let j = i + 1; j < d.end; j++) {
    const l = strip(d.lines[j]);
    if (isIndented(l)) return true;
    if (l.trim() !== '' && !isComment(l)) return false;
  }
  return false;
}

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, '$2');

export function frontmatterReadable(text: string): boolean {
  return doc(text) !== null;
}

/** The first top-level `key:` line of the frontmatter: its value without a trailing comment or one pair of quotes, and its 1-based line in the file. */
export function fmValue(text: string, key: string): { value: string; line: number } | null {
  const d = doc(text);
  if (!d) return null;
  const at = keyIndex(d, key);
  if (at === -1) return null;
  const rest = strip(d.lines[at]).slice(key.length + 1).trimStart();
  return { value: unquote(rest.slice(0, scalarEnd(rest))), line: at + 1 };
}

/**
 * Set or remove one frontmatter key, leaving every other byte as it was. A string writes in place (padding and comment kept) or inserts the line after
 * the nearest preceding key of {@link KEY_ORDER} the file has — past any block under that key — or before the closing fence; null drops the key's line.
 */
export function setKey(text: string, key: string, value: string | null): string {
  const d = doc(text);
  if (!d) return text;
  const at = keyIndex(d, key);
  if (value === null) {
    if (at === -1) return text;
    return d.lines.filter((_, i) => i !== at).join('\n');
  }
  if (at !== -1) return writeFrontmatterLine(text, key, value);
  let pos = d.end;
  for (let k = KEY_ORDER.indexOf(key) - 1; k >= 0; k--) {
    const anchor = keyIndex(d, KEY_ORDER[k]);
    if (anchor === -1) continue;
    pos = anchor + 1;
    while (pos < d.end && (isIndented(strip(d.lines[pos])))) pos++;
    break;
  }
  const lines = [...d.lines];
  lines.splice(pos, 0, `${key}: ${value}${d.nl === '\r\n' ? '\r' : ''}`);
  return lines.join('\n');
}

/** A key's single-line value: null when absent, UNREADABLE for a block scalar or a nested block under it. */
function scalar(text: string, key: string): Read<string | null> {
  const d = doc(text);
  if (!d) return UNREADABLE;
  const v = fmValue(text, key);
  if (!v) return null;
  if (/^[>|][+-]?$/.test(v.value)) return UNREADABLE;
  if (v.value === '' && blockFollows(d, v.line - 1)) return UNREADABLE;
  return v.value;
}

/** A key's inline list `[a, b]`: null when absent or empty, UNREADABLE for any other shape. */
function inlineList(text: string, key: string): Read<string[] | null> {
  const v = scalar(text, key);
  if (v === UNREADABLE) return UNREADABLE;
  if (v === null || v === '') return null;
  const m = /^\[(.*)\]$/.exec(v);
  if (!m) return UNREADABLE;
  return m[1].trim() === '' ? [] : m[1].split(',').map(x => unquote(x.trim()));
}

/** Write each key whose value changed; a null or blank value removes the line, and one holding a `#` comment start is quoted so it reads back whole. */
function writeKeys(text: string, now: Record<string, string | null>, next: Record<string, string | null>): string {
  let out = text;
  for (const key of Object.keys(next)) {
    const v = next[key]?.trim() || null;
    if (v !== (now[key] ?? null)) out = setKey(out, key, v !== null && /(^|\s)#/.test(v) ? quoted(v) : v);
  }
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The first non-blank line, cut to 60 characters, for the closed row of a body field. */
function firstLine(v: string): string {
  const line = v.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** The body after the closing fence, line endings normalised to `\n`. */
function bodyLines(d: Doc): string[] {
  return d.lines.slice(d.end + 1).map(strip);
}

/** The first ```` ```bash ```` fence of the body, as indices into the whole file, with the parser's own fence patterns; close is -1 when it never closes. */
function fence(d: Doc): { open: number; close: number } | null {
  const body = bodyLines(d);
  const open = body.findIndex(l => /^```bash\s*$/.test(l));
  if (open === -1) return null;
  const close = body.findIndex((l, k) => k > open && /^```\s*$/.test(l));
  return { open: d.end + 1 + open, close: close === -1 ? -1 : d.end + 1 + close };
}

export function formKind(text: string): FormKind {
  const run = fmValue(text, 'run')?.value;
  return run === 'shell' || run === 'claude' ? run : null;
}

/** Which kinds show each row (§Rows); `visibleFields` and each field's `kinds` both read it, so the table lives once. */
const ROWS: readonly [FieldId, readonly FormKind[]][] = [
  ['schedule', ['shell', 'claude', null]],
  ['machines', ['shell', 'claude', null]],
  ['repos', ['shell', 'claude', null]],
  ['script', ['shell']],
  ['prompt', ['claude']],
  ['model', ['claude']],
  ['permission', ['claude']],
  ['limits', ['shell', 'claude', null]],
  ['tools', ['claude']],
];
const kindsOf = (id: FieldId): readonly FormKind[] => ROWS.find(([r]) => r === id)![1];

export function visibleFields(kind: FormKind): FieldId[] {
  return ROWS.filter(([, kinds]) => kinds.includes(kind)).map(([id]) => id);
}

const machines: FieldDef<Machines> = {
  id: 'machines', label: 'Machines', keys: ['machines'], kinds: kindsOf('machines'),
  read(text) {
    const items = inlineList(text, 'machines');
    if (items === UNREADABLE) return UNREADABLE;
    if (items !== null && items.some(x => x !== 'mac' && x !== 'wsl')) return UNREADABLE;
    return { mac: items?.includes('mac') ?? false, wsl: items?.includes('wsl') ?? false };
  },
  write(text, v) {
    const now = machines.read(text);
    if (now === UNREADABLE || (now.mac === v.mac && now.wsl === v.wsl)) return text;
    const list = [v.mac ? 'mac' : null, v.wsl ? 'wsl' : null].filter(x => x !== null);
    return setKey(text, 'machines', `[${list.join(', ')}]`);
  },
  summary(v) {
    if (v.mac && v.wsl) return { text: 'mac + wsl', tone: 'set' };
    if (v.mac || v.wsl) return { text: `${v.mac ? 'mac' : 'wsl'} only`, tone: 'set' };
    return { text: 'No machine', tone: 'err' };
  },
};

const repos: FieldDef<Repos> = {
  id: 'repos', label: 'Repos', keys: ['foreach', 'cwd'], kinds: kindsOf('repos'),
  read(text) {
    const foreach = scalar(text, 'foreach');
    const cwd = scalar(text, 'cwd');
    if (foreach === UNREADABLE || cwd === UNREADABLE) return UNREADABLE;
    const { mode, picks } = readForeach(text);
    // readForeach reads anything it doesn't recognise as Single cwd; a foreach line it couldn't place is one the form can't show.
    if (foreach !== null && mode === 'cwd') return UNREADABLE;
    return { mode, picks, cwd: cwd ?? '' };
  },
  write(text, v) {
    const now = repos.read(text);
    if (now === UNREADABLE) return text;
    if (now.mode === v.mode) {
      if (v.mode === 'all') return text;
      if (v.mode === 'pick' && sameList(now.picks, v.picks)) return text;
      if (v.mode === 'cwd' && now.cwd === v.cwd.trim()) return text;
    }
    if (v.mode !== 'cwd') return setRepos(text, v.mode, v.picks);
    const dropped = setRepos(text, 'cwd', []);
    return writeKeys(dropped, { cwd: fmValue(dropped, 'cwd')?.value ?? null }, { cwd: v.cwd });
  },
  summary(v, ctx) {
    if (v.mode === 'all') return { text: `All pinned (${ctx.pinCount})`, tone: 'set' };
    if (v.mode === 'pick') {
      if (v.picks.length === 0) return { text: 'No repos picked', tone: 'err' };
      return { text: `${v.picks.length} repo${v.picks.length === 1 ? '' : 's'}: ${v.picks.join(', ')}`, tone: 'set' };
    }
    return v.cwd ? { text: v.cwd, tone: 'set' } : { text: "Routines folder's parent", tone: 'dim' };
  },
};

const script: FieldDef<Script> = {
  id: 'script', label: 'Script', keys: [], kinds: kindsOf('script'),
  read(text) {
    const d = doc(text);
    if (!d) return UNREADABLE;
    const f = fence(d);
    if (!f) return '';
    // A fence that never closes gives no end for the script, so a write could only guess which lines are its.
    if (f.close === -1) return UNREADABLE;
    return d.lines.slice(f.open + 1, f.close).map(strip).join('\n');
  },
  write(text, v) {
    const d = doc(text);
    if (!d || script.read(text) === v) return text;
    const f = fence(d);
    if (f && f.close === -1) return text;
    const cr = d.nl === '\r\n' ? '\r' : '';
    const inner = v === '' ? [] : v.split('\n').map(l => l + cr);
    if (f) return [...d.lines.slice(0, f.open + 1), ...inner, ...d.lines.slice(f.close)].join('\n');
    const head = d.lines.slice(0, d.end + 1).join('\n');
    const sep = head.endsWith('\r') ? '\n' : d.nl;
    const body = bodyLines(d).join('\n').trimEnd();
    const block = ['```bash', ...v.split('\n'), '```'].join(d.nl) + d.nl;
    return head + sep + (body === '' ? '' : body.split('\n').join(d.nl) + d.nl + d.nl) + block;
  },
  summary(v) {
    const line = firstLine(v);
    return line ? { text: line, tone: 'set' } : { text: 'Empty script', tone: 'err' };
  },
};

const prompt: FieldDef<Prompt> = {
  id: 'prompt', label: 'Prompt', keys: [], kinds: kindsOf('prompt'),
  read(text) {
    const d = doc(text);
    if (!d) return UNREADABLE;
    return bodyLines(d).join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  },
  write(text, v) {
    const d = doc(text);
    if (!d || prompt.read(text) === v) return text;
    const head = d.lines.slice(0, d.end + 1).join('\n');
    const sep = head.endsWith('\r') ? '\n' : d.nl;
    const body = v.replace(/\r\n/g, '\n').trimEnd();
    return head + sep + (body === '' ? '' : body.split('\n').join(d.nl) + d.nl);
  },
  summary(v) {
    const line = firstLine(v);
    return line ? { text: line, tone: 'set' } : { text: 'No prompt yet', tone: 'err' };
  },
};

const model: FieldDef<ModelEffort> = {
  id: 'model', label: 'Model', keys: ['model', 'effort'], kinds: kindsOf('model'),
  read(text) {
    const m = scalar(text, 'model');
    const e = scalar(text, 'effort');
    if (m === UNREADABLE || e === UNREADABLE) return UNREADABLE;
    return { model: m || null, effort: e || null };
  },
  write(text, v) {
    const now = model.read(text);
    if (now === UNREADABLE) return text;
    return writeKeys(text, { model: now.model, effort: now.effort }, { model: v.model, effort: v.effort });
  },
  summary(v) {
    if (!v.model && !v.effort) return { text: 'Default model', tone: 'dim' };
    const effort = v.effort ? ` · ${v.effort} effort` : '';
    return { text: `${v.model ?? 'Default model'}${effort}`, tone: 'set' };
  },
};

const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'];

const permission: FieldDef<Permission> = {
  id: 'permission', label: 'Permission', keys: ['permission-mode'], kinds: kindsOf('permission'),
  read(text) {
    const v = scalar(text, 'permission-mode');
    return v === UNREADABLE ? UNREADABLE : v || null;
  },
  write(text, v) {
    const now = permission.read(text);
    if (now === UNREADABLE) return text;
    return writeKeys(text, { 'permission-mode': now }, { 'permission-mode': v });
  },
  summary(v) {
    if (!v) return { text: 'Default', tone: 'dim' };
    // The validator refuses anything else (bypassPermissions included), so the row says it as written, in red.
    return { text: v, tone: PERMISSION_MODES.includes(v) ? 'set' : 'err' };
  },
};

const limits: FieldDef<Limits> = {
  id: 'limits', label: 'Limits', keys: ['max-turns', 'timeout'], kinds: kindsOf('limits'),
  read(text) {
    const mt = scalar(text, 'max-turns');
    const to = scalar(text, 'timeout');
    if (mt === UNREADABLE || to === UNREADABLE) return UNREADABLE;
    return { maxTurns: mt || null, timeout: to || null };
  },
  write(text, v) {
    const now = limits.read(text);
    if (now === UNREADABLE) return text;
    return writeKeys(text, { 'max-turns': now.maxTurns, timeout: now.timeout }, { 'max-turns': v.maxTurns, timeout: v.timeout });
  },
  summary(v, ctx) {
    const parts: string[] = [];
    // max-turns only means something to claude; a shell or kind-less job shows the timeout alone.
    if (ctx.kind === 'claude') parts.push(v.maxTurns ? `${v.maxTurns} turns` : 'No turn limit');
    parts.push(v.timeout ? `${v.timeout} timeout` : '1h timeout (default)');
    const set = (ctx.kind === 'claude' && v.maxTurns) || v.timeout;
    return { text: parts.join(' · '), tone: set ? 'set' : 'dim' };
  },
};

export type TimeoutUnit = 's' | 'm' | 'h';
const TIMEOUT = /^(\d+)([smh])$/;

/**
 * What the Limits row shows for a timeout: the amount, the pressed unit and the unit a typed amount commits with. The file's unit wins; with no timeout
 * the local pick (else `m`) is pressed, so a unit can be chosen before the number; a written timeout the row cannot parse presses nothing until one is picked.
 */
export function timeoutUnitView(timeout: string | null, pick: TimeoutUnit | null): { amount: string; shown: TimeoutUnit | null; commit: TimeoutUnit } {
  const parsed = TIMEOUT.exec(timeout ?? '');
  if (parsed) return { amount: parsed[1], shown: parsed[2] as TimeoutUnit, commit: parsed[2] as TimeoutUnit };
  if (timeout === null) return { amount: '', shown: pick ?? 'm', commit: pick ?? 'm' };
  return { amount: timeout, shown: pick, commit: pick ?? 'm' };
}

/** The timeout a unit click writes, or null to write nothing: a bare positive whole number is repaired to carry the unit, anything else unparsed is left. */
export function timeoutWithUnit(timeout: string | null, u: TimeoutUnit): string | null {
  const parsed = TIMEOUT.exec(timeout ?? '');
  if (parsed) return `${parsed[1]}${u}`;
  const bare = timeout?.trim() ?? '';
  return /^[1-9]\d*$/.test(bare) ? `${bare}${u}` : null;
}

const tools: FieldDef<Tools> = {
  id: 'tools', label: 'Tools', keys: ['allowed-tools'], kinds: kindsOf('tools'),
  read(text) {
    const items = inlineList(text, 'allowed-tools');
    return items === UNREADABLE ? UNREADABLE : items ?? [];
  },
  write(text, v) {
    const now = tools.read(text);
    if (now === UNREADABLE || sameList(now, v)) return text;
    return setKey(text, 'allowed-tools', v.length === 0 ? null : `[${v.join(', ')}]`);
  },
  summary(v) {
    return v.length === 0 ? { text: 'Any tool', tone: 'dim' } : { text: v.join(', '), tone: 'set' };
  },
};

const HOURLY_STEPS = [2, 3, 6, 12] as const;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number): string => String(n).padStart(2, '0');
const inRange = (token: string, max: number): number | null => (/^\d+$/.test(token) && Number(token) <= max ? Number(token) : null);

/**
 * A cron value into a preset, by its raw tokens and never the parsed sets: `0-5 9 * * *` parses to the same minutes as `0,1,2,3,4,5 9 * * *`, and neither
 * is a single minute the Daily control could show. Anything that is not exactly a preset's shape is Custom, with its text kept as typed.
 */
function recognise(raw: string): Schedule {
  const custom: Schedule = { preset: 'custom', text: raw };
  if (isManualCron(raw)) return { preset: 'manual' };
  const tok = raw.trim().split(/\s+/);
  if (tok.length !== 5 || tok[2] !== '*' || tok[3] !== '*') return custom;
  const minute = inRange(tok[0], 59);
  if (minute === null) return custom;
  const [, hourTok, , , dow] = tok;
  if (hourTok === '*' && dow === '*') return { preset: 'hourly', minute, every: 1 };
  const step = /^\*\/(\d+)$/.exec(hourTok);
  if (step && dow === '*') {
    const every = HOURLY_STEPS.find(n => String(n) === step[1]);
    return every === undefined ? custom : { preset: 'hourly', minute, every };
  }
  const hour = inRange(hourTok, 23);
  if (hour === null) return custom;
  if (dow === '*') return { preset: 'daily', hour, minute };
  if (dow === '1-5') return { preset: 'weekdays', hour, minute };
  if (!/^[0-7](,[0-7])*$/.test(dow)) return custom;
  const days = [...new Set(dow.split(',').map(d => Number(d) % 7))].sort((a, b) => a - b);
  return { preset: 'weekly', days, hour, minute };
}

/** The `cron:` value a schedule writes; null while it has none to write (Weekly before a day is picked). */
export function cronFor(s: Schedule): string | null {
  switch (s.preset) {
    case 'manual': return 'manual';
    case 'hourly': return s.every === 1 ? `${s.minute} * * * *` : `${s.minute} */${s.every} * * *`;
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'weekdays': return `${s.minute} ${s.hour} * * 1-5`;
    case 'weekly': return s.days.length === 0 ? null : `${s.minute} ${s.hour} * * ${s.days.join(',')}`;
    case 'custom': return s.text;
  }
}

/** Quote a written value the way `jobTemplate` does, falling back to single quotes (or none) for text that holds a double quote. */
function quoted(v: string): string {
  if (!v.includes('"')) return `"${v}"`;
  return v.includes("'") ? v : `'${v}'`;
}

/**
 * Move to another preset, carrying the minute and hour across where both sides have them. A Custom cron that is really one of the presets is derived through
 * `recognise` first, so leaving it keeps its time; one that is not starts from 09:00 (spec §Schedule presets, the builder's call).
 */
export function switchPreset(from: Schedule, to: Preset): Schedule {
  if (to === from.preset) return from;
  if (to === 'manual') return { preset: 'manual' };
  const base = from.preset === 'custom' ? recognise(from.text) : from;
  if (to === 'custom') return { preset: 'custom', text: cronFor(from) ?? '' };
  const minute = 'minute' in base ? base.minute : 0;
  const hour = 'hour' in base ? base.hour : 9;
  if (to === 'hourly') return base.preset === 'hourly' ? base : { preset: 'hourly', minute, every: 1 };
  if (to === 'weekly') return base.preset === 'weekly' ? base : { preset: 'weekly', days: [], hour, minute };
  return { preset: to, hour, minute };
}

const sameSchedule = (a: Schedule, b: Schedule): boolean => JSON.stringify(a) === JSON.stringify(b);

const schedule: FieldDef<Schedule> = {
  id: 'schedule', label: 'Schedule', keys: ['cron'], kinds: kindsOf('schedule'),
  read(text) {
    const v = scalar(text, 'cron');
    if (v === UNREADABLE) return UNREADABLE;
    return recognise(v ?? '');
  },
  write(text, v) {
    const now = schedule.read(text);
    if (now === UNREADABLE) return text;
    // A blank Custom removes the line, the way a blank Limits or Tools does; `cronFor`'s '' stays for the Custom view's own readers.
    if (v.preset === 'custom' && v.text.trim() === '') return setKey(text, 'cron', null);
    const cron = cronFor(v);
    if (cron === null || sameSchedule(now, v)) return text;
    return setKey(text, 'cron', v.preset === 'manual' ? cron : quoted(cron));
  },
  summary(v) {
    const at = (h: number, m: number): string => `${pad2(h)}:${pad2(m)}`;
    switch (v.preset) {
      case 'manual': return { text: 'Manual · Run now only', tone: 'set' };
      case 'hourly': return { text: `${v.every === 1 ? 'Every hour' : `Every ${v.every}h`} at :${pad2(v.minute)}`, tone: 'set' };
      case 'daily': return { text: `Daily at ${at(v.hour, v.minute)}`, tone: 'set' };
      case 'weekdays': return { text: `Weekdays at ${at(v.hour, v.minute)}`, tone: 'set' };
      case 'weekly': {
        if (v.days.length === 0) return { text: 'Pick a day', tone: 'err' };
        const names = [...v.days].sort((a, b) => (a + 6) % 7 - (b + 6) % 7).map(d => DAY_NAMES[d]);
        return { text: `${names.join(', ')} at ${at(v.hour, v.minute)}`, tone: 'set' };
      }
      case 'custom': {
        if (v.text.trim() === '') return { text: 'No schedule', tone: 'err' };
        const p = parseCron(v.text);
        return p.ok ? { text: describeCron(p.cron), tone: 'set' } : { text: 'Cron needs fixing', tone: 'err' };
      }
    }
  },
};

export const FIELDS: {
  schedule: FieldDef<Schedule>;
  machines: FieldDef<Machines>;
  repos: FieldDef<Repos>;
  script: FieldDef<Script>;
  prompt: FieldDef<Prompt>;
  model: FieldDef<ModelEffort>;
  permission: FieldDef<Permission>;
  limits: FieldDef<Limits>;
  tools: FieldDef<Tools>;
} = { schedule, machines, repos, script, prompt, model, permission, limits, tools };

/** Which row owns a frontmatter key's line. */
const OWNER: Record<string, FieldId> = {
  cron: 'schedule', machines: 'machines', foreach: 'repos', cwd: 'repos', model: 'model', effort: 'model', 'permission-mode': 'permission',
  'allowed-tools': 'tools', 'max-turns': 'limits', timeout: 'limits',
};

/**
 * Hand each validator error to the row that owns its line (§Validation in rows). Three errors are matched by message, since the validator pins them to
 * line 0 or to the `run:` line — `cron is required` (a blank Custom removes the line) and the two body ones; an error a hidden row would own, or on a line no row owns, goes to `rest` so a disabled Save always shows its reason.
 */
export function routeErrors(text: string, errors: JobError[], kind: FormKind): { byField: Partial<Record<FieldId, JobError[]>>; rest: JobError[] } {
  const d = doc(text);
  const visible = visibleFields(kind);
  const byField: Partial<Record<FieldId, JobError[]>> = {};
  const rest: JobError[] = [];
  for (const err of errors) {
    let owner: FieldId | undefined;
    if (err.message === 'cron is required') owner = 'schedule';
    else if (err.message === 'claude job needs a prompt') owner = 'prompt';
    else if (err.message === 'shell job needs a ```bash block') owner = 'script';
    else if (d && err.line > 1 && err.line - 1 < d.end) {
      const key = /^([A-Za-z0-9_-]+):/.exec(d.lines[err.line - 1])?.[1];
      owner = key === undefined ? undefined : OWNER[key];
    }
    if (owner && visible.includes(owner)) (byField[owner] ??= []).push(err);
    else rest.push(err);
  }
  return { byField, rest };
}
