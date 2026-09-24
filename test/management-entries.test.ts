import assert from 'node:assert';

import { buildEntries, filterEntries, railRows } from '../client/src/lib/managementEntries.js';
import type { McpServerInfo, ScopeConfig } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function scope(partial: Partial<ScopeConfig>): ScopeConfig {
  return {
    scope: 'global', root: '/home/.claude',
    skills: [], agents: [], commands: [], rules: [], hooks: [], memory: [], settings: [], plugins: [], mcpServers: [],
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

  if (test('skill entry carries its dir files with abs paths + fileKind; absent when single-file', () => {
    const g = buildEntries(scope({
      skills: [
        { name: 'rich', description: null, path: '/s/rich/SKILL.md', source: 'user', files: [
          { rel: 'SKILL.md', size: 10 },
          { rel: 'references/api.md', size: 20 },
          { rel: 'scripts/run.sh', size: 30 }
        ] },
        { name: 'solo', description: null, path: '/s/solo/SKILL.md', source: 'user' }
      ]
    }));
    const [rich, solo] = g.find(x => x.title === 'Skills')!.entries;
    assert.strictEqual(rich.kind, 'file');
    if (rich.kind !== 'file') return;
    assert.deepStrictEqual(rich.files!.map(f => f.path), ['/s/rich/SKILL.md', '/s/rich/references/api.md', '/s/rich/scripts/run.sh']);
    assert.deepStrictEqual(rich.files!.map(f => f.rel), ['SKILL.md', 'references/api.md', 'scripts/run.sh']);
    assert.deepStrictEqual(rich.files!.map(f => f.fileKind), ['markdown', 'markdown', 'text']);
    assert.deepStrictEqual(rich.files!.map(f => f.size), [10, 20, 30]);
    if (solo.kind === 'file') assert.strictEqual(solo.files, undefined);
  })) p++; else f++;

  if (test('filterEntries matches a skill on one of its file rels', () => {
    const groups = buildEntries(scope({
      skills: [{ name: 'rich', description: null, path: '/s/rich/SKILL.md', source: 'user', files: [
        { rel: 'SKILL.md', size: 1 },
        { rel: 'references/tone-guide.md', size: 2 }
      ] }]
    }));
    const hit = filterEntries(groups, 'TONE-GUIDE');
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].entries[0].label, 'rich');
    assert.strictEqual(filterEntries(groups, 'nothing-here').length, 0);
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

  if (test('railRows: root files first, then dir headers with their files, leaf labels', () => {
    const files = [
      { rel: 'SKILL.md', path: '/s/SKILL.md', size: 1, fileKind: 'markdown' as const },
      { rel: 'notes.md', path: '/s/notes.md', size: 2, fileKind: 'markdown' as const },
      { rel: 'references/api.md', path: '/s/references/api.md', size: 3, fileKind: 'markdown' as const },
      { rel: 'references/tone.md', path: '/s/references/tone.md', size: 4, fileKind: 'markdown' as const },
      { rel: 'scripts/deep/run.sh', path: '/s/scripts/deep/run.sh', size: 5, fileKind: 'text' as const }
    ];
    const rows = railRows(files);
    assert.deepStrictEqual(rows.map(r => r.kind), ['file', 'file', 'dir', 'file', 'file', 'dir', 'file']);
    assert.deepStrictEqual(
      rows.map(r => (r.kind === 'dir' ? r.dir : r.label)),
      ['SKILL.md', 'notes.md', 'references/', 'api.md', 'tone.md', 'scripts/deep/', 'run.sh']
    );
    const paths = rows.filter(r => r.kind === 'file').map(r => (r.kind === 'file' ? r.file.path : ''));
    assert.deepStrictEqual(paths, [
      '/s/SKILL.md', '/s/notes.md', '/s/references/api.md', '/s/references/tone.md', '/s/scripts/deep/run.sh'
    ]);
  })) p++; else f++;

  if (test('railRows: dirs sorted after root files even when a dir sorts first by rel', () => {
    const files = [
      { rel: 'aaa/one.md', path: '/s/aaa/one.md', size: 1, fileKind: 'markdown' as const },
      { rel: 'zzz.md', path: '/s/zzz.md', size: 1, fileKind: 'markdown' as const }
    ];
    assert.deepStrictEqual(railRows(files).map(r => r.kind), ['file', 'dir', 'file']);
    assert.deepStrictEqual(railRows([]), []);
  })) p++; else f++;

  const mcp = (partial: Partial<McpServerInfo>): McpServerInfo => ({
    name: 'codegraph', source: 'user', transport: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], url: null,
    envKeys: [], headerKeys: [], declaredIn: '/home/.claude.json', disabled: false, ...partial
  });

  if (test('MCP servers group sits right after Plugins (global) and first (project); absent when empty', () => {
    const plugin = { key: 'p@m', name: 'p', marketplace: 'm', version: '1', description: null, installPath: '/p', enabled: true, manifestPath: null,
      counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0 } };
    const g = buildEntries(scope({ plugins: [plugin], mcpServers: [mcp({})] }));
    assert.deepStrictEqual(g.map(x => x.title).slice(0, 3), ['Plugins', 'MCP servers', 'Skills']);
    const pr = buildEntries(scope({ scope: 'project', mcpServers: [mcp({ source: 'project' })] }));
    assert.strictEqual(pr[0].title, 'MCP servers');
    assert.ok(!buildEntries(scope({})).some(x => x.title === 'MCP servers'));
    assert.ok(!buildEntries(scope({ scope: 'project' })).some(x => x.title === 'MCP servers'));
  })) p++; else f++;

  if (test('MCP entry: kind mcp, key, sublabel from command or url, source/disabled badge, no file', () => {
    const g = buildEntries(scope({ mcpServers: [
      mcp({}),
      mcp({ name: 'remote', transport: 'http', command: null, args: [], url: 'https://x/mcp' }),
      mcp({ name: 'off', source: 'plugin:bm', disabled: true })
    ] }));
    const entries = g.find(x => x.title === 'MCP servers')!.entries;
    const cg = entries.find(e => e.label === 'codegraph')!;
    assert.strictEqual(cg.kind, 'mcp');
    if (cg.kind === 'mcp') assert.strictEqual(cg.mcp.name, 'codegraph');
    assert.strictEqual(cg.key, 'mcp:user:codegraph');
    assert.strictEqual(cg.sublabel, 'stdio · codegraph');
    assert.strictEqual(cg.badge, 'user');
    assert.strictEqual(cg.filePath, null);
    assert.strictEqual(entries.find(e => e.label === 'remote')!.sublabel, 'http · https://x/mcp');
    const off = entries.find(e => e.label === 'off')!;
    assert.strictEqual(off.badge, 'disabled');
    assert.strictEqual(off.subgroup, 'bm');
  })) p++; else f++;

  if (test('MCP subgroups: user and local rows before plugin:* rows', () => {
    const g = buildEntries(scope({ mcpServers: [
      mcp({ name: 'aaa', source: 'plugin:alpha' }),
      mcp({ name: 'zzz', source: 'user' }),
      mcp({ name: 'mmm', source: 'local' })
    ] }));
    const entries = g.find(x => x.title === 'MCP servers')!.entries;
    assert.deepStrictEqual(entries.map(e => e.subgroup), ['local', 'user', 'alpha']);
  })) p++; else f++;

  console.log(`\nmanagementEntries: ${p} passed, ${f} failed`);
  return f;
}
