import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compareTaskIds,
  composePlanTasks,
  parsePlanHeadings,
  planSignals,
  readPlanHeadings,
  resetPlanCache,
  resolvePlanFile,
  stripPlanToken,
} from '../server/lib/plan-progress.js';
import type { PlanSignal } from '../server/lib/plan-progress.js';

function test(name: string, fn: () => void): boolean {
  resetPlanCache();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-plan-progress-'));
let fileSeq = 0;

function planFile(body: string, sub = `d${++fileSeq}`): string {
  const d = path.join(dir, sub);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'plan.md');
  fs.writeFileSync(file, body);
  return file;
}

const bash = (command: string, cwd: string | null = '/r'): PlanSignal[] => planSignals('Bash', { command }, cwd);
const plan = (p: string, base: string | null = '/r'): PlanSignal => ({ kind: 'plan', path: p, base });
const done = (id: string): PlanSignal => ({ kind: 'done', id });
const live = (id: string): PlanSignal => ({ kind: 'live', id });
const LEDGER = '/r/.superpowers/sdd/p/progress.md';
const HEADER = '# SDD ledger — plan: docs/p.md\n';

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };
  console.log('\nplan-progress tests\n');

  t('U1 ledger header via Bash printf (literal \\n and closing quote stripped)', () => {
    assert.deepStrictEqual(bash("printf '# SDD ledger — plan: docs/p.md\\n' >> .superpowers/sdd/p/progress.md"), [plan('docs/p.md')]);
  });

  t('U1b one printf writing the header and more lines: the plan token ends at the first literal \\n', () => {
    assert.deepStrictEqual(bash("printf '# SDD ledger — plan: docs/p.md\\nSpec: docs/s.md\\n' > .superpowers/sdd/p/progress.md"), [plan('docs/p.md')]);
    assert.strictEqual(stripPlanToken("docs/p.md\\nbranch:"), 'docs/p.md');
  });

  t('U2 ledger header via Write content and Edit new_string', () => {
    assert.deepStrictEqual(planSignals('Write', { file_path: LEDGER, content: HEADER }, '/r'), [plan('docs/p.md')]);
    assert.deepStrictEqual(planSignals('Edit', { file_path: LEDGER, old_string: 'x', new_string: HEADER }, '/r'), [plan('docs/p.md')]);
  });

  t('U3 the template literal <plan file path> never resolves', () => {
    assert.deepStrictEqual(bash("echo '# SDD ledger — plan: <plan file path>' >> .superpowers/sdd/x/progress.md"), []);
  });

  t('U4 done from a ledger input; the same text with no progress.md is nothing', () => {
    assert.deepStrictEqual(bash("echo 'Task 2: complete (abc..def)' >> .superpowers/sdd/p/progress.md"), [done('2')]);
    assert.deepStrictEqual(bash("echo 'Task 2: complete'"), []);
  });

  t('U4b variable-built ledger path still qualifies', () => {
    assert.deepStrictEqual(bash("W=.superpowers/sdd/p; printf 'Task 2: complete (x)\\n' >> \"$W/progress.md\""), [done('2')]);
  });

  t('U4c a Write whose content quotes a ledger path and a done line is not a ledger input', () => {
    const content = 'see /r/.superpowers/sdd/x/progress.md\nTask 1: complete\n';
    assert.deepStrictEqual(planSignals('Write', { file_path: '/r/docs/superpowers/specs/s.md', content }, '/r'), []);
  });

  t('U5 task-brief gives the plan and a running task, quoted or not', () => {
    assert.deepStrictEqual(bash('bash scripts/task-brief docs/p.md 3'), [plan('docs/p.md'), live('3')]);
    assert.deepStrictEqual(bash('"$SDD/scripts/task-brief" "docs/p.md" 3'), [plan('docs/p.md'), live('3')]);
  });

  t('U6 Agent description: word-bounded Task <N>', () => {
    const agent = (description: string): PlanSignal[] => planSignals('Agent', { description }, '/r');
    assert.deepStrictEqual(agent('Implement Task 4: wire it'), [live('4')]);
    assert.deepStrictEqual(agent('Review Task 4 (spec + quality)'), [live('4')]);
    assert.deepStrictEqual(agent('Final review'), []);
    assert.deepStrictEqual(agent('Task 40 prep'), [live('40')]);
  });

  t('U7 Skill: only the two executing skills, plan = first .md token of args', () => {
    const skill = (name: string, args: string): PlanSignal[] => planSignals('Skill', { skill: name, args }, '/r');
    assert.deepStrictEqual(skill('superpowers:subagent-driven-development', 'docs/p.md'), [plan('docs/p.md')]);
    assert.deepStrictEqual(skill('superpowers:executing-plans', 'Execute docs/p.md task by task'), [plan('docs/p.md')]);
    assert.deepStrictEqual(skill('superpowers:subagent-driven-development', ''), []);
    assert.deepStrictEqual(skill('superpowers:brainstorming', 'docs/p.md'), []);
  });

  t('U17 an Edit never reads old_string', () => {
    const input = { file_path: LEDGER, old_string: 'Task 3: dispatched', new_string: 'Task 3: complete (x)' };
    assert.deepStrictEqual(planSignals('Edit', input, '/r'), [done('3')]);
    // `dispatched` is no signal, so the brief's own old_string cannot prove the rule; one that would signal if it were read can.
    const stale = { file_path: LEDGER, old_string: '# SDD ledger — plan: docs/old.md\nTask 7: complete', new_string: 'Task 3: complete (x)' };
    assert.deepStrictEqual(planSignals('Edit', stale, '/r'), [done('3')]);
  });

  t('U18 stripPlanToken, and an unresolved variable names no plan but keeps its task id', () => {
    assert.strictEqual(stripPlanToken("docs/p.md\\n'"), 'docs/p.md');
    assert.strictEqual(stripPlanToken('docs/x.md"'), 'docs/x.md');
    assert.strictEqual(stripPlanToken('`docs/y.md`'), 'docs/y.md');
    assert.strictEqual(stripPlanToken('"docs/z.md\\n"'), 'docs/z.md');
    assert.strictEqual(stripPlanToken('$PLAN'), '$PLAN');
    assert.deepStrictEqual(bash('bash scripts/task-brief $PLAN 3'), [live('3')]);
  });

  t('U-rp review-package names the plan and nothing else', () => {
    assert.deepStrictEqual(bash('"$SDD/scripts/review-package" docs/p.md abc1234 def5678'), [plan('docs/p.md')]);
  });

  t('U19 task-start is running, task-done is done', () => {
    assert.deepStrictEqual(bash('task-start docs/p.md 2'), [plan('docs/p.md'), live('2')]);
    assert.deepStrictEqual(bash('"$EP/scripts/task-done" docs/p.md 2 abc1234 -- pnpm test'), [plan('docs/p.md'), done('2')]);
  });

  t('U-var a plan passed as a variable names no plan but its task id still counts', () => {
    assert.deepStrictEqual(bash('"$EP/scripts/task-done" "$P" 4 abc1234 -- pnpm test'), [done('4')]);
    assert.deepStrictEqual(bash('bash scripts/task-brief $P 3'), [live('3')]);
    assert.deepStrictEqual(bash('bash scripts/task-start $P 3'), [live('3')]);
    // A literal plan beside a variable one still signals only the literal plan.
    assert.deepStrictEqual(bash('task-brief docs/p.md 2; task-done "$P" 2'), [plan('docs/p.md'), live('2'), done('2')]);
  });

  t('U-printf several ledger entries in one printf format all count', () => {
    const W = 'W=.superpowers/sdd/p; ';
    assert.deepStrictEqual(bash(W + String.raw`printf 'Task 1: complete\nTask 2: complete\n' >> "$W/progress.md"`), [done('1'), done('2')]);
    assert.deepStrictEqual(bash(W + String.raw`printf 'Task 9: complete\nTask 10: complete\n' >> "$W/progress.md"`), [done('9'), done('10')]);
    // The escape is the only word-character predecessor let through: a bare letter, an identifier tail or a hyphen still blocks the match.
    assert.deepStrictEqual(bash(W + `echo 'xTask 1: complete' >> "$W/progress.md"`), []);
    assert.deepStrictEqual(bash(W + `echo 'nTask 1: complete' >> "$W/progress.md"`), []);
    assert.deepStrictEqual(bash(W + `echo 'sub-Task 1: complete' >> "$W/progress.md"`), []);
    // `Task 40` is task 40 and never task 4.
    assert.deepStrictEqual(bash(W + `echo 'Task 40: complete' >> "$W/progress.md"`), [done('40')]);
    assert.deepStrictEqual(bash(W + String.raw`printf 'Task 40: complete\nTask 4: complete\n' >> "$W/progress.md"`), [done('40'), done('4')]);
    assert.deepStrictEqual(planSignals('Write', { file_path: LEDGER, content: 'Task 1: complete\nxTask 2: complete\n' }, '/r'), [done('1')]);
  });

  t('U15 a leading cd decides the base; relative cd resolves against the record cwd', () => {
    assert.deepStrictEqual(bash('cd /wt/x && bash scripts/task-brief docs/p.md 3', '/elsewhere')[0], plan('docs/p.md', '/wt/x'));
    assert.deepStrictEqual(bash('cd ../wt; task-brief docs/p.md 3', '/r/sub')[0], plan('docs/p.md', '/r/wt'));
    assert.deepStrictEqual(bash('bash scripts/task-brief docs/p.md 3', null)[0], plan('docs/p.md', null));
    assert.deepStrictEqual(planSignals('Skill', { skill: 'x:executing-plans', args: 'docs/p.md' }, '/elsewhere'), [plan('docs/p.md', '/elsewhere')]);
  });

  t('U-order plan, then running, then done', () => {
    const cmd = "W=.superpowers/sdd/p; bash scripts/task-brief docs/p.md 5; echo 'Task 5: complete' >> $W/progress.md";
    assert.deepStrictEqual(bash(cmd), [plan('docs/p.md'), live('5'), done('5')]);
  });

  t('U10 compareTaskIds and rows for ids that have no heading', () => {
    assert.deepStrictEqual(['10', '5b', '2', '5a', '5'].sort(compareTaskIds), ['2', '5', '5a', '5b', '10']);
    const rows = composePlanTasks([], new Set(['10', '5b', '2']), '5a');
    assert.deepStrictEqual(rows.map((r) => r.id), ['2', '5a', '5b', '10']);
    assert.deepStrictEqual(rows.map((r) => r.subject), ['Task 2', 'Task 5a', 'Task 5b', 'Task 10']);
    assert.deepStrictEqual(rows.map((r) => r.status), ['completed', 'in_progress', 'completed', 'completed']);
    assert.ok(rows.every((r) => r.activeForm === null));
  });

  t('U12 heading forms, a non-heading, and a duplicate id', () => {
    const text = ['## Task 1: One', '### Task 5a: Five A', '### Task 7 (conditional): Seven', '### Task 8 — Eight', '## Task 1 findings', '### Task 1: Dup'].join('\n');
    assert.deepStrictEqual(parsePlanHeadings(text), [
      { id: '1', title: 'One' }, { id: '5a', title: 'Five A' }, { id: '7', title: 'Seven' }, { id: '8', title: 'Eight' },
    ]);
  });

  t('U12b headings inside a fenced block are examples, not tasks', () => {
    const text = '### Task 1: One\n```md\n### Task 9: Example\n```\n### Task 2: Two\n';
    assert.deepStrictEqual(parsePlanHeadings(text).map((h) => h.id), ['1', '2']);
  });

  t('U12c CRLF line endings leave no \\r in titles', () => {
    assert.deepStrictEqual(parsePlanHeadings('### Task 1: One\r\n### Task 2: Two\r\n'), [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }]);
  });

  t('U13 unreadable plan paths give null; resolvePlanFile falls back to projectPath', () => {
    assert.strictEqual(readPlanHeadings(path.join(dir, 'nope.md')), null);
    assert.strictEqual(readPlanHeadings(dir), null);
    const locked = planFile('### Task 1: One\n');
    fs.chmodSync(locked, 0);
    if (process.getuid?.() !== 0) assert.strictEqual(readPlanHeadings(locked), null);
    fs.chmodSync(locked, 0o644);

    const project = path.join(dir, 'proj');
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'p.md'), '### Task 1: One\n');
    assert.strictEqual(resolvePlanFile('docs/p.md', '/missing', project), path.join(project, 'docs', 'p.md'));
    assert.strictEqual(resolvePlanFile('docs/p.md', '/missing', path.join(dir, 'also-missing')), null);
    assert.strictEqual(resolvePlanFile('docs/p.md', null, null), null);
    assert.strictEqual(resolvePlanFile(path.join(project, 'docs', 'p.md'), null, null), path.join(project, 'docs', 'p.md'));
  });

  t('U13b base wins over projectPath when both hold the file', () => {
    const a = path.join(dir, 'ba'); const b = path.join(dir, 'bb');
    for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'p.md'), '### Task 1: One\n'); }
    assert.strictEqual(resolvePlanFile('p.md', a, b), path.join(a, 'p.md'));
  });

  t('U11 cached read; an amended plan with a newer mtime is re-parsed', () => {
    const file = planFile('### Task 1: One\n');
    const first = readPlanHeadings(file);
    assert.deepStrictEqual(first, [{ id: '1', title: 'One' }]);
    assert.deepStrictEqual(readPlanHeadings(file), first);
    fs.appendFileSync(file, '### Task 2: Two\n');
    const bump = new Date(Date.now() + 2000);
    fs.utimesSync(file, bump, bump);
    assert.deepStrictEqual(readPlanHeadings(file)?.map((h) => h.id), ['1', '2']);
  });

  t('U14 done wins over live', () => {
    const rows = composePlanTasks([{ id: '1', title: 'A' }, { id: '2', title: 'B' }, { id: '3', title: 'C' }], new Set(['1']), '1');
    assert.deepStrictEqual(rows.map((r) => r.status), ['completed', 'pending', 'pending']);
    assert.deepStrictEqual(rows.map((r) => r.subject), ['A', 'B', 'C']);
  });

  t('never throws on odd inputs', () => {
    assert.deepStrictEqual(planSignals('Bash', { command: 42 }, '/r'), []);
    assert.deepStrictEqual(planSignals('Skill', {}, '/r'), []);
    assert.deepStrictEqual(planSignals('Read', { file_path: LEDGER }, '/r'), []);
  });

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
