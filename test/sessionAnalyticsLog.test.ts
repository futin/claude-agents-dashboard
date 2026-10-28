import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSessionAnalyticsLog, lessonForSession, parseLogEvents, readSessionAnalyticsLog, resetSessionAnalyticsLogCache, statusForSession
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

  t('readSessionAnalyticsLog reuses its parse until the file changes, and forgets a deleted file', () => {
    resetSessionAnalyticsLogCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-kaizen-'));
    const log = path.join(dir, 'session-analytics-log.md');
    const line = (id: string) => `- 2026-07-10 [proj-a] ${id}: 500k billable (2M ctx), top cost Read. Lesson: read less.\n`;
    try {
      fs.writeFileSync(log, line('aaaa1111'));
      const first = readSessionAnalyticsLog(log);
      assert.equal(first.length, 1);
      assert.strictEqual(readSessionAnalyticsLog(log), first, 'untouched file returns the remembered array');
      fs.appendFileSync(log, line('bbbb2222'));
      assert.equal(readSessionAnalyticsLog(log).length, 2);
      fs.rmSync(log);
      assert.deepEqual(readSessionAnalyticsLog(log), []);
      fs.writeFileSync(log, line('cccc3333'));
      const again = readSessionAnalyticsLog(log);
      assert.equal(again.length, 1);
      assert.equal(again[0].idPrefix, 'cccc3333');
    } finally {
      resetSessionAnalyticsLogCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The structured tail (#332): ` ‖ ` then `key: value` fields split at ` · ` + a known key.
  const PREFIX = '- 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. ';
  const one = (line: string) => {
    const ev = parseLogEvents(line);
    assert.equal(ev.lessons.length, 1, `one lesson from: ${line}`);
    assert.deepEqual(parseSessionAnalyticsLog(line), ev.lessons, 'both parsers return the same shape');
    return ev.lessons[0];
  };

  t('tail: a legacy line parses exactly as before — no fields, no none', () => {
    const l = one(PREFIX + 'Lesson: keep subagents terse.');
    assert.deepEqual(l, { date: '2026-07-12', project: 'dashboard', idPrefix: 'd04e9b52', lesson: 'keep subagents terse.' });
  });

  t('tail: a full tail splits into the four fields and leaves the lesson clean', () => {
    const l = one(PREFIX + 'Lesson: read the doc before editing the status machine. ‖ cue: editing a state machine with a rules doc · component: project '
      + 'CLAUDE.md §Code rules · evidence: errorSignals.retries=4 on Edit · confidence: high (three retries, same file)');
    assert.equal(l.lesson, 'read the doc before editing the status machine.');
    assert.deepEqual(l.fields, {
      cue: 'editing a state machine with a rules doc',
      component: 'project CLAUDE.md §Code rules',
      evidence: 'errorSignals.retries=4 on Edit',
      confidence: 'high',
      confidenceReason: 'three retries, same file'
    });
    assert.equal(l.none, undefined);
  });

  t('tail: a ` · ` inside a value that is not followed by a key survives', () => {
    const l = one(PREFIX + 'Lesson: read less. ‖ cue: big reads · component: habit · evidence: byTool[Read] · 31k avg: whole-file reads · confidence: medium');
    assert.equal(l.fields?.evidence, 'byTool[Read] · 31k avg: whole-file reads');
    assert.equal(l.fields?.confidence, 'medium');
  });

  t('tail: keys in any order and any case; confidence stored lower-case', () => {
    const l = one(PREFIX + 'Lesson: x. ‖ Confidence: LOW · Cue: x · Component: habit');
    assert.deepEqual(l.fields, { confidence: 'low', cue: 'x', component: 'habit' });
  });

  t('tail: a confidence outside high|medium|low is dropped, the rest kept', () => {
    const l = one(PREFIX + 'Lesson: x. ‖ cue: c · component: habit · evidence: e · confidence: sure');
    assert.deepEqual(l.fields, { cue: 'c', component: 'habit', evidence: 'e' });
  });

  t('tail: a tail with no known key yields no fields, and the lesson is still cut', () => {
    const l = one(PREFIX + 'Lesson: foo. ‖ whatever');
    assert.equal(l.lesson, 'foo.');
    assert.equal(l.fields, undefined);
  });

  t('none: `none —` / `None -` flag a born-closed lesson; `nonetheless` does not', () => {
    const l = one(PREFIX + 'Lesson: none — routine docs-sync, nothing new.');
    assert.equal(l.none, true);
    assert.equal(l.noneReason, 'routine docs-sync, nothing new.');
    assert.equal(l.lesson, 'none — routine docs-sync, nothing new.');
    assert.equal(one(PREFIX + 'Lesson: None - x').none, true);
    assert.equal(one(PREFIX + 'Lesson: none – en dash').none, true);
    const not = one(PREFIX + 'Lesson: nonetheless keep going');
    assert.equal(not.none, undefined);
    assert.equal(not.noneReason, undefined);
  });

  t('none: a none line ignores any tail', () => {
    const l = one(PREFIX + 'Lesson: none — nothing new. ‖ cue: c · component: habit · confidence: high');
    assert.equal(l.none, true);
    assert.equal(l.lesson, 'none — nothing new.');
    assert.equal(l.fields, undefined);
  });

  t('tail: the mid-session capture shape keeps the whole quoted correction as evidence', () => {
    const l = one('- 2026-10-28 [dashboard] abc123: mid-session observation. Lesson: check X first. ‖ cue: c · component: habit · evidence: '
      + 'user correction: "you should have checked X first" · confidence: medium (one observation)');
    assert.equal(l.lesson, 'check X first.');
    assert.equal(l.fields?.evidence, 'user correction: "you should have checked X first"');
    assert.equal(l.fields?.confidence, 'medium');
    assert.equal(l.fields?.confidenceReason, 'one observation');
  });

  t('tail: a status note containing ` ‖ ` still classifies as a status line', () => {
    const ev = parseLogEvents('- 2026-08-01 [p] abcd1234: status actioned — Lesson: x ‖ cue: y');
    assert.equal(ev.lessons.length, 0);
    assert.equal(ev.statuses.length, 1);
    assert.equal(ev.statuses[0].note, 'Lesson: x ‖ cue: y');
  });

  t('tail: lessonForSession returns the clean lesson text only', () => {
    const lessons = parseSessionAnalyticsLog(PREFIX + 'Lesson: read less. ‖ cue: c · component: habit');
    assert.equal(lessonForSession(lessons, 'd04e9b52-0000'), 'read less.');
  });

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
