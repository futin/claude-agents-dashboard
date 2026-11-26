/**
 * Pins the shape of the dashboard plugin (docs/superpowers/specs/2026-10-01-dashboard-plugin-design.md).
 *
 * A manifest that parses but does not install — a plugin name that disagrees with its marketplace entry, a source path that moved — only fails on a user's
 * machine, at `/plugin install`. And anything plugin-shaped that lands in `plugin/` (an `.mcp.json`, a `hooks/`) loads in every project on every machine
 * that installed it, which is the reason the plugin lives in a subfolder at all. Adding either on purpose means editing this file.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generate, LIB_MODULES } from '../../scripts/gen-plugin-lib.js';
import { parseFrontmatter } from '../../shared/frontmatter.js';
import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Every skill the plugin ships. A new one is added here deliberately, beside its directory. */
const SKILLS = ['git-sync', 'kaizen'];

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

export function run(): number {
  console.log('\n=== plugin manifest ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const marketPath = path.join(root, '.claude-plugin', 'marketplace.json');
  const pluginJsonPath = path.join(root, 'plugin', '.claude-plugin', 'plugin.json');

  if (test('both manifests parse as JSON', () => {
    readJson(marketPath);
    readJson(pluginJsonPath);
  })) p++; else f++;

  if (test('the marketplace lists exactly one plugin, named as plugin.json names it, sourced from ./plugin', () => {
    const market = readJson(marketPath);
    const plugin = readJson(pluginJsonPath);
    assert.ok(Array.isArray(market.plugins), 'marketplace.plugins is an array');
    assert.strictEqual(market.plugins.length, 1);
    const [entry] = market.plugins;
    assert.strictEqual(entry.name, plugin.name);
    assert.strictEqual(entry.source, './plugin');
    assert.ok(fs.existsSync(path.join(root, entry.source, '.claude-plugin', 'plugin.json')), 'the source dir holds .claude-plugin/plugin.json');
  })) p++; else f++;

  if (test('plugin.json carries a semver version', () => {
    const { version } = readJson(pluginJsonPath);
    assert.match(String(version), /^\d+\.\d+\.\d+$/);
  })) p++; else f++;

  if (test('plugin/ holds only .claude-plugin, lib and skills — nothing else loads in every project, and never bin/', () => {
    const entries = fs.readdirSync(path.join(root, 'plugin')).sort();
    assert.deepStrictEqual(entries, ['.claude-plugin', 'lib', 'skills']);
  })) p++; else f++;

  if (test('plugin/lib/ holds exactly the seven generated .mjs modules plus the hand-written run-routine.mjs wrapper', () => {
    assert.strictEqual(LIB_MODULES.length, 7);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'plugin', 'lib')).sort(), [...LIB_MODULES.map((m) => m.out), 'run-routine.mjs'].sort());
  })) p++; else f++;

  for (const m of LIB_MODULES) {
    if (test(`plugin/lib/${m.out} is ${m.source} transpiled — a TS edit without \`pnpm plugin:gen\` fails here`, () => {
      const expected = generate(fs.readFileSync(path.join(root, m.source), 'utf8'));
      assert.strictEqual(fs.readFileSync(path.join(root, 'plugin', 'lib', m.out), 'utf8'), expected);
    })) p++; else f++;
  }

  if (test('every import in a generated module is a node: builtin or a sibling the generator also writes — anything else is a missing file once installed', () => {
    const generated = new Set(LIB_MODULES.map((m) => m.out));
    for (const m of LIB_MODULES) {
      const text = fs.readFileSync(path.join(root, 'plugin', 'lib', m.out), 'utf8');
      // `from '…'` covers import and re-export; `import '…'` / `import('…')` the bare and dynamic forms.
      for (const [, a, b] of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = a ?? b;
        assert.ok(spec.startsWith('node:') || (spec.startsWith('./') && generated.has(spec.slice(2))), `${m.out} imports ${spec}, which is neither node: nor a generated sibling`);
      }
    }
  })) p++; else f++;

  if (test('the generated modules load under plain node with no package.json, and parseJob works — a broken specifier fails here', () => {
    const entry = pathToFileURL(path.join(root, 'plugin', 'lib', 'routine-file.mjs')).href;
    const file = ['---', 'cron: "0 9 * * *"', 'run: claude', '---', '/git-sync', ''].join('\n');
    const script = `const m = await import(${JSON.stringify(entry)}); const r = m.parseJob('tiny', ${JSON.stringify(file)}, 'mac'); `
      + 'process.stdout.write(JSON.stringify({ errors: r.errors, cron: r.job && r.job.cron }));';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: path.join(root, 'plugin') });
    assert.deepStrictEqual(JSON.parse(out), { errors: [], cron: '0 9 * * *' });
  })) p++; else f++;

  if (test('kaizen.mjs loads its generated modules under plain node with no package.json — a bad relative path fails here', () => {
    const kaizen = path.join(root, 'plugin', 'skills', 'kaizen', 'kaizen.mjs');
    const script = `await import(${JSON.stringify(pathToFileURL(kaizen).href)}); process.stdout.write('ok');`;
    // Importing runs no CLI: the entry check compares argv[1] to the file, and here argv[1] is absent.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: path.join(root, 'plugin') });
    assert.strictEqual(out.endsWith('ok'), true);
  })) p++; else f++;

  if (test('run-routine.mjs takes PERMISSION_MODES from the validator, never a copy of its own', () => {
    const text = fs.readFileSync(path.join(root, 'plugin', 'lib', 'run-routine.mjs'), 'utf8');
    assert.ok(!/\b(const|let|var)\s+PERMISSION_MODES\b/.test(text), 'run-routine.mjs declares its own PERMISSION_MODES');
    assert.match(text, /import\s*\{[^}]*\bPERMISSION_MODES\b[^}]*\}\s*from\s*'\.\/routine-file\.mjs'/);
  })) p++; else f++;

  if (test('no generated module keeps an import of types.js or a .js specifier — types are erased, siblings are .mjs', () => {
    for (const { out: name } of LIB_MODULES) {
      const text = fs.readFileSync(path.join(root, 'plugin', 'lib', name), 'utf8');
      assert.ok(!/types\.js/.test(text), `${name} mentions types.js`);
      assert.ok(!/from\s+['"]\.\/[\w-]+\.js['"]/.test(text), `${name} imports a .js sibling`);
    }
  })) p++; else f++;

  if (test('plugin/skills/ holds exactly the shipped skills, each SKILL.md named after its directory', () => {
    const dir = path.join(root, 'plugin', 'skills');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [...SKILLS].sort());
    for (const name of SKILLS) {
      const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8'));
      assert.strictEqual(data.name, name, `${name}/SKILL.md frontmatter name`);
    }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
