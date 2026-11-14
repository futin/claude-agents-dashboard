/**
 * `test/suites.ts` — the suite list `run-all.ts` runs and `scripts/ci-scope.ts` selects from. A suite is registered by existing, so what is pinned is what
 * counts as one: every `*.test.ts` under `test/`, sorted, never Playwright's `test/visual/`, never a helper or a runner.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSuites } from '../suites.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function run(): number {
  console.log('\n=== suites.ts (discovered test suites) ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('the real tree: ≥ 202 suites, sorted, all *.test.ts, no visual specs, no helpers or runners', () => {
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

  r(test('a fixture tree: only *.test.ts outside test/visual/, repo-relative with / separators', () => {
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

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
