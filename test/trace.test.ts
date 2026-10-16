import assert from 'node:assert';

import type { TraceStep } from '../shared/types.js';
import { TraceBuilder } from '../server/lib/trace.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Item = { rec: any; scope: string };

const CWD = '/r';
let uuidSeq = 0;

/** A typed user prompt (a main-file user record with plain text content). */
function prompt(uuid: string, text: string, ts: string): Item {
  return { rec: { type: 'user', uuid, timestamp: ts, cwd: CWD, message: { role: 'user', content: text } }, scope: 'main' };
}

/** One assistant record holding one tool_use block, the way Claude Code writes each content block as its own record. `ts` undefined omits the timestamp. */
function use(id: string, name: string, input: Record<string, unknown>, ts: string | undefined, msgId: string, scope = 'main'): Item {
  const rec: Record<string, unknown> = {
    type: 'assistant', uuid: 'u' + ++uuidSeq, cwd: CWD,
    message: { id: msgId, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  };
  if (ts !== undefined) rec.timestamp = ts;
  if (scope !== 'main') rec.isSidechain = true;
  return { rec, scope };
}

/** A user record answering `id`; `toolUseResult` is the record-level object beside the block (omitted when undefined). */
function result(id: string, content: unknown, isError = false, toolUseResult?: unknown, scope = 'main'): Item {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content };
  if (isError) block.is_error = true;
  const rec: Record<string, unknown> = { type: 'user', uuid: 'u' + ++uuidSeq, cwd: CWD, message: { role: 'user', content: [block] } };
  if (toolUseResult !== undefined) rec.toolUseResult = toolUseResult;
  return { rec, scope };
}

function text(t: string, msgId: string, scope = 'main'): Item {
  return { rec: { type: 'assistant', uuid: 'u' + ++uuidSeq, cwd: CWD, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: t }] } }, scope };
}

/** A thinking block; null is a signature-only block (the text was not recorded). */
function thinking(t: string | null, msgId: string, scope = 'main'): Item {
  const block = { type: 'thinking', thinking: t ?? '', signature: 'sig' + uuidSeq };
  return { rec: { type: 'assistant', uuid: 'u' + ++uuidSeq, cwd: CWD, message: { id: msgId, role: 'assistant', content: [block] } }, scope };
}

const T = (n: number): string => `2026-10-16T10:00:${String(n).padStart(2, '0')}.000Z`;

function build(...items: Item[]): TraceBuilder {
  const b = new TraceBuilder(null);
  b.ingest(items);
  return b;
}

function step(b: TraceBuilder, id: string): TraceStep {
  const s = b.steps().find((x) => x.id === id);
  assert.ok(s, `no step ${id}`);
  return s;
}

export function run(): number {
  console.log('\n=== trace.ts ===\n');
  let p = 0, f = 0;

  if (test('1. prompt + Read use: a prompt step and a running read step, no internal fields', () => {
    const b = build(prompt('p1', 'Look at the toolbar', T(1)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(2), 'm1'));
    const steps = b.steps();
    assert.deepStrictEqual(steps.map((s) => s.id), ['p1', 'r1']);
    const [pr, rd] = steps;
    assert.strictEqual(pr.kind, 'prompt');
    assert.strictEqual(pr.tool, 'Prompt');
    assert.strictEqual(pr.detail, 'Look at the toolbar');
    assert.strictEqual(pr.status, null);
    assert.strictEqual(pr.turn, 1);
    assert.strictEqual(rd.kind, 'read');
    assert.strictEqual(rd.tool, 'Read');
    assert.strictEqual(rd.detail, '/r/a.ts');
    assert.strictEqual(rd.status, 'running');
    assert.strictEqual(rd.result, null);
    assert.strictEqual(rd.turn, 1);
    assert.strictEqual(rd.at, T(2));
    assert.deepStrictEqual(rd.why, []);
    for (const k of ['scope', 'file', 'cwd', 'command', 'planText', 'resultText', 'rev']) assert.ok(!(k in rd), `leaked ${k}`);
    assert.strictEqual(b.rev, 1);
    assert.ok(b.epoch.length > 0);
  })) p++; else f++;

  if (test('2. a Read result with 3 numbered non-empty lines → ok, "3 lines"', () => {
    const b = build(use('r1', 'Read', { file_path: '/r/a.ts' }, T(1), 'm1'), result('r1', '     1\tone\n     2\ttwo\n     3\tthree\n'));
    const s = step(b, 'r1');
    assert.strictEqual(s.status, 'ok');
    assert.strictEqual(s.result, '3 lines');
  })) p++; else f++;

  if (test('3. Bash with a description that errors → intent from description, error line with tags stripped', () => {
    const b = build(
      use('b1', 'Bash', { command: 'pnpm typecheck', description: 'Typecheck' }, T(1), 'm1'),
      result('b1', '<tool_use_error>x.ts(1,1): boom</tool_use_error>', true)
    );
    const s = step(b, 'b1');
    assert.strictEqual(s.kind, 'bash');
    assert.strictEqual(s.intent, 'Typecheck');
    assert.strictEqual(s.intentFrom, 'description');
    assert.strictEqual(s.status, 'error');
    assert.strictEqual(s.result, 'x.ts(1,1): boom');
  })) p++; else f++;

  if (test('4. assistant text sharing the use\'s message id → first-sentence intent from text', () => {
    const b = build(text('Read the doc first. Then edit.', 'm1'), use('r1', 'Read', { file_path: '/r/doc.md' }, T(1), 'm1'));
    const s = step(b, 'r1');
    assert.strictEqual(s.intent, 'Read the doc first');
    assert.strictEqual(s.intentFrom, 'text');
    // Text from another message does not carry over.
    const c = build(text('Done here. Bye.', 'm0'), use('r2', 'Read', { file_path: '/r/doc.md' }, T(1), 'm1'));
    assert.strictEqual(step(c, 'r2').intent, null);
    assert.strictEqual(step(c, 'r2').intentFrom, null);
  })) p++; else f++;

  if (test('5. thinking: readable text, signature only, and the recorded/readable counts', () => {
    const b = build(
      thinking('I should read the config.', 'm1'), use('r1', 'Read', { file_path: '/r/c.json' }, T(1), 'm1'),
      thinking(null, 'm2'), use('r2', 'Read', { file_path: '/r/d.json' }, T(2), 'm2'),
      use('r3', 'Read', { file_path: '/r/e.json' }, T(3), 'm3')
    );
    const a = step(b, 'r1');
    assert.strictEqual(a.thinking, 'text');
    assert.strictEqual(a.thinkingText, 'I should read the config.');
    const s = step(b, 'r2');
    assert.strictEqual(s.thinking, 'signature');
    assert.ok(!('thinkingText' in s));
    assert.strictEqual(step(b, 'r3').thinking, null);
    assert.deepStrictEqual(b.thinking(), { recorded: 2, readable: 1 });
  })) p++; else f++;

  if (test('6. AskUserQuestion resolved → answers joined with " · ", kind decide', () => {
    const b = build(
      use('q1', 'AskUserQuestion', { questions: [{ question: 'Which view?' }, { question: 'Persist?' }] }, T(1), 'm1'),
      result('q1', 'User has answered your questions: "Which view?"="Triage", "Persist?"="The view". You can now continue')
    );
    const s = step(b, 'q1');
    assert.strictEqual(s.kind, 'decide');
    assert.strictEqual(s.answer, 'Triage · The view');
  })) p++; else f++;

  if (test('7. ExitPlanMode ok → approved; error → rejected', () => {
    const b = build(
      use('x1', 'ExitPlanMode', { plan: 'Do it' }, T(1), 'm1'), result('x1', 'User has approved your plan.'),
      use('x2', 'ExitPlanMode', { plan: 'Do it' }, T(2), 'm2'), result('x2', 'The user doesn\'t want to proceed', true)
    );
    assert.strictEqual(step(b, 'x1').answer, 'approved');
    assert.strictEqual(step(b, 'x1').status, 'ok');
    assert.strictEqual(step(b, 'x2').status, 'error');
    assert.strictEqual(step(b, 'x2').answer, 'rejected');
  })) p++; else f++;

  if (test('8. git commit resolved → sha', () => {
    const b = build(use('c1', 'Bash', { command: 'git commit -m x' }, T(1), 'm1'), result('c1', '[main 5d21e08] x\n 3 files changed'));
    const s = step(b, 'c1');
    assert.strictEqual(s.kind, 'bash');
    assert.strictEqual(s.sha, '5d21e08');
    assert.strictEqual(s.result, '[main 5d21e08] x');
  })) p++; else f++;

  if (test('9. Agent use → agent kind and label; a step in its scope takes its id and turn', () => {
    const b = build(
      prompt('p1', 'Map it', T(1)),
      use('ag1', 'Agent', { subagent_type: 'cavecrew-investigator', description: 'map toolbar', prompt: 'Find the toolbar' }, T(2), 'm1'),
      prompt('p2', 'Meanwhile, this', T(3)),
      use('r1', 'Read', { file_path: '/r/t.tsx' }, T(4), 's1', 'ag1')
    );
    const ag = step(b, 'ag1');
    assert.strictEqual(ag.kind, 'agent');
    assert.strictEqual(ag.tool, 'Agent · cavecrew-investigator');
    assert.strictEqual(ag.detail, 'map toolbar');
    assert.ok(!('agent' in ag));
    const rd = step(b, 'r1');
    assert.strictEqual(rd.agent, 'ag1');
    assert.strictEqual(rd.turn, ag.turn);
    assert.strictEqual(rd.turn, 1);
  })) p++; else f++;

  if (test('10. TaskCreate + TaskUpdate in_progress, then an Edit → the Edit carries the task subject', () => {
    const b = build(
      use('tc', 'TaskCreate', { subject: 'Wire the trace' }, T(1), 'm1'),
      result('tc', 'Task #1 created successfully: Wire the trace', false, { task: { id: '1', subject: 'Wire the trace' } }),
      use('tu', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, T(2), 'm2'),
      result('tu', 'Updated task #1 status', false, { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }),
      use('e1', 'Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, T(3), 'm3')
    );
    assert.strictEqual(step(b, 'e1').task, 'Wire the trace');
    assert.strictEqual(step(b, 'e1').kind, 'edit');
    assert.ok(!('task' in step(b, 'tc')));
  })) p++; else f++;

  if (test('11. a second prompt starts turn 2', () => {
    const b = build(
      use('r0', 'Read', { file_path: '/r/a.ts' }, T(1), 'm0'),
      prompt('p1', 'one', T(2)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(3), 'm1'),
      prompt('p2', 'two', T(4)), use('r2', 'Read', { file_path: '/r/a.ts' }, T(5), 'm2')
    );
    assert.deepStrictEqual(b.steps().map((s) => [s.id, s.turn]), [['r0', 0], ['p1', 1], ['r1', 1], ['p2', 2], ['r2', 2]]);
  })) p++; else f++;

  if (test('12. changedSince after an ingest of only a result → exactly the resolved step', () => {
    const b = build(prompt('p1', 'go', T(1)), use('r1', 'Read', { file_path: '/r/a.ts' }, T(2), 'm1'), use('r2', 'Read', { file_path: '/r/b.ts' }, T(3), 'm1'));
    const r = b.rev;
    b.ingest([result('r1', '     1\tx')]);
    assert.strictEqual(b.rev, r + 1);
    const changed = b.changedSince(r);
    assert.deepStrictEqual(changed.map((s) => s.id), ['r1']);
    assert.strictEqual(changed[0].status, 'ok');
    // An ingest that changes nothing leaves rev alone.
    b.ingest([]);
    assert.strictEqual(b.rev, r + 1);
    assert.deepStrictEqual(b.changedSince(r + 1), []);
  })) p++; else f++;

  if (test('13. a use record with no timestamp takes the previous step\'s at; the first takes \'\'', () => {
    const b = build(use('r0', 'Read', { file_path: '/r/a.ts' }, undefined, 'm0'), use('r1', 'Read', { file_path: '/r/a.ts' }, T(7), 'm1'), use('r2', 'Read', { file_path: '/r/b.ts' }, undefined, 'm2'));
    assert.strictEqual(step(b, 'r0').at, '');
    assert.strictEqual(step(b, 'r2').at, T(7));
  })) p++; else f++;

  if (test('14. one record holding thinking, text and two uses → both uses get the intent and thinking, the block counts once', () => {
    const rec = {
      type: 'assistant', timestamp: T(1), cwd: CWD,
      message: {
        id: 'm1', role: 'assistant', content: [
          { type: 'thinking', thinking: 'Both files matter.', signature: 's' },
          { type: 'text', text: 'Check both configs.\nThen decide.' },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.json' } },
          { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/r/b.json' } }
        ]
      }
    };
    const b = build({ rec, scope: 'main' });
    for (const id of ['r1', 'r2']) {
      const s = step(b, id);
      assert.strictEqual(s.intent, 'Check both configs');
      assert.strictEqual(s.intentFrom, 'text');
      assert.strictEqual(s.thinking, 'text');
      assert.strictEqual(s.thinkingText, 'Both files matter.');
    }
    assert.deepStrictEqual(b.thinking(), { recorded: 1, readable: 1 });
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
