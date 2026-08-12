import assert from 'node:assert';

import {
  parseSessionAnalyticsLog, lessonForSession, parseLogEvents, statusForSession
} from '../server/lib/sessionAnalyticsLog.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const SAMPLE = [
  '# Session analytics log',
  '',
  '- 2026-07-10 [proj-a] aaaa1111: 500k billable (2M ctx), top cost Read. Lesson: read less.',
  'garbage line that should be skipped',
  '- 2026-07-12 [claude-agents-dashboard] d04e9b52: 1.0M billable (12.1M ctx), top cost 4 subagents. Lesson: subagents should return terse findings.',
  '- not-a-date [x] y: no lesson here',
  '- 2026-07-12 [proj-a] aaaa1111: 700k billable (3M ctx), top cost Bash. Lesson: newer lesson for aaaa.'
].join('\n');

// A log that has been through the status lifecycle: lessons, status lines, a review marker.
const MIXED = [
  '- 2026-07-10 [proj-a] aaaa1111: 500k billable (2M ctx), top cost Read. Lesson: read less.',
  '- 2026-07-11 [proj-b] bbbb2222: 100k billable (1M ctx), top cost Bash. Lesson: batch commands.',
  '- 2026-08-01 [proj-a] aaaa1111: status actioned — added to project CLAUDE.md',
  '- 2026-08-02 [proj-b] bbbb2222: status dropped',
  '- 2026-08-05 [proj-a] aaaa1111: status promoted — global CLAUDE.md after 4 projects',
  '- 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2',
  '- 2026-08-03 review: an older marker, out of order on purpose'
].join('\n');

export function run(): number {
  console.log('sessionAnalyticsLog.test.ts');
  let ok = 0, n = 0;
  const t = (name: string, fn: () => void) => { n++; if (test(name, fn)) ok++; };

  t('parses well-formed lines, skips junk', () => {
    const parsed = parseSessionAnalyticsLog(SAMPLE);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], { date: '2026-07-10', project: 'proj-a', idPrefix: 'aaaa1111', lesson: 'read less.' });
    assert.equal(parsed[1].idPrefix, 'd04e9b52');
    assert.equal(parsed[1].lesson, 'subagents should return terse findings.');
  });

  t('empty / non-string input → []', () => {
    assert.deepEqual(parseSessionAnalyticsLog(''), []);
    // @ts-expect-error deliberately wrong type
    assert.deepEqual(parseSessionAnalyticsLog(null), []);
  });

  t('lessonForSession matches by id prefix', () => {
    const parsed = parseSessionAnalyticsLog(SAMPLE);
    const l = lessonForSession(parsed, 'd04e9b52-1234-5678-9abc-def012345678');
    assert.equal(l, 'subagents should return terse findings.');
  });

  t('lessonForSession newest match wins', () => {
    const parsed = parseSessionAnalyticsLog(SAMPLE);
    const l = lessonForSession(parsed, 'aaaa1111-0000-0000-0000-000000000000');
    assert.equal(l, 'newer lesson for aaaa.');
  });

  t('lessonForSession no match → null', () => {
    const parsed = parseSessionAnalyticsLog(SAMPLE);
    assert.equal(lessonForSession(parsed, 'ffffffff-0000'), null);
    assert.equal(lessonForSession(parsed, ''), null);
  });

  // --- status + review lines (the append-only lifecycle) -------------------

  t('legacy log reads identically through parseLogEvents', () => {
    const ev = parseLogEvents(SAMPLE);
    assert.deepEqual(ev.lessons, parseSessionAnalyticsLog(SAMPLE));
    assert.deepEqual(ev.statuses, []);
    assert.equal(ev.lastReviewDate, null);
  });

  t('status + review lines parsed, lessons unaffected', () => {
    const ev = parseLogEvents(MIXED);
    assert.deepEqual(ev.lessons.map(l => l.idPrefix), ['aaaa1111', 'bbbb2222']);
    assert.equal(ev.statuses.length, 3);
    assert.deepEqual(ev.statuses[0], {
      date: '2026-08-01', project: 'proj-a', idPrefix: 'aaaa1111',
      status: 'actioned', note: 'added to project CLAUDE.md'
    });
    assert.equal(ev.statuses[1].note, undefined); // no em-dash note
    assert.equal(ev.lastReviewDate, '2026-08-09'); // newest marker wins
  });

  t('the old parser ignores status + review lines (forward-compatible)', () => {
    // scan.ts still uses parseSessionAnalyticsLog — new shapes must be invisible to it.
    assert.deepEqual(parseSessionAnalyticsLog(MIXED).map(l => l.idPrefix), ['aaaa1111', 'bbbb2222']);
  });

  t('a status note mentioning "Lesson:" is not read as a lesson', () => {
    const ev = parseLogEvents('- 2026-08-01 [p] abcd1234: status dropped — kept the Lesson: wording only');
    assert.deepEqual(ev.lessons, []);
    assert.equal(ev.statuses[0].status, 'dropped');
  });

  t('malformed status / review lines are skipped', () => {
    const ev = parseLogEvents([
      '- 2026-08-01 [p] abcd1234: status wat — unknown verb',
      '- not-a-date review: nope',
      '- 2026-08-01 review'  // no colon → still a marker
    ].join('\n'));
    assert.deepEqual(ev.statuses, []);
    assert.equal(ev.lastReviewDate, '2026-08-01');
  });

  t('statusForSession: prefix match, newest wins, no match → null', () => {
    const { statuses } = parseLogEvents(MIXED);
    assert.deepEqual(statusForSession(statuses, 'aaaa1111-0000-0000-0000-000000000000'), {
      status: 'promoted', date: '2026-08-05', note: 'global CLAUDE.md after 4 projects'
    });
    assert.deepEqual(statusForSession(statuses, 'bbbb2222-1111'), { status: 'dropped', date: '2026-08-02' });
    assert.equal(statusForSession(statuses, 'ffffffff-0000'), null);
    assert.equal(statusForSession(statuses, ''), null);
  });

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
