/**
 * `test/suites.ts` — the suite list `run-all.ts` runs and `scripts/ci-scope.ts` selects from. A suite is registered by existing, so what is pinned is what
 * counts as one: every `*.test.ts` under `test/`, sorted, never Playwright's `test/visual/`, never a helper or a runner.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSuites, runSuites } from '../suites.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** `runSuites` over `mods`, with its console lines captured instead of printed. */
async function runQuiet(mods: Record<string, unknown>[]): Promise<{ failed: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    const failed = await runSuites(mods.map((mod, i) => ({ file: `test/s${i}.test.ts`, mod })));
    return { failed, out: lines.join('\n') };
  } finally {
    console.log = log;
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function run(): Promise<number> {
  console.log('\n=== suites.ts (discovered test suites) ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(await test('the real tree: ≥ 202 suites, sorted, all *.test.ts, no visual specs, no helpers or runners', () => {
    const list = listSuites(ROOT);
    assert.ok(list.length >= 202, `only ${list.length} suites`);
    assert.deepStrictEqual(list, [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const file of list) {
      assert.ok(file.endsWith('.test.ts'), file);
      assert.ok(!file.startsWith('test/visual/'), file);
    }
    for (const helper of ['test/run-all.ts', 'test/run-some.ts', 'test/api-harness.ts', 'test/git-fixture.ts', 'test/tmp-root.ts', 'test/suites.ts']) {
      assert.ok(!list.includes(helper), helper);
    }
    assert.ok(list.includes('test/guards/suites.test.ts'), 'this suite finds itself');
  }));

  r(await test('a fixture tree: only *.test.ts outside test/visual/, repo-relative with / separators', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-suites-'));
    try {
      for (const file of ['test/b/y.test.ts', 'test/a/x.test.ts', 'test/c.ts', 'test/visual/z.test.ts']) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), 'export function run() { return 0; }\n');
      }
      assert.deepStrictEqual(listSuites(dir), ['test/a/x.test.ts', 'test/b/y.test.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  r(await test('runSuites sums each run() count, sync and async, in order', async () => {
    const order: number[] = [];
    const got = await runQuiet([
      { run: () => { order.push(0); return 0; } },
      { run: async () => { order.push(1); return 2; } },
      { run: () => { order.push(2); return 1; } }
    ]);
    assert.strictEqual(got.failed, 3);
    assert.deepStrictEqual(order, [0, 1, 2]);
  }));

  r(await test('a run() that returns no count fails once, by name, and never hides a later failure', async () => {
    for (const bad of [undefined, Number.NaN, -1, 1.5, '1', null]) {
      const got = await runQuiet([{ run: async () => bad }, { run: () => 2 }]);
      assert.strictEqual(got.failed, 3, `${String(bad)} → ${got.failed}`);
      assert.match(got.out, /✗ test\/s0\.test\.ts run\(\) returned .*not a failure count/);
    }
  }));

  r(await test('a module with no run export fails once, by name', async () => {
    const got = await runQuiet([{}, { run: 'nope' }, { run: () => 0 }]);
    assert.strictEqual(got.failed, 2);
    assert.match(got.out, /✗ test\/s0\.test\.ts exports no run\(\)/);
    assert.match(got.out, /✗ test\/s1\.test\.ts exports no run\(\)/);
  }));

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
