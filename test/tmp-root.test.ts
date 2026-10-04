/**
 * `test/tmp-root.ts` — the per-run temp root that keeps the suite from leaking `mkdtemp` dirs into `/tmp` (backlog #177).
 *
 * Two things are pinned: that `run-all.ts` really imported it before this module ran (read off the environment, never by importing it here, which would
 * prove nothing), and that a process which imports it leaves no root behind however it ends — normal exit, an uncaught throw, or SIGTERM.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const MODULE = path.join(REPO, 'test', 'tmp-root.ts');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Run a child that imports the module, plants a fixture, reports, then ends the way `ending` says. */
function child(dir: string, ending: string): { root: string; fixture: string; existed: boolean; status: number | null } {
  const script = path.join(dir, `child-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(script, [
    `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';`,
    `import { TEST_TMP_ROOT } from ${JSON.stringify(MODULE)};`,
    `const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe-'));`,
    `fs.writeFileSync(path.join(fixture, 'f'), 'x');`,
    `console.log(JSON.stringify({ root: TEST_TMP_ROOT, fixture, existed: fs.existsSync(fixture) }));`,
    ending,
  ].join('\n'));
  const r = spawnSync(TSX, [script], { encoding: 'utf8' });
  const line = r.stdout.split('\n').find(l => l.startsWith('{'));
  assert.ok(line, `child printed no report; stderr: ${r.stderr}`);
  return { ...JSON.parse(line), status: r.status };
}

export function run(): number {
  console.log('\n=== tmp-root.ts (per-run temp root) ===\n');
  let p = 0, f = 0;

  if (test('run-all.ts imported it first: os.tmpdir() is the run root', () => {
    const root = process.env.CAD_TEST_TMP_ROOT;
    assert.ok(root, 'CAD_TEST_TMP_ROOT unset — run-all.ts no longer imports ./tmp-root.js');
    assert.strictEqual(os.tmpdir(), root);
    assert.match(path.basename(root), /^cad-test-run-/);
  })) p++; else f++;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tmproot-'));
  try {
    for (const [label, ending, code] of [
      ['a normal exit', '', 0],
      ['an uncaught throw', `throw new Error('boom');`, 1],
      ['SIGTERM', `process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);`, 143],
    ] as const) {
      if (test(`a fixture planted under the root is gone after ${label}`, () => {
        const c = child(dir, ending);
        assert.ok(c.existed, 'fixture was never created');
        assert.ok(c.fixture.startsWith(c.root + path.sep), `fixture ${c.fixture} not under root ${c.root}`);
        assert.strictEqual(c.status, code);
        assert.strictEqual(fs.existsSync(c.root), false, `root ${c.root} survived`);
      })) p++; else f++;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
