/**
 * `scripts/sync-plugin.ts` — reinstalls the dashboard plugin so the installed copy matches the pushed repo.
 *
 * A plugin install is a copy keyed by the version in plugin.json, so an edit under plugin/ changes nothing for a running session, and `claude plugin update`
 * stops at "already at the latest version" while the version stays put. The script's whole value is in noticing drift and refusing to install a tree GitHub
 * does not have, so those halves are what is tested here: the digests, the refusal ladder, and reading the install record. The `claude plugin` calls are not
 * run — a test that reinstalled this machine's plugin to prove a string would be worse than none.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { driftedPaths, hashTree, PLUGIN_ID, PUBLISHED_PATHS, publishBlocker, publishedDigests, readInstall } from '../scripts/sync-plugin.js';
import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-plugin-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const PLUGIN = {
  '.claude-plugin/plugin.json': '{"name":"x"}',
  'skills/a/SKILL.md': 'a',
  'skills/b/tools/b.mjs': 'b',
};

export function run(): number {
  console.log('\n=== sync-plugin ===\n');
  let p = 0, f = 0;

  if (test('PLUGIN_ID is <plugin.json name>@<marketplace.json name>', () => {
    const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.strictEqual(PLUGIN_ID, `${plugin.name}@${market.name}`);
  })) p++; else f++;

  if (test('hashTree: the same files written in a different order hash the same', () => {
    const reversed = Object.fromEntries(Object.entries(PLUGIN).reverse());
    assert.strictEqual(hashTree(tree(PLUGIN)), hashTree(tree(reversed)));
  })) p++; else f++;

  if (test('hashTree: a byte change, a rename and a deletion each move the digest', () => {
    const base = hashTree(tree(PLUGIN));
    assert.notStrictEqual(hashTree(tree({ ...PLUGIN, 'skills/a/SKILL.md': 'A' })), base, 'byte change');
    const { 'skills/a/SKILL.md': moved, ...rest } = PLUGIN;
    assert.notStrictEqual(hashTree(tree({ ...rest, 'skills/a/SKILL2.md': moved })), base, 'rename');
    assert.notStrictEqual(hashTree(tree(rest)), base, 'deletion');
  })) p++; else f++;

  if (test('hashTree: a missing root hashes to the empty string', () => {
    assert.strictEqual(hashTree(path.join(os.tmpdir(), 'sync-plugin-does-not-exist')), '');
  })) p++; else f++;

  if (test('publishedDigests covers .claude-plugin and skills, and ignores files beside them', () => {
    assert.deepStrictEqual(PUBLISHED_PATHS, ['.claude-plugin', 'skills']);
    const clean = publishedDigests(tree(PLUGIN));
    const marked = publishedDigests(tree({ ...PLUGIN, '.in_use': '', '.orphaned_at': '1' }));
    assert.deepStrictEqual(Object.keys(clean), ['.claude-plugin', 'skills']);
    assert.deepStrictEqual(marked, clean);
  })) p++; else f++;

  if (test('driftedPaths names only the differing paths, in PUBLISHED_PATHS order, and an absent path is drift', () => {
    const repo = { '.claude-plugin': 'm', skills: 's' };
    assert.deepStrictEqual(driftedPaths(repo, { '.claude-plugin': 'm', skills: 's' }), []);
    assert.deepStrictEqual(driftedPaths(repo, { '.claude-plugin': 'm', skills: 'S' }), ['skills']);
    assert.deepStrictEqual(driftedPaths(repo, { skills: '', '.claude-plugin': '' }), ['.claude-plugin', 'skills']);
  })) p++; else f++;

  if (test('publishBlocker: a clean, pushed, up-to-date tree passes', () => {
    assert.strictEqual(publishBlocker({ branch: 'main', dirty: [], ahead: 0, behind: 0 }), undefined);
  })) p++; else f++;

  if (test('publishBlocker: a branch other than main refuses first — the marketplace installs main', () => {
    const msg = publishBlocker({ branch: 'feat/x', dirty: [' M plugin/skills/a/SKILL.md'], ahead: 1, behind: 0 });
    assert.ok(msg, 'refuses');
    assert.match(msg!, /feat\/x/);
    assert.match(msg!, /main/);
    assert.doesNotMatch(msg!, /SKILL\.md/);
  })) p++; else f++;

  if (test('publishBlocker: uncommitted files under plugin/ are named, and outrank ahead/behind', () => {
    const msg = publishBlocker({ branch: 'main', dirty: [' M plugin/skills/kaizen/SKILL.md', '?? plugin/skills/new/'], ahead: 2, behind: 1 });
    assert.ok(msg, 'refuses');
    assert.match(msg!, /plugin\/skills\/kaizen\/SKILL\.md/);
    assert.match(msg!, /plugin\/skills\/new\//);
    assert.match(msg!, /commit/i);
    assert.doesNotMatch(msg!, /git push/);
  })) p++; else f++;

  if (test('publishBlocker: unpushed commits refuse with the push command, and outrank behind', () => {
    const msg = publishBlocker({ branch: 'main', dirty: [], ahead: 3, behind: 1 });
    assert.ok(msg, 'refuses');
    assert.match(msg!, /3 commit/);
    assert.match(msg!, /git push/);
  })) p++; else f++;

  if (test('publishBlocker: a HEAD behind origin/main refuses with the pull command', () => {
    const msg = publishBlocker({ branch: 'main', dirty: [], ahead: 0, behind: 2 });
    assert.ok(msg, 'refuses');
    assert.match(msg!, /2 commit/);
    assert.match(msg!, /git pull --ff-only/);
  })) p++; else f++;

  if (test('readInstall: no file, or no entry for this plugin, reads as not installed', () => {
    assert.strictEqual(readInstall(path.join(os.tmpdir(), 'sync-plugin-no-installed.json')), undefined);
    const other = path.join(tree({ 'i.json': JSON.stringify({ plugins: { 'other@m': [{ scope: 'user', installPath: '/x' }] } }) }), 'i.json');
    assert.strictEqual(readInstall(other), undefined);
  })) p++; else f++;

  if (test('readInstall: prefers the user-scope entry over a project-scope one listed first', () => {
    const entries = [
      { scope: 'project', installPath: '/p', version: '0.1.0' },
      { scope: 'user', installPath: '/u', version: '0.1.0', gitCommitSha: 'abc' },
    ];
    const file = path.join(tree({ 'i.json': JSON.stringify({ plugins: { [PLUGIN_ID]: entries } }) }), 'i.json');
    assert.strictEqual(readInstall(file)?.installPath, '/u');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
