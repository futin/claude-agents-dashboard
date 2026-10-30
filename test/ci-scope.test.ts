/**
 * `scripts/ci-scope.ts` — the CI check command that runs only what a PR's diff can break.
 *
 * The property that matters is one-sided: a wrong `docs` verdict skips typecheck and build on a change that needs them, while a wrong `full` only costs
 * minutes. So every case that should fall back to full is pinned here, as is the selection of the doc guards a docs-only PR still has to run.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify, makePlan, mentions, nodeSuitePaths, pathTokens, prFiles, readSuites, scopeOf, selectSuites, tsxSuitePaths,
} from '../scripts/ci-scope.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function run(): number {
  console.log('\n=== ci scope ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('classify: docs/** and any other *.md are docs, everything else is full', () => {
    for (const file of ['docs/overview.md', 'docs/guides/x/diagram.svg', 'README.md', '.claude/CLAUDE.md', 'plugin/skills/kaizen/SKILL.md', 'backlog/tasks/1.md']) {
      assert.strictEqual(classify(file), 'docs', file);
    }
    for (const file of ['server/index.ts', 'client/src/App.tsx', 'shared/types.ts', 'package.json', 'pnpm-lock.yaml', 'plugin/lib/cron.mjs', 'docsy.ts']) {
      assert.strictEqual(classify(file), 'full', file);
    }
  }));

  r(test('classify: scripts/, test/ and .github/ are full even when they are markdown', () => {
    for (const file of ['scripts/notes.md', 'test/fixtures/a.md', '.github/pull_request_template.md']) assert.strictEqual(classify(file), 'full', file);
  }));

  r(test('scopeOf: the widest file wins, and no list or an empty one is full', () => {
    assert.strictEqual(scopeOf(['docs/a.md', 'README.md']), 'docs');
    assert.strictEqual(scopeOf(['docs/a.md', 'server/index.ts']), 'full');
    assert.strictEqual(scopeOf([]), 'full');
    assert.strictEqual(scopeOf(null), 'full');
  }));

  r(test('pathTokens: top-level dir, parent and file rooted; basename; parent name', () => {
    assert.deepStrictEqual(pathTokens('docs/workflows/ci.md'), {
      rooted: ['docs', 'docs/workflows', 'docs/workflows/ci.md'], base: 'ci.md', parent: 'workflows',
    });
    assert.deepStrictEqual(pathTokens('docs/overview.md'), { rooted: ['docs', 'docs/overview.md'], base: 'overview.md', parent: 'docs' });
    assert.deepStrictEqual(pathTokens('README.md'), { rooted: ['README.md'], base: 'README.md', parent: null });
  }));

  r(test('mentions: a bounded path piece on a code line counts', () => {
    assert.ok(mentions("const d = path.join(root, 'docs');", ['docs/workflows/ci.md']), 'top-level dir as a join segment');
    assert.ok(mentions("read('docs/workflows/ci.md')", ['docs/workflows/ci.md']), 'the rooted path');
    assert.ok(mentions("new URL('../SKILL.md', import.meta.url)", ['plugin/skills/kaizen/SKILL.md']), 'the basename after a slash');
    assert.ok(mentions("path.join(root, 'workflows', x)", ['docs/workflows/ci.md']), 'the parent name as a join segment');
  }));

  r(test('mentions: comments, unbounded words and a nested dir of the same name do not count', () => {
    assert.ok(!mentions("// reads path.join(root, 'docs')\n * see 'docs/overview.md'", ['docs/overview.md']), 'comment lines are dropped');
    assert.ok(!mentions("const a = 'mydocs'; const b = 'docsy';", ['docs/overview.md']), 'unbounded');
    assert.ok(!mentions("import x from '../server/docs/thing.js';", ['docs/overview.md']), 'server/docs is not the root docs/');
    assert.ok(!mentions("read('overview.mdx')", ['docs/overview.md']), 'a longer basename');
  }));

  r(test('makePlan: full is the three checks the workflow used to list', () => {
    const plan = makePlan(['server/index.ts'], { tsx: [], node: [] });
    assert.strictEqual(plan.scope, 'full');
    assert.deepStrictEqual(plan.steps.map(s => [s.cmd, ...s.args].join(' ')), ['pnpm typecheck', 'pnpm build', 'pnpm test']);
    assert.strictEqual(makePlan(null, { tsx: [], node: [] }).scope, 'full');
  }));

  r(test('makePlan: docs runs only the suites of either runner that name the changed docs, and may run nothing', () => {
    const suites = {
      tsx: [{ file: 'test/a.test.ts', source: "join(root, 'docs')" }, { file: 'test/b.test.ts', source: "join(root, 'server')" }],
      node: [{ file: 'p/t/c.test.mjs', source: "new URL('../SKILL.md')" }],
    };
    const docs = makePlan(['docs/x.md'], suites);
    assert.strictEqual(docs.scope, 'docs');
    assert.deepStrictEqual(docs.steps.map(s => [s.cmd, ...s.args].join(' ')), ['pnpm exec tsx test/run-some.ts test/a.test.ts']);
    const skill = makePlan(['plugin/skills/kaizen/SKILL.md'], suites);
    assert.deepStrictEqual(skill.steps.map(s => [s.cmd, ...s.args].join(' ')), ['node --test p/t/c.test.mjs']);
    assert.deepStrictEqual(makePlan(['backlog/1.md'], suites).steps, []);
  }));

  r(test('prFiles: off a pull_request event it is null without touching git', () => {
    const got = prFiles(() => { throw new Error('git must not run'); }, 'push');
    assert.strictEqual(got.files, null);
    assert.match(got.why, /not a pull request/);
  }));

  r(test('prFiles: diffs the merge commit against its first parent with renames split; any odd shape is null', () => {
    const calls: string[] = [];
    const git = (parents: string[]) => (args: string[]) => {
      calls.push(args.join(' '));
      if (args[0] === 'cat-file') return ['tree t', ...parents.map(p => `parent ${p}`), 'author a'].join('\n');
      if (args[0] === 'diff') return 'docs/a.md\nREADME.md\n';
      return '';
    };
    const ok = prFiles(git(['base', 'head']), 'pull_request');
    assert.deepStrictEqual(ok.files, ['docs/a.md', 'README.md']);
    assert.deepStrictEqual(calls.slice(1), ['fetch --no-tags --depth=1 origin base', 'diff --name-only --no-renames base HEAD']);
    assert.strictEqual(prFiles(git(['only']), 'pull_request').files, null);
    assert.strictEqual(prFiles(() => { throw new Error('fetch failed'); }, 'pull_request').files, null);
  }));

  r(test('the suite lists come from the real tree: run-all.ts imports and the test script glob', () => {
    const tsx = tsxSuitePaths(ROOT);
    assert.ok(tsx.includes('test/docs-links.test.ts'));
    assert.ok(tsx.includes('test/ci-scope.test.ts'));
    assert.ok(!tsx.includes('test/api-harness.ts') && !tsx.includes('test/run-all.ts'), 'helpers and the runner are not suites');
    assert.ok(nodeSuitePaths(ROOT).includes('plugin/skills/kaizen/test/skill.test.mjs'));
  }));

  r(test("this repo's doc guards are selected by the files they read", () => {
    const suites = readSuites(ROOT);
    assert.ok(selectSuites(['docs/subsystems/analytics.md'], suites.tsx).includes('test/docs-links.test.ts'));
    assert.ok(selectSuites(['plugin/skills/kaizen/SKILL.md'], suites.node).includes('plugin/skills/kaizen/test/skill.test.mjs'));
  }));

  r(test('the CLI prints the plan under --dry-run and runs nothing', () => {
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    const out = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/ci-scope.ts', '--dry-run', '--files', 'docs/overview.md'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /^ci-scope: docs-only — files given by hand; running run-some/);
    assert.match(out.stdout, /would run: pnpm exec tsx test\/run-some\.ts .*test\/docs-links\.test\.ts/);
    assert.doesNotMatch(out.stdout, /typecheck\n|ALL PASS/);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
