/**
 * schedule-file.ts — parse, validate and rewrite a scheduled-job file (zero deps; runs on the server, in the client drawer and, transpiled to .mjs,
 * in the plain-Node wrapper). It reads the raw frontmatter lines itself instead of trusting `parseFrontmatter`'s data, because a nested block, an
 * empty value, a duplicate key or an unknown key must each be an error naming its line. `import type` from types.ts only: the transpiled copy has
 * no types module to load.
 */
import { parseCron, toCalendarIntervals } from './cron.mjs';
import { scalarEnd, writeFrontmatterLine } from './frontmatter.mjs';
const NAME_RE = /^[a-z0-9-]+$/;
const RESERVED = new Set(['runs', 'validate', 'reconcile', 'reveal']);
const KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;
const KNOWN = new Set([
    'cron', 'machines', 'run', 'foreach', 'cwd', 'enabled', 'model', 'effort', 'permission-mode', 'allowed-tools', 'max-turns', 'timeout',
]);
const LIST_KEYS = new Set(['machines', 'allowed-tools']);
const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'];
const DEFAULT_TIMEOUT_MS = 3_600_000;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
function unquote(v) {
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")))
        return v.slice(1, -1);
    return v;
}
/** `[a, b]` -> items, or null when the value is not the inline form. */
function inlineList(v) {
    if (v.length < 2 || v[0] !== '[' || v[v.length - 1] !== ']')
        return null;
    const inner = v.slice(1, -1).trim();
    if (inner === '')
        return [];
    return inner.split(',').map((x) => unquote(x.trim()));
}
const isComment = (l) => /^\s*#/.test(l);
const isBlank = (l) => l.trim() === '';
const isIndented = (l) => /^\s+\S/.test(l) && !isComment(l);
export function parseJob(name, text) {
    const errors = [];
    const push = (line, message) => { errors.push({ line, message }); };
    const done = (job) => ({ job: errors.length === 0 ? job : null, errors });
    if (!NAME_RE.test(name))
        push(0, 'name must match [a-z0-9-]+');
    else if (RESERVED.has(name))
        push(0, 'name is reserved');
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
    if (lines[0] !== '---') {
        push(0, 'file must start with a --- frontmatter block');
        return done(null);
    }
    const end = lines.indexOf('---', 1);
    if (end === -1) {
        push(0, 'frontmatter is not closed with ---');
        return done(null);
    }
    const seen = new Map();
    // Keys whose block was already reported: present, but neither empty nor missing, so no second error is raised for them.
    const broken = new Set();
    let i = 1;
    while (i < end) {
        const l = lines[i];
        if (isBlank(l) || isComment(l)) {
            i++;
            continue;
        }
        const lineNo = i + 1;
        const m = l.match(KEY_RE);
        if (!m || /^\s/.test(l)) {
            push(lineNo, /^\s/.test(l) ? 'unexpected indented line' : 'expected key: value');
            i++;
            continue;
        }
        const key = m[1];
        const rest = m[2].trimStart();
        const value = unquote(rest.slice(0, scalarEnd(rest)));
        i++;
        // A block under the key (nested list/map, or `>` / `|` scalar) is consumed whole so it is reported once, on the key's own line.
        const blockScalar = /^[>|][+-]?$/.test(value);
        let nested = false;
        if (value === '' || blockScalar) {
            let j = i;
            while (j < end && (isBlank(lines[j]) || isComment(lines[j]) || isIndented(lines[j]))) {
                if (isIndented(lines[j]))
                    nested = true;
                j++;
            }
            if (nested || blockScalar)
                i = j;
        }
        if (seen.has(key)) {
            push(lineNo, `${key} given twice`);
            continue;
        }
        seen.set(key, { value, line: lineNo });
        if (!KNOWN.has(key)) {
            push(lineNo, `unknown key ${key}`);
            continue;
        }
        if (nested || blockScalar) {
            push(lineNo, LIST_KEYS.has(key) || key === 'foreach' ? `${key} must be an inline list [a, b]` : `${key} must be a single-line value`);
            broken.add(key);
        }
    }
    const get = (key) => (broken.has(key) ? null : seen.get(key) ?? null);
    const requireValue = (key) => {
        const e = get(key);
        if (e && e.value === '') {
            push(e.line, `${key} is empty`);
            return null;
        }
        return e;
    };
    const oneToken = (key) => {
        const e = requireValue(key);
        if (!e)
            return null;
        if (/\s/.test(e.value)) {
            push(e.line, `${key} must be one token`);
            return null;
        }
        return e.value;
    };
    const listOf = (key) => {
        const e = requireValue(key);
        if (!e)
            return null;
        const items = inlineList(e.value);
        if (items === null)
            push(e.line, `${key} must be an inline list [a, b]`);
        return items;
    };
    // cron
    let cron = null;
    const cronE = requireValue('cron');
    if (cronE) {
        const r = parseCron(cronE.value);
        if (!r.ok)
            push(cronE.line, r.error);
        else
            cron = cronE.value;
    }
    else if (!seen.has('cron'))
        push(0, 'cron is required');
    // machines
    let machines = null;
    const machinesE = get('machines');
    if (machinesE) {
        const items = listOf('machines');
        if (items) {
            const bad = items.find((x) => x !== 'mac' && x !== 'wsl');
            if (bad !== undefined)
                push(machinesE.line, `machines: unknown machine ${bad}`);
            else if (items.length === 0)
                push(machinesE.line, 'machines needs mac, wsl or both');
            else
                machines = [...new Set(items)];
        }
    }
    else if (!seen.has('machines'))
        push(0, 'machines is required');
    // run
    let runKind = null;
    const runE = requireValue('run');
    if (runE) {
        if (runE.value === 'shell' || runE.value === 'claude')
            runKind = runE.value;
        else
            push(runE.line, 'run must be shell or claude');
    }
    else if (!seen.has('run'))
        push(0, 'run is required');
    // mac can only express what launchd's StartCalendarInterval can
    if (cron !== null && cronE && machines?.includes('mac')) {
        const parsed = parseCron(cron);
        if (parsed.ok && toCalendarIntervals(parsed.cron) === null)
            push(cronE.line, 'cron: launchd cannot combine day-of-month and weekday; use one');
    }
    // foreach / cwd
    let foreach = null;
    const foreachE = requireValue('foreach');
    if (foreachE) {
        if (foreachE.value === 'pinned')
            foreach = 'pinned';
        else {
            const items = inlineList(foreachE.value);
            if (items === null)
                push(foreachE.line, 'foreach must be pinned or a list [a, b]');
            else if (items.length === 0 || items.some((x) => x === ''))
                push(foreachE.line, 'foreach list is empty');
            else
                foreach = items;
        }
    }
    const cwdE = requireValue('cwd');
    if (cwdE && seen.has('foreach'))
        push(cwdE.line, 'cwd is not used with foreach');
    // enabled
    let enabled = true;
    const enabledE = requireValue('enabled');
    if (enabledE) {
        if (enabledE.value === 'true' || enabledE.value === 'false')
            enabled = enabledE.value === 'true';
        else
            push(enabledE.line, 'enabled must be true or false');
    }
    const model = oneToken('model');
    const effort = oneToken('effort');
    let permissionMode = null;
    const pmE = requireValue('permission-mode');
    if (pmE) {
        const hit = PERMISSION_MODES.find((x) => x === pmE.value);
        if (hit)
            permissionMode = hit;
        else
            push(pmE.line, 'permission-mode must be plan, acceptEdits or auto');
    }
    let allowedTools = null;
    allowedTools = listOf('allowed-tools');
    let maxTurns = null;
    const mtE = requireValue('max-turns');
    if (mtE) {
        if (/^\d+$/.test(mtE.value) && Number(mtE.value) > 0)
            maxTurns = Number(mtE.value);
        else
            push(mtE.line, 'max-turns must be a positive integer');
    }
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    const toE = requireValue('timeout');
    if (toE) {
        const tm = toE.value.match(/^(\d+)([smh])$/);
        if (tm && Number(tm[1]) > 0)
            timeoutMs = Number(tm[1]) * UNIT_MS[tm[2]];
        else
            push(toE.line, 'timeout must be like 30s, 30m or 2h');
    }
    // body + script
    const bodyLines = lines.slice(end + 1);
    const body = bodyLines.join('\n').trim();
    let script = null;
    if (runKind === 'shell') {
        const open = bodyLines.findIndex((l) => /^```bash\s*$/.test(l));
        const close = open === -1 ? -1 : bodyLines.findIndex((l, k) => k > open && /^```\s*$/.test(l));
        if (open === -1)
            push(seen.get('run')?.line ?? 0, 'shell job needs a ```bash block');
        else if (close === -1)
            push(end + 1 + open + 1, 'shell job needs a ```bash block');
        else
            script = bodyLines.slice(open + 1, close).join('\n');
    }
    else if (runKind === 'claude' && body === '')
        push(0, 'claude job needs a prompt');
    errors.sort((a, b) => a.line - b.line);
    if (errors.length > 0 || cron === null || machines === null || runKind === null)
        return done(null);
    return done({
        name, cron, machines, run: runKind, foreach, cwd: cwdE ? cwdE.value : null, enabled, model, effort, permissionMode, allowedTools, maxTurns, timeoutMs, body, script,
    });
}
/**
 * Ambiguity check for `foreach: [names]`: a name shared by two listed pins cannot say which repo is meant, so the file must use a dirName. A name
 * matching no listed pin is not an error here — the wrapper skips it as `not pinned` on a machine that lacks it. Line 0: pins carry no file position.
 */
export function checkPins(job, pins) {
    if (!Array.isArray(job.foreach))
        return [];
    const errors = [];
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
export function serializeEnabled(text, enabled) {
    return writeFrontmatterLine(text, 'enabled', enabled ? 'true' : 'false', 'run');
}
