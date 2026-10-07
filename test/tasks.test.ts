import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SessionTask } from '../shared/types.js';
import { CHUNK_BYTES, readSessionTasks, resetTaskCache, taskCacheStats } from '../server/lib/tasks.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tasks-'));
let fileSeq = 0;
let useSeq = 0;

/** A fresh transcript holding `body`, with the cache reset so every case starts cold. */
function transcript(body: string): string {
  resetTaskCache();
  const file = path.join(dir, `t${++fileSeq}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';

/** An assistant record holding one tool_use; `cwd` is the record-level shell cwd Claude Code stamps on every record. */
function call(name: string, useId: string, input: Record<string, unknown>, cwd?: string): string {
  const rec: Record<string, unknown> = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] } };
  if (cwd !== undefined) rec.cwd = cwd;
  return line(rec);
}

/** A user record answering `useId`; `toolUseResult` is the record-level object Claude Code writes beside the block (omitted when undefined). */
function result(useId: string, toolUseResult: unknown, content = 'ok', isError = false): string {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: useId, content };
  if (isError) block.is_error = true;
  const rec: Record<string, unknown> = { type: 'user', message: { role: 'user', content: [block] } };
  if (toolUseResult !== undefined) rec.toolUseResult = toolUseResult;
  return line(rec);
}

function createCall(subject: string, activeForm?: string): { useId: string; text: string } {
  const useId = 'toolu_create_' + ++useSeq;
  const input: Record<string, unknown> = { subject, description: subject + ' in detail' };
  if (activeForm !== undefined) input.activeForm = activeForm;
  return { useId, text: call('TaskCreate', useId, input) };
}

/** A confirmed TaskCreate: the call plus its result carrying `task.id`. */
function create(id: string, subject: string, activeForm?: string): string {
  const c = createCall(subject, activeForm);
  return c.text + result(c.useId, { task: { id, subject } }, `Task #${id} created successfully: ${subject}`);
}

/** A TaskUpdate call plus its result; the default result is a success that mirrors `input.status` the way Claude Code writes it. */
function update(input: Record<string, unknown>, toolUseResult?: unknown): string {
  const useId = 'toolu_update_' + ++useSeq;
  const status = input.status;
  const res = toolUseResult ?? {
    success: true,
    taskId: input.taskId,
    updatedFields: Object.keys(input).filter((k) => k !== 'taskId'),
    ...(typeof status === 'string' ? { statusChange: { from: 'pending', to: status } } : {})
  };
  return call('TaskUpdate', useId, input) + result(useId, res, `Updated task #${String(input.taskId)} status`);
}

const plain = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });
const reply = (text: string): string => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

let rootSeq = 0;

/** A fresh project dir with `docs/<name>.md` for each plan, whose value is its task subjects (headings numbered from 1). */
function planRoot(plans: Record<string, string[]>): string {
  const root = path.join(dir, `proj${++rootSeq}`);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const [name, titles] of Object.entries(plans)) {
    fs.writeFileSync(path.join(root, 'docs', `${name}.md`), `# ${name}\n\n` + titles.map((t, i) => `### Task ${i + 1}: ${t}\n\nbody\n`).join('\n'));
  }
  return root;
}

/** A Bash call whose record cwd is `root`. */
const bash = (root: string, command: string): string => call('Bash', 'toolu_b' + ++useSeq, { command }, root);
const agent = (root: string, description: string): string => call('Agent', 'toolu_a' + ++useSeq, { description, prompt: 'p' }, root);
/** The ledger header the skills write, as a printf. */
const header = (root: string, planPath: string): string =>
  bash(root, `W=.superpowers/sdd/p; mkdir -p $W; printf '# SDD ledger — plan: ${planPath}\\n' > "$W/progress.md"`);
/** One ledger line appended the way the controller does. */
const ledger = (root: string, line: string): string => bash(root, `W=.superpowers/sdd/p; printf '${line}\\n' >> "$W/progress.md"`);

/** The task list of a case that has no plan: the plan half of the result must be null, so every pre-plan case also proves the fold adds nothing. */
function rt(file: string): SessionTask[] | null {
  const r = readSessionTasks(file, null);
  assert.strictEqual(r.plan, null);
  return r.tasks;
}

const subjects = (t: SessionTask[] | null): string[] | null => t && t.map((x) => x.subject);
const statuses = (t: SessionTask[] | null): string[] | null => t && t.map((x) => x.status);

export function run(): number {
  console.log('\n=== tasks.ts ===\n');
  let p = 0, f = 0;

  if (test('1. creates then updates: creation order kept, statuses applied', () => {
    const file = transcript(
      create('1', 'A', 'Doing A') + create('2', 'B') + create('3', 'C') +
      update({ taskId: '1', status: 'in_progress' }) + update({ taskId: '1', status: 'completed' })
    );
    const t = rt(file);
    assert.deepStrictEqual(subjects(t), ['A', 'B', 'C']);
    assert.deepStrictEqual(statuses(t), ['completed', 'pending', 'pending']);
    assert.deepStrictEqual(t![0], { id: '1', subject: 'A', status: 'completed', activeForm: 'Doing A' });
  })) p++; else f++;

  if (test('2. a create call with no result line → null', () => {
    assert.strictEqual(rt(transcript(createCall('A').text)), null);
  })) p++; else f++;

  if (test('3. an update that failed validation (string result, is_error) changes nothing', () => {
    const useId = 'toolu_update_bad';
    const file = transcript(
      create('1', 'A') +
      call('TaskUpdate', useId, { taskId: '1', status: 'in_progress' }) +
      result(useId, 'Error: InputValidationError: taskId must be a string', 'InputValidationError: taskId must be a string', true)
    );
    assert.deepStrictEqual(statuses(rt(file)), ['pending']);
  })) p++; else f++;

  if (test('4. deleted removes the task; deleting every task gives [] not null', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + update({ taskId: '1', status: 'deleted' }));
    assert.deepStrictEqual(subjects(rt(file)), ['B']);
    fs.appendFileSync(file, update({ taskId: '2', status: 'deleted' }));
    assert.deepStrictEqual(rt(file), []);
  })) p++; else f++;

  if (test('5. an update to an unknown taskId changes nothing and does not throw', () => {
    const file = transcript(create('1', 'A') + update({ taskId: '9', status: 'completed' }));
    assert.deepStrictEqual(rt(file), [{ id: '1', subject: 'A', status: 'pending', activeForm: null }]);
  })) p++; else f++;

  if (test('6. a status-less update applies subject/activeForm and leaves status', () => {
    const file = transcript(
      create('1', 'A', 'Doing A') +
      update({ taskId: '1', subject: 'A2', activeForm: 'Doing A2' }, { success: true, taskId: '1', updatedFields: ['subject', 'activeForm'] })
    );
    assert.deepStrictEqual(rt(file), [{ id: '1', subject: 'A2', status: 'pending', activeForm: 'Doing A2' }]);
  })) p++; else f++;

  if (test('7. message text holding "TaskCreate" / "TaskUpdate" (no tool_use block) → null', () => {
    const text = line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'TaskCreate' }, { type: 'text', text: 'TaskUpdate' }] } });
    // Whole-string text values serialize with bare quotes, so the prefilter really does hit and the shape check is what decides.
    assert.ok(text.includes('"TaskCreate"') && text.includes('"TaskUpdate"'));
    assert.strictEqual(rt(transcript(text + reply('I will use TaskCreate and TaskUpdate.'))), null);
  })) p++; else f++;

  if (test('7b. a non-result record carrying a pending tool_use id does not consume the call', () => {
    const c = createCall('A');
    // Hook attachments carry the call's id (`attachment.toolUseID`), so they pass the pending-id prefilter without being the result.
    const hook = line({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', content: ['noted'], hookName: 'PostToolUse:TaskCreate', toolUseID: c.useId, hookEvent: 'PostToolUse' }
    });
    const file = transcript(c.text + hook + result(c.useId, { task: { id: '1', subject: 'A' } }));
    assert.deepStrictEqual(subjects(rt(file)), ['A']);
  })) p++; else f++;

  if (test('8. an unterminated last line is deferred until its newline lands', () => {
    const c = createCall('A');
    const res = result(c.useId, { task: { id: '1', subject: 'A' } });
    const file = transcript(c.text + res.slice(0, -1));
    assert.strictEqual(rt(file), null);
    fs.appendFileSync(file, '\n');
    assert.deepStrictEqual(subjects(rt(file)), ['A']);
  })) p++; else f++;

  if (test('9. a later call reads only the appended bytes', () => {
    const file = transcript(create('1', 'A'));
    rt(file);
    const before = taskCacheStats().bytesRead;
    const appended = update({ taskId: '1', status: 'in_progress' });
    fs.appendFileSync(file, appended);
    assert.deepStrictEqual(statuses(rt(file)), ['in_progress']);
    assert.strictEqual(taskCacheStats().bytesRead - before, Buffer.byteLength(appended));
  })) p++; else f++;

  if (test('10. a file that shrank is re-folded from the start', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + create('3', 'C'));
    assert.deepStrictEqual(subjects(rt(file)), ['A', 'B', 'C']);
    const shorter = create('1', 'Z');
    assert.ok(Buffer.byteLength(shorter) < fs.statSync(file).size);
    fs.writeFileSync(file, shorter);
    assert.deepStrictEqual(subjects(rt(file)), ['Z']);
  })) p++; else f++;

  if (test('11. no task records → null, and a second call reads nothing', () => {
    const file = transcript(plain('hello') + reply('hi there') + plain('bye'));
    assert.strictEqual(rt(file), null);
    const before = taskCacheStats().bytesRead;
    assert.ok(before > 0);
    assert.strictEqual(rt(file), null);
    assert.strictEqual(taskCacheStats().bytesRead, before);
  })) p++; else f++;

  if (test('12. a multibyte subject straddling the chunk boundary decodes intact', () => {
    const subject = 'Übersicht — ✓ prüfen';
    const c = createCall(subject);
    const at = Buffer.from(c.text).indexOf(Buffer.from(subject));
    // One byte into 'Ü' (two bytes in UTF-8): the boundary splits the sequence itself.
    const fillerLen = CHUNK_BYTES - at - 1;
    const overhead = Buffer.byteLength(plain(''));
    const filler = plain('x'.repeat(fillerLen - overhead));
    assert.strictEqual(Buffer.byteLength(filler) + at + 1, CHUNK_BYTES);
    const file = transcript(filler + c.text + result(c.useId, { task: { id: '1', subject } }));
    assert.deepStrictEqual(subjects(rt(file)), [subject]);
  })) p++; else f++;

  if (test('13. a 1.2 MB create result spanning chunks is assembled and the fold continues past it', () => {
    const c = createCall('A');
    const big = result(c.useId, { task: { id: '1', subject: 'A' }, pad: 'p'.repeat(1_200_000) });
    assert.ok(Buffer.byteLength(big) > CHUNK_BYTES);
    const file = transcript(c.text + big + update({ taskId: '1', status: 'in_progress' }));
    assert.deepStrictEqual(rt(file), [{ id: '1', subject: 'A', status: 'in_progress', activeForm: null }]);
  })) p++; else f++;

  if (test('14. a read error returns the remembered list, then the next readable call catches up', () => {
    if (process.getuid?.() === 0) { console.log('    (skipped: root ignores file modes)'); return; }
    const file = transcript(create('1', 'A'));
    assert.deepStrictEqual(statuses(rt(file)), ['pending']);
    fs.appendFileSync(file, update({ taskId: '1', status: 'completed' }));
    fs.chmodSync(file, 0);
    try {
      assert.deepStrictEqual(statuses(rt(file)), ['pending']);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assert.deepStrictEqual(statuses(rt(file)), ['completed']);
  })) p++; else f++;

  if (test('activeForm: empty string or absent on create → null', () => {
    const file = transcript(create('1', 'A', '') + create('2', 'B'));
    assert.deepStrictEqual(rt(file)!.map((t) => t.activeForm), [null, null]);
  })) p++; else f++;

  if (test('a create result without task.id adds nothing', () => {
    const c = createCall('A');
    assert.strictEqual(rt(transcript(c.text + result(c.useId, { message: 'no id here' }))), null);
  })) p++; else f++;

  if (test('a create whose id is already known replaces it in place', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + create('1', 'A again'));
    assert.deepStrictEqual(subjects(rt(file)), ['A again', 'B']);
  })) p++; else f++;

  if (test('an unknown status is ignored; edits on the same call still apply', () => {
    const file = transcript(create('1', 'A') + update({ taskId: '1', status: 'blocked', subject: 'A2' }));
    assert.deepStrictEqual(rt(file), [{ id: '1', subject: 'A2', status: 'pending', activeForm: null }]);
  })) p++; else f++;

  if (test('statusChange.to wins over input.status', () => {
    const file = transcript(
      create('1', 'A') +
      update(
        { taskId: '1', status: 'in_progress' },
        { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }
      )
    );
    assert.deepStrictEqual(statuses(rt(file)), ['completed']);
  })) p++; else f++;

  if (test('ids are never sorted: "10" created before "2" stays first', () => {
    const file = transcript(create('10', 'ten') + create('2', 'two'));
    assert.deepStrictEqual(subjects(rt(file)), ['ten', 'two']);
  })) p++; else f++;

  if (test('a missing file → null, and its entry is dropped', () => {
    const file = transcript(create('1', 'A'));
    rt(file);
    assert.strictEqual(taskCacheStats().entries, 1);
    fs.unlinkSync(file);
    assert.strictEqual(rt(file), null);
    assert.strictEqual(taskCacheStats().entries, 0);
  })) p++; else f++;

  if (test('LRU: 64 entries max, and a call refreshes recency', () => {
    resetTaskCache();
    const files = Array.from({ length: 65 }, (_, i) => {
      const file = path.join(dir, `lru${i}.jsonl`);
      fs.writeFileSync(file, create('1', 'S' + i));
      return file;
    });
    for (const file of files.slice(0, 64)) rt(file);
    rt(files[0]); // touch the oldest, so lru1 is the one evicted next
    rt(files[64]);
    assert.strictEqual(taskCacheStats().entries, 64);
    let before = taskCacheStats().bytesRead;
    rt(files[0]);
    assert.strictEqual(taskCacheStats().bytesRead, before, 'the refreshed entry survived');
    before = taskCacheStats().bytesRead;
    assert.deepStrictEqual(subjects(rt(files[1])), ['S1']);
    assert.strictEqual(taskCacheStats().bytesRead - before, fs.statSync(files[1]).size, 'the evicted entry re-folds in full');
  })) p++; else f++;

  console.log('\n=== tasks.ts: plan progress ===\n');

  if (test('P1. ledger header via printf resolves the plan: headings become pending rows, taskPlan is the basename', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const r = readSessionTasks(transcript(header(root, 'docs/p.md')), null);
    assert.deepStrictEqual(subjects(r.tasks), ['A', 'B', 'C']);
    assert.deepStrictEqual(statuses(r.tasks), ['pending', 'pending', 'pending']);
    assert.strictEqual(r.plan, 'p');
  })) p++; else f++;

  if (test('P4. a ledger line completes its row; the same text as assistant text, user text or a tool_result completes none', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const file = transcript(header(root, 'docs/p.md'));
    fs.appendFileSync(file, ledger(root, 'Task 2: complete (abc1234)'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'completed', 'pending']);
    for (const noise of [reply('Task 2: complete'), plain('Task 2: complete'), result('toolu_x', undefined, 'Task 2: complete (abc1234)')]) {
      const r = readSessionTasks(transcript(header(root, 'docs/p.md') + noise), null);
      assert.deepStrictEqual(statuses(r.tasks), ['pending', 'pending', 'pending']);
    }
  })) p++; else f++;

  if (test('P5. task-brief alone resolves the plan and marks its task running; a ledger completion then clears live', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const file = transcript(bash(root, 'task-brief docs/p.md 3'));
    const r = readSessionTasks(file, null);
    assert.strictEqual(r.plan, 'p');
    assert.deepStrictEqual(statuses(r.tasks), ['pending', 'pending', 'in_progress']);
    fs.appendFileSync(file, ledger(root, 'Task 3: complete (abc1234)'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'pending', 'completed']);
  })) p++; else f++;

  if (test('P6. an Agent "Implement Task N" marks N running, and a later "Review Task N" keeps it', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const file = transcript(header(root, 'docs/p.md') + agent(root, 'Implement Task 2: x'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'in_progress', 'pending']);
    fs.appendFileSync(file, agent(root, 'Review Task 2 (spec + quality)'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'in_progress', 'pending']);
  })) p++; else f++;

  if (test('P8. a ledger line written before any plan signal applies once the plan appears', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const file = transcript(ledger(root, 'Task 1: complete (abc1234)'));
    assert.deepStrictEqual(readSessionTasks(file, null), { tasks: null, plan: null });
    fs.appendFileSync(file, bash(root, 'task-brief docs/p.md 2'));
    const r = readSessionTasks(file, null);
    assert.strictEqual(r.plan, 'p');
    assert.deepStrictEqual(statuses(r.tasks), ['completed', 'in_progress', 'pending']);
  })) p++; else f++;

  if (test('P9. a different plan replaces the first and drops its done and live state', () => {
    const root = planRoot({ a: ['A1', 'A2'], b: ['B1', 'B2', 'B3'] });
    const file = transcript(header(root, 'docs/a.md') + ledger(root, 'Task 1: complete (x)') + ledger(root, 'Task 2: complete (y)'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['completed', 'completed']);
    fs.appendFileSync(file, header(root, 'docs/b.md'));
    const r = readSessionTasks(file, null);
    assert.strictEqual(r.plan, 'b');
    assert.deepStrictEqual(subjects(r.tasks), ['B1', 'B2', 'B3']);
    assert.deepStrictEqual(statuses(r.tasks), ['pending', 'pending', 'pending']);
  })) p++; else f++;

  if (test('P9b. A, then B, then A again: A starts clean — what was done before the first switch does not come back', () => {
    const root = planRoot({ a: ['A1', 'A2'], b: ['B1'] });
    const file = transcript(header(root, 'docs/a.md') + ledger(root, 'Task 1: complete (x)') + header(root, 'docs/b.md') + header(root, 'docs/a.md'));
    const r = readSessionTasks(file, null);
    assert.strictEqual(r.plan, 'a');
    assert.deepStrictEqual(statuses(r.tasks), ['pending', 'pending']);
  })) p++; else f++;

  if (test('P9c. the same plan spelled relative and then absolute is one plan: state is kept', () => {
    const root = planRoot({ p: ['A', 'B'] });
    const file = transcript(header(root, 'docs/p.md') + ledger(root, 'Task 1: complete (x)') + header(root, path.join(root, 'docs/p.md')));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['completed', 'pending']);
  })) p++; else f++;

  if (test('P10. a missing plan file still lists the ids seen, in id order, named "Task <id>"', () => {
    const root = planRoot({});
    const file = transcript(
      header(root, 'docs/gone.md') + ledger(root, 'Task 10: complete (x)') + ledger(root, 'Task 2: complete (y)') + agent(root, 'Implement Task 5a: x')
    );
    const r = readSessionTasks(file, root);
    assert.deepStrictEqual(r.tasks!.map((t) => t.id), ['2', '5a', '10']);
    assert.deepStrictEqual(subjects(r.tasks), ['Task 2', 'Task 5a', 'Task 10']);
    assert.deepStrictEqual(statuses(r.tasks), ['completed', 'in_progress', 'completed']);
    assert.strictEqual(r.plan, 'gone');
  })) p++; else f++;

  if (test('P11. an amended plan shows on the next call without re-reading the transcript', () => {
    const root = planRoot({ p: ['A', 'B'] });
    const file = transcript(header(root, 'docs/p.md'));
    assert.deepStrictEqual(subjects(readSessionTasks(file, null).tasks), ['A', 'B']);
    const before = taskCacheStats().bytesRead;
    const planFile = path.join(root, 'docs/p.md');
    fs.appendFileSync(planFile, '\n### Task 3: C\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(planFile, later, later);
    assert.deepStrictEqual(subjects(readSessionTasks(file, null).tasks), ['A', 'B', 'C']);
    assert.strictEqual(taskCacheStats().bytesRead, before);
  })) p++; else f++;

  if (test('P13. a plan without headings and no ids falls back to the TaskCreate list, or to null without one', () => {
    const root = planRoot({ p: [] });
    assert.deepStrictEqual(readSessionTasks(transcript(header(root, 'docs/p.md')), null), { tasks: null, plan: null });
    const r = readSessionTasks(transcript(header(root, 'docs/p.md') + create('1', 'X')), null);
    assert.deepStrictEqual(subjects(r.tasks), ['X']);
    assert.strictEqual(r.plan, null);
  })) p++; else f++;

  if (test('P14. a plan with headings beats a confirmed TaskCreate list', () => {
    const root = planRoot({ p: ['A', 'B'] });
    const r = readSessionTasks(transcript(create('1', 'X') + header(root, 'docs/p.md')), null);
    assert.deepStrictEqual(subjects(r.tasks), ['A', 'B']);
    assert.strictEqual(r.plan, 'p');
  })) p++; else f++;

  if (test('P15. a relative plan resolves against the record cwd, then a leading cd, then projectPath', () => {
    const root = planRoot({ p: ['A', 'B'] });
    const elsewhere = fs.mkdtempSync(path.join(dir, 'else-'));
    const viaCwd = readSessionTasks(transcript(header(root, 'docs/p.md')), elsewhere);
    assert.deepStrictEqual(subjects(viaCwd.tasks), ['A', 'B']);
    const viaProject = readSessionTasks(transcript(header(elsewhere, 'docs/p.md')), root);
    assert.deepStrictEqual(subjects(viaProject.tasks), ['A', 'B']);
    const viaCd = readSessionTasks(transcript(call('Bash', 'toolu_cd', { command: `cd ${root} && task-brief docs/p.md 1` }, elsewhere)), null);
    assert.deepStrictEqual(subjects(viaCd.tasks), ['A', 'B']);
    assert.deepStrictEqual(readSessionTasks(transcript(header(elsewhere, 'docs/p.md')), null).tasks, null);
  })) p++; else f++;

  if (test('P16. a ledger line straddling the chunk boundary still counts', () => {
    const root = planRoot({ p: ['A', 'B'] });
    const head = header(root, 'docs/p.md');
    const target = ledger(root, 'Task 1: complete (abc1234)');
    const at = Buffer.from(target).indexOf(Buffer.from('Task 1: complete'));
    // Five bytes into the match, so the boundary splits the very text the ledger rule reads.
    const fillerLen = CHUNK_BYTES - Buffer.byteLength(head) - at - 5;
    const filler = plain('x'.repeat(fillerLen - Buffer.byteLength(plain(''))));
    assert.strictEqual(Buffer.byteLength(head) + Buffer.byteLength(filler) + at + 5, CHUNK_BYTES);
    assert.deepStrictEqual(statuses(readSessionTasks(transcript(head + filler + target + reply('end')), null).tasks), ['completed', 'pending']);
  })) p++; else f++;

  if (test('P19. task-start / task-done resolve the plan and finish the task; the script\'s stdout alone finishes nothing', () => {
    const root = planRoot({ p: ['A', 'B', 'C'] });
    const file = transcript(bash(root, 'task-start docs/p.md 2'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'in_progress', 'pending']);
    fs.appendFileSync(file, bash(root, '"$EP/scripts/task-done" docs/p.md 2 abc1234 -- pnpm test'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'completed', 'pending']);
    const only = transcript(header(root, 'docs/p.md') + result('toolu_y', undefined, 'Task 2: complete (abc1234)'));
    assert.deepStrictEqual(statuses(readSessionTasks(only, null).tasks), ['pending', 'pending', 'pending']);
  })) p++; else f++;

  if (test('P20. a Review for a finished task does not displace the one running', () => {
    const root = planRoot({ p: ['A', 'B', 'C', 'D', 'E'] });
    const file = transcript(header(root, 'docs/p.md') + ledger(root, 'Task 4: complete (x)') + agent(root, 'Implement Task 5: x') + agent(root, 'Review Task 4'));
    assert.deepStrictEqual(statuses(readSessionTasks(file, null).tasks), ['pending', 'pending', 'pending', 'completed', 'in_progress']);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
