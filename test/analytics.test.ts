import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listReports, reviewStatus } from '../server/lib/analytics.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Build a tmp fake home with a session-analytics-log + N transcripts. */
function fakeHome(opts: { sessionAnalyticsLog?: string; transcripts?: Record<string, unknown[]> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-analytics-'));
  const projDir = path.join(home, '.claude', 'projects', '-tmp-demo');
  fs.mkdirSync(projDir, { recursive: true });
  for (const [id, records] of Object.entries(opts.transcripts ?? {})) {
    fs.writeFileSync(path.join(projDir, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n'));
  }
  if (opts.sessionAnalyticsLog !== undefined) {
    fs.writeFileSync(path.join(home, '.claude', 'session-analytics-log.md'), opts.sessionAnalyticsLog);
  }
  return home;
}

/** Minimal assistant turn with usage + a tool_use. */
function turn(cwd: string, iso: string) {
  return {
    cwd,
    timestamp: iso,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 },
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]
    }
  };
}

const logLine = (date: string, project: string, id: string, lesson: string) =>
  `- ${date} [${project}] ${id}: 160 billable (1.16k ctx), top cost Read. Lesson: ${lesson}`;

export function run(): number {
  console.log('analytics.test.ts');
  let ok = 0, n = 0;
  const t = (name: string, fn: () => void) => { n++; if (test(name, fn)) ok++; };

  t('logged session → enriched report (lesson + live analysis)', () => {
    const home = fakeHome({
      sessionAnalyticsLog: logLine('2026-07-12', 'demo', 'abc12345', 'keep it tight.'),
      transcripts: { 'abc12345-0000-1111-2222-333344445555': [turn('/tmp/demo', '2026-07-12T10:00:00.000Z')] }
    });
    const reports = listReports(5, { homeDir: home });
    assert.equal(reports.length, 1);
    const r = reports[0];
    assert.equal(r.sessionId, 'abc12345-0000-1111-2222-333344445555'); // resolved from prefix
    assert.equal(r.project, 'demo');
    assert.equal(r.lesson, 'keep it tight.');
    assert.equal(r.loggedAt, '2026-07-12');
    assert.ok(r.analysis, 'analysis present');
    assert.equal(r.analysis!.totals.billableApprox, 160); // 100+50+10
  });

  // #312: a session split across two project dirs (a `cd` into a worktree) resolves to its live half, whichever
  // dir `readdirSync` yields first — so run it with the halves' dir names both ways round.
  for (const [oldDir, newDir] of [['-a-old', '-z-new'], ['-z-old', '-a-new']]) {
    t(`split session → the newer half's cwd (old half in ${oldDir})`, () => {
      const home = fakeHome({ sessionAnalyticsLog: logLine('2026-07-12', 'demo', 'split123', 'one id, two dirs.') });
      const id = 'split123-0000-1111-2222-333344445555';
      const write = (dirName: string, cwd: string, mtimeSec: number) => {
        const dir = path.join(home, '.claude', 'projects', dirName);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.jsonl`);
        fs.writeFileSync(file, JSON.stringify(turn(cwd, '2026-07-12T10:00:00.000Z')));
        fs.utimesSync(file, mtimeSec, mtimeSec);
      };
      write(oldDir, '/old', 1_000_000);
      write(newDir, '/new', 2_000_000);
      const reports = listReports(5, { homeDir: home });
      assert.equal(reports.length, 1);
      assert.equal(reports[0].cwd, '/new');
    });
  }

  t('missing transcript → lesson kept, analysis null, project from log', () => {
    const home = fakeHome({ sessionAnalyticsLog: logLine('2026-07-12', 'ghostproj', 'deadbeef', 'still logged.') });
    const reports = listReports(5, { homeDir: home });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].analysis, null);
    assert.equal(reports[0].lesson, 'still logged.');
    assert.equal(reports[0].project, 'ghostproj');
    assert.equal(reports[0].sessionId, 'deadbeef'); // falls back to the prefix
  });

  t('newest-first, deduped by session, capped by limit', () => {
    const home = fakeHome({
      sessionAnalyticsLog: [
        logLine('2026-07-10', 'demo', 'aaaa1111', 'old lesson for a.'),
        logLine('2026-07-11', 'demo', 'bbbb2222', 'lesson b.'),
        logLine('2026-07-12', 'demo', 'cccc3333', 'lesson c.'),
        logLine('2026-07-13', 'demo', 'aaaa1111', 'NEW lesson for a.')
      ].join('\n')
    });
    const all = listReports(10, { homeDir: home });
    assert.deepEqual(all.map(r => r.sessionId), ['aaaa1111', 'cccc3333', 'bbbb2222']); // a newest (re-logged), deduped
    assert.equal(all[0].lesson, 'NEW lesson for a.');
    const capped = listReports(2, { homeDir: home });
    assert.deepEqual(capped.map(r => r.sessionId), ['aaaa1111', 'cccc3333']);
  });

  t('no session-analytics-log → []', () => {
    const home = fakeHome({});
    assert.deepEqual(listReports(5, { homeDir: home }), []);
  });

  // --- lesson lifecycle + review sweep ------------------------------------

  t('status line rides along on the report; unstatused lesson stays open', () => {
    const home = fakeHome({
      sessionAnalyticsLog: [
        logLine('2026-07-12', 'demo', 'abc12345', 'keep it tight.'),
        logLine('2026-07-13', 'demo', 'dddd4444', 'no status for this one.'),
        '- 2026-08-01 [demo] abc12345: status actioned — added to project CLAUDE.md'
      ].join('\n'),
      transcripts: { 'abc12345-0000-1111-2222-333344445555': [turn('/tmp/demo', '2026-07-12T10:00:00.000Z')] }
    });
    const byId = Object.fromEntries(listReports(5, { homeDir: home }).map(r => [r.sessionId.slice(0, 8), r]));
    // Matched against the RESOLVED full session id, not just the logged prefix.
    assert.deepEqual(byId['abc12345'].lessonStatus, {
      status: 'actioned', date: '2026-08-01', note: 'added to project CLAUDE.md'
    });
    assert.equal(byId['dddd4444'].lessonStatus, null);
  });

  t('a status line alone never creates a report', () => {
    const home = fakeHome({ sessionAnalyticsLog: '- 2026-08-01 [demo] abc12345: status actioned — no lesson logged' });
    assert.deepEqual(listReports(5, { homeDir: home }), []);
  });

  t('reviewStatus: empty log is never due', () => {
    const home = fakeHome({});
    assert.deepEqual(reviewStatus({ homeDir: home, now: new Date('2026-08-09T00:00:00Z') }), {
      lastReviewAt: null, reviewDue: false
    });
  });

  t('reviewStatus: lessons but no marker → due', () => {
    const home = fakeHome({ sessionAnalyticsLog: logLine('2026-07-12', 'demo', 'abc12345', 'x.') });
    const s = reviewStatus({ homeDir: home, now: new Date('2026-08-09T00:00:00Z') });
    assert.equal(s.lastReviewAt, null);
    assert.equal(s.reviewDue, true);
  });

  t('reviewStatus: 7-day boundary', () => {
    const home = fakeHome({
      sessionAnalyticsLog: [
        logLine('2026-07-12', 'demo', 'abc12345', 'x.'),
        '- 2026-08-01 review: swept 3 lessons'
      ].join('\n')
    });
    const at = (iso: string) => reviewStatus({ homeDir: home, now: new Date(iso) });
    assert.equal(at('2026-08-08T00:00:00Z').reviewDue, false); // exactly 7 days — still fresh
    assert.equal(at('2026-08-08T12:00:00Z').reviewDue, true);  // past 7 days
    assert.equal(at('2026-08-08T12:00:00Z').lastReviewAt, '2026-08-01');
  });

  t('reviewStatus: `none` lessons are born closed — a log of only them is never due', () => {
    const nones = [
      logLine('2026-07-12', 'demo', 'abc12345', 'none — routine, nothing new.'),
      logLine('2026-07-13', 'demo', 'dddd4444', 'None - x')
    ];
    const now = new Date('2026-08-09T00:00:00Z');
    assert.equal(reviewStatus({ homeDir: fakeHome({ sessionAnalyticsLog: nones.join('\n') }), now }).reviewDue, false);
    const withOne = [...nones, logLine('2026-07-14', 'demo', 'eeee5555', 'batch the reads.')].join('\n');
    assert.equal(reviewStatus({ homeDir: fakeHome({ sessionAnalyticsLog: withOne }), now }).reviewDue, true);
  });

  t('report: a tailed lesson carries its fields and clean text; a none lesson is flagged, not open', () => {
    const home = fakeHome({
      sessionAnalyticsLog: [
        logLine('2026-07-12', 'demo', 'abc12345',
          'read less. ‖ cue: big reads · component: habit · evidence: byTool[Read] · confidence: low (one session)'),
        logLine('2026-07-13', 'demo', 'dddd4444', 'none — nothing new.')
      ].join('\n')
    });
    const byId = Object.fromEntries(listReports(5, { homeDir: home }).map(r => [r.sessionId.slice(0, 8), r]));
    assert.equal(byId['abc12345'].lesson, 'read less.');
    assert.deepEqual(byId['abc12345'].lessonFields, {
      cue: 'big reads', component: 'habit', evidence: 'byTool[Read]', confidence: 'low', confidenceReason: 'one session'
    });
    assert.equal(byId['abc12345'].lessonNone, undefined);
    assert.equal(byId['dddd4444'].lessonNone, true);
    assert.equal(byId['dddd4444'].lessonFields, undefined);
    assert.equal(byId['dddd4444'].lesson, 'none — nothing new.');
  });

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
