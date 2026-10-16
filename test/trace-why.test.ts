import assert from 'node:assert';

import type { TraceStep, TraceWhy } from '../shared/types.js';
import { TraceBuilder } from '../server/lib/trace.js';
import { inferWhy, isCheck, TEST_RE } from '../server/lib/trace-why.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Item = { rec: any; scope: string };

const CWD = '/r';
let seq = 0;

function prompt(uuid: string, text: string, ts: string): Item {
  return { rec: { type: 'user', uuid, timestamp: ts, cwd: CWD, message: { role: 'user', content: text } }, scope: 'main' };
}

function use(id: string, name: string, input: Record<string, unknown>, ts: string, scope = 'main'): Item {
  const rec: Record<string, unknown> = {
    type: 'assistant', uuid: 'u' + ++seq, cwd: CWD, timestamp: ts,
    message: { id: 'm' + id, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  };
  if (scope !== 'main') rec.isSidechain = true;
  return { rec, scope };
}

function result(id: string, content: unknown, isError = false, scope = 'main'): Item {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content };
  if (isError) block.is_error = true;
  return { rec: { type: 'user', uuid: 'u' + ++seq, cwd: CWD, message: { role: 'user', content: [block] } }, scope };
}

const T = (n: number): string => `2026-10-16T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;

/** Fold items one `ingest` per item, timestamps rising, so every result lands before the next call. */
function build(...items: Item[]): TraceBuilder {
  const b = new TraceBuilder(null);
  for (const it of items) b.ingest([it]);
  return b;
}

function why(b: TraceBuilder, id: string): TraceWhy[] {
  const s: TraceStep | undefined = b.steps().find((x) => x.id === id);
  assert.ok(s, `no step ${id}`);
  return s.why;
}

const edit = (id: string, file: string, n: number, scope = 'main'): Item => use(id, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' }, T(n), scope);
const bash = (id: string, command: string, n: number, scope = 'main'): Item => use(id, 'Bash', { command }, T(n), scope);

export function run(): number {
  console.log('\n=== trace-why.ts ===\n');
  let p = 0, f = 0;

  if (test('1. asked: a Read with no other cause points at the turn prompt', () => {
    const b = build(prompt('p1', 'Look at it', T(1)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(2)));
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'p1', rel: 'asked' }]);
    assert.deepStrictEqual(why(b, 'p1'), []);
  })) p++; else f++;

  if (test('2. asked adds nothing before the first prompt (turn 0)', () => {
    const b = build(use('r1', 'Read', { file_path: '/r/a.ts' }, T(1)));
    assert.deepStrictEqual(why(b, 'r1'), []);
  })) p++; else f++;

  if (test('3. informed (a): a Read of the file informs the Edit of it', () => {
    const b = build(use('r1', 'Read', { file_path: '/r/a.ts' }, T(1)), result('r1', '1\tx'), edit('e1', '/r/a.ts', 2));
    assert.ok(why(b, 'e1').some((w) => w.id === 'r1' && w.rel === 'informed'));
  })) p++; else f++;

  if (test('4. informed (a) is the nearest Read of that file, not an older one, and another file does not count', () => {
    const b = build(
      use('r0', 'Read', { file_path: '/r/a.ts' }, T(1)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(2)),
      use('r2', 'Read', { file_path: '/r/z.ts' }, T(3)), edit('e1', '/r/a.ts', 4)
    );
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'r1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('5. informed (b): a Grep whose result names the file informs the Read of it', () => {
    const b = build(use('g1', 'Grep', { pattern: 'x' }, T(1)), result('g1', '/r/b.ts:3: x'), use('r1', 'Read', { file_path: '/r/b.ts' }, T(2)));
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'g1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('6. informed (b) matches the cwd-relative path, and a still-running step does not inform', () => {
    const b = build(
      use('g1', 'Grep', { pattern: 'x' }, T(1)), result('g1', 'client/src/c.ts:1: y'),
      use('g2', 'Grep', { pattern: 'y' }, T(2)),
      use('r1', 'Read', { file_path: '/r/client/src/c.ts' }, T(3))
    );
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'g1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('7. informed (b): a main step is informed by a finished agent step whose result names the file', () => {
    const b = build(
      use('a1', 'Agent', { description: 'look', subagent_type: 'Explore' }, T(1)), result('a1', 'The bug is in /r/d.ts line 4'),
      edit('e1', '/r/d.ts', 2)
    );
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'a1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('8. retry: the step after an errored one in the same scope links it first', () => {
    const b = build(prompt('p1', 'go', T(1)), bash('b1', 'pnpm build', 2), result('b1', 'boom', true), edit('e1', '/r/a.ts', 3));
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'b1', rel: 'retry' }]);
  })) p++; else f++;

  if (test('9. retry ignores prompts and other scopes', () => {
    const b = build(
      use('a1', 'Agent', { description: 'd' }, T(1)),
      bash('b1', 'false', 2, 'a1'), result('b1', 'no', true, 'a1'),
      prompt('p1', 'again', T(3)),
      bash('b2', 'ls', 4)
    );
    assert.ok(!why(b, 'b2').some((w) => w.rel === 'retry'));
    // The main step before the prompt was the Agent step, which has not errored.
    const c = build(bash('b1', 'false', 1), result('b1', 'no', true), prompt('p1', 'again', T(2)), bash('b2', 'ls', 3));
    assert.deepStrictEqual(why(c, 'b2'), [{ id: 'b1', rel: 'retry' }]);
  })) p++; else f++;

  if (test('10. verifies: a test run links the edits since the previous test run, newest first', () => {
    const b = build(edit('e1', '/r/a.ts', 1), edit('e2', '/r/b.ts', 2), bash('t1', 'pnpm test', 3), edit('e3', '/r/c.ts', 4), bash('t2', 'pnpm test', 5));
    assert.deepStrictEqual(why(b, 't1'), [{ id: 'e2', rel: 'verifies' }, { id: 'e1', rel: 'verifies' }]);
    assert.deepStrictEqual(why(b, 't2'), [{ id: 'e3', rel: 'verifies' }]);
  })) p++; else f++;

  if (test('11. verifies stays inside its scope and caps at the newest 8', () => {
    const items: Item[] = [use('a1', 'Agent', { description: 'd' }, T(1)), edit('s1', '/r/sub.ts', 2, 'a1')];
    for (let i = 0; i < 10; i++) items.push(edit('e' + i, `/r/f${i}.ts`, 3 + i));
    items.push(bash('t1', 'pnpm typecheck', 20));
    const b = build(...items);
    const w = why(b, 't1');
    assert.deepStrictEqual(w.map((x) => x.id), ['e9', 'e8', 'e7', 'e6', 'e5', 'e4', 'e3', 'e2']);
    assert.ok(w.every((x) => x.rel === 'verifies'));
  })) p++; else f++;

  if (test('12. TEST_RE matches test runners and not unrelated words', () => {
    for (const c of ['pnpm test', 'npx tsc --noEmit', 'cargo check', 'go vet ./...', 'pytest -x', 'pnpm lint']) assert.ok(TEST_RE.test(c), c);
    for (const c of ['ls -la', 'git status', 'cat latest.txt', 'cargo build']) assert.ok(!TEST_RE.test(c), c);
  })) p++; else f++;

  if (test('13. commits: a commit links the edits since the previous commit, newest first', () => {
    const b = build(
      edit('e1', '/r/a.ts', 1), bash('c1', 'git commit -m a', 2),
      edit('e2', '/r/b.ts', 3), edit('e3', '/r/c.ts', 4), bash('c2', 'git commit -m b', 5)
    );
    assert.deepStrictEqual(why(b, 'c1'), [{ id: 'e1', rel: 'commits' }]);
    assert.deepStrictEqual(why(b, 'c2'), [{ id: 'e3', rel: 'commits' }, { id: 'e2', rel: 'commits' }]);
  })) p++; else f++;

  if (test('14. commits spans scopes and caps at the newest 12', () => {
    const items: Item[] = [use('a1', 'Agent', { description: 'd' }, T(1)), edit('s1', '/r/sub.ts', 2, 'a1')];
    for (let i = 0; i < 12; i++) items.push(edit('e' + i, `/r/f${i}.ts`, 3 + i));
    items.push(bash('c1', 'git commit -m x', 30));
    const w = why(build(...items), 'c1');
    assert.strictEqual(w.length, 12);
    assert.strictEqual(w[0].id, 'e11');
    assert.ok(!w.some((x) => x.id === 's1'));
    const spans = build(use('a1', 'Agent', { description: 'd' }, T(1)), edit('s1', '/r/sub.ts', 2, 'a1'), bash('c1', 'git commit -m x', 3));
    assert.deepStrictEqual(why(spans, 'c1'), [{ id: 's1', rel: 'commits' }]);
  })) p++; else f++;

  if (test('15. plan: an approved plan that names the file links the Edit', () => {
    const b = build(
      use('x1', 'ExitPlanMode', { plan: 'Touch client/src/x.tsx' }, T(1)), result('x1', 'approved'),
      edit('e1', '/r/client/src/x.tsx', 2), edit('e2', '/r/client/src/other.tsx', 3)
    );
    assert.ok(why(b, 'e1').some((w) => w.id === 'x1' && w.rel === 'plan'));
    assert.ok(!why(b, 'e2').some((w) => w.rel === 'plan'));
  })) p++; else f++;

  if (test('16. plan: a bare basename with a dot matches; a rejected plan and a dotless basename do not', () => {
    const b = build(use('x1', 'ExitPlanMode', { plan: 'Change x.tsx and Makefile' }, T(1)), result('x1', 'ok'), edit('e1', '/r/deep/x.tsx', 2), edit('e2', '/r/sub/Makefile', 3));
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'x1', rel: 'plan' }]);
    assert.ok(!why(b, 'e2').some((w) => w.rel === 'plan'));
    const c = build(use('x1', 'ExitPlanMode', { plan: 'Touch x.tsx' }, T(1)), result('x1', 'no', true), edit('e1', '/r/x.tsx', 2));
    assert.ok(!why(c, 'e1').some((w) => w.rel === 'plan'));
  })) p++; else f++;

  if (test('17. answer: later steps of the turn link the answered question, with no asked', () => {
    const b = build(
      prompt('p1', 'plan it', T(1)),
      use('q1', 'AskUserQuestion', { questions: [] }, T(2)), result('q1', '"Which?"="A"'),
      use('r1', 'Read', { file_path: '/r/a.ts' }, T(3)),
      prompt('p2', 'next', T(4)),
      use('r2', 'Read', { file_path: '/r/b.ts' }, T(5))
    );
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'q1', rel: 'answer' }]);
    assert.deepStrictEqual(why(b, 'r2'), [{ id: 'p2', rel: 'asked' }]);
  })) p++; else f++;

  if (test('18. answer needs an ok result and the main scope', () => {
    const b = build(
      prompt('p1', 'go', T(1)),
      use('q1', 'AskUserQuestion', { questions: [] }, T(2)), result('q1', 'declined', true),
      use('r1', 'Read', { file_path: '/r/a.ts' }, T(3))
    );
    assert.ok(!why(b, 'r1').some((w) => w.rel === 'answer'));
  })) p++; else f++;

  if (test('19. delegated: a subagent call with no other cause links its Task step', () => {
    const b = build(prompt('p1', 'go', T(1)), use('a1', 'Agent', { description: 'dig' }, T(2)), bash('b1', 'ls', 3, 'a1'));
    assert.deepStrictEqual(why(b, 'b1'), [{ id: 'a1', rel: 'delegated' }]);
    // asked belongs to the main scope only.
    assert.deepStrictEqual(why(b, 'a1'), [{ id: 'p1', rel: 'asked' }]);
  })) p++; else f++;

  if (test('20. delegated is dropped when another rule fired', () => {
    const b = build(use('a1', 'Agent', { description: 'dig' }, T(1)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(2), 'a1'), edit('e1', '/r/a.ts', 3, 'a1'));
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'r1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('21. dedup: a step reached by two rules appears once, under the first', () => {
    const b = build(use('r1', 'Read', { file_path: '/r/a.ts' }, T(1)), result('r1', 'see /r/a.ts here'), edit('e1', '/r/a.ts', 2));
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'r1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('22. order: retry comes before informed and the retry id is not repeated', () => {
    const b = build(
      use('r1', 'Read', { file_path: '/r/a.ts' }, T(1)), result('r1', 'x'),
      bash('b1', 'pnpm test', 2), result('b1', 'fail', true),
      edit('e1', '/r/a.ts', 3)
    );
    assert.deepStrictEqual(why(b, 'e1'), [{ id: 'b1', rel: 'retry' }, { id: 'r1', rel: 'informed' }]);
  })) p++; else f++;

  if (test('23. a test run that errored and follows its edits: retry then verifies', () => {
    const b = build(edit('e1', '/r/a.ts', 1), bash('t1', 'pnpm test', 2), result('t1', 'x', true), edit('e2', '/r/a.ts', 3), bash('t2', 'pnpm test', 4));
    assert.deepStrictEqual(why(b, 't2'), [{ id: 'e2', rel: 'verifies' }]);
    assert.deepStrictEqual(why(b, 'e2'), [{ id: 't1', rel: 'retry' }]);
  })) p++; else f++;

  if (test('24. inferWhy reads results as they stand: a later resolve does not rewrite an earlier why', () => {
    const b = build(use('b1', 'Bash', { command: 'ls' }, T(1)), edit('e1', '/r/a.ts', 2), result('b1', 'x', true));
    assert.deepStrictEqual(why(b, 'e1'), []);
    assert.strictEqual(typeof inferWhy, 'function');
  })) p++; else f++;

  if (test('25. a sed over foo.test.ts is not a check: no verifies, and it does not reset the window', () => {
    const b = build(edit('e1', '/r/a.ts', 1), bash('s1', 'sed -n 1,5p foo.test.ts', 2), edit('e2', '/r/b.ts', 3), bash('t1', 'pnpm test', 4));
    assert.ok(!why(b, 's1').some((w) => w.rel === 'verifies'));
    assert.deepStrictEqual(why(b, 't1'), [{ id: 'e2', rel: 'verifies' }, { id: 'e1', rel: 'verifies' }]);
  })) p++; else f++;

  if (test('26. a commit with "tests" in its message gets only commits edges and does not reset the verifies window', () => {
    const b = build(edit('e1', '/r/a.ts', 1), bash('c1', 'git commit -m "add tests"', 2), edit('e2', '/r/b.ts', 3), bash('t1', 'pnpm test', 4));
    assert.deepStrictEqual(why(b, 'c1'), [{ id: 'e1', rel: 'commits' }]);
    assert.deepStrictEqual(why(b, 't1'), [{ id: 'e2', rel: 'verifies' }, { id: 'e1', rel: 'verifies' }]);
  })) p++; else f++;

  if (test('27. git add test/x.ts is not a check; node --test test/a.test.ts is', () => {
    const b = build(edit('e1', '/r/a.ts', 1), bash('a1', 'git add test/x.ts', 2), bash('n1', 'node --test test/a.test.ts', 3));
    assert.ok(!why(b, 'a1').some((w) => w.rel === 'verifies'));
    assert.deepStrictEqual(why(b, 'n1'), [{ id: 'e1', rel: 'verifies' }]);
  })) p++; else f++;

  if (test('28. isCheck: runners count, paths, quoted text and commits do not', () => {
    for (const c of ['pnpm test', 'pnpm test:visual', 'npx tsc --noEmit', 'cd /r && pnpm lint', 'node --test test/a.test.ts', 'go test ./...']) assert.ok(isCheck(c), c);
    for (const c of ['sed -n 1,5p foo.test.ts', 'git add test/x.ts', 'git commit -m "add tests"', "grep 'test' a.ts", 'cat test/run-all.ts', 'ls']) assert.ok(!isCheck(c), c);
  })) p++; else f++;

  if (test('29. answer: EnterPlanMode resolving ok is not the user\'s verdict', () => {
    const b = build(
      prompt('p1', 'go', T(1)),
      use('n1', 'EnterPlanMode', {}, T(2)), result('n1', 'entered'),
      use('r1', 'Read', { file_path: '/r/a.ts' }, T(3))
    );
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'p1', rel: 'asked' }]);
  })) p++; else f++;

  if (test('30. answer: a decision from an earlier turn is not scanned past, and a subagent step before it does not stop the scan', () => {
    const b = build(
      prompt('p1', 'one', T(1)), use('q1', 'AskUserQuestion', { questions: [] }, T(2)), result('q1', '"A"="B"'),
      prompt('p2', 'two', T(3)), use('a1', 'Agent', { description: 'd' }, T(4)), bash('b1', 'ls', 5, 'a1'),
      use('r1', 'Read', { file_path: '/r/a.ts' }, T(6))
    );
    assert.deepStrictEqual(why(b, 'r1'), [{ id: 'p2', rel: 'asked' }]);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
