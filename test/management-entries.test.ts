import assert from 'node:assert';

import { buildEntries, filterEntries } from '../client/src/lib/managementEntries.js';
import type { ScopeConfig } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function scope(partial: Partial<ScopeConfig>): ScopeConfig {
  return {
    scope: 'global', root: '/home/.claude',
    skills: [], agents: [], commands: [], rules: [], hooks: [], memory: [], settings: [], plugins: [],
    ...partial
  };
}

export function run(): number {
  console.log('\n=== managementEntries.ts ===\n');
  let p = 0, f = 0;

  if (test('groups in fixed order; plugins group only for global scope', () => {
    const g = buildEntries(scope({}));
    assert.deepStrictEqual(g.map(x => x.title), ['Plugins', 'Skills', 'Agents', 'Commands', 'Rules', 'Hooks', 'Memory', 'Settings']);
    const pr = buildEntries(scope({ scope: 'project' }));
    assert.deepStrictEqual(pr.map(x => x.title), ['Skills', 'Agents', 'Commands', 'Rules', 'Hooks', 'Memory', 'Settings']);
  })) p++; else f++;

  if (test('config items map to file entries with path, source badge, fileKind, subgroup', () => {
    const g = buildEntries(scope({
      skills: [{ name: 'study', description: 'learn', path: '/p/SKILL.md', source: 'plugin:x' }]
    }));
    const e = g.find(x => x.title === 'Skills')!.entries[0];
    assert.strictEqual(e.kind, 'file');
    if (e.kind === 'file') assert.strictEqual(e.fileKind, 'markdown');
    assert.strictEqual(e.label, 'study');
    assert.strictEqual(e.sublabel, 'learn');
    assert.strictEqual(e.badge, 'plugin:x');
    assert.strictEqual(e.filePath, '/p/SKILL.md');
    assert.strictEqual(e.subgroup, 'x');
    assert.ok(e.key);
  })) p++; else f++;

  if (test('skills sort user/project first, then plugin subgroups + labels alphabetically', () => {
    const g = buildEntries(scope({
      skills: [
        { name: 'zeta', description: null, path: '/z', source: 'plugin:beta' },
        { name: 'alpha', description: null, path: '/a', source: 'plugin:beta' },
        { name: 'mid', description: null, path: '/m', source: 'plugin:acme' },
        { name: 'mine', description: null, path: '/u', source: 'user' }
      ]
    }));
    const entries = g.find(x => x.title === 'Skills')!.entries;
    assert.deepStrictEqual(entries.map(e => e.label), ['mine', 'mid', 'alpha', 'zeta']);
    assert.deepStrictEqual(entries.map(e => e.subgroup), ['user', 'acme', 'beta', 'beta']);
  })) p++; else f++;

  if (test('hooks: kind hook with payload, sorted+subgrouped by event, filePath prefers scriptPath', () => {
    const g = buildEntries(scope({
      hooks: [
        { event: 'Stop', matcher: null, command: 'x.sh', source: 'user', declaredIn: '/s.json', scriptPath: '/x.sh' },
        { event: 'PreToolUse', matcher: 'Ask', command: 'beep', source: 'user', declaredIn: '/s.json', scriptPath: null }
      ]
    }));
    const [a, b] = g.find(x => x.title === 'Hooks')!.entries;
    assert.strictEqual(a.label, 'PreToolUse · Ask');
    assert.strictEqual(a.kind, 'hook');
    if (a.kind === 'hook') assert.strictEqual(a.hook.command, 'beep');
    assert.strictEqual(a.subgroup, 'PreToolUse');
    assert.strictEqual(a.filePath, '/s.json');
    assert.strictEqual(b.label, 'Stop');
    if (b.kind === 'hook') assert.strictEqual(b.hook.scriptPath, '/x.sh');
    assert.strictEqual(b.subgroup, 'Stop');
    assert.strictEqual(b.filePath, '/x.sh');
    assert.notStrictEqual(a.key, b.key);
  })) p++; else f++;

  if (test('settings: only existing files become entries, fileKind json', () => {
    const g = buildEntries(scope({
      settings: [
        { label: 'settings.json', path: '/c/settings.json', exists: true },
        { label: 'settings.local.json', path: '/c/settings.local.json', exists: false }
      ]
    }));
    const entries = g.find(x => x.title === 'Settings')!.entries;
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].label, 'settings.json');
    if (entries[0].kind === 'file') assert.strictEqual(entries[0].fileKind, 'json');
  })) p++; else f++;

  if (test('plugins: label name, badge shows disabled, filePath = manifest (null when absent)', () => {
    const g = buildEntries(scope({
      plugins: [
        { key: 'a@m', name: 'a', marketplace: 'm', version: '1.0', description: 'd', installPath: '/i', enabled: true, manifestPath: '/i/p.json', counts: { skills: 1, agents: 0, commands: 0, rules: 0, hooks: 0 } },
        { key: 'b@m', name: 'b', marketplace: 'm', version: null, description: null, installPath: '/j', enabled: false, manifestPath: null, counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0 } }
      ]
    }));
    const [a, b] = g.find(x => x.title === 'Plugins')!.entries;
    assert.strictEqual(a.label, 'a');
    assert.strictEqual(a.badge, 'v1.0');
    assert.strictEqual(a.filePath, '/i/p.json');
    assert.strictEqual(a.subgroup, null);
    assert.strictEqual(b.badge, 'disabled');
    assert.strictEqual(b.filePath, null);
  })) p++; else f++;

  if (test('filterEntries matches label+sublabel case-insensitively, drops empty groups, keeps subgroup', () => {
    const groups = buildEntries(scope({
      skills: [
        { name: 'study', description: 'learning walkthrough', path: '/a', source: 'user' },
        { name: 'caveman', description: 'compressed comms', path: '/b', source: 'plugin:cave' }
      ]
    }));
    const hit = filterEntries(groups, 'LEARN');
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].title, 'Skills');
    assert.strictEqual(hit[0].entries.length, 1);
    assert.strictEqual(hit[0].entries[0].label, 'study');
    assert.strictEqual(hit[0].entries[0].subgroup, 'user');
    assert.deepStrictEqual(filterEntries(groups, ''), groups);
  })) p++; else f++;

  console.log(`\nmanagementEntries: ${p} passed, ${f} failed`);
  return f;
}
