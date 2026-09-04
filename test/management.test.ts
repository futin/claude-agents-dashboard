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

/**
 * Fake ~/.claude/projects root with one transcript per spec, carrying cwd.
 * `originCwd` makes the transcript drift: it is written as the launch cwd on
 * the head record and `cwd` lands on a later one, the way a session that
 * chdir'd into a worktree records it.
 */
function makeProjectsRoot(
  specs: { dirName: string; id: string; cwd: string | null; originCwd?: string; mtimeMs: number }[]
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mroot-'));
  for (const s of specs) {
    const dir = path.join(root, s.dirName);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(s.mtimeMs).toISOString();
    const recs = [
      s.cwd !== null
        ? { cwd: s.originCwd ?? s.cwd, gitBranch: 'main', version: '2.1.0', timestamp: stamp, type: 'user' }
        : { type: 'user' },
      ...(s.originCwd && s.cwd !== null ? [{ cwd: s.cwd, type: 'user', timestamp: stamp }] : []),
      { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100 } }, timestamp: stamp }
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

  tally(await test('listRecentProjects: a dir whose newest transcript chdir\'d into a worktree publishes the repo, not the worktree', async () => {
    // bug-14. One dir, newest transcript launched at the repo root and chdir'd
    // into a worktree; the older one never left the root. Only the newest is
    // read, so the repo survives only if the launch cwd is what gets published.
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const HOUR = 3600_000;
    const repo = makeProject();
    const worktree = path.join(repo, '.worktrees', 'X');
    const root = makeProjectsRoot([
      { dirName: '-repo', id: 'wt', cwd: worktree, originCwd: repo, mtimeMs: NOW - 1 * HOUR },
      { dirName: '-repo', id: 'old', cwd: repo, mtimeMs: NOW - 3 * HOUR }
    ]);
    const refs = mgmt.listRecentProjects({ lookbackHours: 24 }, { root, now: NOW });
    assert.deepStrictEqual(refs.map(r => r.path), [repo]);
  }));

  tally(await test('listRecentProjects: one entry per dirName, so a drifted dir cannot collide with itself', async () => {
    // dirName is the key the rail uses for React keys and the spawn <option>
    // values, and /api/management/project resolves it to exactly one path.
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const repo = makeProject();
    const root = makeProjectsRoot([
      { dirName: '-repo', id: 'wt', cwd: path.join(repo, '.worktrees', 'X'), originCwd: repo, mtimeMs: NOW - 1000 }
    ]);
    const dirNames = mgmt.listRecentProjects({ lookbackHours: 24 }, { root, now: NOW }).map(r => r.dirName);
    assert.deepStrictEqual(dirNames, [...new Set(dirNames)]);
  }));

  tally(await test('resolveProject: a drifted dir resolves to its launch repo, not the worktree', async () => {
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const repo = makeProject();
    const root = makeProjectsRoot([
      { dirName: '-repo', id: 'wt', cwd: path.join(repo, '.worktrees', 'X'), originCwd: repo, mtimeMs: NOW - 1000 }
    ]);
    const hit = mgmt.resolveProject({ lookbackHours: 24 }, '-repo', { root, now: NOW });
    assert.strictEqual(hit && hit.path, repo);
  }));

  // The multi-dir case: the worktree was itself launched in, so it has its own
  // project dir and an older entry for that same cwd. Each dir must keep its own
  // path — the repo's dir resolving to the worktree would spawn there, and the
  // worktree's dir losing its entry drops it off the rail. Which of the two
  // breaks first depends on the order `readdirSync` hands back the dirs, so both
  // orders are pinned.
  for (const [label, ownerDir] of [['after', '-repo-worktrees-X'], ['before', '-a-worktree-owner']]) {
    tally(await test(`resolveProject: an older dir holding the worktree cwd (sorting ${label} the repo's) keeps both dirs intact`, async () => {
      const NOW = Date.parse('2026-07-12T12:00:00Z');
      const HOUR = 3600_000;
      const repo = makeProject();
      const worktree = path.join(repo, '.worktrees', 'X');
      const root = makeProjectsRoot([
        { dirName: ownerDir, id: 'own', cwd: worktree, mtimeMs: NOW - 5 * HOUR },
        { dirName: '-repo', id: 'wt', cwd: worktree, originCwd: repo, mtimeMs: NOW - 1 * HOUR }
      ]);
      const cfg = { lookbackHours: 24 };
      const refs = mgmt.listRecentProjects(cfg, { root, now: NOW });
      assert.deepStrictEqual(refs.map(r => r.path).sort(), [repo, worktree].sort());
      const repoRef = mgmt.resolveProject(cfg, '-repo', { root, now: NOW });
      assert.strictEqual(repoRef && repoRef.path, repo);
      const wtRef = mgmt.resolveProject(cfg, ownerDir, { root, now: NOW });
      assert.strictEqual(wtRef && wtRef.path, worktree);
    }));
  }

  tally(await test('encodeProjectDir matches the ~/.claude/projects naming', async () => {
    assert.strictEqual(
      mgmt.encodeProjectDir('/Users/a/p/backlog-manager/.worktrees/merge-mode'),
      '-Users-a-p-backlog-manager--worktrees-merge-mode'
    );
  }));

  tally(await test('listRecentProjects: each dir publishes the cwd it is named for, not the one the session drifted from', async () => {
    // Observed live: a session launched in the repo and chdir'd into a worktree
    // writes into BOTH project dirs, and the copy sitting in the worktree's own
    // dir still reports the repo as its originCwd. Keying off the launch cwd
    // alone would make that dir publish the repo too, lose the key to the repo's
    // own newer dir, and drop the worktree off the rail entirely.
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const HOUR = 3600_000;
    const repo = makeProject();
    const worktree = path.join(repo, '.worktrees', 'X');
    const repoDir = mgmt.encodeProjectDir(repo);
    const wtDir = mgmt.encodeProjectDir(worktree);
    const root = makeProjectsRoot([
      { dirName: repoDir, id: 'a', cwd: worktree, originCwd: repo, mtimeMs: NOW - 1 * HOUR },
      { dirName: wtDir, id: 'b', cwd: worktree, originCwd: repo, mtimeMs: NOW - 2 * HOUR }
    ]);
    const cfg = { lookbackHours: 24 };
    const refs = mgmt.listRecentProjects(cfg, { root, now: NOW });
    assert.deepStrictEqual(refs.map(r => r.path).sort(), [repo, worktree].sort());
    assert.strictEqual(mgmt.resolveProject(cfg, repoDir, { root, now: NOW })!.path, repo);
    assert.strictEqual(mgmt.resolveProject(cfg, wtDir, { root, now: NOW })!.path, worktree);
  }));

  tally(await test('listRecentProjects: an unresolvable launch cwd falls open to the newest cwd alone', async () => {
    // The complement: originCwd is null by design when the head window holds no
    // cwd, so the entry is the newest cwd and nothing else — no null path, no
    // phantom project. Padding puts the file past the 256 KB tail window while
    // its head carries no cwd record.
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const worktree = path.join(makeProject(), '.worktrees', 'X');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-mroot-'));
    const file = path.join(root, '-nohead', 'pad.jsonl');
    const recs = [
      ...Array.from({ length: 900 }, (_, i) => ({ type: 'progress', note: 'p' + i + '-' + 'x'.repeat(280) })),
      { cwd: worktree, gitBranch: 'main', version: '2.1.0', timestamp: new Date(NOW).toISOString(), type: 'user' },
      { message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100 } }, timestamp: new Date(NOW).toISOString() }
    ];
    put(root, '-nohead/pad.jsonl', recs.map(r => JSON.stringify(r)).join('\n'));
    fs.utimesSync(file, NOW / 1000, NOW / 1000);
    const refs = mgmt.listRecentProjects({ lookbackHours: 24 }, { root, now: NOW });
    assert.deepStrictEqual(refs.map(r => r.path), [worktree]);
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

  tally(await test('skill dir with only SKILL.md → files omitted', async () => {
    const home = makeHome();
    put(home, '.claude/skills/solo/SKILL.md', SKILL_MD);
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.skills.length, 1);
    assert.strictEqual(scope.skills[0].files, undefined);
  }));

  tally(await test('skill dir files: SKILL.md first then rel-sorted, sizes, nested rels, dotfiles skipped', async () => {
    const home = makeHome();
    put(home, '.claude/skills/rich/SKILL.md', SKILL_MD);
    put(home, '.claude/skills/rich/zeta.md', 'z');
    put(home, '.claude/skills/rich/references/api.md', 'ab');
    put(home, '.claude/skills/rich/scripts/run.sh', 'abc');
    put(home, '.claude/skills/rich/.hidden.md', 'nope');
    put(home, '.claude/skills/rich/.git/config', 'nope');
    const scope = await mgmt.readGlobalScope(home);
    const files = scope.skills[0].files!;
    assert.deepStrictEqual(files.map(f => f.rel), ['SKILL.md', 'references/api.md', 'scripts/run.sh', 'zeta.md']);
    assert.strictEqual(files[0].size, SKILL_MD.length);
    assert.strictEqual(files[1].size, 2);
    assert.strictEqual(files[2].size, 3);
    assert.strictEqual(files[3].size, 1);
  }));

  tally(await test('skill dir files: walk stops past max depth', async () => {
    const home = makeHome();
    put(home, '.claude/skills/deep/SKILL.md', SKILL_MD);
    put(home, '.claude/skills/deep/a/b/c/ok.md', 'x');
    put(home, '.claude/skills/deep/a/b/c/d/too-deep.md', 'x');
    const scope = await mgmt.readGlobalScope(home);
    const rels = scope.skills[0].files!.map(f => f.rel);
    assert.ok(rels.includes('a/b/c/ok.md'));
    assert.ok(!rels.includes('a/b/c/d/too-deep.md'));
  }));

  tally(await test('skill dir files: capped at SKILL_FILES_CAP, SKILL.md kept', async () => {
    const home = makeHome();
    put(home, '.claude/skills/many/SKILL.md', SKILL_MD);
    for (let i = 0; i < mgmt.SKILL_FILES_CAP + 20; i++) {
      put(home, `.claude/skills/many/f${String(i).padStart(4, '0')}.md`, 'x');
    }
    const scope = await mgmt.readGlobalScope(home);
    const files = scope.skills[0].files!;
    assert.strictEqual(files.length, mgmt.SKILL_FILES_CAP);
    assert.strictEqual(files[0].rel, 'SKILL.md');
  }));

  tally(await test('skill dir files: symlinks are never listed (they would escape the servable set)', async () => {
    const home = makeHome();
    put(home, '.claude/skills/linky/SKILL.md', SKILL_MD);
    const secret = put(home, '.claude/.credentials.json', '{"secret":true}');
    fs.symlinkSync(secret, path.join(home, '.claude/skills/linky/creds.json'));
    fs.symlinkSync(path.join(home, '.claude'), path.join(home, '.claude/skills/linky/escape'));
    const scope = await mgmt.readGlobalScope(home);
    assert.strictEqual(scope.skills[0].files, undefined);
  }));

  tally(await test('collectServablePaths: every listed skill file is servable; skipped dotfile is not', async () => {
    const NOW = Date.parse('2026-07-12T12:00:00Z');
    const home = makeHome();
    put(home, '.claude/skills/rich/SKILL.md', SKILL_MD);
    const ref = put(home, '.claude/skills/rich/references/api.md', 'ab');
    const script = put(home, '.claude/skills/rich/scripts/run.sh', 'abc');
    const hidden = put(home, '.claude/skills/rich/.secret.md', 'no');
    const root = makeProjectsRoot([]);
    const allowed = await mgmt.collectServablePaths({ lookbackHours: 24 }, { root, now: NOW, homeDir: home });
    assert.ok(allowed.has(ref));
    assert.ok(allowed.has(script));
    assert.ok(!allowed.has(hidden));
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
