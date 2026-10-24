/**
 * The drawer form's field registry (`client/src/lib/routineForm.ts`): each field's read / write / summary over a job file's text, and the router that
 * hands validator errors to rows. The fixtures are the drawer's own templates, comments and alignment padding included, so "touches only its own lines"
 * is checked against the files people actually start from.
 */
import assert from 'node:assert';

import {
  FIELDS, UNREADABLE, fmValue, formKind, frontmatterReadable, routeErrors, setKey, visibleFields
} from '../client/src/lib/routineForm.js';
import { jobTemplate, setRepos } from '../client/src/lib/routines.js';

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

  // --- repos ---

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
    assert.deepStrictEqual(r.byField, { model: [model], prompt: [prompt], schedule: [cron], machines: [machines] });
    assert.deepStrictEqual(r.rest, [cron0, comment]);

    const bash = e(5, 'shell job needs a ```bash block');
    const shellModel = e(lineOf(SKILL, 'model:'), 'model must be one token');
    const rs = routeErrors(SKILL, [bash, shellModel], 'shell');
    assert.deepStrictEqual(rs.byField, { script: [bash] });
    assert.deepStrictEqual(rs.rest, [shellModel]);

    assert.deepStrictEqual(routeErrors(SKILL, [prompt], 'shell'), { byField: {}, rest: [prompt] });
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
