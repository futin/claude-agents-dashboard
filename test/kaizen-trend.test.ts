import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `kaizen.mjs --trend` is kaizen-only (the dashboard never reads it), so the vendored script is the thing under test — spawned, as the
// analyze.test.ts parity cases spawn it.
const KAIZEN = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../.claude/skills/kaizen/kaizen.mjs');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function trend(lines: string[]): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-kaizen-trend-'));
  const log = path.join(dir, 'session-analytics-log.md');
  fs.writeFileSync(log, lines.join('\n'));
  const r = spawnSync(process.execPath, [KAIZEN, '--trend', log], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** One grammar-conforming lesson line; `ctx` is written verbatim so a test can pick the suffix. */
function lesson(i: number, project: string, ctx: string, billable = '300k'): string {
  const day = String(1 + i).padStart(2, '0');
  return `- 2026-08-${day} [${project}] ${project.slice(0, 2)}${String(i).padStart(6, '0')}: ${billable} billable (${ctx} ctx, 90 turns), top cost Bash. Lesson: x.`;
}

const group = (t: any, name: string) => t.projects.find((g: any) => g.name === name);

export function run(): number {
  console.log('\n=== kaizen.mjs --trend ===\n');
  let n = 0, ok = 0;
  const t = (name: string, fn: () => void) => { n++; if (test(name, fn)) ok++; };

  t('ten steadily climbing sessions: drift reported', () => {
    const r = trend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m, i) => lesson(i, 'proj-a', `${m}M`)));
    const g = group(r, 'proj-a');
    assert.strictEqual(g.sessions, 10);
    assert.strictEqual(g.baselineMedian, 4_000_000);
    assert.strictEqual(g.recentMedian, 9_000_000);
    assert.strictEqual(g.ratio, 2.25);
    assert.strictEqual(g.drift, true);
    assert.deepStrictEqual(r.drifting, ['proj-a']);
  });

  t('ten flat sessions and one spike: NOT drift, wherever the spike lands', () => {
    for (const at of [10, 9, 4]) {
      const ctx = Array.from({ length: 11 }, (_, i) => (i === at ? '90M' : '10M'));
      const g = group(trend(ctx.map((c, i) => lesson(i, 'proj-a', c))), 'proj-a');
      assert.strictEqual(g.sessions, 11);
      assert.strictEqual(g.recentMedian, 10_000_000, `spike at ${at}`);
      assert.strictEqual(g.drift, false, `spike at ${at}`);
    }
  });

  t('five climbing sessions: too short to judge, not drift (needs 6)', () => {
    const g = group(trend([1, 2, 3, 4, 5].map((m, i) => lesson(i, 'proj-a', `${m}M`))), 'proj-a');
    assert.strictEqual(g.sessions, 5);
    assert.strictEqual(g.recentMedian, null);
    assert.strictEqual(g.drift, false);
  });

  t('mixed projects: grouped per project, a climb in one does not flag the other', () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(lesson(2 * i, 'climb', `${(i + 1) * 10}M`));
      lines.push(lesson(2 * i + 1, 'flat', '20M'));
    }
    const r = trend(lines);
    assert.deepStrictEqual(r.projects.map((g: any) => [g.name, g.sessions]).sort(), [['climb', 8], ['flat', 8]]);
    assert.deepStrictEqual(group(r, 'flat').series, Array(8).fill(20_000_000));
    assert.strictEqual(group(r, 'flat').drift, false);
    assert.strictEqual(group(r, 'climb').drift, true);
    assert.deepStrictEqual(r.drifting, ['climb']);
    assert.strictEqual(r.overall.sessions, 16);
  });

  t('prose, status and review lines are skipped silently and not counted', () => {
    const r = trend([
      '# Session analytics log',
      'Format: `- <date> [<project>] <session-id>: <billable> billable (<ctx>), top cost <x>. Lesson: <takeaway>.`',
      lesson(0, 'proj-a', '5M'),
      '- 2026-08-09 [proj-a] pr000000: status actioned — added to project CLAUDE.md',
      '- 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2',
      '- 2026-08-10 [proj-a] bbbb2222: mid-session observation. Lesson: check first.',
      'free prose mentioning 300k billable (2M ctx) without the line shape'
    ]);
    assert.strictEqual(r.sessions, 1);
    assert.strictEqual(r.withoutCtx, 0);
    assert.deepStrictEqual(r.overall.series, [5_000_000]);
  });

  t('a billable line with no (N ctx) figure is skipped without discarding the sweep', () => {
    const r = trend([
      lesson(0, 'proj-a', '5M'),
      '- 2026-08-02 [proj-a] cccc3333: 400k billable, 0 subagents, top cost Read. Lesson: y.',
      lesson(2, 'proj-a', '7M')
    ]);
    assert.strictEqual(r.withoutCtx, 1);
    assert.strictEqual(r.sessions, 2);
    assert.deepStrictEqual(r.overall.series, [5_000_000, 7_000_000]);
  });

  t('empty log, one-line log and a missing log: no crash, nothing reported', () => {
    for (const lines of [[], [lesson(0, 'proj-a', '5M')]]) {
      const r = trend(lines);
      assert.strictEqual(r.overall.drift, false);
      assert.strictEqual(r.overall.ratio, null);
      assert.deepStrictEqual(r.drifting, []);
    }
    const missing = spawnSync(process.execPath, [KAIZEN, '--trend', path.join(os.tmpdir(), 'cad-no-such-log.md')], { encoding: 'utf8' });
    assert.strictEqual(missing.status, 0, missing.stderr);
    assert.strictEqual(JSON.parse(missing.stdout).sessions, 0);
  });

  t('figures parse with k and M suffixes, decimals and thousands commas', () => {
    const r = trend([
      '- 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: z.',
      lesson(1, 'proj-b', '950k', '1.06M'),
      lesson(2, 'proj-b', '2,614M', '12,000')
    ]);
    const pts = [r.overall.series, r.projects.map((g: any) => g.name).sort()];
    assert.deepStrictEqual(pts, [[1_400_000, 950_000, 2_614_000_000], ['dashboard', 'proj-b']]);
  });

  t('a later line for the same session replaces the earlier one instead of counting twice', () => {
    const r = trend([
      '- 2026-08-01 [proj-a] aaaa1111: 100k billable (1M ctx), top cost Read. Lesson: first.',
      '- 2026-08-02 [proj-a] bbbb2222: 100k billable (2M ctx), top cost Read. Lesson: other.',
      '- 2026-08-03 [proj-a] aaaa1111: 100k billable (3M ctx), top cost Read. Lesson: rerun.'
    ]);
    assert.deepStrictEqual(r.overall.series, [2_000_000, 3_000_000]);
  });

  console.log(`  ${ok}/${n}`);
  return n - ok;
}
