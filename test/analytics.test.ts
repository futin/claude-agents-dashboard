import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listReports } from '../server/lib/analytics.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Build a tmp fake home with a doctor-log + N transcripts. */
function fakeHome(opts: { doctorLog?: string; transcripts?: Record<string, unknown[]> } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-analytics-'));
  const projDir = path.join(home, '.claude', 'projects', '-tmp-demo');
  fs.mkdirSync(projDir, { recursive: true });
  for (const [id, records] of Object.entries(opts.transcripts ?? {})) {
    fs.writeFileSync(path.join(projDir, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n'));
  }
  if (opts.doctorLog !== undefined) {
    fs.writeFileSync(path.join(home, '.claude', 'doctor-log.md'), opts.doctorLog);
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
      doctorLog: logLine('2026-07-12', 'demo', 'abc12345', 'keep it tight.'),
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

  t('missing transcript → lesson kept, analysis null, project from log', () => {
    const home = fakeHome({ doctorLog: logLine('2026-07-12', 'ghostproj', 'deadbeef', 'still logged.') });
    const reports = listReports(5, { homeDir: home });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].analysis, null);
    assert.equal(reports[0].lesson, 'still logged.');
    assert.equal(reports[0].project, 'ghostproj');
    assert.equal(reports[0].sessionId, 'deadbeef'); // falls back to the prefix
  });

  t('newest-first, deduped by session, capped by limit', () => {
    const home = fakeHome({
      doctorLog: [
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

  t('no doctor-log → []', () => {
    const home = fakeHome({});
    assert.deepEqual(listReports(5, { homeDir: home }), []);
  });

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
