/**
 * server/lib/routine-import.ts — the one-time copy of the old shared job folder into this machine's own, every job disabled. Every case runs through the
 * host seam with a tmpdir as `$HOME`, so neither the real `~/.claude` nor `~/claude-global` is read or written.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from '../../server/lib/config.js';
import { importSharedJobs, rewriteImported } from '../../server/lib/routine-import.js';
import { parseJob } from '../../shared/routine-file.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

interface Sandbox { home: string; state: string; jobs: string; marker: string; config: Config; host: { homedir: () => string; env: Record<string, string> } }

function sandbox(over: Partial<Config> = {}): Sandbox {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routine-import-')));
  const state = path.join(home, '.claude', 'routines');
  const config = { routinesDir: '', routinesStateRoot: state, routineMachine: 'mac', ...over } as Config;
  return { home, state, jobs: path.join(state, 'jobs'), marker: path.join(state, 'jobs-imported.json'), config, host: { homedir: () => home, env: { HOME: home } } };
}

function plant(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), body);
}

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[p + '/'] = ''; walk(p); } else out[p] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const JOB = (extra: string): string => `---\nrun: claude\ncron: 0 9 * * *\n${extra}---\nbody\n`;
const ENABLED_BOTH = JOB('machines: [mac, wsl]\nenabled: true\n');
const parseMac = (name: string, text: string) => parseJob(name, text, 'mac');
const marker = (s: Sandbox): { at: string; from: string | null; count: number } => JSON.parse(fs.readFileSync(s.marker, 'utf8')) as { at: string; from: string | null; count: number };

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('rewriteImported: drops machines, disables, adds cwd, touches nothing else', () => {
    const src = '---\nrun: claude\nmachines: [mac, wsl]          # comment\ncron: 0 9 * * *\nenabled: true   # on\n---\nbody\n';
    assert.strictEqual(rewriteImported(src, '~/claude-global'), '---\nrun: claude\ncwd: ~/claude-global\ncron: 0 9 * * *\nenabled: false   # on\n---\nbody\n');
  });
  t('rewriteImported: a block-list machines key goes with its items', () => {
    const src = '---\nrun: claude\nmachines:\n  - mac\n  - wsl\ncron: 0 9 * * *\n---\n';
    assert.strictEqual(rewriteImported(src, '~/g'), '---\nrun: claude\ncwd: ~/g\nenabled: false\ncron: 0 9 * * *\n---\n');
  });
  t('rewriteImported: foreach or an existing cwd means no cwd is added', () => {
    assert.ok(!/cwd:/.test(rewriteImported('---\nrun: claude\nforeach: pinned\nenabled: true\n---\n', '~/g')));
    assert.ok(rewriteImported('---\nrun: claude\ncwd: ~/x\nenabled: true\n---\n', '~/g').includes('cwd: ~/x\n'));
    assert.ok(!rewriteImported('---\nrun: claude\ncwd: ~/x\nenabled: true\n---\n', '~/g').includes('~/g'));
  });
  t('rewriteImported: no enabled line gets enabled: false after run:, cwd directly after run:', () => {
    assert.strictEqual(rewriteImported('---\nrun: claude\ncron: 1 * * * *\n---\n', '~/g'), '---\nrun: claude\ncwd: ~/g\nenabled: false\ncron: 1 * * * *\n---\n');
  });
  t('rewriteImported: CRLF stays CRLF on every line', () => {
    const out = rewriteImported('---\r\nrun: claude\r\nmachines: [mac]\r\nenabled: true\r\n---\r\nbody\r\n', '~/g');
    assert.strictEqual(out, '---\r\nrun: claude\r\ncwd: ~/g\r\nenabled: false\r\n---\r\nbody\r\n');
    assert.ok(!/[^\r]\n/.test(out.replace(/^\n/, '')));
  });
  t('rewriteImported: an unparseable file takes the same edits', () => {
    const out = rewriteImported('---\nrun: bogus\nmachines: [mac]\nenabled: true\n---\n', '~/g');
    assert.strictEqual(out, '---\nrun: bogus\ncwd: ~/g\nenabled: false\n---\n');
  });
  t('rewriteImported: text without frontmatter is returned unchanged', () => {
    assert.strictEqual(rewriteImported('just text\nmachines: [mac]\n', '~/g'), 'just text\nmachines: [mac]\n');
  });

  t('imports every .md disabled', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'routines'), {
      'a.md': ENABLED_BOTH, 'b.md': JOB('machines: [wsl]\nenabled: false\n'), 'c.md': '---\nrun: bogus\ncron: 0 9 * * *\nmachines: [mac]\n---\n'
    });
    const r = importSharedJobs(s.config, s.host);
    assert.deepStrictEqual(r, { state: 'imported', from: path.join(s.home, 'claude-global', 'routines'), count: 3 });
    for (const n of ['a', 'b']) {
      const parsed = parseMac(n, fs.readFileSync(path.join(s.jobs, `${n}.md`), 'utf8'));
      assert.deepStrictEqual(parsed.errors, [], n);
      assert.strictEqual(parsed.job?.enabled, false, n);
    }
    const c = fs.readFileSync(path.join(s.jobs, 'c.md'), 'utf8');
    assert.ok(!c.includes('machines:') && c.includes('enabled: false'), c);
    const errs = parseMac('c', c).errors;
    assert.strictEqual(errs.length, 1, JSON.stringify(errs));
    assert.ok(/run/.test(errs[0].message), errs[0].message);
    const m = marker(s);
    assert.strictEqual(m.from, path.join(s.home, 'claude-global', 'routines'));
    assert.strictEqual(m.count, 3);
    assert.ok(!Number.isNaN(Date.parse(m.at)));
  });
  t('writes cwd as ~/claude-global for an old folder under home', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'routines'), { 'a.md': ENABLED_BOTH });
    importSharedJobs(s.config, s.host);
    assert.ok(fs.readFileSync(path.join(s.jobs, 'a.md'), 'utf8').includes('cwd: ~/claude-global\n'));
  });
  t('falls back to the legacy schedules folder', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'schedules'), { 'a.md': ENABLED_BOTH });
    const r = importSharedJobs(s.config, s.host);
    assert.deepStrictEqual(r, { state: 'imported', from: path.join(s.home, 'claude-global', 'schedules'), count: 1 });
  });
  t('prefers routines over schedules when both exist', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'routines'), { 'a.md': ENABLED_BOTH });
    plant(path.join(s.home, 'claude-global', 'schedules'), { 'z.md': ENABLED_BOTH });
    importSharedJobs(s.config, s.host);
    assert.deepStrictEqual(fs.readdirSync(s.jobs), ['a.md']);
  });
  t('ignores non-.md files, subfolders and dotfiles', () => {
    const s = sandbox();
    const old = path.join(s.home, 'claude-global', 'routines');
    plant(old, { 'a.md': ENABLED_BOTH, 'notes.txt': 'x', '.x.123.tmp': 'x', '.hidden.md': ENABLED_BOTH });
    fs.mkdirSync(path.join(old, 'sub.md'));
    fs.mkdirSync(path.join(old, 'sub'));
    const r = importSharedJobs(s.config, s.host);
    assert.strictEqual(r.state === 'imported' && r.count, 1);
    assert.deepStrictEqual(fs.readdirSync(s.jobs), ['a.md']);
  });
  t('leaves the old folder byte-identical', () => {
    const s = sandbox();
    const old = path.join(s.home, 'claude-global', 'routines');
    plant(old, { 'a.md': ENABLED_BOTH, 'notes.txt': 'x' });
    fs.mkdirSync(path.join(old, 'sub'));
    const before = listing(old);
    importSharedJobs(s.config, s.host);
    assert.deepStrictEqual(listing(old), before);
  });
  t('runs once, even after the jobs are deleted', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'routines'), { 'a.md': ENABLED_BOTH, 'b.md': ENABLED_BOTH });
    assert.strictEqual(importSharedJobs(s.config, s.host).state, 'imported');
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'done' });
    fs.rmSync(path.join(s.jobs, 'a.md'));
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'done' });
    assert.ok(!fs.existsSync(path.join(s.jobs, 'a.md')));
    fs.rmSync(s.jobs, { recursive: true });
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'done' });
    assert.ok(!fs.existsSync(s.jobs));
  });
  t('an explicit ROUTINES_DIR skips with no marker and no jobs folder', () => {
    const s = sandbox({ routinesDir: '~/my-jobs' });
    plant(path.join(s.home, 'claude-global', 'routines'), { 'a.md': ENABLED_BOTH });
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'explicit-dir' });
    assert.ok(!fs.existsSync(s.marker) && !fs.existsSync(s.jobs));
  });
  t('an explicit ROUTINES_DIR naming an old shared folder skips as explicit-old, either name, ~ or absolute, trailing slash too', () => {
    for (const dir of ['~/claude-global/routines', '~/claude-global/schedules/', 'HOME/claude-global/schedules']) {
      const s = sandbox();
      const cfg = { ...s.config, routinesDir: dir.replace('HOME', s.home) };
      plant(path.join(s.home, 'claude-global', 'schedules'), { 'a.md': ENABLED_BOTH });
      assert.deepStrictEqual(importSharedJobs(cfg, s.host), { state: 'skipped', why: 'explicit-old' }, dir);
      assert.ok(!fs.existsSync(s.marker) && !fs.existsSync(s.jobs), dir);
    }
  });
  t('an explicit ROUTINES_DIR only next to an old folder name is not explicit-old', () => {
    const s = sandbox({ routinesDir: '~/claude-global/routines-x' });
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'explicit-dir' });
  });
  t('no old folder: empty jobs folder and a count-0 marker', () => {
    const s = sandbox();
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'no-old' });
    assert.deepStrictEqual(fs.readdirSync(s.jobs), []);
    assert.strictEqual(marker(s).count, 0);
    assert.strictEqual(marker(s).from, null);
  });
  t('jobs/ without a marker: kept as is, marker count 0, nothing copied', () => {
    const s = sandbox();
    plant(path.join(s.home, 'claude-global', 'routines'), { 'a.md': ENABLED_BOTH });
    plant(s.jobs, { 'z.md': 'mine' });
    assert.deepStrictEqual(importSharedJobs(s.config, s.host), { state: 'skipped', why: 'jobs-exist' });
    assert.deepStrictEqual(listing(s.jobs), { [path.join(s.jobs, 'z.md')]: 'mine' });
    assert.strictEqual(marker(s).count, 0);
  });
  t('a crash mid-import leaves no jobs/ and no marker; the next call cleans the temp folder and imports both', () => {
    const s = sandbox();
    const old = path.join(s.home, 'claude-global', 'routines');
    plant(old, { 'a.md': ENABLED_BOTH, 'b.md': ENABLED_BOTH });
    // The second file becomes unreadable, so the copy fails after the first file landed in the temp folder.
    fs.chmodSync(path.join(old, 'b.md'), 0o000);
    try {
      assert.throws(() => importSharedJobs(s.config, s.host));
      assert.ok(!fs.existsSync(s.jobs) && !fs.existsSync(s.marker));
      assert.ok(fs.existsSync(path.join(s.state, '.jobs-import.tmp')), 'the leftover temp folder is what the retry must clean');
    } finally {
      fs.chmodSync(path.join(old, 'b.md'), 0o644);
    }
    const r = importSharedJobs(s.config, s.host);
    assert.strictEqual(r.state === 'imported' && r.count, 2);
    assert.deepStrictEqual(fs.readdirSync(s.jobs).sort(), ['a.md', 'b.md']);
    assert.ok(!fs.existsSync(path.join(s.state, '.jobs-import.tmp')));
  });
  t('overlap: a jobs folder inside the old folder writes nothing; a sibling of it does not overlap', () => {
    const s = sandbox();
    const old = path.join(s.home, 'claude-global', 'routines');
    plant(old, { 'a.md': ENABLED_BOTH });
    const inside = { ...s.config, routinesStateRoot: old } as Config;
    assert.deepStrictEqual(importSharedJobs(inside, s.host), { state: 'skipped', why: 'overlap' });
    assert.deepStrictEqual(fs.readdirSync(old), ['a.md']);
    // `routines-x` shares a string prefix with `routines` but is not inside it.
    const sibling = { ...s.config, routinesStateRoot: path.join(s.home, 'claude-global', 'routines-x') } as Config;
    assert.strictEqual(importSharedJobs(sibling, s.host).state, 'imported');
  });

  console.log(`\nroutine-import: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
