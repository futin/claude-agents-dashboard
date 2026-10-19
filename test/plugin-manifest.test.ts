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

import ts from 'typescript';

import { parseFrontmatter } from '../shared/frontmatter.js';
import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Every skill the plugin ships. A new one is added here deliberately, beside its directory. */
const SKILLS = ['git-sync', 'kaizen'];

/** The shared modules the schedule wrapper runs, generated into plugin/lib by `pnpm plugin:gen` (scripts/gen-plugin-lib.ts). */
const LIB_MODULES = ['cron', 'frontmatter', 'schedule-file'];

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

  if (test('plugin/lib/ holds exactly the three generated .mjs modules', () => {
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'plugin', 'lib')).sort(), LIB_MODULES.map((m) => `${m}.mjs`));
  })) p++; else f++;

  for (const name of LIB_MODULES) {
    if (test(`plugin/lib/${name}.mjs is shared/${name}.ts transpiled — a TS edit without \`pnpm plugin:gen\` fails here`, () => {
      const source = fs.readFileSync(path.join(root, 'shared', `${name}.ts`), 'utf8');
      const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      const expected = outputText.replace(/(from\s+['"]\.\/[\w-]+)\.js(['"])/g, '$1.mjs$2');
      assert.strictEqual(fs.readFileSync(path.join(root, 'plugin', 'lib', `${name}.mjs`), 'utf8'), expected);
    })) p++; else f++;
  }

  if (test('the generated modules load under plain node with no package.json, and parseJob works — a broken specifier fails here', () => {
    const entry = pathToFileURL(path.join(root, 'plugin', 'lib', 'schedule-file.mjs')).href;
    const file = ['---', 'cron: "0 9 * * *"', 'machines: [mac]', 'run: claude', '---', '/git-sync', ''].join('\n');
    const script = `const m = await import(${JSON.stringify(entry)}); const r = m.parseJob('tiny', ${JSON.stringify(file)}); `
      + 'process.stdout.write(JSON.stringify({ errors: r.errors, cron: r.job && r.job.cron }));';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: path.join(root, 'plugin') });
    assert.deepStrictEqual(JSON.parse(out), { errors: [], cron: '0 9 * * *' });
  })) p++; else f++;

  if (test('no generated module keeps an import of types.js or a .js specifier — types are erased, siblings are .mjs', () => {
    for (const name of LIB_MODULES) {
      const text = fs.readFileSync(path.join(root, 'plugin', 'lib', `${name}.mjs`), 'utf8');
      assert.ok(!/types\.js/.test(text), `${name}.mjs mentions types.js`);
      assert.ok(!/from\s+['"]\.\/[\w-]+\.js['"]/.test(text), `${name}.mjs imports a .js sibling`);
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
