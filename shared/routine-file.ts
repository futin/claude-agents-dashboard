/**
 * routine-file.ts — parse, validate and rewrite a routine file (zero deps; runs on the server, in the client drawer and, transpiled to .mjs,
 * in the plain-Node wrapper). It reads the raw frontmatter lines itself instead of trusting `parseFrontmatter`'s data, because a nested block, an
 * empty value, a duplicate key or an unknown key must each be an error naming its line. `import type` from types.ts only: the transpiled copy has
 * no types module to load.
 */
import { isManualCron, parseCron, toCalendarIntervals } from './cron.js';
import { frontmatterFence, scalarEnd, writeFrontmatterLine } from './frontmatter.js';
import type { RoutineJob } from './types.js';

/** `line` is 1-based in the whole file (the opening `---` is line 1); 0 means the file as a whole. */
export interface JobError { line: number; message: string }

export interface PinSnapshot { dirName: string; name: string; path: string | null; listed: boolean }

export interface ParsedJob { job: RoutineJob | null; errors: JobError[] }

/** A routine's name: the filename, and a segment of its API routes. */
export const NAME_RE = /^[a-z0-9-]+$/;
/** Names a routine may not take: the `/api/routines/<x>` routes already spelled with them. */
export const RESERVED: ReadonlySet<string> = new Set(['runs', 'validate', 'reconcile', 'reveal']);
/** The launchd label every routine is installed under — a contract between the server's reconciler and the client's display. */
export const LABEL_PREFIX = 'com.claude-dashboard.routine.';
const KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;
const KNOWN = new Set([
  'cron', 'run', 'foreach', 'cwd', 'enabled', 'model', 'effort', 'permission-mode', 'allowed-tools', 'max-turns', 'timeout', 'when',
]);
/** Keys whose value is a shell line: read raw (the rest of the line, trimmed) — a ` #` or a pair of quotes is shell syntax there, not YAML. */
export const RAW_KEYS: ReadonlySet<string> = new Set(['when']);
const LIST_KEYS = new Set(['allowed-tools']);
/** The modes a routine may run under, lowest to highest: the runner clamps a file's mode to its ceiling by this order. */
export const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'] as const;
/** A job's timeout when its file names none, and the grammar of the `timeout` key. */
/**
 * The wrapper's file names: `run-routine.mjs`, and `run-schedule.mjs` from before Schedules became Routines, because a run an older install started is
 * still a live wrapper holding its lock.
 */
const WRAPPER_NAMES: ReadonlySet<string> = new Set(['run-routine.mjs', 'run-schedule.mjs']);

/**
 * Whether the command line `command` runs the wrapper for exactly `job`: a whitespace-split element whose basename is a wrapper name, followed by `job` as
 * the next element (`git-sync` never matches `git-sync-all`). The server's lock sweep and the wrapper's own lock both ask this; an install path with a space
 * in it would read as not-a-wrapper, and `~/.claude/plugins/…` has none. The basename is the text after the last `/`, since the client imports this module
 * and `node:path` is not there.
 */
export function isWrapperCommand(command: string, job: string): boolean {
  const tokens = command.trim().split(/\s+/);
  return tokens.some((t, i) => WRAPPER_NAMES.has(t.slice(t.lastIndexOf('/') + 1)) && tokens[i + 1] === job);
}

/** A lock's `bootId` against this host's: one missing on either side counts as the same boot, so a host that cannot read one never reads every lock stale. */
export function sameBoot(held: unknown, mine: string | null): boolean {
  return held == null || mine == null || held === mine;
}

export const DEFAULT_TIMEOUT_MS = 3_600_000;
export const TIMEOUT_RE = /^(\d+)([smh])$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Strips one matching pair of outer quotes, as every frontmatter value is read. */
export function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) return v.slice(1, -1);
  return v;
}

/** `[a, b]` -> items, or null when the value is not the inline form. */
export function inlineList(v: string): string[] | null {
  if (v.length < 2 || v[0] !== '[' || v[v.length - 1] !== ']') return null;
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((x) => unquote(x.trim()));
}

const isComment = (l: string): boolean => /^\s*#/.test(l);
const isBlank = (l: string): boolean => l.trim() === '';
const isIndented = (l: string): boolean => /^\s+\S/.test(l) && !isComment(l);

export function parseJob(name: string, text: string, machine: 'mac' | 'wsl'): ParsedJob {
  const errors: JobError[] = [];
  const push = (line: number, message: string): void => { errors.push({ line, message }); };
  const done = (job: RoutineJob | null): ParsedJob => ({ job: errors.length === 0 ? job : null, errors });

  if (!NAME_RE.test(name)) push(0, 'name must match [a-z0-9-]+');
  else if (RESERVED.has(name)) push(0, 'name is reserved');

  const fence = frontmatterFence(String(text ?? ''));
  if (!fence) { push(0, 'file must start with a --- frontmatter block'); return done(null); }
  const end = fence.close;
  if (end === -1) { push(0, 'frontmatter is not closed with ---'); return done(null); }
  const lines = fence.lines.map((l) => l.replace(/\r$/, ''));

  const seen = new Map<string, { value: string; line: number }>();
  // Keys whose block was already reported: present, but neither empty nor missing, so no second error is raised for them.
  const broken = new Set<string>();
  let i = 1;
  while (i < end) {
    const l = lines[i];
    if (isBlank(l) || isComment(l)) { i++; continue; }
    const lineNo = i + 1;
    const m = l.match(KEY_RE);
    if (!m || /^\s/.test(l)) {
      push(lineNo, /^\s/.test(l) ? 'unexpected indented line' : 'expected key: value');
      i++;
      continue;
    }
    const key = m[1];
    const rest = m[2].trimStart();
    const value = RAW_KEYS.has(key) ? rest.trimEnd() : unquote(rest.slice(0, scalarEnd(rest)));
    i++;

    // A block under the key (nested list/map, or `>` / `|` scalar) is consumed whole so it is reported once, on the key's own line.
    const blockScalar = /^[>|][+-]?$/.test(value);
    let nested = false;
    if (value === '' || blockScalar) {
      let j = i;
      while (j < end && (isBlank(lines[j]) || isComment(lines[j]) || isIndented(lines[j]))) {
        if (isIndented(lines[j])) nested = true;
        j++;
      }
      if (nested || blockScalar) i = j;
    }

    if (seen.has(key)) { push(lineNo, `${key} given twice`); continue; }
    seen.set(key, { value, line: lineNo });
    if (key === 'machines') { push(lineNo, 'machines: no longer used — a job runs on the machine whose folder holds it; delete this line'); broken.add(key); continue; }
    if (!KNOWN.has(key)) { push(lineNo, `unknown key ${key}`); continue; }
    if (nested || blockScalar) {
      push(lineNo, LIST_KEYS.has(key) || key === 'foreach' ? `${key} must be an inline list [a, b]` : `${key} must be a single-line value`);
      broken.add(key);
    }
  }

  const get = (key: string): { value: string; line: number } | null => (broken.has(key) ? null : seen.get(key) ?? null);
  const requireValue = (key: string): { value: string; line: number } | null => {
    const e = get(key);
    if (e && e.value === '') { push(e.line, `${key} is empty`); return null; }
    return e;
  };
  const oneToken = (key: 'model' | 'effort'): string | null => {
    const e = requireValue(key);
    if (!e) return null;
    if (/\s/.test(e.value)) { push(e.line, `${key} must be one token`); return null; }
    return e.value;
  };
  const listOf = (key: string): string[] | null => {
    const e = requireValue(key);
    if (!e) return null;
    const items = inlineList(e.value);
    if (items === null) push(e.line, `${key} must be an inline list [a, b]`);
    return items;
  };

  // cron
  let cron: string | null = null;
  const cronE = requireValue('cron');
  if (cronE) {
    if (isManualCron(cronE.value)) cron = cronE.value;
    else {
      const r = parseCron(cronE.value);
      if (!r.ok) push(cronE.line, r.error);
      else cron = cronE.value;
    }
  } else if (!seen.has('cron')) push(0, 'cron is required');

  // run
  let runKind: 'shell' | 'claude' | null = null;
  const runE = requireValue('run');
  if (runE) {
    if (runE.value === 'shell' || runE.value === 'claude') runKind = runE.value;
    else push(runE.line, 'run must be shell or claude');
  } else if (!seen.has('run')) push(0, 'run is required');

  // mac can only express what launchd's StartCalendarInterval can
  if (cron !== null && !isManualCron(cron) && cronE && machine === 'mac') {
    const parsed = parseCron(cron);
    if (parsed.ok && toCalendarIntervals(parsed.cron) === null) push(cronE.line, 'cron: launchd cannot combine day-of-month and weekday; use one');
  }

  // foreach / cwd
  let foreach: RoutineJob['foreach'] = null;
  const foreachE = requireValue('foreach');
  if (foreachE) {
    if (foreachE.value === 'pinned') foreach = 'pinned';
    else {
      const items = inlineList(foreachE.value);
      if (items === null) push(foreachE.line, 'foreach must be pinned or a list [a, b]');
      else if (items.length === 0 || items.some((x) => x === '')) push(foreachE.line, 'foreach list is empty');
      else foreach = items;
    }
  }
  const cwdE = requireValue('cwd');
  if (cwdE && seen.has('foreach')) push(cwdE.line, 'cwd is not used with foreach');

  // enabled
  let enabled = true;
  const enabledE = requireValue('enabled');
  if (enabledE) {
    if (enabledE.value === 'true' || enabledE.value === 'false') enabled = enabledE.value === 'true';
    else push(enabledE.line, 'enabled must be true or false');
  }

  const model = oneToken('model');
  const effort = oneToken('effort');

  let permissionMode: RoutineJob['permissionMode'] = null;
  const pmE = requireValue('permission-mode');
  if (pmE) {
    const hit = PERMISSION_MODES.find((x) => x === pmE.value);
    if (hit) permissionMode = hit;
    else push(pmE.line, 'permission-mode must be plan, acceptEdits or auto');
  }

  let allowedTools: string[] | null = null;
  allowedTools = listOf('allowed-tools');

  let maxTurns: number | null = null;
  const mtE = requireValue('max-turns');
  if (mtE) {
    if (/^\d+$/.test(mtE.value) && Number(mtE.value) > 0) maxTurns = Number(mtE.value);
    else push(mtE.line, 'max-turns must be a positive integer');
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const toE = requireValue('timeout');
  if (toE) {
    const tm = toE.value.match(TIMEOUT_RE);
    if (tm && Number(tm[1]) > 0) timeoutMs = Number(tm[1]) * UNIT_MS[tm[2] as keyof typeof UNIT_MS];
    else push(toE.line, 'timeout must be like 30s, 30m or 2h');
  }

  // A shell job can test for itself; the gate exists to spare a claude session.
  let when: string | null = null;
  const whenE = requireValue('when');
  if (whenE) {
    if (runKind === 'shell') push(whenE.line, 'when is only for run: claude');
    else when = whenE.value;
  }

  // body + script
  const bodyLines = lines.slice(end + 1);
  const body = bodyLines.join('\n').trim();
  let script: string | null = null;
  if (runKind === 'shell') {
    const open = bodyLines.findIndex((l) => /^```bash\s*$/.test(l));
    const close = open === -1 ? -1 : bodyLines.findIndex((l, k) => k > open && /^```\s*$/.test(l));
    if (open === -1) push(seen.get('run')?.line ?? 0, 'shell job needs a ```bash block');
    else if (close === -1) push(end + 1 + open + 1, 'shell job needs a ```bash block');
    else script = bodyLines.slice(open + 1, close).join('\n');
  } else if (runKind === 'claude' && body === '') push(0, 'claude job needs a prompt');

  errors.sort((a, b) => a.line - b.line);
  if (errors.length > 0 || cron === null || runKind === null) return done(null);
  return done({
    name, cron, run: runKind, foreach, cwd: cwdE ? cwdE.value : null, enabled, model, effort, permissionMode, allowedTools, maxTurns, timeoutMs, when, body,
    script,
  });
}

/**
 * Ambiguity check for `foreach: [names]`: a name shared by two listed pins cannot say which repo is meant, so the file must use a dirName. A name
 * matching no listed pin is not an error here — the wrapper skips it as `not pinned` on a machine that lacks it. Line 0: pins carry no file position.
 */
export function checkPins(job: RoutineJob, pins: PinSnapshot[]): JobError[] {
  if (!Array.isArray(job.foreach)) return [];
  const errors: JobError[] = [];
  const listed = pins.filter((p) => p.listed);
  for (const entry of job.foreach) {
    const byName = listed.filter((p) => p.name === entry);
    if (byName.length > 1) {
      errors.push({ line: 0, message: `foreach: ${entry} is ambiguous here (${byName.map((p) => p.dirName).join(', ')}); use the dirName` });
    }
  }
  return errors;
}

/** Flip `enabled:` in place, inserting it after `run:` when the file has none; every other byte of the file is kept. */
export function serializeEnabled(text: string, enabled: boolean): string {
  return writeFrontmatterLine(text, 'enabled', enabled ? 'true' : 'false', 'run');
}
