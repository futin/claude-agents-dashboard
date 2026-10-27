/**
 * The drawer form's field registry (`client/src/lib/routineForm.ts`): each field's read / write / summary over a job file's text, and the router that
 * hands validator errors to rows. The fixtures are the drawer's own templates, comments and alignment padding included, so "touches only its own lines"
 * is checked against the files people actually start from.
 */
import assert from 'node:assert';

import {
  FIELDS, UNREADABLE, cronFor, fmValue, formKind, frontmatterReadable, routeErrors, setKey, switchPreset, timeoutUnitView, timeoutWithUnit, visibleFields
} from '../client/src/lib/routineForm.js';
import { jobTemplate, setRepos } from '../client/src/lib/routines.js';
import type { Schedule } from '../client/src/lib/routineForm.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const SKILL = jobTemplate('skill');
const SHELL = jobTemplate('shell');
const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
const ctx = { pinCount: 6, kind: 'claude' as const };
const lineOf = (text: string, prefix: string): number => text.split('\n').findIndex(l => l.startsWith(prefix)) + 1;

/** Every line but `except` (0-based) is byte-identical, and the line count is unchanged. */
function onlyLineChanged(before: string, after: string, except: number): void {
  const a = before.split('\n'), b = after.split('\n');
  assert.strictEqual(b.length, a.length);
  a.forEach((l, i) => { if (i !== except) assert.strictEqual(b[i], l, `line ${i + 1} changed`); });
}

export function run(): number {
  console.log('\n=== routineForm.ts (drawer form field registry) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  // --- line helpers ---

  t('fmValue: quotes and the trailing comment dropped, 1-based line; a commented-out key is absent', () => {
    assert.deepStrictEqual(fmValue(SKILL, 'cron'), { value: '0 22 * * *', line: 2 });
    assert.strictEqual(fmValue(SKILL, 'cwd'), null);
    assert.deepStrictEqual(fmValue(crlf(SKILL), 'model'), { value: 'opus', line: 8 });
  });

  t('fmValue: never reads past the closing fence', () => {
    assert.strictEqual(fmValue('---\nrun: claude\n---\nmodel: opus\n', 'model'), null);
  });

  t('frontmatterReadable: needs the opening fence on line 1 and a closing one', () => {
    assert.strictEqual(frontmatterReadable(SKILL), true);
    assert.strictEqual(frontmatterReadable(crlf(SKILL)), true);
    assert.strictEqual(frontmatterReadable('cron: x\n---\n'), false);
    assert.strictEqual(frontmatterReadable('---\ncron: x\n'), false);
  });

  t('setKey in place: only the model line changes, padding and comment kept', () => {
    const out = setKey(SKILL, 'model', 'sonnet');
    const orig = SKILL.split('\n')[7];
    assert.ok(orig.startsWith('model: opus '));
    assert.strictEqual(out.split('\n')[7], orig.replace('opus', 'sonnet'));
    onlyLineChanged(SKILL, out, 7);
  });

  t('setKey null drops exactly that line; CRLF result is the LF result with CRLF endings', () => {
    const at = lineOf(SKILL, 'max-turns:') - 1;
    const out = setKey(SKILL, 'max-turns', null);
    const want = SKILL.split('\n');
    want.splice(at, 1);
    assert.strictEqual(out, want.join('\n'));
    assert.strictEqual(setKey(crlf(SKILL), 'max-turns', null), crlf(out));
  });

  t('setKey null on an absent key returns the text unchanged', () => {
    assert.strictEqual(setKey(SKILL, 'cwd', null), SKILL);
  });

  t('setKey inserts after the nearest preceding existing key', () => {
    const noEffort = setKey(SKILL, 'effort', null);
    const out = setKey(noEffort, 'effort', 'high');
    const lines = out.split('\n');
    const m = lines.findIndex(l => l.startsWith('model:'));
    assert.strictEqual(lines[m + 1], 'effort: high');
    assert.strictEqual(out, SKILL.split('\n').map((l, i) => (i === m + 1 ? 'effort: high' : l)).join('\n'));

    const small = '---\ncron: "0 7 * * *"\nmachines: [mac]\nrun: shell\n---\nbody\n';
    assert.strictEqual(setKey(small, 'timeout', '30m'), '---\ncron: "0 7 * * *"\nmachines: [mac]\nrun: shell\ntimeout: 30m\n---\nbody\n');
  });

  t('setKey insert: no preceding key goes before the closing fence; CRLF kept on the new line', () => {
    assert.strictEqual(setKey('---\ntimeout: 1h\n---\n', 'cron', '0 7 * * *'), '---\ntimeout: 1h\ncron: 0 7 * * *\n---\n');
    assert.strictEqual(setKey('---\r\nrun: shell\r\n---\r\n', 'timeout', '2h'), '---\r\nrun: shell\r\ntimeout: 2h\r\n---\r\n');
  });

  t('setKey insert skips a block under the anchor key instead of splitting it', () => {
    const text = '---\nrun: claude\nallowed-tools:\n  - Bash\n---\nhi\n';
    assert.strictEqual(setKey(text, 'max-turns', '5'), '---\nrun: claude\nallowed-tools:\n  - Bash\nmax-turns: 5\n---\nhi\n');
  });

  t('formKind: the run: value; anything else or no line is null', () => {
    assert.strictEqual(formKind(SKILL), 'claude');
    assert.strictEqual(formKind(SHELL), 'shell');
    assert.strictEqual(formKind('---\ncron: x\nrun: bash\n---\n'), null);
    assert.strictEqual(formKind('---\ncron: x\n---\n'), null);
  });

  // --- machines ---

  t('machines: read, summary, unreadable', () => {
    const m = FIELDS.machines;
    assert.deepStrictEqual(m.read(SKILL), { mac: true, wsl: true });
    assert.deepStrictEqual(m.summary({ mac: true, wsl: true }, ctx), { text: 'mac + wsl', tone: 'set' });
    assert.deepStrictEqual(m.summary({ mac: false, wsl: true }, ctx), { text: 'wsl only', tone: 'set' });
    assert.deepStrictEqual(m.summary({ mac: true, wsl: false }, ctx), { text: 'mac only', tone: 'set' });
    const none = m.read('---\nmachines: []\n---\n');
    assert.deepStrictEqual(none, { mac: false, wsl: false });
    assert.deepStrictEqual(m.summary(none as { mac: boolean; wsl: boolean }, ctx), { text: 'No machine', tone: 'err' });
    assert.strictEqual(m.read('---\nmachines: [mac, linux]\n---\n'), UNREADABLE);
    assert.strictEqual(m.read('---\nmachines:\n  - mac\n---\n'), UNREADABLE);
    assert.strictEqual(m.read('no frontmatter'), UNREADABLE);
  });

  t('machines: write keeps the comment; none writes []; unchanged is a no-op', () => {
    const m = FIELDS.machines;
    const at = lineOf(SKILL, 'machines:') - 1;
    const out = m.write(SKILL, { mac: true, wsl: false });
    assert.strictEqual(out.split('\n')[at], SKILL.split('\n')[at].replace('[mac, wsl]', '[mac]'));
    onlyLineChanged(SKILL, out, at);
    assert.ok(m.write(SKILL, { mac: false, wsl: false }).split('\n')[at].startsWith('machines: []'));
    assert.strictEqual(m.write(SKILL, { mac: true, wsl: true }), SKILL);
    assert.strictEqual(m.write(crlf(SKILL), { mac: true, wsl: false }), crlf(out));
  });

  t('machines: a write over an unreadable line leaves the text unchanged', () => {
    const odd = '---\nmachines: [mac, linux]\nrun: shell\n---\n';
    assert.strictEqual(FIELDS.machines.write(odd, { mac: true, wsl: false }), odd);
  });

  // --- repos ---

  t('repos: a write over an unreadable line leaves the text unchanged', () => {
    const block = '---\nforeach:\n  - a\n---\n';
    assert.strictEqual(FIELDS.repos.write(block, { mode: 'all', picks: [], cwd: '' }), block);
    assert.strictEqual(FIELDS.repos.write(block, { mode: 'cwd', picks: [], cwd: '~/y' }), block);
  });

  t('repos: read and summaries', () => {
    const r = FIELDS.repos;
    assert.deepStrictEqual(r.read(SKILL), { mode: 'all', picks: [], cwd: '' });
    assert.deepStrictEqual(r.summary({ mode: 'all', picks: [], cwd: '' }, { pinCount: 6, kind: 'claude' }), { text: 'All pinned (6)', tone: 'set' });
    const pick = r.read('---\nforeach: [a, b]\n---\n');
    assert.deepStrictEqual(pick, { mode: 'pick', picks: ['a', 'b'], cwd: '' });
    assert.deepStrictEqual(r.summary({ mode: 'pick', picks: ['a', 'b'], cwd: '' }, ctx), { text: '2 repos: a, b', tone: 'set' });
    const one = r.read('---\ncwd: ~/x\n---\n');
    assert.deepStrictEqual(one, { mode: 'cwd', picks: [], cwd: '~/x' });
    assert.deepStrictEqual(r.summary({ mode: 'cwd', picks: [], cwd: '~/x' }, ctx), { text: '~/x', tone: 'set' });
    const neither = r.read('---\nrun: shell\n---\n');
    assert.deepStrictEqual(neither, { mode: 'cwd', picks: [], cwd: '' });
    assert.deepStrictEqual(r.summary({ mode: 'cwd', picks: [], cwd: '' }, ctx), { text: "Routines folder's parent", tone: 'dim' });
    assert.strictEqual(r.read('---\nforeach: everything\n---\n'), UNREADABLE);
    // A value holding ` #` would read back cut at the comment, so it is written quoted and reads back whole.
    const hashed = r.write('---\nrun: shell\n---\n', { mode: 'cwd', picks: [], cwd: '~/a #b' });
    assert.strictEqual(hashed, '---\nrun: shell\ncwd: "~/a #b"\n---\n');
    assert.deepStrictEqual(r.read(hashed), { mode: 'cwd', picks: [], cwd: '~/a #b' });
    assert.strictEqual(r.write(hashed, { mode: 'cwd', picks: [], cwd: '~/a #b' }), hashed);
  });

  t('repos: One folder drops foreach and writes cwd; empty cwd removes it', () => {
    const r = FIELDS.repos;
    const out = r.write(SKILL, { mode: 'cwd', picks: [], cwd: '~/y' });
    assert.strictEqual(fmValue(out, 'foreach'), null);
    assert.strictEqual(fmValue(out, 'cwd')?.value, '~/y');
    const want = SKILL.split('\n').filter(l => !l.startsWith('foreach:'));
    want.splice(want.findIndex(l => l.startsWith('run:')) + 1, 0, 'cwd: ~/y');
    assert.strictEqual(out, want.join('\n'));
    const cleared = r.write(out, { mode: 'cwd', picks: [], cwd: '' });
    assert.strictEqual(cleared, SKILL.split('\n').filter(l => !l.startsWith('foreach:')).join('\n'));
  });

  // The shell template's foreach explanation rides on the foreach line, so it leaves with it (#285).
  t('repos: One folder on the shell template leaves no foreach comment behind', () => {
    const out = FIELDS.repos.write(SHELL, { mode: 'cwd', picks: [], cwd: '~/x' });
    assert.ok(!/pinned = every pinned repo/.test(out), out);
    assert.ok(!/foreach/.test(out.split('\n---\n')[0]), out);
    assert.strictEqual(fmValue(out, 'cwd')?.value, '~/x');
  });

  t('repos: Pick on the shell template keeps the trailing explanation; Pick then All round-trips', () => {
    const r = FIELDS.repos;
    const picked = r.write(SHELL, { mode: 'pick', picks: ['a'], cwd: '' });
    const line = picked.split('\n').find(l => l.startsWith('foreach:'));
    assert.match(line ?? '', /^foreach: \[a\]\s+# pinned = every pinned repo; a list = only these, by folder name$/);
    assert.strictEqual(r.write(picked, { mode: 'all', picks: [], cwd: '' }), SHELL);
  });

  t('repos: All and Pick writes are setRepos', () => {
    const r = FIELDS.repos;
    assert.strictEqual(r.write(SKILL, { mode: 'pick', picks: ['a', 'b'], cwd: '' }), setRepos(SKILL, 'pick', ['a', 'b']));
    const single = '---\ncron: x\nmachines: [mac]\nrun: shell\ncwd: ~/z\n---\n```bash\nls\n```\n';
    assert.strictEqual(r.write(single, { mode: 'all', picks: [], cwd: '' }), setRepos(single, 'all', []));
    assert.strictEqual(r.write(SKILL, { mode: 'all', picks: [], cwd: '' }), SKILL);
  });

  // --- script ---

  t('script: reads the fence inside; a write replaces only it', () => {
    const s = FIELDS.script;
    assert.strictEqual(s.read(SHELL), 'git pull --ff-only --quiet');
    const framed = SHELL.replace('```bash\n', 'Before.\n```bash\n') + 'After.\n';
    const out = s.write(framed, 'echo hi');
    assert.strictEqual(out, framed.replace('git pull --ff-only --quiet', 'echo hi'));
    assert.strictEqual(s.write(crlf(framed), 'echo hi\nls'), crlf(framed.replace('git pull --ff-only --quiet', 'echo hi\nls')));
    assert.strictEqual(s.read(crlf(framed)), 'git pull --ff-only --quiet');
    assert.strictEqual(s.write(SHELL, 'git pull --ff-only --quiet'), SHELL);
  });

  t('script: no fence reads empty and a write appends one after the body', () => {
    const s = FIELDS.script;
    const head = '---\ncron: x\nmachines: [mac]\nrun: shell\n---\n';
    assert.strictEqual(s.read(head + 'note\n'), '');
    assert.strictEqual(s.write(head + 'note\n', 'echo hi'), head + 'note\n\n```bash\necho hi\n```\n');
    assert.strictEqual(s.write(head, 'echo hi'), head + '```bash\necho hi\n```\n');
    assert.strictEqual(s.write(head + 'note\n', ''), head + 'note\n');
  });

  t('script: an unclosed fence is unreadable; summary is the first non-empty line', () => {
    const s = FIELDS.script;
    assert.strictEqual(s.read('---\nrun: shell\n---\n```bash\nls\n'), UNREADABLE);
    assert.deepStrictEqual(s.summary('\n  git pull\nls', ctx), { text: 'git pull', tone: 'set' });
    assert.deepStrictEqual(s.summary('', ctx), { text: 'Empty script', tone: 'err' });
  });

  // --- prompt ---

  t('prompt: reads the body; a write replaces only it and ends with one newline', () => {
    const pr = FIELDS.prompt;
    assert.strictEqual(pr.read(SKILL), '/git-sync');
    const out = pr.write(SKILL, 'Do the thing.\nThen stop.\n\n');
    const fm = SKILL.slice(0, SKILL.indexOf('/git-sync'));
    assert.strictEqual(out, fm + 'Do the thing.\nThen stop.\n');
    assert.strictEqual(pr.write(crlf(SKILL), 'a\nb'), crlf(fm + 'a\nb\n'));
    assert.strictEqual(pr.write(SKILL, '/git-sync'), SKILL);
    assert.strictEqual(pr.write('---\nrun: claude\n---', 'hi'), '---\nrun: claude\n---\nhi\n');
  });

  t('prompt: summary is the first line, cut at 60 with …; empty is the red "No prompt yet"', () => {
    const pr = FIELDS.prompt;
    assert.deepStrictEqual(pr.summary('/git-sync', ctx), { text: '/git-sync', tone: 'set' });
    assert.deepStrictEqual(pr.summary('', ctx), { text: 'No prompt yet', tone: 'err' });
    const long = 'x'.repeat(70);
    assert.deepStrictEqual(pr.summary(long + '\nmore', ctx), { text: 'x'.repeat(60) + '…', tone: 'set' });
    assert.deepStrictEqual(pr.summary('x'.repeat(60), ctx), { text: 'x'.repeat(60), tone: 'set' });
  });

  // --- model ---

  t('model: read, summaries, writes', () => {
    const m = FIELDS.model;
    assert.deepStrictEqual(m.read(SKILL), { model: 'opus', effort: 'medium' });
    assert.deepStrictEqual(m.summary({ model: 'opus', effort: 'medium' }, ctx), { text: 'opus · medium effort', tone: 'set' });
    assert.deepStrictEqual(m.summary({ model: null, effort: null }, ctx), { text: 'Default model', tone: 'dim' });
    assert.deepStrictEqual(m.summary({ model: null, effort: 'high' }, ctx), { text: 'Default model · high effort', tone: 'set' });
    const out = m.write(SKILL, { model: null, effort: 'medium' });
    assert.strictEqual(out, SKILL.split('\n').filter(l => !l.startsWith('model:')).join('\n'));
    const quoted = SKILL.replace('model: opus', 'model: "opus"');
    assert.strictEqual(m.write(quoted, m.read(quoted) as { model: string | null; effort: string | null }), quoted);
    assert.strictEqual(m.read('---\nmodel: >\n  opus\n---\n'), UNREADABLE);
  });

  // --- permission ---

  t('permission: read, summaries, remove', () => {
    const pm = FIELDS.permission;
    assert.strictEqual(pm.read(SKILL), 'acceptEdits');
    assert.deepStrictEqual(pm.summary('acceptEdits', ctx), { text: 'acceptEdits', tone: 'set' });
    assert.strictEqual(pm.read('---\nrun: claude\n---\n'), null);
    assert.deepStrictEqual(pm.summary(null, ctx), { text: 'Default', tone: 'dim' });
    const bypass = SKILL.replace('permission-mode: acceptEdits', 'permission-mode: bypassPermissions');
    assert.strictEqual(pm.read(bypass), 'bypassPermissions');
    assert.deepStrictEqual(pm.summary('bypassPermissions', ctx), { text: 'bypassPermissions', tone: 'err' });
    assert.strictEqual(pm.write(SKILL, null), SKILL.split('\n').filter(l => !l.startsWith('permission-mode:')).join('\n'));
  });

  // --- limits ---

  t('limits: read and kind-aware summaries', () => {
    const lm = FIELDS.limits;
    assert.deepStrictEqual(lm.read(SKILL), { maxTurns: '60', timeout: '30m' });
    assert.deepStrictEqual(lm.summary({ maxTurns: '60', timeout: '30m' }, ctx), { text: '60 turns · 30m timeout', tone: 'set' });
    const none = lm.read('---\nrun: claude\n---\n');
    assert.deepStrictEqual(none, { maxTurns: null, timeout: null });
    assert.deepStrictEqual(lm.summary({ maxTurns: null, timeout: null }, ctx), { text: 'No turn limit · 1h timeout (default)', tone: 'dim' });
    assert.deepStrictEqual(lm.summary({ maxTurns: null, timeout: null }, { pinCount: 0, kind: 'shell' }), { text: '1h timeout (default)', tone: 'dim' });
    assert.deepStrictEqual(lm.summary({ maxTurns: '60', timeout: '2h' }, { pinCount: 0, kind: 'shell' }), { text: '2h timeout', tone: 'set' });
  });

  t('limits: blank removes, a value writes in place', () => {
    const lm = FIELDS.limits;
    const at = lineOf(SKILL, 'timeout:') - 1;
    const out = lm.write(SKILL, { maxTurns: '60', timeout: '2h' });
    assert.strictEqual(out.split('\n')[at], SKILL.split('\n')[at].replace('30m', '2h'));
    onlyLineChanged(SKILL, out, at);
    assert.strictEqual(lm.write(SKILL, { maxTurns: '', timeout: '30m' }), SKILL.split('\n').filter(l => !l.startsWith('max-turns:')).join('\n'));
    assert.strictEqual(lm.write(SHELL, { maxTurns: null, timeout: '2h' }), SHELL.replace('enabled: true\n', 'enabled: true\ntimeout: 2h\n'));
  });

  t('limits: the timeout unit is the file\'s, the pick before any timeout, and none for an unparsed one', () => {
    assert.deepStrictEqual(timeoutUnitView('30m', null), { amount: '30', shown: 'm', commit: 'm' });
    assert.deepStrictEqual(timeoutUnitView('30m', 'h'), { amount: '30', shown: 'm', commit: 'm' });
    assert.deepStrictEqual(timeoutUnitView(null, null), { amount: '', shown: 'm', commit: 'm' });
    assert.deepStrictEqual(timeoutUnitView(null, 's'), { amount: '', shown: 's', commit: 's' });
    assert.deepStrictEqual(timeoutUnitView('90', null), { amount: '90', shown: null, commit: 'm' });
    assert.deepStrictEqual(timeoutUnitView('90', 'h'), { amount: '90', shown: 'h', commit: 'h' });
    assert.deepStrictEqual(timeoutUnitView('1.5h', null), { amount: '1.5h', shown: null, commit: 'm' });
  });

  t('limits: a unit click rewrites a parsed timeout, repairs a bare whole number, and writes nothing otherwise', () => {
    assert.strictEqual(timeoutWithUnit('30m', 'h'), '30h');
    assert.strictEqual(timeoutWithUnit('90', 's'), '90s');
    assert.strictEqual(timeoutWithUnit(' 90 ', 's'), '90s');
    assert.strictEqual(timeoutWithUnit('1.5h', 'm'), null);
    assert.strictEqual(timeoutWithUnit('0', 'm'), null);
    assert.strictEqual(timeoutWithUnit(null, 'm'), null);
  });

  // --- tools ---

  t('tools: read, summaries, writes, block list unreadable', () => {
    const tl = FIELDS.tools;
    assert.deepStrictEqual(tl.read(SKILL), ['Bash', 'Read']);
    assert.deepStrictEqual(tl.summary(['Bash', 'Read'], ctx), { text: 'Bash, Read', tone: 'set' });
    assert.deepStrictEqual(tl.read('---\nrun: claude\n---\n'), []);
    assert.deepStrictEqual(tl.summary([], ctx), { text: 'Any tool', tone: 'dim' });
    assert.strictEqual(tl.write(SKILL, []), SKILL.split('\n').filter(l => !l.startsWith('allowed-tools:')).join('\n'));
    assert.strictEqual(tl.read('---\nrun: claude\nallowed-tools:\n  - Bash\n---\nhi\n'), UNREADABLE);
    assert.strictEqual(tl.write(SKILL, ['Bash', 'Read']), SKILL);
    const at = lineOf(SKILL, 'allowed-tools:') - 1;
    onlyLineChanged(SKILL, tl.write(SKILL, ['Bash']), at);
  });

  // --- visibility and routing ---

  t('visibleFields: table order per kind', () => {
    assert.deepStrictEqual(visibleFields('shell'), ['schedule', 'machines', 'repos', 'script', 'limits']);
    assert.deepStrictEqual(visibleFields('claude'), ['schedule', 'machines', 'repos', 'prompt', 'model', 'permission', 'limits', 'tools']);
    assert.deepStrictEqual(visibleFields(null), ['schedule', 'machines', 'repos', 'limits']);
  });

  t('routeErrors: owned lines go to their row, hidden rows and unowned lines to rest', () => {
    const e = (line: number, message: string) => ({ line, message });
    const model = e(lineOf(SKILL, 'model:'), 'model must be one token');
    const prompt = e(0, 'claude job needs a prompt');
    const cron0 = e(0, 'cron is required');
    const comment = e(lineOf(SKILL, '# cwd:'), 'x');
    const cron = e(2, 'cron: bad');
    const machines = e(3, 'machines needs mac, wsl or both');
    const r = routeErrors(SKILL, [model, prompt, cron0, comment, cron, machines], 'claude');
    assert.deepStrictEqual(r.byField, { model: [model], prompt: [prompt], schedule: [cron0, cron], machines: [machines] });
    assert.deepStrictEqual(r.rest, [comment]);

    const bash = e(5, 'shell job needs a ```bash block');
    const shellModel = e(lineOf(SKILL, 'model:'), 'model must be one token');
    const rs = routeErrors(SKILL, [bash, shellModel], 'shell');
    assert.deepStrictEqual(rs.byField, { script: [bash] });
    assert.deepStrictEqual(rs.rest, [shellModel]);

    assert.deepStrictEqual(routeErrors(SKILL, [prompt], 'shell'), { byField: {}, rest: [prompt] });
  });

  // --- schedule presets ---

  const withCron = (value: string): string => setKey(SKILL, 'cron', value);
  const readCron = (value: string) => FIELDS.schedule.read(withCron(value));
  const daily = (hour: number, minute: number): Schedule => ({ preset: 'daily', hour, minute });

  t('schedule read: each preset from its raw cron text, a quoted value alike', () => {
    assert.deepStrictEqual(readCron('manual'), { preset: 'manual' });
    assert.deepStrictEqual(readCron('25 * * * *'), { preset: 'hourly', minute: 25, every: 1 });
    assert.deepStrictEqual(readCron('25 */6 * * *'), { preset: 'hourly', minute: 25, every: 6 });
    assert.deepStrictEqual(readCron('25 9 * * *'), daily(9, 25));
    assert.deepStrictEqual(readCron('"25 9 * * *"'), daily(9, 25));
    assert.deepStrictEqual(readCron('25 9 * * 1-5'), { preset: 'weekdays', hour: 9, minute: 25 });
    assert.deepStrictEqual(readCron('25 9 * * 1,4'), { preset: 'weekly', days: [1, 4], hour: 9, minute: 25 });
    assert.deepStrictEqual(readCron('25 9 * * 0,7'), { preset: 'weekly', days: [0], hour: 9, minute: 25 });
    assert.deepStrictEqual(FIELDS.schedule.read(SKILL), daily(22, 0));
  });

  t('schedule read: near-misses and mid-typing text are Custom with their text, a missing line is Custom empty', () => {
    for (const text of ['25 9 * * 1-3', '25 */5 * * *', '25 9 1 * *', '*/15 * * * *', '25 9 * 1 *', '0-5 9 * * *', '*/1', '25 9 * *']) {
      assert.deepStrictEqual(readCron(text), { preset: 'custom', text }, text);
    }
    assert.deepStrictEqual(FIELDS.schedule.read(setKey(SKILL, 'cron', null)), { preset: 'custom', text: '' });
  });

  t('schedule write: presets are quoted and keep the line comment, Manual is bare, Weekly with no day writes nothing', () => {
    const out = FIELDS.schedule.write(SKILL, daily(9, 25));
    assert.ok(out.split('\n')[1].startsWith('cron: "25 9 * * *"'), out.split('\n')[1]);
    assert.ok(out.split('\n')[1].endsWith('# five fields, local time of the machine that runs it'));
    onlyLineChanged(SKILL, out, 1);
    const manual = FIELDS.schedule.write(SKILL, { preset: 'manual' });
    assert.ok(manual.split('\n')[1].startsWith('cron: manual '), manual.split('\n')[1]);
    assert.ok(manual.split('\n')[1].endsWith('# five fields, local time of the machine that runs it'));
    assert.strictEqual(FIELDS.schedule.write(SKILL, { preset: 'weekly', days: [], hour: 9, minute: 25 }), SKILL);
    assert.strictEqual(fmValue(FIELDS.schedule.write(SKILL, { preset: 'custom', text: '*/15 9-17 * * 1-5' }), 'cron')!.value, '*/15 9-17 * * 1-5');
    assert.ok(FIELDS.schedule.write(SKILL, { preset: 'custom', text: '*/15 9-17 * * 1-5' }).includes('cron: "*/15 9-17 * * 1-5"'));
    assert.strictEqual(FIELDS.schedule.write(SKILL, FIELDS.schedule.read(SKILL) as Schedule), SKILL);
    assert.strictEqual(FIELDS.schedule.write(withCron('>'), daily(9, 0)), withCron('>'));
  });

  t('schedule write: an absent line goes before the closing fence, CRLF survives', () => {
    const bare = '---\nrun: claude\n---\nhi\n';
    assert.strictEqual(FIELDS.schedule.write(bare, daily(9, 0)), '---\nrun: claude\ncron: "0 9 * * *"\n---\nhi\n');
    const out = FIELDS.schedule.write(crlf(SKILL), daily(9, 25));
    assert.strictEqual(out.split('\n').length, SKILL.split('\n').length);
    assert.ok(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')));
  });

  t('schedule write: a blank Custom removes the cron line, never writes cron: ""', () => {
    const at = lineOf(SKILL, 'cron:') - 1;
    const without = SKILL.split('\n').filter((_, i) => i !== at).join('\n');
    for (const text of ['', '   ']) {
      const out = FIELDS.schedule.write(SKILL, { preset: 'custom', text });
      assert.strictEqual(fmValue(out, 'cron'), null, JSON.stringify(text));
      assert.strictEqual(out, without, JSON.stringify(text));
    }
    const bare = setKey(SKILL, 'cron', null);
    assert.strictEqual(FIELDS.schedule.write(bare, { preset: 'custom', text: '' }), bare);
    const out = FIELDS.schedule.write(crlf(SKILL), { preset: 'custom', text: '' });
    assert.strictEqual(out, crlf(without));
    assert.strictEqual(FIELDS.schedule.write(withCron('>'), { preset: 'custom', text: '' }), withCron('>'));
  });

  t('schedule: read(write(t, s)) round-trips one value of every preset', () => {
    const values: Schedule[] = [
      { preset: 'manual' }, { preset: 'hourly', minute: 25, every: 1 }, { preset: 'hourly', minute: 0, every: 12 }, daily(9, 25),
      { preset: 'weekdays', hour: 7, minute: 5 }, { preset: 'weekly', days: [0, 3, 6], hour: 23, minute: 59 },
      { preset: 'custom', text: '*/15 9-17 * * 1-5' }, { preset: 'custom', text: '25 9 1 * *' },
    ];
    for (const v of values) assert.deepStrictEqual(FIELDS.schedule.read(FIELDS.schedule.write(SKILL, v)), v, JSON.stringify(v));
    assert.strictEqual(cronFor({ preset: 'weekly', days: [], hour: 9, minute: 0 }), null);
    assert.strictEqual(cronFor({ preset: 'manual' }), 'manual');
    assert.strictEqual(cronFor({ preset: 'hourly', minute: 25, every: 2 }), '25 */2 * * *');
  });

  t('schedule summary: every preset, Mon-first weekdays, and the Custom states', () => {
    const s = (v: Schedule) => FIELDS.schedule.summary(v, ctx);
    assert.strictEqual(s({ preset: 'manual' }).text, 'Manual · Run now only');
    assert.strictEqual(s({ preset: 'hourly', minute: 25, every: 1 }).text, 'Every hour at :25');
    assert.strictEqual(s({ preset: 'hourly', minute: 25, every: 2 }).text, 'Every 2h at :25');
    assert.strictEqual(s(daily(9, 25)).text, 'Daily at 09:25');
    assert.strictEqual(s({ preset: 'weekdays', hour: 9, minute: 25 }).text, 'Weekdays at 09:25');
    assert.strictEqual(s({ preset: 'weekly', days: [1, 4], hour: 9, minute: 25 }).text, 'Mon, Thu at 09:25');
    assert.strictEqual(s({ preset: 'weekly', days: [0, 6], hour: 9, minute: 25 }).text, 'Sat, Sun at 09:25');
    assert.strictEqual(s({ preset: 'custom', text: '*/15 9-17 * * 1-5' }).text, 'Every 15 minutes, 09:00–17:45, Mon–Fri');
    assert.deepStrictEqual(s({ preset: 'custom', text: '25 9 *' }), { text: 'Cron needs fixing', tone: 'err' });
    assert.deepStrictEqual(s({ preset: 'custom', text: '' }), { text: 'No schedule', tone: 'err' });
  });

  t('switchPreset: carries time where both sides have one, derives through read, defaults to 09:00', () => {
    assert.deepStrictEqual(switchPreset(daily(9, 25), 'weekdays'), { preset: 'weekdays', hour: 9, minute: 25 });
    assert.deepStrictEqual(switchPreset(daily(9, 25), 'hourly'), { preset: 'hourly', minute: 25, every: 1 });
    assert.deepStrictEqual(switchPreset({ preset: 'hourly', minute: 25, every: 1 }, 'daily'), daily(9, 25));
    assert.deepStrictEqual(switchPreset(daily(9, 25), 'weekly'), { preset: 'weekly', days: [], hour: 9, minute: 25 });
    assert.deepStrictEqual(switchPreset({ preset: 'weekdays', hour: 9, minute: 25 }, 'custom'), { preset: 'custom', text: '25 9 * * 1-5' });
    assert.deepStrictEqual(switchPreset({ preset: 'custom', text: '0 14 * * *' }, 'daily'), daily(14, 0));
    assert.deepStrictEqual(switchPreset({ preset: 'custom', text: '*/15 * * * *' }, 'daily'), daily(9, 0));
    assert.deepStrictEqual(switchPreset(daily(9, 25), 'manual'), { preset: 'manual' });
    assert.deepStrictEqual(switchPreset({ preset: 'custom', text: '*/15 * * * *' }, 'manual'), { preset: 'manual' });
    assert.deepStrictEqual(switchPreset({ preset: 'manual' }, 'daily'), daily(9, 0));
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
