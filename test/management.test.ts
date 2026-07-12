import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as mgmt from '../server/lib/management.js';

function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); return true; })
    .catch(e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; });
}

/** Write a file under root, creating parent dirs. Returns the absolute path. */
function put(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** Fresh tmpdir acting as $HOME (`.claude` lives inside). */
function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cad-home-'));
}

/** Fresh tmpdir acting as one project working directory. */
function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cad-proj-'));
}

/** Fake ~/.claude/projects root with one transcript per spec, carrying cwd. */
function makeProjectsRoot(specs: { dirName: string; id: string; cwd: string | null; mtimeMs: number }[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mroot-'));
  for (const s of specs) {
    const dir = path.join(root, s.dirName);
    fs.mkdirSync(dir, { recursive: true });
    const recs = [
      s.cwd !== null
        ? { cwd: s.cwd, gitBranch: 'main', version: '2.1.0', timestamp: new Date(s.mtimeMs).toISOString(), type: 'user' }
        : { type: 'user' },
      { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100 } }, timestamp: new Date(s.mtimeMs).toISOString() }
    ];
    const file = path.join(dir, s.id + '.jsonl');
    fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n'));
    fs.utimesSync(file, s.mtimeMs / 1000, s.mtimeMs / 1000);
  }
  return root;
}

const SKILL_MD = '---\nname: my-skill\ndescription: >\n  Does one thing.\n  Well.\n---\n# body\n';

/** Install one plugin into home's plugin cache; returns its installPath. */
function putPlugin(home: string, key: string, opts: { pluginJson?: object | null; withHooks?: boolean } = {}): string {
  const [name, marketplace] = key.split('@');
  const installPath = path.join(home, '.claude', 'plugins', 'cache', marketplace, name, '1.0.0');
  fs.mkdirSync(installPath, { recursive: true });
  if (opts.pluginJson !== null) {
    put(installPath, '.claude-plugin/plugin.json', JSON.stringify(opts.pluginJson ?? { name, description: 'a plugin', version: '1.0.0' }));
  }
  put(installPath, 'skills/plug-skill/SKILL.md', SKILL_MD);
  put(installPath, 'agents/helper.md', '---\nname: helper\ndescription: agent desc\ntools: Read\n---\nbody');
  put(installPath, 'rules/tone.md', 'Always terse.');
  put(installPath, 'commands/go.toml', 'description = "run it"\nprompt = "..."');
  put(installPath, 'commands/go2.md', '---\ndescription: md command\n---\nbody');
  if (opts.withHooks !== false) {
    put(installPath, 'scripts/on-start.sh', '#!/bin/sh\necho hi');
    put(installPath, 'hooks/hooks.json', JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/on-start.sh' }] }] }
    }));
  }
  const reg = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  let plugins: Record<string, unknown[]> = {};
  if (fs.existsSync(reg)) plugins = JSON.parse(fs.readFileSync(reg, 'utf8')).plugins;
  plugins[key] = [{ scope: 'user', installPath, version: '1.0.0' }];
  put(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins }));
  return installPath;
}

/** Async: management.ts is promise-based; run-all awaits this (top-level await). */
export async function run(): Promise<number> {
  console.log('\n=== management.ts ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean) => { if (ok) p++; else f++; };

  tally(await test('global scope lists user skills with frontmatter name/description; dir without SKILL.md skipped', async () => {
    const home = makeHome();
    put(home, '.claude/skills/study/SKILL.md', SKILL_MD);
    fs.mkdirSync(path.join(home, '.claude/skills/not-a-skill'), { recursive: true });
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.scope, 'global');
    assert.strictEqual(scope.skills.length, 1);
    assert.strictEqual(scope.skills[0].name, 'my-skill');
    assert.strictEqual(scope.skills[0].description, 'Does one thing. Well.');
    assert.strictEqual(scope.skills[0].source, 'user');
    assert.ok(scope.skills[0].path.endsWith('/study/SKILL.md'));
  }));

  tally(await test('missing skills/agents/rules dirs → empty arrays, no throw', async () => {
    const home = makeHome();
    const scope = await mgmt.readGlobalScope(home);
    assert.deepStrictEqual(scope.skills, []);
    assert.deepStrictEqual(scope.agents, []);
    assert.deepStrictEqual(scope.rules, []);
    assert.deepStrictEqual(scope.commands, []);
    assert.deepStrictEqual(scope.hooks, []);
    assert.deepStrictEqual(scope.plugins, []);
  }));

  tally(await test('commands: nested subdir .md included; plugin .toml with stem name + greppable description', async () => {
    const home = makeHome();
    put(home, '.claude/commands/top.md', '---\ndescription: top cmd\n---\n');
    put(home, '.claude/commands/ns/inner.md', 'body only');
    putPlugin(home, 'plug@mkt');
    const scope = await mgmt.readGlobalScope(home);
    const names = scope.commands.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['go', 'go2', 'inner', 'top']);
    const toml = scope.commands.find(c => c.name === 'go')!;
    assert.strictEqual(toml.description, 'run it');
    assert.strictEqual(toml.source, 'plugin:plug');
  }));

  tally(await test('hooks flattened from settings.json with source user + declaredIn', async () => {
    const home = makeHome();
    const script = put(home, '.claude/hooks/stop.sh', '#!/bin/sh\necho done');
    const settings = put(home, '.claude/settings.json', JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: script }] }],
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'osascript -e beep' }] }]
      }
    }));
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.hooks.length, 2);
    const stop = scope.hooks.find(h => h.event === 'Stop')!;
    assert.strictEqual(stop.matcher, null);
    assert.strictEqual(stop.source, 'user');
    assert.strictEqual(stop.declaredIn, settings);
    assert.strictEqual(stop.scriptPath, script);
    const pre = scope.hooks.find(h => h.event === 'PreToolUse')!;
    assert.strictEqual(pre.matcher, 'AskUserQuestion');
    assert.strictEqual(pre.scriptPath, null);
  }));

  tally(await test('plugin hooks.json flattened with plugin source and ${CLAUDE_PLUGIN_ROOT} resolved to scriptPath', async () => {
    const home = makeHome();
    const installPath = putPlugin(home, 'plug@mkt');
    const scope = await mgmt.readGlobalScope(home);
    const hook = scope.hooks.find(h => h.source === 'plugin:plug')!;
    assert.strictEqual(hook.event, 'SessionStart');
    assert.strictEqual(hook.matcher, 'startup');
    assert.strictEqual(hook.scriptPath, path.join(installPath, 'scripts/on-start.sh'));
    assert.ok(hook.declaredIn.endsWith('hooks/hooks.json'));
  }));

  tally(await test('plugin without .claude-plugin/plugin.json → name from key, manifestPath null', async () => {
    const home = makeHome();
    putPlugin(home, 'bare@mkt', { pluginJson: null });
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.plugins.length, 1);
    assert.strictEqual(scope.plugins[0].name, 'bare');
    assert.strictEqual(scope.plugins[0].marketplace, 'mkt');
    assert.strictEqual(scope.plugins[0].manifestPath, null);
    assert.strictEqual(scope.plugins[0].description, null);
  }));

  tally(await test('plugin with stale/missing installPath → listed with zero counts', async () => {
    const home = makeHome();
    put(home, '.claude/plugins/installed_plugins.json', JSON.stringify({
      version: 2,
      plugins: { 'ghost@mkt': [{ scope: 'user', installPath: path.join(home, 'nope'), version: '9' }] }
    }));
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.plugins.length, 1);
    assert.strictEqual(scope.plugins[0].key, 'ghost@mkt');
    assert.deepStrictEqual(scope.plugins[0].counts, { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0 });
  }));

  tally(await test('malformed installed_plugins.json → plugins [], rest of scope intact', async () => {
    const home = makeHome();
    put(home, '.claude/plugins/installed_plugins.json', '{not json');
    put(home, '.claude/skills/s/SKILL.md', SKILL_MD);
    const scope = await mgmt.readGlobalScope(home);
    assert.deepStrictEqual(scope.plugins, []);
    assert.strictEqual(scope.skills.length, 1);
  }));

  tally(await test('enabledPlugins false → enabled:false but still listed', async () => {
    const home = makeHome();
    putPlugin(home, 'plug@mkt');
    put(home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'plug@mkt': false } }));
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.plugins[0].enabled, false);
  }));

  tally(await test('memory: global CLAUDE.md listed only when present; project lists both locations', async () => {
    const home = makeHome();
    assert.deepStrictEqual((await mgmt.readGlobalScope(home)).memory, []);
    put(home, '.claude/CLAUDE.md', '# global');
    assert.strictEqual((await mgmt.readGlobalScope(home)).memory.length, 1);

    const proj = makeProject();
    put(proj, 'CLAUDE.md', '# root');
    put(proj, '.claude/CLAUDE.md', '# nested');
    const scope = await mgmt.readProjectScope(proj);
    assert.strictEqual(scope.memory.length, 2);
    assert.ok(scope.memory.every(m => m.source === 'project'));
  }));

  tally(await test('project scope reads .claude skills + settings files with exists flags', async () => {
    const proj = makeProject();
    put(proj, '.claude/skills/local/SKILL.md', SKILL_MD);
    put(proj, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } }));
    const scope = await mgmt.readProjectScope(proj);
    assert.strictEqual(scope.scope, 'project');
    assert.strictEqual(scope.skills.length, 1);
    assert.strictEqual(scope.skills[0].source, 'project');
    assert.strictEqual(scope.hooks.length, 1);
    const s = Object.fromEntries(scope.settings.map(x => [x.label, x.exists]));
    assert.deepStrictEqual(s, { 'settings.json': true, 'settings.local.json': false });
  }));

  tally(await test('listRecentProjects: dedupes by cwd, respects lookback, newest-first, skips cwd-less', async () => {
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const HOUR = 3600_000;
    const projA = makeProject();
    const projB = makeProject();
    const root = makeProjectsRoot([
      { dirName: '-a-old', id: 'a1', cwd: projA, mtimeMs: NOW - 5 * HOUR },
      { dirName: '-a-new', id: 'a2', cwd: projA, mtimeMs: NOW - 1 * HOUR },
      { dirName: '-b', id: 'b1', cwd: projB, mtimeMs: NOW - 2 * HOUR },
      { dirName: '-stale', id: 's1', cwd: makeProject(), mtimeMs: NOW - 48 * HOUR },
      { dirName: '-nocwd', id: 'n1', cwd: null, mtimeMs: NOW - 1 * HOUR }
    ]);
    const refs = mgmt.listRecentProjects({ lookbackHours: 24 }, { root, now: NOW });
    assert.deepStrictEqual(refs.map(r => r.path), [projA, projB]);
    assert.strictEqual(refs[0].dirName, '-a-new');
    assert.strictEqual(refs[0].name, path.basename(projA));
  }));

  tally(await test('resolveProject: known dirName → ref; unknown → null', async () => {
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const proj = makeProject();
    const root = makeProjectsRoot([{ dirName: '-p', id: 'p1', cwd: proj, mtimeMs: NOW - 1000 }]);
    const hit = mgmt.resolveProject({ lookbackHours: 24 }, '-p', { root, now: NOW });
    assert.strictEqual(hit && hit.path, proj);
    assert.strictEqual(mgmt.resolveProject({ lookbackHours: 24 }, '-other', { root, now: NOW }), null);
  }));

  tally(await test('readProjectScope on nonexistent path → all-empty scope, no throw', async () => {
    const scope = await mgmt.readProjectScope('/nonexistent/path/xyz');
    assert.deepStrictEqual(scope.skills, []);
    assert.deepStrictEqual(scope.memory, []);
    assert.strictEqual(scope.error, undefined);
  }));

  tally(await test('collectServablePaths: includes item/declaredIn/scriptPath/manifest paths; excludes planted secrets', async () => {
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const home = makeHome();
    const skill = put(home, '.claude/skills/s/SKILL.md', SKILL_MD);
    const installPath = putPlugin(home, 'plug@mkt');
    const settings = put(home, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } }));
    const creds = put(home, '.claude/.credentials.json', '{"secret":true}');
    const hist = put(home, '.claude/history.jsonl', '{"cmd":"secret"}');
    const proj = makeProject();
    const projSkill = put(proj, '.claude/skills/t/SKILL.md', SKILL_MD);
    const envFile = put(proj, '.env', 'API_KEY=hush');
    const root = makeProjectsRoot([{ dirName: '-p', id: 'p1', cwd: proj, mtimeMs: NOW - 1000 }]);

    const allowed = await mgmt.collectServablePaths({ lookbackHours: 24 }, { root, now: NOW, homeDir: home });
    assert.ok(allowed.has(skill));
    assert.ok(allowed.has(projSkill));
    assert.ok(allowed.has(settings));
    assert.ok(allowed.has(path.join(installPath, '.claude-plugin/plugin.json')));
    assert.ok(allowed.has(path.join(installPath, 'scripts/on-start.sh')));
    assert.ok(!allowed.has(creds));
    assert.ok(!allowed.has(hist));
    assert.ok(!allowed.has(envFile));
  }));

  tally(await test('readServableFile: member served; non-member and ..-path rejected', async () => {
    const home = makeHome();
    const skill = put(home, '.claude/skills/s/SKILL.md', SKILL_MD);
    const secret = put(home, '.claude/.credentials.json', 'secret');
    const allowed = new Set([skill]);
    const ok = await mgmt.readServableFile(skill, allowed);
    assert.ok(ok);
    assert.strictEqual(ok!.content, SKILL_MD);
    assert.strictEqual(ok!.truncated, false);
    assert.strictEqual(await mgmt.readServableFile(secret, allowed), null);
    const sneaky = home + '/.claude/skills/s/../s/SKILL.md';
    assert.ok(sneaky.includes('..'));
    assert.strictEqual(await mgmt.readServableFile(sneaky, allowed), null);
    assert.strictEqual(await mgmt.readServableFile('relative/path.md', allowed), null);
  }));

  tally(await test('readServableFile truncates beyond cap with truncated flag + real size', async () => {
    const home = makeHome();
    const big = put(home, '.claude/skills/big/SKILL.md', 'x'.repeat(1000));
    const r = await mgmt.readServableFile(big, new Set([big]), 100);
    assert.ok(r);
    assert.strictEqual(r!.size, 1000);
    assert.strictEqual(r!.content.length, 100);
    assert.strictEqual(r!.truncated, true);
  }));

  console.log(`\nmanagement: ${p} passed, ${f} failed`);
  return f;
}
