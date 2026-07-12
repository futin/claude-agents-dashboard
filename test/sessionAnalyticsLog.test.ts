import assert from 'node:assert';

import { parseSessionAnalyticsLog, lessonForSession } from '../server/lib/sessionAnalyticsLog.js';

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

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
