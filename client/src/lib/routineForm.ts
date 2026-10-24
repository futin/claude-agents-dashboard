/**
 * routineForm.ts — the field registry behind the job drawer's summary rows (spec `docs/superpowers/specs/2026-10-24-routine-form-design.md` §The field
 * registry, §Rows). The file's text stays the only state: each field reads its value out of the text, writes a new value back by touching only the lines it
 * owns, and says in plain words what it holds. React only renders these; the schedule field joins `FIELDS` from its own task.
 */
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

/** Write each key whose value changed; a null or blank value removes the line. */
function writeKeys(text: string, now: Record<string, string | null>, next: Record<string, string | null>): string {
  let out = text;
  for (const key of Object.keys(next)) {
    const v = next[key]?.trim() || null;
    if (v !== (now[key] ?? null)) out = setKey(out, key, v);
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
    if (now !== UNREADABLE && now.mac === v.mac && now.wsl === v.wsl) return text;
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
    if (now !== UNREADABLE && now.mode === v.mode) {
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

export const FIELDS: {
  machines: FieldDef<Machines>;
  repos: FieldDef<Repos>;
  script: FieldDef<Script>;
  prompt: FieldDef<Prompt>;
  model: FieldDef<ModelEffort>;
  permission: FieldDef<Permission>;
  limits: FieldDef<Limits>;
  tools: FieldDef<Tools>;
} = { machines, repos, script, prompt, model, permission, limits, tools };

/** Which row owns a frontmatter key's line. Kept apart from `FIELDS` so the cron line routes to Schedule before that field exists here. */
const OWNER: Record<string, FieldId> = {
  cron: 'schedule', machines: 'machines', foreach: 'repos', cwd: 'repos', model: 'model', effort: 'model', 'permission-mode': 'permission',
  'allowed-tools': 'tools', 'max-turns': 'limits', timeout: 'limits',
};

/**
 * Hand each validator error to the row that owns its line (§Validation in rows). Two body errors are matched by message, since the validator pins them to
 * line 0 or to the `run:` line; an error a hidden row would own, or on a line no row owns, goes to `rest` so a disabled Save always shows its reason.
 */
export function routeErrors(text: string, errors: JobError[], kind: FormKind): { byField: Partial<Record<FieldId, JobError[]>>; rest: JobError[] } {
  const d = doc(text);
  const visible = visibleFields(kind);
  const byField: Partial<Record<FieldId, JobError[]>> = {};
  const rest: JobError[] = [];
  for (const err of errors) {
    let owner: FieldId | undefined;
    if (err.message === 'claude job needs a prompt') owner = 'prompt';
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
