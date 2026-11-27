import assert from 'node:assert';

import { isAgentTool } from '../../client/src/lib/agentTool.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== agentTool.ts ===\n');
  let p = 0, f = 0;

  if (test('current Claude Code names the subagent launch tool Agent', () => {
    assert.strictEqual(isAgentTool('Agent'), true);
  })) p++; else f++;

  if (test('older transcripts name it Task, and still match', () => {
    assert.strictEqual(isAgentTool('Task'), true);
  })) p++; else f++;

  if (test('any other tool is not a subagent launch', () => {
    for (const name of ['Bash', 'Read', 'Skill', 'SendMessage', 'TaskStop', 'agent', 'task', ''])
      assert.strictEqual(isAgentTool(name), false, name);
  })) p++; else f++;

  if (test('no tool name is not a subagent launch', () => {
    assert.strictEqual(isAgentTool(undefined), false);
    assert.strictEqual(isAgentTool(null), false);
  })) p++; else f++;

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
