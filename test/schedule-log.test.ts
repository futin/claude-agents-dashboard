/**
 * server/lib/schedule-log.ts — the run-log fold, its incremental reader, rotation, stats and push copy. Fixtures are JSONL in a tmpdir, written in the
 * shapes `plugin/lib/run-schedule.mjs` appends them.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ScheduleRun, ScheduleStep } from '../shared/types.js';
import { computeStats, createLogReader, pushableEvents, rotateIfLarge } from '../server/lib/schedule-log.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const T0 = Date.UTC(2026, 9, 19, 20, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-log-'));
}

const line = (rec: object): string => JSON.stringify(rec) + '\n';
const start = (run: string, o: object = {}): object => ({ kind: 'start', run, job: 'git-sync-all', machine: 'mac', trigger: 'schedule', at: iso(T0), late: false, steps: 2, pid: 4242, ...o });
const stepStart = (run: string, step: number, o: object = {}): object => ({ kind: 'step-start', run, step, repo: `repo${step}`, cwd: `/r/${step}`, at: iso(T0 + step * 1000), ...o });
const stepEnd = (run: string, step: number, o: object = {}): object =>
  ({ kind: 'step-end', run, step, at: iso(T0 + step * 1000 + 500), ms: 500, exit: 0, outcome: 'ok', ...o });
const end = (run: string, o: object = {}): object => ({ kind: 'end', run, at: iso(T0 + 5000), ms: 5000, ok: 2, failed: 0, skipped: 0, stopped: false, ...o });

function complete(run: string, o: { startO?: object; endO?: object; s1?: object } = {}): string {
  return [start(run, o.startO), stepStart(run, 0, { session: 'sess-0' }), stepEnd(run, 0, { cost: 0.5, tokensIn: 1000, tokensOut: 200, turns: 3, model: 'sonnet' }),
    stepStart(run, 1), stepEnd(run, 1, o.s1), end(run, o.endO)].map(line).join('');
}

const never = (): boolean | null => null;
const hour = (): number => 60 * MIN;

export function run(): number {
  console.log('\n=== schedule-log.ts ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('a complete run folds to ok with its two steps and their numbers as the wrapper wrote them', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), complete('r1'));
    const [r, ...rest] = createLogReader(dir, never, hour).read();
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.id, 'r1');
    assert.strictEqual(r.job, 'git-sync-all');
    assert.strictEqual(r.machine, 'mac');
    assert.strictEqual(r.trigger, 'schedule');
    assert.strictEqual(r.steps.length, 2);
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.endedAt, iso(T0 + 5000));
    assert.strictEqual(r.ms, 5000);
    assert.deepStrictEqual([r.ok, r.failed, r.skipped, r.stopped, r.late, r.error, r.why], [2, 0, 0, false, false, null, null]);
    const s = r.steps[0];
    assert.deepStrictEqual([s.repo, s.cwd, s.sessionId, s.outcome, s.ms, s.exit, s.costUsd, s.tokensIn, s.tokensOut, s.turns, s.model],
      ['repo0', '/r/0', 'sess-0', 'ok', 500, 0, 0.5, 1000, 200, 3, 'sonnet']);
    assert.strictEqual(r.steps[1].sessionId, null);
  });

  t('failed 1 on the end record folds to failed', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), complete('r1', { endO: { ok: 1, failed: 1 }, s1: { outcome: 'failed', exit: 1, why: 'exit 1' } }));
    const [r] = createLogReader(dir, never, hour).read();
    assert.strictEqual(r.state, 'failed');
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.steps[1].outcome, 'failed');
    assert.strictEqual(r.steps[1].why, 'exit 1');
  });

  t('an end.error with no steps folds to failed and keeps the error', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), [start('r1', { steps: 0 }), end('r1', { ok: 0, error: 'no pins snapshot' })].map(line).join(''));
    const [r] = createLogReader(dir, never, hour).read();
    assert.strictEqual(r.state, 'failed');
    assert.strictEqual(r.error, 'no pins snapshot');
    assert.deepStrictEqual(r.steps, []);
  });

  t('a start with no end is lost when liveness says false, with the reason, and its unfinished step stays in flight', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), [start('r1'), stepStart('r1', 0), stepEnd('r1', 0), stepStart('r1', 1)].map(line).join(''));
    const calls: Array<[number, string]> = [];
    const [r] = createLogReader(dir, (pid, job) => { calls.push([pid, job]); return false; }, hour).read();
    assert.strictEqual(r.state, 'lost');
    assert.strictEqual(r.why, 'wrapper not running');
    assert.deepStrictEqual(calls, [[4242, 'git-sync-all']]);
    assert.strictEqual(r.steps[1].outcome, null);
    assert.strictEqual(r.steps[1].endedAt, null);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.ok, 1);
    assert.strictEqual(r.endedAt, null);
    assert.strictEqual(r.ms, null);
  });

  t('a start with no end is running when liveness says true, however old', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), line(start('r1')));
    const [r] = createLogReader(dir, () => true, hour, () => T0 + 30 * 24 * 60 * MIN).read();
    assert.strictEqual(r.state, 'running');
  });

  t('liveness null falls to the age rule: timeout x steps + 5 min, 124 min running, 126 min lost', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), line(start('r1', { steps: 2 })));
    const at = (min: number): ScheduleRun => createLogReader(dir, never, hour, () => T0 + min * MIN).read()[0];
    assert.strictEqual(at(124).state, 'running');
    assert.strictEqual(at(126).state, 'lost');
    assert.strictEqual(at(126).why, 'no end record past its timeout');
    assert.strictEqual(at(125).state, 'running');
  });

  t('the age rule asks timeoutMsFor for the run\'s own job', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), line(start('r1', { job: 'pull-pins', steps: 1 })));
    const asked: string[] = [];
    const [r] = createLogReader(dir, never, (job) => { asked.push(job); return 10 * MIN; }, () => T0 + 16 * MIN).read();
    assert.deepStrictEqual(asked, ['pull-pins']);
    assert.strictEqual(r.state, 'lost');
  });

  t('a torn last line is ignored; once its rest arrives, with more records, read() picks them up from the offset', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    const torn = line(stepEnd('r1', 1, { outcome: 'ok' }));
    const head = [start('r1'), stepStart('r1', 0), stepEnd('r1', 0), stepStart('r1', 1)].map(line).join('');
    fs.writeFileSync(file, head + torn.slice(0, 14));
    const reader = createLogReader(dir, () => true, hour);
    const before = reader.read();
    assert.strictEqual(before[0].state, 'running');
    assert.strictEqual(before[0].steps[1].outcome, null);
    assert.deepStrictEqual(reader.read(), before);
    fs.appendFileSync(file, torn.slice(14) + line(end('r1')) + line(start('r2', { at: iso(T0 + MIN) })));
    const after = reader.read();
    assert.deepStrictEqual(after.map((r) => [r.id, r.state]), [['r2', 'running'], ['r1', 'ok']]);
    assert.strictEqual(after[1].steps[1].outcome, 'ok');
  });

  t('the offset cache reads only what was appended: a poll after one appended record does not re-fold the earlier ones', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    fs.writeFileSync(file, complete('r1'));
    const reader = createLogReader(dir, never, hour);
    reader.read();
    // Overwrite the first record's bytes in place with a same-length different job: a re-read from 0 would show it, an offset read cannot.
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('git-sync-all', 'xxx-xxxx-xxx'));
    fs.appendFileSync(file, complete('r2', { startO: { at: iso(T0 + MIN) } }));
    const runs = reader.read();
    assert.strictEqual(runs.find((r) => r.id === 'r1')?.job, 'git-sync-all');
    assert.strictEqual(runs.find((r) => r.id === 'r2')?.state, 'ok');
  });

  t('a rotated file (mac.20261001.jsonl) is read too, and the machine comes from the name before the first dot', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.20261001.jsonl'), complete('old', { startO: { at: iso(T0 - 20 * 24 * 60 * MIN) } }));
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), complete('new') + line({ kind: 'refused', job: 'pull-pins', at: iso(T0 + MIN), trigger: 'schedule', why: 'file gone' }));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log');
    const runs = createLogReader(dir, never, hour).read();
    assert.deepStrictEqual(runs.map((r) => r.id).sort(), ['new', 'old', 'refused-mac-pull-pins-' + Date.parse(iso(T0 + MIN))].sort());
  });

  t('rotateIfLarge renames a 21 MB log to today\'s mac.<yyyymmdd>.jsonl and leaves a 1 MB one alone', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), Buffer.alloc(21 * 1024 * 1024, 0x20));
    fs.writeFileSync(path.join(dir, 'wsl.jsonl'), Buffer.alloc(1024 * 1024, 0x20));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    assert.deepStrictEqual(rotateIfLarge(dir), [`mac.${stamp}.jsonl`]);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`mac.${stamp}.jsonl`, 'wsl.jsonl']);
    assert.strictEqual(fs.statSync(path.join(dir, 'wsl.jsonl')).size, 1024 * 1024);
  });

  t('rotateIfLarge does not overwrite an earlier rotation from the same day', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), Buffer.alloc(300, 0x41));
    const first = rotateIfLarge(dir, 100);
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), Buffer.alloc(300, 0x42));
    const second = rotateIfLarge(dir, 100);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    assert.notStrictEqual(first[0], second[0]);
    assert.strictEqual(fs.readFileSync(path.join(dir, first[0]), 'utf8')[0], 'A');
    assert.strictEqual(fs.readFileSync(path.join(dir, second[0]), 'utf8')[0], 'B');
  });

  t('read() after a rotation still folds every run, whether or not the reader had seen the file before', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    fs.writeFileSync(file, complete('r1'));
    fs.appendFileSync(file, Buffer.alloc(200, 0x20));
    fs.appendFileSync(file, '\n');
    const seen = createLogReader(dir, never, hour);
    assert.strictEqual(seen.read().length, 1);
    const unseen = createLogReader(dir, never, hour);
    assert.deepStrictEqual(rotateIfLarge(dir, 100).length, 1);
    // The wrapper's next run lands in a fresh mac.jsonl, and a run may even straddle the rotation: its start is in the old file, its end in the new.
    fs.writeFileSync(file, complete('r2', { startO: { at: iso(T0 + MIN) } }));
    for (const reader of [seen, unseen]) {
      const runs = reader.read();
      assert.deepStrictEqual(runs.map((r) => r.id), ['r2', 'r1']);
      assert.strictEqual(runs[0].state, 'ok');
    }
    fs.appendFileSync(file, line(start('r3', { at: iso(T0 + 2 * MIN) })));
    assert.deepStrictEqual(seen.read().map((r) => r.id), ['r3', 'r2', 'r1']);
  });

  t('a renamed file keeps its offset: bytes rewritten in place under the new name are not read again', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), complete('r1'));
    const reader = createLogReader(dir, never, hour);
    reader.read();
    const rotated = path.join(dir, 'mac.20261001.jsonl');
    fs.renameSync(path.join(dir, 'mac.jsonl'), rotated);
    fs.writeFileSync(rotated, fs.readFileSync(rotated, 'utf8').replace('git-sync-all', 'xxx-xxxx-xxx'));
    assert.strictEqual(reader.read()[0].job, 'git-sync-all');
  });

  t('a run split across a rotation folds into one: start in the old file, step-end and end in the new', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    fs.writeFileSync(file, [start('r1'), stepStart('r1', 0)].map(line).join(''));
    const reader = createLogReader(dir, () => true, hour);
    assert.strictEqual(reader.read()[0].state, 'running');
    assert.strictEqual(rotateIfLarge(dir, 10).length, 1);
    fs.writeFileSync(file, [stepEnd('r1', 0), stepStart('r1', 1), stepEnd('r1', 1), end('r1')].map(line).join(''));
    const runs = reader.read();
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].state, 'ok');
    assert.strictEqual(runs[0].steps.length, 2);
  });

  t('a file truncated in place is re-read from 0 and the runs it dropped are gone', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    fs.writeFileSync(file, complete('r1') + complete('r2', { startO: { at: iso(T0 + MIN) } }));
    const reader = createLogReader(dir, never, hour);
    assert.strictEqual(reader.read().length, 2);
    fs.writeFileSync(file, complete('r3', { startO: { at: iso(T0 + 2 * MIN) } }));
    assert.deepStrictEqual(reader.read().map((r) => r.id), ['r3']);
  });

  t('an end that arrives after the run was read as lost flips it to ok, and a record repeated changes nothing', () => {
    const dir = tmp();
    const file = path.join(dir, 'mac.jsonl');
    fs.writeFileSync(file, [start('r1'), stepStart('r1', 0), stepEnd('r1', 0), stepStart('r1', 1)].map(line).join(''));
    const reader = createLogReader(dir, () => false, hour);
    assert.strictEqual(reader.read()[0].state, 'lost');
    fs.appendFileSync(file, [stepEnd('r1', 1), stepEnd('r1', 1), end('r1')].map(line).join(''));
    const [r] = reader.read();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.why, null);
    assert.strictEqual(r.steps.length, 2);
  });

  t('refused why running is not a run; refused why "file gone" is a refused row with its reason and no steps', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'), [
      { kind: 'refused', job: 'pull-pins', at: iso(T0), trigger: 'schedule', why: 'running', heldBy: 99 },
      { kind: 'refused', job: 'pull-pins', at: iso(T0 + MIN), trigger: 'manual', why: 'file gone' },
      { kind: 'refused', job: 'pull-pins', at: iso(T0 + 2 * MIN), trigger: 'schedule', why: 'invalid: 3: unknown key "foo"' },
    ].map(line).join(''));
    const runs = createLogReader(dir, never, hour).read();
    assert.strictEqual(runs.length, 2);
    assert.deepStrictEqual(runs.map((r) => [r.state, r.why, r.trigger, r.job, r.machine, r.steps.length]), [
      ['refused', 'invalid: 3: unknown key "foo"', 'schedule', 'pull-pins', 'mac', 0],
      ['refused', 'file gone', 'manual', 'pull-pins', 'mac', 0],
    ]);
    assert.notStrictEqual(runs[0].id, runs[1].id);
  });

  t('runs come back newest first; late, manual and stopped carry through; unknown outcome reads failed, not in flight', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mac.jsonl'),
      complete('a') + complete('b', { startO: { at: iso(T0 + MIN), late: true, trigger: 'manual' }, endO: { stopped: true, ok: 1, failed: 1 }, s1: { outcome: 'weird' } }));
    const runs = createLogReader(dir, never, hour).read();
    assert.deepStrictEqual(runs.map((r) => r.id), ['b', 'a']);
    assert.deepStrictEqual([runs[0].late, runs[0].trigger, runs[0].stopped, runs[0].steps[1].outcome], [true, 'manual', true, 'failed']);
  });

  t('a missing runs folder reads as no runs; watch on it arms nothing and its closer is safe', () => {
    const reader = createLogReader(path.join(tmp(), 'nope'), never, hour);
    assert.deepStrictEqual(reader.read(), []);
    const close = reader.watch(() => assert.fail('no folder, no event'));
    close();
    close();
  });

  // --- computeStats ----------------------------------------------------------------------------------------------------------------------------------

  const NOW = new Date(2026, 9, 19, 12, 0, 0);
  const at = (daysAgo: number, hh = 10): string => new Date(2026, 9, 19 - daysAgo, hh, 0, 0).toISOString();
  const step = (o: Partial<ScheduleStep> = {}): ScheduleStep => ({
    index: 0, repo: null, cwd: null, startedAt: '', endedAt: null, outcome: 'ok', ms: 1, exit: 0, why: null, tail: null, costUsd: null, tokensIn: null,
    tokensOut: null, turns: null, model: null, sessionId: null, ...o,
  });
  const mk = (id: string, daysAgo: number, state: ScheduleRun['state'], o: Partial<ScheduleRun> = {}): ScheduleRun => ({
    id, job: 'git-sync-all', machine: 'mac', trigger: 'schedule', startedAt: at(daysAgo), endedAt: null, ms: 1000, late: false, state, ok: 0, failed: 0, skipped: 0, total: 1,
    stopped: false, error: null, why: null, steps: [step({ costUsd: 0.25, tokensIn: 100, tokensOut: 10 })], ...o,
  });

  // 61 runs: days 0..29 ago one each (day 0 has two), days 30..59 ago one each. In the window: 31 runs = 24 ok, 5 failed, 1 lost, 1 running; 30 in prev.
  const fixture: ScheduleRun[] = [];
  for (let d = 0; d < 30; d++) fixture.push(mk(`w${d}`, d, d % 6 === 5 ? 'failed' : 'ok', { failed: d % 6 === 5 ? 1 : 0 }));
  fixture.push(mk('extra-today', 0, 'ok', { startedAt: at(0, 11) }));
  fixture[3] = mk('w3', 3, 'lost', { ms: null, steps: [step({ outcome: null })] });
  fixture[4] = mk('w4', 4, 'running', { ms: null, steps: [step({ outcome: null })] });
  for (let d = 30; d < 60; d++) fixture.push(mk(`p${d}`, d, 'ok', { steps: [step({ costUsd: 1 })] }));
  fixture.push(mk('too-old', 60, 'ok'));
  fixture.push(mk('refused-x', 1, 'refused', { steps: [], ms: null }));

  t('computeStats over 61 runs: window totals, byDay has 30 entries oldest first, prev covers days 31-60', () => {
    assert.strictEqual(fixture.filter((r) => r.state !== 'refused' && r.id !== 'too-old').length, 61);
    const s = computeStats(fixture, 30, NOW);
    // failed at d = 5, 11, 17, 23, 29; d3 lost, d4 running; so ok = 31 - 5 - 1 - 1 = 24.
    assert.deepStrictEqual([s.runs, s.ok, s.failed, s.lost], [31, 24, 5, 1]);
    // 29 runs carry a 0.25 / 100 / 10 step and 1 s; the lost and running ones have no numbers yet.
    assert.strictEqual(s.costUsd, 0.25 * 29);
    assert.strictEqual(s.tokensIn, 100 * 29);
    assert.strictEqual(s.tokensOut, 10 * 29);
    assert.strictEqual(s.wallMs, 1000 * 29);
    assert.strictEqual(s.byDay.length, 30);
    assert.strictEqual(s.byDay[29].day, '2026-10-19');
    assert.strictEqual(s.byDay[0].day, '2026-09-20');
    assert.deepStrictEqual(s.byDay[29], { day: '2026-10-19', ok: 2, failed: 0 });
    assert.deepStrictEqual(s.byDay[24], { day: '2026-10-14', ok: 0, failed: 1 }, 'day 5 ago failed');
    assert.deepStrictEqual(s.byDay[26], { day: '2026-10-16', ok: 0, failed: 1 }, 'a lost run counts as failed in the bar');
    assert.deepStrictEqual(s.byDay[25], { day: '2026-10-15', ok: 0, failed: 0 }, 'a running run is in neither bar');
    assert.deepStrictEqual(s.prev, { costUsd: 30, runs: 30 });
  });

  t('computeStats: the 7-day window is the last 7 local days and its prev the 7 before, both ends inclusive of whole days', () => {
    const s = computeStats(fixture, 7, NOW);
    assert.strictEqual(s.byDay.length, 7);
    assert.strictEqual(s.byDay[0].day, '2026-10-13');
    // days 0..6 ago: 8 runs (day 0 twice); prev = days 7..13 ago: 7 runs, none refused.
    assert.strictEqual(s.runs, 8);
    assert.strictEqual(s.prev.runs, 7);
    assert.strictEqual(computeStats(fixture, 90, NOW).byDay.length, 90);
  });

  t('computeStats: a run just after local midnight and one just before belong to different days; refusals are never counted', () => {
    const runs = [mk('a', 0, 'ok', { startedAt: new Date(2026, 9, 19, 0, 0, 1).toISOString() }), mk('b', 1, 'ok', { startedAt: new Date(2026, 9, 18, 23, 59, 59).toISOString() }),
      mk('c', 0, 'refused')];
    const s = computeStats(runs, 7, NOW);
    assert.strictEqual(s.runs, 2);
    assert.deepStrictEqual([s.byDay[5], s.byDay[6]].map((d) => [d.day, d.ok]), [['2026-10-18', 1], ['2026-10-19', 1]]);
  });

  // --- pushableEvents --------------------------------------------------------------------------------------------------------------------------------

  t('pushableEvents: a failed run is "<job> · 2 of 12 failed" with the first failed step\'s why', () => {
    const run = mk('r', 0, 'failed', {
      failed: 2, total: 12,
      steps: [step({ index: 0 }), step({ index: 1, outcome: 'skipped', why: 'pin unlisted' }), step({ index: 2, outcome: 'failed', why: 'exit 1' }), step({ index: 3, outcome: 'timeout', why: 'timeout' })],
    });
    assert.deepStrictEqual(pushableEvents([run]).map(({ title, body }) => ({ title, body })), [{ title: 'git-sync-all · 2 of 12 failed', body: 'exit 1' }]);
  });

  t('pushableEvents: a lost run is "<job> · lost" with the local start time and no end record', () => {
    const run = mk('r', 0, 'lost', { startedAt: new Date(2026, 9, 19, 22, 0, 0).toISOString(), ms: null });
    const [e] = pushableEvents([run]);
    assert.strictEqual(e.title, 'git-sync-all · lost');
    assert.strictEqual(e.body, 'started 22:00, no end record · machine slept?');
    assert.strictEqual(e.run, run);
  });

  t('pushableEvents: end.error is "<job> · failed before start", a refusal is "<job> · not run" with its why; ok and running runs never push', () => {
    const events = pushableEvents([
      mk('a', 0, 'failed', { job: 'pull-pins', error: 'ambiguous pin web', steps: [], total: 0 }),
      mk('b', 0, 'refused', { job: 'pull-pins', why: 'disabled', steps: [] }),
      mk('c', 0, 'ok'),
      mk('d', 0, 'running'),
    ]);
    assert.deepStrictEqual(events.map(({ title, body }) => [title, body]), [['pull-pins · failed before start', 'ambiguous pin web'], ['pull-pins · not run', 'disabled']]);
  });

  console.log(`\nschedule-log: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
