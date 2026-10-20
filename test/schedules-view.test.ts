/**
 * The Schedules page's pure view logic (`client/src/lib/schedules.ts`): ledger row text, Runs day groups, stat formatting and the Repos helper's two
 * directions. Every date is built from local parts and `now` is passed in, so the cases hold in any TZ.
 */
import assert from 'node:assert';

import { foreachLine, formatStat, groupRunsByDay, readForeach, rowText, runsQueryString } from '../client/src/lib/schedules.js';
import type { ScheduleJob, ScheduleJobRow, ScheduleRun, ScheduleStep } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Sunday 2026-04-19, noon, local. */
const NOW = new Date(2026, 3, 19, 12, 0);
const at = (month: number, day: number, hour = 0, minute = 0): string => new Date(2026, month - 1, day, hour, minute).toISOString();

function step(over: Partial<ScheduleStep> = {}): ScheduleStep {
  return {
    index: 0, repo: null, cwd: null, startedAt: at(4, 19, 6), endedAt: null, outcome: 'ok', ms: 1000, exit: 0, why: null, tail: null,
    costUsd: null, tokensIn: null, tokensOut: null, turns: null, model: null, sessionId: null, ...over
  };
}

function mkRun(over: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'r1', job: 'j', machine: 'mac', trigger: 'schedule', startedAt: at(4, 19, 6), endedAt: at(4, 19, 6, 1), ms: 38_000, late: false, state: 'ok',
    ok: 1, failed: 0, skipped: 0, total: 1, stopped: false, error: null, why: null, steps: [], ...over
  };
}

function mkJob(over: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    name: 'j', cron: '0 7 * * 1-5', machines: ['mac', 'wsl'], run: 'shell', foreach: 'pinned', cwd: null, enabled: true, model: null, effort: null, permissionMode: null,
    allowedTools: null, maxTurns: null, timeoutMs: 600_000, body: 'x', script: 'x', ...over
  };
}

function mkRow(over: Partial<ScheduleJobRow> = {}): ScheduleJobRow {
  return {
    name: 'j', text: '', job: mkJob(), errors: [], mtimeMs: 0, onThisMachine: true, installed: true, nextAt: at(4, 20, 7), last: null, running: null, ...over
  };
}

export function run(): number {
  console.log('\n=== schedules.ts (client view logic) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('rowText: a shell fan-out that finished this morning reads the mock\'s pull-pins row', () => {
    const r = mkRow({ last: mkRun({ startedAt: at(4, 19, 6), ms: 38_000, ok: 14, total: 14, steps: [step()] }) });
    assert.deepStrictEqual(rowText(r, NOW), { lastLine: '6:00 today · 38s', nextLine: 'tomorrow 07:00', pill: { text: '14 ok', tone: 'green' } });
  });

  t('rowText: a scheduled fan-out in flight reads running · n of N, with its start and "so far"', () => {
    const steps = Array.from({ length: 12 }, (_, i) => step({ index: i, repo: `r${i}`, outcome: i < 4 ? 'ok' : null }));
    const r = mkRow({ running: mkRun({ state: 'running', startedAt: at(4, 19, 11, 57), endedAt: null, ms: null, total: 12, steps }), nextAt: at(4, 19, 22) });
    assert.deepStrictEqual(rowText(r, NOW), { lastLine: '11:57 · 3m so far', nextLine: 'today 22:00', pill: { text: 'running · 4 of 12', tone: 'run' } });
  });

  t('rowText: a by-hand run of one repo reads running · <repo>, and a one-step run just running', () => {
    const hand = mkRun({ state: 'running', trigger: 'manual', startedAt: new Date(NOW.getTime() - 20_000).toISOString(), endedAt: null, total: 1, steps: [step({ repo: 'lookout', outcome: null })] });
    assert.deepStrictEqual(rowText(mkRow({ running: hand }), NOW), { lastLine: 'by hand · 20s', nextLine: 'tomorrow 07:00', pill: { text: 'running · lookout', tone: 'run' } });
    const plain = mkRun({ state: 'running', total: 1, steps: [step({ repo: null, outcome: null })] });
    assert.strictEqual(rowText(mkRow({ running: plain }), NOW).pill.text, 'running');
  });

  t('rowText: a job that does not name this machine reads "wsl only" with no last or next line', () => {
    const r = mkRow({ job: mkJob({ machines: ['wsl'] }), onThisMachine: false, nextAt: null, last: mkRun() });
    assert.deepStrictEqual(rowText(r, NOW), { lastLine: '', nextLine: '—', pill: { text: 'wsl only', tone: 'dim' } });
    const both = mkRow({ job: mkJob({ machines: ['mac', 'wsl'] }), onThisMachine: false });
    assert.strictEqual(rowText(both, NOW).pill.text, 'mac + wsl only', 'several machines are all named');
  });

  t('rowText: a paused job keeps its last run and reads "paused" for next; a claude run adds its cost', () => {
    const r = mkRow({
      job: mkJob({ enabled: false, run: 'claude' }), nextAt: null,
      last: mkRun({ startedAt: at(4, 7, 9), ms: 360_000, steps: [step({ costUsd: 0.5 }), step({ costUsd: 0.02 })] })
    });
    assert.deepStrictEqual(rowText(r, NOW), { lastLine: '12d ago · 6m · $0.52', nextLine: 'paused', pill: { text: 'ok', tone: 'green' } });
  });

  t('rowText: when the last run started: today, yesterday, under a fortnight ago in days, then the date', () => {
    const when = (start: string) => rowText(mkRow({ last: mkRun({ startedAt: start, ms: 11 * 60_000 }) }), NOW).lastLine;
    assert.strictEqual(when(at(4, 19, 0, 5)), '0:05 today · 11m');
    assert.strictEqual(when(at(4, 18, 22)), 'yesterday 22:00 · 11m');
    assert.strictEqual(when(at(4, 6, 9)), '13d ago · 11m');
    assert.strictEqual(when(at(4, 5, 9)), 'Apr 5 · 11m', 'a fortnight is the line');
    assert.strictEqual(when(at(4, 1, 9)), 'Apr 1 · 11m');
  });

  t('rowText: the next fire: today, tomorrow, then the date; always a padded clock', () => {
    const next = (iso: string) => rowText(mkRow({ nextAt: iso }), NOW).nextLine;
    assert.strictEqual(next(at(4, 19, 22)), 'today 22:00');
    assert.strictEqual(next(at(4, 20, 7)), 'tomorrow 07:00');
    assert.strictEqual(next(at(5, 1, 9, 30)), 'May 1 09:30');
    assert.strictEqual(rowText(mkRow({ nextAt: null }), NOW).nextLine, '—', 'enabled but nothing scheduled');
  });

  t('rowText: failed runs: some failed is amber, all failed and pre-step errors are red, a one-step failure is plain "failed"', () => {
    const pill = (over: Partial<ScheduleRun>) => rowText(mkRow({ last: mkRun(over) }), NOW).pill;
    assert.deepStrictEqual(pill({ state: 'failed', ok: 10, failed: 2, total: 12 }), { text: '2 of 12 failed', tone: 'amber' });
    assert.deepStrictEqual(pill({ state: 'failed', ok: 0, failed: 12, total: 12 }), { text: '12 of 12 failed', tone: 'red' });
    assert.deepStrictEqual(pill({ state: 'failed', ok: 0, failed: 1, total: 1 }), { text: 'failed', tone: 'red' });
    assert.deepStrictEqual(pill({ state: 'failed', ok: 0, failed: 0, total: 0, error: 'no pins' }), { text: 'failed', tone: 'red' });
  });

  t('rowText: lost and refused read in mustard, a job that never ran says so, an unparsable file reads invalid', () => {
    assert.deepStrictEqual(rowText(mkRow({ last: mkRun({ state: 'lost', ms: null, endedAt: null }) }), NOW).pill, { text: 'lost', tone: 'mustard' });
    assert.deepStrictEqual(rowText(mkRow({ last: mkRun({ state: 'refused', ms: null, total: 0 }) }), NOW).pill, { text: 'not run', tone: 'mustard' });
    assert.deepStrictEqual(rowText(mkRow({ last: null }), NOW), { lastLine: '', nextLine: 'tomorrow 07:00', pill: { text: 'never run', tone: 'dim' } });
    assert.deepStrictEqual(rowText(mkRow({ job: null, errors: [{ line: 1, message: 'bad' }], onThisMachine: false, nextAt: null }), NOW), { lastLine: '', nextLine: '—', pill: { text: 'invalid', tone: 'red' } });
  });

  t('rowText: an unreadable start time drops that part of the line instead of printing NaN', () => {
    const r = mkRow({ last: mkRun({ startedAt: 'garbage', ms: 38_000 }) });
    assert.strictEqual(rowText(r, NOW).lastLine, '38s');
  });

  t('groupRunsByDay: Apr 18 and Apr 15 against Sunday Apr 19 label "Yesterday · Sat 18" then "Wed 15", runs kept in arrival order', () => {
    const a = mkRun({ id: 'a', startedAt: at(4, 18, 22) });
    const b = mkRun({ id: 'b', startedAt: at(4, 18, 3, 12) });
    const c = mkRun({ id: 'c', startedAt: at(4, 15, 7) });
    const groups = groupRunsByDay([a, b, c], NOW);
    assert.deepStrictEqual(groups.map(g => g.label), ['Yesterday · Sat 18', 'Wed 15']);
    assert.deepStrictEqual(groups.map(g => g.runs.map(r => r.id)), [['a', 'b'], ['c']]);
  });

  t('groupRunsByDay: today gets its own label, an empty list gives no groups, a bad start time lands in a "—" group', () => {
    const groups = groupRunsByDay([mkRun({ id: 't', startedAt: at(4, 19, 9) }), mkRun({ id: 'x', startedAt: 'nope' }), mkRun({ id: 'o', startedAt: at(4, 11, 22) })], NOW);
    assert.deepStrictEqual(groups.map(g => g.label), ['Today · Sun 19', '—', 'Sat 11']);
    assert.deepStrictEqual(groupRunsByDay([], NOW), []);
  });

  t('groupRunsByDay: the same weekday a week back is not "Yesterday", and month ends count whole days', () => {
    const groups = groupRunsByDay([mkRun({ startedAt: at(4, 12, 9) })], NOW);
    assert.strictEqual(groups[0].label, 'Sun 12');
    const first = groupRunsByDay([mkRun({ startedAt: at(2, 28, 23) })], new Date(2026, 2, 1, 8, 0));
    assert.strictEqual(first[0].label, 'Yesterday · Sat 28');
  });

  t('formatStat: the mock\'s four shapes', () => {
    assert.strictEqual(formatStat(24.1, 'usd'), '$24.10');
    assert.strictEqual(formatStat(4_100_000, 'tokens'), '4.1M');
    assert.strictEqual(formatStat(18_720_000, 'ms'), '5h 12m');
    assert.strictEqual(formatStat(0.852, 'pct'), '85%');
  });

  t('formatStat: the edges of each shape', () => {
    assert.strictEqual(formatStat(0, 'usd'), '$0.00');
    assert.strictEqual(formatStat(0, 'tokens'), '0');
    assert.strictEqual(formatStat(850, 'tokens'), '850');
    assert.strictEqual(formatStat(1500, 'tokens'), '1.5k');
    assert.strictEqual(formatStat(310_000, 'tokens'), '310k');
    assert.strictEqual(formatStat(4_000_000, 'tokens'), '4M');
    assert.strictEqual(formatStat(500, 'ms'), '500ms');
    assert.strictEqual(formatStat(38_000, 'ms'), '38s');
    assert.strictEqual(formatStat(340_000, 'ms'), '5m 40s');
    assert.strictEqual(formatStat(360_000, 'ms'), '6m');
    assert.strictEqual(formatStat(3_599_600, 'ms'), '1h', 'a second short of the hour rounds up, never "60m"');
    assert.strictEqual(formatStat(18_000_000, 'ms'), '5h');
    assert.strictEqual(formatStat(1, 'pct'), '100%');
    assert.strictEqual(formatStat(NaN, 'usd'), '—');
    assert.strictEqual(formatStat(Infinity, 'ms'), '—');
  });

  t('foreachLine: pick lists the names, all is "pinned", cwd is empty (the caller writes cwd:)', () => {
    assert.strictEqual(foreachLine('pick', ['lookout', 'ixray']), 'foreach: [lookout, ixray]');
    assert.strictEqual(foreachLine('all', []), 'foreach: pinned');
    assert.strictEqual(foreachLine('cwd', []), '');
    assert.strictEqual(foreachLine('all', ['ignored']), 'foreach: pinned', 'picks only matter in Pick');
  });

  t('readForeach inverts foreachLine for every mode', () => {
    const file = (line: string) => `---\ncron: "0 9 * * *"\n${line}\nrun: claude\n---\nbody`;
    assert.deepStrictEqual(readForeach(file(foreachLine('pick', ['lookout', 'ixray']))), { mode: 'pick', picks: ['lookout', 'ixray'] });
    assert.deepStrictEqual(readForeach(file(foreachLine('all', []))), { mode: 'all', picks: [] });
    assert.deepStrictEqual(readForeach(file('cwd: ~/work/x')), { mode: 'cwd', picks: [] });
    assert.deepStrictEqual(readForeach(file(foreachLine('cwd', []))), { mode: 'cwd', picks: [] });
  });

  t('readForeach: quoted names, extra spaces, CRLF, an empty list and a pin named like a keyword', () => {
    assert.deepStrictEqual(readForeach('---\r\nforeach:   [ "a" ,\'b\',  c ]\r\n---\r\nx').picks, ['a', 'b', 'c']);
    assert.deepStrictEqual(readForeach('---\nforeach: []\n---\nx'), { mode: 'pick', picks: [] });
    assert.deepStrictEqual(readForeach('---\nforeach: [pinned]\n---\nx'), { mode: 'pick', picks: ['pinned'] });
    assert.deepStrictEqual(readForeach('---\nforeach: pinned   \n---\nx'), { mode: 'all', picks: [] });
  });

  t('readForeach reads the frontmatter only: a body that quotes the key, or a file with no frontmatter, is cwd', () => {
    assert.deepStrictEqual(readForeach('---\ncwd: ~/x\n---\nforeach: pinned\n'), { mode: 'cwd', picks: [] });
    assert.deepStrictEqual(readForeach('foreach: pinned\nno frontmatter'), { mode: 'cwd', picks: [] });
    assert.deepStrictEqual(readForeach(''), { mode: 'cwd', picks: [] });
    assert.deepStrictEqual(readForeach('---\nforeach: garbage\n---\nx'), { mode: 'cwd', picks: [] }, 'neither pinned nor a list: the validator reports it, the helper stays out');
  });

  t('runsQueryString: days always, filters only when set', () => {
    assert.strictEqual(runsQueryString({ days: 30, job: '', outcome: '', runner: '' }), '?days=30');
    assert.strictEqual(runsQueryString({ days: 7, job: 'git-sync-all', outcome: 'failed', runner: 'claude' }), '?days=7&job=git-sync-all&outcome=failed&runner=claude');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
