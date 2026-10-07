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

function call(name: string, useId: string, input: Record<string, unknown>): string {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] } });
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
    const t = readSessionTasks(file);
    assert.deepStrictEqual(subjects(t), ['A', 'B', 'C']);
    assert.deepStrictEqual(statuses(t), ['completed', 'pending', 'pending']);
    assert.deepStrictEqual(t![0], { id: '1', subject: 'A', status: 'completed', activeForm: 'Doing A' });
  })) p++; else f++;

  if (test('2. a create call with no result line → null', () => {
    assert.strictEqual(readSessionTasks(transcript(createCall('A').text)), null);
  })) p++; else f++;

  if (test('3. an update that failed validation (string result, is_error) changes nothing', () => {
    const useId = 'toolu_update_bad';
    const file = transcript(
      create('1', 'A') +
      call('TaskUpdate', useId, { taskId: '1', status: 'in_progress' }) +
      result(useId, 'Error: InputValidationError: taskId must be a string', 'InputValidationError: taskId must be a string', true)
    );
    assert.deepStrictEqual(statuses(readSessionTasks(file)), ['pending']);
  })) p++; else f++;

  if (test('4. deleted removes the task; deleting every task gives [] not null', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + update({ taskId: '1', status: 'deleted' }));
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['B']);
    fs.appendFileSync(file, update({ taskId: '2', status: 'deleted' }));
    assert.deepStrictEqual(readSessionTasks(file), []);
  })) p++; else f++;

  if (test('5. an update to an unknown taskId changes nothing and does not throw', () => {
    const file = transcript(create('1', 'A') + update({ taskId: '9', status: 'completed' }));
    assert.deepStrictEqual(readSessionTasks(file), [{ id: '1', subject: 'A', status: 'pending', activeForm: null }]);
  })) p++; else f++;

  if (test('6. a status-less update applies subject/activeForm and leaves status', () => {
    const file = transcript(
      create('1', 'A', 'Doing A') +
      update({ taskId: '1', subject: 'A2', activeForm: 'Doing A2' }, { success: true, taskId: '1', updatedFields: ['subject', 'activeForm'] })
    );
    assert.deepStrictEqual(readSessionTasks(file), [{ id: '1', subject: 'A2', status: 'pending', activeForm: 'Doing A2' }]);
  })) p++; else f++;

  if (test('7. message text holding "TaskCreate" / "TaskUpdate" (no tool_use block) → null', () => {
    const text = line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'TaskCreate' }, { type: 'text', text: 'TaskUpdate' }] } });
    // Whole-string text values serialize with bare quotes, so the prefilter really does hit and the shape check is what decides.
    assert.ok(text.includes('"TaskCreate"') && text.includes('"TaskUpdate"'));
    assert.strictEqual(readSessionTasks(transcript(text + reply('I will use TaskCreate and TaskUpdate.'))), null);
  })) p++; else f++;

  if (test('7b. a non-result record carrying a pending tool_use id does not consume the call', () => {
    const c = createCall('A');
    // Hook attachments carry the call's id (`attachment.toolUseID`), so they pass the pending-id prefilter without being the result.
    const hook = line({
      type: 'attachment',
      attachment: { type: 'hook_additional_context', content: ['noted'], hookName: 'PostToolUse:TaskCreate', toolUseID: c.useId, hookEvent: 'PostToolUse' }
    });
    const file = transcript(c.text + hook + result(c.useId, { task: { id: '1', subject: 'A' } }));
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['A']);
  })) p++; else f++;

  if (test('8. an unterminated last line is deferred until its newline lands', () => {
    const c = createCall('A');
    const res = result(c.useId, { task: { id: '1', subject: 'A' } });
    const file = transcript(c.text + res.slice(0, -1));
    assert.strictEqual(readSessionTasks(file), null);
    fs.appendFileSync(file, '\n');
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['A']);
  })) p++; else f++;

  if (test('9. a later call reads only the appended bytes', () => {
    const file = transcript(create('1', 'A'));
    readSessionTasks(file);
    const before = taskCacheStats().bytesRead;
    const appended = update({ taskId: '1', status: 'in_progress' });
    fs.appendFileSync(file, appended);
    assert.deepStrictEqual(statuses(readSessionTasks(file)), ['in_progress']);
    assert.strictEqual(taskCacheStats().bytesRead - before, Buffer.byteLength(appended));
  })) p++; else f++;

  if (test('10. a file that shrank is re-folded from the start', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + create('3', 'C'));
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['A', 'B', 'C']);
    const shorter = create('1', 'Z');
    assert.ok(Buffer.byteLength(shorter) < fs.statSync(file).size);
    fs.writeFileSync(file, shorter);
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['Z']);
  })) p++; else f++;

  if (test('11. no task records → null, and a second call reads nothing', () => {
    const file = transcript(plain('hello') + reply('hi there') + plain('bye'));
    assert.strictEqual(readSessionTasks(file), null);
    const before = taskCacheStats().bytesRead;
    assert.ok(before > 0);
    assert.strictEqual(readSessionTasks(file), null);
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
    assert.deepStrictEqual(subjects(readSessionTasks(file)), [subject]);
  })) p++; else f++;

  if (test('13. a 1.2 MB create result spanning chunks is assembled and the fold continues past it', () => {
    const c = createCall('A');
    const big = result(c.useId, { task: { id: '1', subject: 'A' }, pad: 'p'.repeat(1_200_000) });
    assert.ok(Buffer.byteLength(big) > CHUNK_BYTES);
    const file = transcript(c.text + big + update({ taskId: '1', status: 'in_progress' }));
    assert.deepStrictEqual(readSessionTasks(file), [{ id: '1', subject: 'A', status: 'in_progress', activeForm: null }]);
  })) p++; else f++;

  if (test('14. a read error returns the remembered list, then the next readable call catches up', () => {
    if (process.getuid?.() === 0) { console.log('    (skipped: root ignores file modes)'); return; }
    const file = transcript(create('1', 'A'));
    assert.deepStrictEqual(statuses(readSessionTasks(file)), ['pending']);
    fs.appendFileSync(file, update({ taskId: '1', status: 'completed' }));
    fs.chmodSync(file, 0);
    try {
      assert.deepStrictEqual(statuses(readSessionTasks(file)), ['pending']);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    assert.deepStrictEqual(statuses(readSessionTasks(file)), ['completed']);
  })) p++; else f++;

  if (test('activeForm: empty string or absent on create → null', () => {
    const file = transcript(create('1', 'A', '') + create('2', 'B'));
    assert.deepStrictEqual(readSessionTasks(file)!.map((t) => t.activeForm), [null, null]);
  })) p++; else f++;

  if (test('a create result without task.id adds nothing', () => {
    const c = createCall('A');
    assert.strictEqual(readSessionTasks(transcript(c.text + result(c.useId, { message: 'no id here' }))), null);
  })) p++; else f++;

  if (test('a create whose id is already known replaces it in place', () => {
    const file = transcript(create('1', 'A') + create('2', 'B') + create('1', 'A again'));
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['A again', 'B']);
  })) p++; else f++;

  if (test('an unknown status is ignored; edits on the same call still apply', () => {
    const file = transcript(create('1', 'A') + update({ taskId: '1', status: 'blocked', subject: 'A2' }));
    assert.deepStrictEqual(readSessionTasks(file), [{ id: '1', subject: 'A2', status: 'pending', activeForm: null }]);
  })) p++; else f++;

  if (test('statusChange.to wins over input.status', () => {
    const file = transcript(
      create('1', 'A') +
      update(
        { taskId: '1', status: 'in_progress' },
        { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }
      )
    );
    assert.deepStrictEqual(statuses(readSessionTasks(file)), ['completed']);
  })) p++; else f++;

  if (test('ids are never sorted: "10" created before "2" stays first', () => {
    const file = transcript(create('10', 'ten') + create('2', 'two'));
    assert.deepStrictEqual(subjects(readSessionTasks(file)), ['ten', 'two']);
  })) p++; else f++;

  if (test('a missing file → null, and its entry is dropped', () => {
    const file = transcript(create('1', 'A'));
    readSessionTasks(file);
    assert.strictEqual(taskCacheStats().entries, 1);
    fs.unlinkSync(file);
    assert.strictEqual(readSessionTasks(file), null);
    assert.strictEqual(taskCacheStats().entries, 0);
  })) p++; else f++;

  if (test('LRU: 64 entries max, and a call refreshes recency', () => {
    resetTaskCache();
    const files = Array.from({ length: 65 }, (_, i) => {
      const file = path.join(dir, `lru${i}.jsonl`);
      fs.writeFileSync(file, create('1', 'S' + i));
      return file;
    });
    for (const file of files.slice(0, 64)) readSessionTasks(file);
    readSessionTasks(files[0]); // touch the oldest, so lru1 is the one evicted next
    readSessionTasks(files[64]);
    assert.strictEqual(taskCacheStats().entries, 64);
    let before = taskCacheStats().bytesRead;
    readSessionTasks(files[0]);
    assert.strictEqual(taskCacheStats().bytesRead, before, 'the refreshed entry survived');
    before = taskCacheStats().bytesRead;
    assert.deepStrictEqual(subjects(readSessionTasks(files[1])), ['S1']);
    assert.strictEqual(taskCacheStats().bytesRead - before, fs.statSync(files[1]).size, 'the evicted entry re-folds in full');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
