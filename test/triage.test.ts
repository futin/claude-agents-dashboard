import assert from 'node:assert';

import type { Session } from '../shared/types.js';
import { chatTab } from '../client/src/lib/holds.js';
import { triageGroups } from '../client/src/lib/triage.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Minimal Session; only the fields the grouping reads carry meaning. */
function sess(p: Partial<Session>): Session {
  return {
    id: p.id ?? 'id',
    project: p.project ?? 'proj',
    projectPath: null,
    sessionName: null,
    gitBranch: null,
    model: 'claude-opus-5',
    tokens: 0,
    contextWindow: 200_000,
    contextWindowLabel: '200k',
    contextPct: 0,
    status: p.status ?? 'idle',
    surface: 'local',
    remoteQuestion: p.remoteQuestion ?? false,
    remotePlan: p.remotePlan ?? false,
    remoteReply: p.remoteReply ?? false,
    permissionWait: p.permissionWait ?? false,
    activity: null,
    lastTimestamp: null,
    updatedMs: 0,
    version: null,
    kaizenLesson: null
  };
}

export function run(): number {
  console.log('\n=== triage.ts + chatTab ===\n');
  let p = 0, f = 0;

  if (test('triageGroups: a held question lands in needs whatever the status', () => {
    const g = triageGroups([sess({ id: 'q', status: 'idle', remoteQuestion: true })]);
    assert.deepStrictEqual(g.needs.map(s => s.id), ['q']);
    assert.strictEqual(g.working.length, 0);
    assert.strictEqual(g.quiet.length, 0);
  })) p++; else f++;

  if (test('triageGroups: a permission dialog outranks working', () => {
    const g = triageGroups([sess({ id: 'perm', status: 'working', permissionWait: true })]);
    assert.deepStrictEqual(g.needs.map(s => s.id), ['perm']);
    assert.strictEqual(g.working.length, 0);
  })) p++; else f++;

  if (test('triageGroups: a terminal question with no hold is still a need', () => {
    const g = triageGroups([sess({ id: 'tq', status: 'question' })]);
    assert.deepStrictEqual(g.needs.map(s => s.id), ['tq']);
  })) p++; else f++;

  if (test('triageGroups: working goes to working, idle and pending to quiet', () => {
    const g = triageGroups([
      sess({ id: 'w', status: 'working' }),
      sess({ id: 'i', status: 'idle' }),
      sess({ id: 'p', status: 'incomplete' })
    ]);
    assert.deepStrictEqual(g.working.map(s => s.id), ['w']);
    assert.deepStrictEqual(g.quiet.map(s => s.id), ['i', 'p']);
    assert.strictEqual(g.needs.length, 0);
  })) p++; else f++;

  if (test('triageGroups: input order survives inside each group', () => {
    const g = triageGroups([
      sess({ id: 'w2', status: 'working' }),
      sess({ id: 'n1', status: 'idle', remoteReply: true }),
      sess({ id: 'w1', status: 'working' }),
      sess({ id: 'n2', status: 'working', remotePlan: true })
    ]);
    assert.deepStrictEqual(g.working.map(s => s.id), ['w2', 'w1']);
    assert.deepStrictEqual(g.needs.map(s => s.id), ['n1', 'n2']);
  })) p++; else f++;

  if (test('triageGroups: the three groups partition the input', () => {
    const list = [
      sess({ id: 'a', status: 'working', remoteQuestion: true }),
      sess({ id: 'b', status: 'working' }),
      sess({ id: 'c', status: 'idle' }),
      sess({ id: 'd', status: 'question' }),
      sess({ id: 'e', status: 'incomplete', permissionWait: true })
    ];
    const g = triageGroups(list);
    const ids = [...g.needs, ...g.working, ...g.quiet].map(s => s.id).sort();
    assert.strictEqual(g.needs.length + g.working.length + g.quiet.length, list.length);
    assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd', 'e']);
  })) p++; else f++;

  if (test('triageGroups: empty in, three empty groups out', () => {
    assert.deepStrictEqual(triageGroups([]), { needs: [], working: [], quiet: [] });
  })) p++; else f++;

  if (test('chatTab: a held question says answer in the answer tone', () => {
    const t = chatTab(sess({ remoteQuestion: true }));
    assert.strictEqual(t.label, 'answer');
    assert.strictEqual(t.tone, 'answer');
  })) p++; else f++;

  if (test('chatTab: a permission dialog says allow? in its own tone', () => {
    const t = chatTab(sess({ permissionWait: true }));
    assert.strictEqual(t.label, 'allow?');
    assert.strictEqual(t.tone, 'permission');
  })) p++; else f++;

  if (test('chatTab: plan and reply share the answer tone', () => {
    assert.strictEqual(chatTab(sess({ remotePlan: true })).label, 'plan?');
    assert.strictEqual(chatTab(sess({ remotePlan: true })).tone, 'answer');
    assert.strictEqual(chatTab(sess({ remoteReply: true })).label, 'reply?');
  })) p++; else f++;

  if (test('chatTab: no hold is the plain chat button', () => {
    const t = chatTab(sess({}));
    assert.strictEqual(t.label, 'chat');
    assert.strictEqual(t.tone, '');
    assert.ok(t.title.length > 0);
  })) p++; else f++;

  if (test('chatTab: a question outranks a permission dialog when both are set', () => {
    assert.strictEqual(chatTab(sess({ remoteQuestion: true, permissionWait: true })).label, 'answer');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
