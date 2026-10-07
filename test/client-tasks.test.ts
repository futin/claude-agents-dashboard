import assert from 'node:assert';

import { planName, scrollTargetId, taskLine, taskProgress } from '../client/src/lib/tasks.js';
import type { SessionTask, TaskStatus } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function task(id: number | string, status: TaskStatus, over: Partial<SessionTask> = {}): SessionTask {
  return { id: String(id), subject: `Task ${id}`, status, activeForm: null, ...over };
}

/** `n` tasks, ids 1..n, statuses taken from `statuses` by position. */
function list(statuses: TaskStatus[]): SessionTask[] {
  return statuses.map((s, i) => task(i + 1, s));
}

function ids(ts: SessionTask[]): string[] { return ts.map(t => t.id); }

export function run(): number {
  console.log('\n=== client/lib/tasks.ts ===\n');
  let p = 0, f = 0;

  if (test('null and empty lists have no progress', () => {
    assert.strictEqual(taskProgress(null), null);
    assert.strictEqual(taskProgress([]), null);
  })) p++; else f++;

  if (test('mid-run list: counts, rounded percent, live task and the next pending one', () => {
    const ts = list([...Array(7).fill('completed'), 'in_progress', ...Array(5).fill('pending')] as TaskStatus[]);
    const pr = taskProgress(ts)!;
    assert.strictEqual(pr.done, 7);
    assert.strictEqual(pr.total, 13);
    assert.strictEqual(pr.pct, 54);
    assert.deepStrictEqual(ids(pr.live), ['8']);
    assert.strictEqual(pr.next?.id, '9');
    assert.strictEqual(pr.allDone, false);
  })) p++; else f++;

  if (test('nothing started: 0%, no live, next is the first task', () => {
    const pr = taskProgress(list(Array(6).fill('pending') as TaskStatus[]))!;
    assert.strictEqual(pr.done, 0);
    assert.strictEqual(pr.pct, 0);
    assert.deepStrictEqual(pr.live, []);
    assert.strictEqual(pr.next?.id, '1');
    assert.strictEqual(pr.allDone, false);
  })) p++; else f++;

  if (test('two live tasks keep list order; the line and the scroll target follow the first', () => {
    const ts = list(['completed', 'completed', 'in_progress', 'pending', 'in_progress']);
    ts[2].activeForm = 'Doing three';
    ts[4].activeForm = 'Doing five';
    const pr = taskProgress(ts)!;
    assert.deepStrictEqual(ids(pr.live), ['3', '5']);
    assert.deepStrictEqual(taskLine(pr), { text: 'Doing three', kind: 'live' });
    assert.strictEqual(scrollTargetId(pr), '3');
  })) p++; else f++;

  if (test('a live task without an activeForm shows its subject', () => {
    const pr = taskProgress([task(1, 'in_progress', { subject: 'Wire the thing' })])!;
    assert.deepStrictEqual(taskLine(pr), { text: 'Wire the thing', kind: 'live' });
  })) p++; else f++;

  if (test('no live task: the line is Next: plus the first pending subject, and scroll goes to it', () => {
    const pr = taskProgress(list(['completed', 'pending', 'pending']))!;
    assert.deepStrictEqual(taskLine(pr), { text: 'Next: Task 2', kind: 'next' });
    assert.strictEqual(scrollTargetId(pr), '2');
  })) p++; else f++;

  if (test('all completed: allDone, 100%, "All done" line, nothing to scroll to', () => {
    const pr = taskProgress(list(Array(13).fill('completed') as TaskStatus[]))!;
    assert.strictEqual(pr.allDone, true);
    assert.strictEqual(pr.pct, 100);
    assert.strictEqual(pr.next, null);
    assert.deepStrictEqual(taskLine(pr), { text: 'All done', kind: 'done' });
    assert.strictEqual(scrollTargetId(pr), null);
  })) p++; else f++;

  if (test('a 200-character subject comes back untrimmed (truncation is CSS)', () => {
    const subject = 'x'.repeat(200);
    const live = taskProgress([task(1, 'in_progress', { subject })])!;
    assert.strictEqual(taskLine(live).text.length, 200);
    const next = taskProgress([task(1, 'pending', { subject })])!;
    assert.strictEqual(taskLine(next).text, 'Next: ' + subject);
  })) p++; else f++;

  if (test('ids are opaque strings: "10" live beats "2" pending, no numeric or string sort', () => {
    const ts = [task(2, 'pending'), task(10, 'in_progress')];
    assert.strictEqual(scrollTargetId(taskProgress(ts)!), '10');
    // List order, not id order, decides the first pending task.
    assert.strictEqual(scrollTargetId(taskProgress([task(10, 'pending'), task(2, 'pending')])!), '10');
  })) p++; else f++;

  if (test('planName strips one leading date and leaves anything else alone', () => {
    assert.strictEqual(planName('2026-10-07-task-progress'), 'task-progress');
    assert.strictEqual(planName('phase0-spike'), 'phase0-spike');
    // No trailing dash after the date means nothing to strip.
    assert.strictEqual(planName('2026-10-07'), '2026-10-07');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
