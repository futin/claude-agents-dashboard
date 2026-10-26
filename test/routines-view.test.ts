/**
 * The Routines page's pure view logic (`client/src/lib/routines.ts`): ledger row text, Runs day groups, stat formatting and the Repos helper's two
 * directions. Every date is built from local parts and `now` is passed in, so the cases hold in any TZ.
 */
import assert from 'node:assert';

import {
  chipClass, costDelta, createPollSeq, editsWithoutAsking, foreachLine, formatStat, groupRunsByDay, isFanOut, jobTemplate, launchdLabel, medianMs, nameProblem,
  readForeach, reconcileChip, reconcilePreview, rowText, runClock, dotTone, topFailure, jobPins, pinOutcome, stepErrLine, runKicker, runPill, runsQueryString, setRepos,
  pausedLook, splitNext, splitSteps, stepPill, successRate, topTokenShare, withLate, writeFailureText
} from '../client/src/lib/routines.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';
import { parseJob } from '../shared/routine-file.js';
import type { RoutineJob, RoutineJobRow, RoutineRun, RoutineStats, RoutineStep } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Sunday 2026-04-19, noon, local. */
const NOW = new Date(2026, 3, 19, 12, 0);
const at = (month: number, day: number, hour = 0, minute = 0): string => new Date(2026, month - 1, day, hour, minute).toISOString();

function step(over: Partial<RoutineStep> = {}): RoutineStep {
  return {
    index: 0, repo: null, cwd: null, startedAt: at(4, 19, 6), endedAt: null, outcome: 'ok', ms: 1000, exit: 0, why: null, tail: null,
    costUsd: null, tokensIn: null, tokensOut: null, turns: null, model: null, sessionId: null, ...over
  };
}

function mkRun(over: Partial<RoutineRun> = {}): RoutineRun {
  return {
    id: 'r1', job: 'j', machine: 'mac', trigger: 'schedule', startedAt: at(4, 19, 6), endedAt: at(4, 19, 6, 1), ms: 38_000, late: false, state: 'ok',
    ok: 1, failed: 0, skipped: 0, total: 1, stopped: false, error: null, why: null, steps: [], ...over
  };
}

function mkJob(over: Partial<RoutineJob> = {}): RoutineJob {
  return {
    name: 'j', cron: '0 7 * * 1-5', machines: ['mac', 'wsl'], run: 'shell', foreach: 'pinned', cwd: null, enabled: true, model: null, effort: null, permissionMode: null,
    allowedTools: null, maxTurns: null, timeoutMs: 600_000, body: 'x', script: 'x', ...over
  };
}

function mkRow(over: Partial<RoutineJobRow> = {}): RoutineJobRow {
  return {
    name: 'j', text: '', job: mkJob(), errors: [], mtimeMs: 0, onThisMachine: true, installed: true, nextAt: at(4, 20, 7), last: null, running: null, ...over
  };
}

export function run(): number {
  console.log('\n=== routines.ts (client view logic) ===\n');
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

  t('rowText: a manual job reads "manual" for next, paused or not; a scheduled paused one still reads "paused"', () => {
    for (const enabled of [false, true]) {
      const r = mkRow({ job: mkJob({ cron: 'manual', enabled }), nextAt: null });
      assert.deepStrictEqual(rowText(r, NOW), { lastLine: '', nextLine: 'manual', pill: { text: 'never run', tone: 'dim' } }, `enabled ${enabled}`);
    }
    assert.strictEqual(rowText(mkRow({ job: mkJob({ enabled: false }), nextAt: null }), NOW).nextLine, 'paused');
    const away = mkRow({ job: mkJob({ cron: 'manual', machines: ['wsl'] }), onThisMachine: false, nextAt: null });
    assert.deepStrictEqual(rowText(away, NOW), { lastLine: '', nextLine: '—', pill: { text: 'wsl only', tone: 'dim' } });
  });

  t('pausedLook: only an existing, disabled, non-manual job', () => {
    assert.strictEqual(pausedLook(null), false);
    assert.strictEqual(pausedLook(mkJob({ enabled: false })), true);
    assert.strictEqual(pausedLook(mkJob({ cron: 'manual', enabled: false })), false);
    assert.strictEqual(pausedLook(mkJob({ enabled: true })), false);
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
    const pill = (over: Partial<RoutineRun>) => rowText(mkRow({ last: mkRun(over) }), NOW).pill;
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

  t('createPollSeq: a tick is skipped while a fetch is out, and goes again once the newest has settled', () => {
    const q = createPollSeq();
    const a = q.next(false);
    assert.strictEqual(a, 1);
    assert.strictEqual(q.next(false), null, 'a timed tick does not pile on a slow fold');
    assert.strictEqual(q.settle(a as number), true);
    assert.strictEqual(q.next(false), 2);
  });

  t('createPollSeq: refresh supersedes a fetch in flight, and the older answer arriving late is not applied', () => {
    const q = createPollSeq();
    const slow = q.next(false) as number;
    const fast = q.next(true) as number;
    assert.strictEqual(fast, slow + 1, 'a forced poll goes even while one is out');
    assert.strictEqual(q.settle(fast), true, 'the newer answer lands first');
    assert.strictEqual(q.settle(slow), false, 'the older fold resolving after it is stale');
    assert.strictEqual(q.next(false), fast + 1, 'and the gate is open');
  });

  t('createPollSeq: a superseded answer arriving first does not open the gate or get applied', () => {
    const q = createPollSeq();
    const slow = q.next(false) as number;
    const fast = q.next(true) as number;
    assert.strictEqual(q.settle(slow), false);
    assert.strictEqual(q.next(false), null, 'the newest fetch is still out');
    assert.strictEqual(q.settle(fast), true);
  });

  t('formatStat: just under a million tokens promotes to M instead of reading 1000k', () => {
    assert.strictEqual(formatStat(999_500, 'tokens'), '1M');
    assert.strictEqual(formatStat(999_400, 'tokens'), '999k');
  });

  t('runsQueryString: days always, filters only when set', () => {
    assert.strictEqual(runsQueryString({ days: 30, job: '', outcome: '', runner: '' }), '?days=30');
    assert.strictEqual(runsQueryString({ days: 7, job: 'git-sync-all', outcome: 'failed', runner: 'claude' }), '?days=7&job=git-sync-all&outcome=failed&runner=claude');
  });

  t('readForeach: a trailing comment on the line is not the value (the spec example file reads as All pinned)', () => {
    assert.deepStrictEqual(readForeach('---\nforeach: pinned               # absent = run once\n---\n'), { mode: 'all', picks: [] });
    assert.deepStrictEqual(readForeach('---\nforeach: [a, b]  # two\n---\n'), { mode: 'pick', picks: ['a', 'b'] });
    assert.deepStrictEqual(readForeach(jobTemplate('skill')), { mode: 'all', picks: [] });
  });

  t('setRepos: pick rewrites foreach in place and keeps its comment; all writes pinned', () => {
    const src = '---\ncron: "0 7 * * *"\nrun: shell\nforeach: pinned   # keep me\nenabled: true\n---\nbody\n';
    assert.strictEqual(setRepos(src, 'pick', ['a', 'b']), '---\ncron: "0 7 * * *"\nrun: shell\nforeach: [a, b]   # keep me\nenabled: true\n---\nbody\n');
    assert.strictEqual(setRepos(setRepos(src, 'pick', ['a']), 'all', []), src);
  });

  t('setRepos: from a cwd file, all inserts foreach after run: and drops the cwd: line; a # cwd comment stays', () => {
    const src = '---\ncron: "0 7 * * *"\nrun: shell\n# cwd: ~/x\ncwd: ~/Documents/x\nenabled: true\n---\nbody\n';
    assert.strictEqual(setRepos(src, 'all', []), '---\ncron: "0 7 * * *"\nrun: shell\nforeach: pinned\n# cwd: ~/x\nenabled: true\n---\nbody\n');
  });

  t('setRepos: cwd drops foreach and leaves cwd: alone; a body line naming the key is untouched; no frontmatter is unchanged', () => {
    const src = '---\nrun: shell\nforeach: [a]\ncwd: ~/y\n---\nforeach: pinned\n';
    assert.strictEqual(setRepos(src, 'cwd', []), '---\nrun: shell\ncwd: ~/y\n---\nforeach: pinned\n');
    assert.strictEqual(setRepos('no frontmatter', 'all', []), 'no frontmatter');
    assert.strictEqual(setRepos('---\nrun: shell\n', 'all', []), '---\nrun: shell\n');
  });

  t('setRepos: CRLF files keep CRLF on the rewritten and inserted lines', () => {
    assert.strictEqual(setRepos('---\r\nrun: shell\r\n---\r\nx\r\n', 'pick', ['a']), '---\r\nrun: shell\r\nforeach: [a]\r\n---\r\nx\r\n');
    assert.strictEqual(setRepos('---\r\nrun: shell\r\nforeach: pinned\r\n---\r\n', 'cwd', []), '---\r\nrun: shell\r\n---\r\n');
  });

  t('jobTemplate: every kind parses with no errors, and each is the runner its kind says', () => {
    for (const kind of ['shell', 'prompt', 'skill'] as const) {
      const parsed = parseJob('a-job', jobTemplate(kind));
      assert.deepStrictEqual(parsed.errors, [], `${kind}: ${JSON.stringify(parsed.errors)}`);
      assert.strictEqual(parsed.job?.run, kind === 'shell' ? 'shell' : 'claude');
      assert.strictEqual(parsed.job?.foreach, 'pinned');
    }
    assert.strictEqual(parseJob('a-job', jobTemplate('skill')).job?.body, '/git-sync');
    assert.strictEqual(parseJob('a-job', jobTemplate('shell')).job?.script, 'git pull --ff-only --quiet');
  });

  t('nameProblem: empty, bad pattern, reserved, taken, then fine', () => {
    assert.strictEqual(nameProblem('', []), 'Name the job; it becomes the filename.');
    assert.strictEqual(nameProblem('Pull_Pins', []), 'Lowercase letters, digits and - only.');
    assert.strictEqual(nameProblem('runs', []), 'runs is reserved.');
    assert.strictEqual(nameProblem('pull-pins', ['pull-pins']), 'A job named pull-pins already exists.');
    assert.strictEqual(nameProblem('pull-pins', ['other']), null);
  });

  t('editsWithoutAsking: acceptEdits in the frontmatter (quoted or commented), not plan, not a body line', () => {
    assert.strictEqual(editsWithoutAsking(jobTemplate('skill')), true);
    assert.strictEqual(editsWithoutAsking('---\npermission-mode: "acceptEdits"\n---\n'), true);
    assert.strictEqual(editsWithoutAsking('---\npermission-mode: plan\n---\npermission-mode: acceptEdits\n'), false);
    assert.strictEqual(editsWithoutAsking(jobTemplate('shell')), false);
  });

  t('splitNext: day then clock on the last space; a one-word line stays one line', () => {
    assert.deepStrictEqual(splitNext('tomorrow 07:00'), ['tomorrow', '07:00']);
    assert.deepStrictEqual(splitNext('Nov 1 09:30'), ['Nov 1', '09:30']);
    assert.deepStrictEqual(splitNext('paused'), ['paused', null]);
  });

  t('withLate: late lands after the time, alone on an empty line, and nowhere when the run was on time', () => {
    assert.strictEqual(withLate('6:00 today · 38s', true), '6:00 today · late · 38s');
    assert.strictEqual(withLate('22:00', true), '22:00 · late');
    assert.strictEqual(withLate('', true), 'late');
    assert.strictEqual(withLate('6:00 today · 38s', false), '6:00 today · 38s');
    assert.strictEqual(runClock(mkRun({ startedAt: at(4, 19, 7, 5), late: true })), '07:05 · late');
  });

  t('writeFailureText: read-only and token 403s, not-owner, running, 404, 422, network, anything else', () => {
    assert.strictEqual(writeFailureText('Run now', 403, { error: 'read-only from this network' }), READ_ONLY_TEXT);
    assert.strictEqual(writeFailureText('Run now', 403, { error: 'bad token' }), 'Run now needs the Answer token — set it under Settings › Local › Connection.');
    assert.strictEqual(writeFailureText('Save', 409, { error: 'not-owner' }), 'Another server owns the routines on this machine; this one only reads.');
    assert.strictEqual(writeFailureText('Run now', 409, { error: 'already-running' }), 'Run now: the job is already running.');
    assert.strictEqual(writeFailureText('Stop', 409, { error: 'not-running' }), 'Stop: the job is not running.');
    assert.strictEqual(writeFailureText('Delete', 404, null), 'Delete: no such job.');
    assert.strictEqual(writeFailureText('Save', 422, { errors: [] }), 'Save: the file has errors.');
    assert.strictEqual(writeFailureText('Reveal', 0, null), 'Reveal failed: the server did not answer.');
    assert.strictEqual(writeFailureText('Reconcile', 500, { error: 'x' }), 'Reconcile failed (HTTP 500).');
    // Run now's other 409s (server/lib/routine-run.ts RunResult), its 400 and its 500.
    assert.strictEqual(writeFailureText('Run now', 409, { error: 'invalid' }), 'Run now: the job file has errors — fix them before running it.');
    assert.strictEqual(writeFailureText('Run now', 409, { error: 'not-this-machine' }), 'Run now: the job is not set to run on this machine (its machines: line).');
    assert.strictEqual(writeFailureText('Run now', 409, { error: 'no-plugin' }), 'Run now needs the dashboard plugin installed on this machine.');
    assert.strictEqual(writeFailureText('Run now', 400, { error: 'bad-only' }), 'Run now: the steps picked to run were not valid.');
    assert.strictEqual(writeFailureText('Run now', 500, { error: 'spawn-failed' }), 'Run now failed: the job could not be launched.');
    assert.strictEqual(writeFailureText('Run now', 409, { error: 'toString' }), 'Run now failed (HTTP 409).', 'an inherited key is not a code');
  });

  const stats = (over: Partial<RoutineStats> = {}): RoutineStats => ({
    runs: 0, ok: 0, failed: 0, lost: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, wallMs: 0, byDay: [], prev: { costUsd: 0, runs: 0 }, ...over
  });

  t('costDelta: up is red, down is green, a flat or empty previous window says so', () => {
    assert.deepStrictEqual(costDelta(stats({ costUsd: 24.1, prev: { costUsd: 20.7, runs: 50 } }), 30), { text: '↑ $3.40 vs previous 30d', dir: 'up' });
    assert.deepStrictEqual(costDelta(stats({ costUsd: 1, prev: { costUsd: 2.5, runs: 3 } }), 7), { text: '↓ $1.50 vs previous 7d', dir: 'dn' });
    assert.deepStrictEqual(costDelta(stats({ costUsd: 1, prev: { costUsd: 1.001, runs: 3 } }), 7), { text: 'same as previous 7d', dir: null });
    assert.deepStrictEqual(costDelta(stats({ costUsd: 1 }), 90), { text: 'nothing in the previous 90d', dir: null });
  });

  t('successRate: ok over ok + failed + lost; NaN reads — when nothing finished', () => {
    assert.strictEqual(formatStat(successRate(stats({ ok: 52, failed: 8, lost: 1 })), 'pct'), '85%');
    assert.strictEqual(formatStat(successRate(stats()), 'pct'), '—');
  });

  t('topTokenShare: the biggest job and its share; one job alone, or no tokens, is null', () => {
    const r = (job: string, n: number) => mkRun({ job, steps: [step({ tokensIn: n, tokensOut: 0 })] });
    assert.deepStrictEqual(topTokenShare([r('a', 71), r('b', 20), r('a', 0), r('c', 9)]), { job: 'a', share: 0.71 });
    assert.strictEqual(topTokenShare([r('a', 5), r('a', 5)]), null);
    assert.strictEqual(topTokenShare([r('a', 0), r('b', 0)]), null);
  });

  t('medianMs: odd and even counts, running runs skipped, NaN when none finished', () => {
    assert.strictEqual(medianMs([mkRun({ ms: 3 }), mkRun({ ms: 1 }), mkRun({ ms: 2 })]), 2);
    assert.strictEqual(medianMs([mkRun({ ms: 1 }), mkRun({ ms: 4 }), mkRun({ ms: null })]), 2.5);
    assert.ok(Number.isNaN(medianMs([mkRun({ ms: null })])));
  });

  t('runKicker: a finished fan-out, a late one, a by-hand run in flight, a plain run', () => {
    const fan = mkRun({ startedAt: at(4, 18, 22), ms: 664_000, total: 12, steps: [step({ repo: 'a', costUsd: 0.5 }), step({ repo: 'b', costUsd: 0.34 })] });
    assert.strictEqual(runKicker(fan, NOW), 'Yesterday 22:00 · by schedule · 12 repos · 11m 4s · $0.84');
    assert.strictEqual(runKicker({ ...fan, startedAt: at(4, 17, 22), late: true }, NOW), 'Apr 17 22:00 · by schedule · late · 12 repos · 11m 4s · $0.84');
    const live = mkRun({ state: 'running', trigger: 'manual', startedAt: at(4, 19, 11, 59), ms: null, total: 1, steps: [step({ repo: 'lookout', outcome: null })] });
    assert.strictEqual(runKicker(live, NOW), 'Now · by hand · 1 repo · 1m so far');
    assert.strictEqual(runKicker(mkRun({ startedAt: at(4, 19, 6) }), NOW), 'Today 06:00 · by schedule · 38s');
    assert.strictEqual(isFanOut(mkRun()), false);
  });

  t('stepPill: ok, exit code, failed with no code, timeout, stopped, skipped, in flight, lost', () => {
    assert.deepStrictEqual(stepPill(step(), 'ok'), { text: 'ok', tone: 'green' });
    assert.deepStrictEqual(stepPill(step({ outcome: 'failed', exit: 1 }), 'failed'), { text: 'exit 1', tone: 'red' });
    assert.deepStrictEqual(stepPill(step({ outcome: 'failed', exit: null }), 'failed'), { text: 'failed', tone: 'red' });
    assert.deepStrictEqual(stepPill(step({ outcome: 'timeout' }), 'failed'), { text: 'timeout', tone: 'red' });
    assert.deepStrictEqual(stepPill(step({ outcome: 'stopped' }), 'failed'), { text: 'stopped', tone: 'mustard' });
    assert.deepStrictEqual(stepPill(step({ outcome: 'skipped' }), 'ok'), { text: 'skipped', tone: 'dim' });
    assert.deepStrictEqual(stepPill(step({ outcome: null }), 'running'), { text: 'running', tone: 'run' });
    assert.deepStrictEqual(stepPill(step({ outcome: null }), 'lost'), { text: 'lost', tone: 'mustard' });
    assert.deepStrictEqual(runPill(mkRun({ state: 'lost' })), { text: 'lost', tone: 'mustard' });
  });

  t('splitSteps: failures always show in order, ok steps fill up to the limit, the rest are counted', () => {
    const s = [step({ index: 0 }), step({ index: 1, outcome: 'failed' }), step({ index: 2 }), step({ index: 3 }), step({ index: 4, outcome: 'failed' })];
    const four = splitSteps(s, 4);
    assert.deepStrictEqual(four.shown.map(x => x.index), [0, 1, 2, 4]);
    assert.strictEqual(four.hiddenOk, 1);
    const none = splitSteps(s, 0);
    assert.deepStrictEqual(none.shown.map(x => x.index), [1, 4]);
    assert.strictEqual(none.hiddenOk, 3);
    assert.strictEqual(launchdLabel('git-sync-all'), 'com.claude-dashboard.routine.git-sync-all');
  });

  t('reconcileChip: owned by <x>, not owner for a server that never opted in, then the owner\'s verdicts', () => {
    const rep = (state: 'in-sync' | 'drift' | 'failed', n = 0) => ({ state, changes: Array.from({ length: n }, () => ({ name: 'a', action: 'install' as const, why: '' })), unchanged: 0, error: null, at: '' });
    assert.deepStrictEqual(reconcileChip({ owner: { ownedBy: '/x:4173' }, reconcile: rep('in-sync'), jobs: [] }), { text: 'owned by /x:4173', tone: 'dim' });
    assert.deepStrictEqual(reconcileChip({ owner: { ownedBy: '' }, reconcile: rep('in-sync'), jobs: [] }), { text: 'not owner', tone: 'dim' });
    assert.deepStrictEqual(reconcileChip({ owner: 'owner', reconcile: rep('in-sync'), jobs: [mkRow(), mkRow({ installed: false })] }), { text: '1 installed · in sync', tone: 'green' });
    assert.deepStrictEqual(reconcileChip({ owner: 'owner', reconcile: rep('drift', 2), jobs: [] }), { text: 'drift · 2 to apply', tone: 'amber' });
    assert.deepStrictEqual(reconcileChip({ owner: 'owner', reconcile: rep('failed'), jobs: [] }), { text: 'reconcile failed', tone: 'red' });
  });

  t('reconcilePreview: one row per change, pending listed but not counted, the nameless change named, Apply only with work to do', () => {
    const p = reconcilePreview({
      state: 'drift', unchanged: 2, error: null, at: '',
      changes: [
        { name: 'pull-pins', action: 'install', why: 'new' }, { name: 'old', action: 'remove', why: 'file gone' },
        { name: 'busy', action: 'pending', why: 'running' }, { name: '', action: 'remove', why: '1 unrecognised line(s) in the marker block' }
      ]
    });
    assert.deepStrictEqual(p, {
      summary: '3 changes to apply · 1 pending · 2 unchanged',
      rows: [
        { key: '0:pull-pins', name: 'pull-pins', action: 'install', why: 'new' }, { key: '1:old', name: 'old', action: 'remove', why: 'file gone' },
        { key: '2:busy', name: 'busy', action: 'pending', why: 'running' }, { key: '3:', name: 'crontab block', action: 'remove', why: '1 unrecognised line(s) in the marker block' }
      ],
      error: null,
      canApply: true
    });
    assert.strictEqual(reconcilePreview({ state: 'drift', unchanged: 0, error: null, at: '', changes: [{ name: 'a', action: 'update', why: 'changed' }] })?.summary, '1 change to apply');
  });

  t('reconcilePreview: nothing to do, all-pending and a refused plan cannot apply; a non-report body is null', () => {
    assert.deepStrictEqual(reconcilePreview({ state: 'in-sync', changes: [], unchanged: 3, error: null, at: '' }),
      { summary: 'Nothing to do · 3 unchanged', rows: [], error: null, canApply: false });
    assert.deepStrictEqual(reconcilePreview({ state: 'in-sync', changes: [], unchanged: 0, error: null, at: '' })?.summary, 'Nothing to do');
    const pend = reconcilePreview({ state: 'pending', changes: [{ name: 'busy', action: 'pending', why: 'running' }], unchanged: 0, error: null, at: '' });
    assert.strictEqual(pend?.summary, '1 pending');
    assert.strictEqual(pend?.canApply, false);
    const bad = reconcilePreview({ state: 'no-plugin', changes: [], unchanged: 0, error: 'plugin not installed', at: '' });
    assert.strictEqual(bad?.error, 'plugin not installed');
    assert.strictEqual(bad?.canApply, false);
    assert.strictEqual(reconcilePreview(null), null);
    assert.strictEqual(reconcilePreview({ error: 'reconcile failed' }), null);
  });

  t('chipClass: the running tone never takes `.rtn-run`, the fold row grid it once collided with', () => {
    assert.strictEqual(chipClass('run'), 'git-chip rtn-runner');
    assert.strictEqual(chipClass('red'), 'git-chip rtn-red');
    assert.strictEqual(chipClass('green'), 'git-chip green');
  });

  t('dotTone: running wins over paused, paused wins over the last outcome, mustard reads lost', () => {
    assert.strictEqual(dotTone({ text: 'running', tone: 'run' }, false), 'live');
    assert.strictEqual(dotTone({ text: 'failed', tone: 'red' }, false), 'off');
    assert.strictEqual(dotTone({ text: 'ok', tone: 'green' }, true), 'ok');
    assert.strictEqual(dotTone({ text: '2 of 12 failed', tone: 'amber' }, true), 'warn');
    assert.strictEqual(dotTone({ text: 'failed', tone: 'red' }, true), 'bad');
    assert.strictEqual(dotTone({ text: 'lost', tone: 'mustard' }, true), 'lost');
    assert.strictEqual(dotTone({ text: 'never run', tone: 'dim' }, true), '');
  });

  t('topFailure: counts failed and lost runs per job; null when nothing failed', () => {
    const r = (job: string, state: 'ok' | 'failed' | 'lost') => mkRun({ job, state });
    assert.strictEqual(topFailure([r('a', 'ok')]), null);
    assert.strictEqual(topFailure([r('a', 'failed'), r('b', 'lost'), r('a', 'failed'), r('c', 'ok')]), '2 of 3 failures: a');
    assert.strictEqual(topFailure([r('a', 'failed'), r('a', 'lost')]), 'all 2 from a');
  });

  t('jobPins: pinned = listed pins only, a list is kept as written, cwd is none', () => {
    const pins = [{ name: 'x', listed: true }, { name: 'dead', listed: false }, { name: 'y', listed: true }];
    assert.deepStrictEqual(jobPins('pinned', pins), ['x', 'y']);
    assert.deepStrictEqual(jobPins(['y', 'not-here'], pins), ['y', 'not-here']);
    assert.deepStrictEqual(jobPins(null, pins), []);
  });

  t('pinOutcome and stepErrLine: the pin\'s step pill, and the last output line before why', () => {
    const run = mkRun({ state: 'failed', steps: [step({ repo: 'a', outcome: 'failed', exit: 1 }), step({ repo: 'b', outcome: 'ok' })] });
    assert.deepStrictEqual(pinOutcome(run, 'a'), { text: 'exit 1', tone: 'red' });
    assert.deepStrictEqual(pinOutcome(run, 'b'), { text: 'ok', tone: 'green' });
    assert.strictEqual(pinOutcome(run, 'c'), null);
    assert.strictEqual(pinOutcome(null, 'a'), null);
    assert.strictEqual(stepErrLine(step({ tail: 'one\nfatal: no auth\n\n', why: 'exit 1' })), 'fatal: no auth');
    assert.strictEqual(stepErrLine(step({ tail: null, why: 'timeout' })), 'timeout');
    assert.strictEqual(stepErrLine(step({ tail: null, why: null })), null);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
