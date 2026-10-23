/**
 * `scripts/sync-plugin.ts` — reinstalls the dashboard plugin so the installed copy matches the pushed repo.
 *
 * A plugin install is a copy keyed by the version in plugin.json, so an edit under plugin/ changes nothing for a running session, and `claude plugin update`
 * stops at "already at the latest version" while the version stays put. The script's whole value is in noticing drift and refusing to install a tree GitHub
 * does not have, so those halves are what is tested here: the digests, the refusal ladder, bringing a checkout level with origin/main (against throwaway git
 * repos in tmpdir), and reading the install record. The `claude plugin` calls are not run — a test that reinstalled this machine's plugin to prove a string
 * would be worse than none.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bringCheckoutCurrent, checkoutGate, driftedPaths, hashTree, PLUGIN_ID, PUBLISHED_PATHS, postReconcile, publishedDigests, readInstall,
} from '../scripts/sync-plugin.js';
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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commitFile(cwd: string, rel: string, body: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), body);
  git(cwd, 'add', '--', rel);
  git(cwd, 'commit', '-q', '-m', `edit ${rel}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A bare origin, a `stale` clone of it, and a `peer` clone that has since pushed `merged` more commits — the shape of a checkout that never pulled a PR
 * merged on GitHub. The stale clone's origin/main still points at the old tip until something fetches.
 */
function staleCheckout(merged = 1): { stale: string; tip: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-plugin-git-'));
  const origin = path.join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const peer = path.join(base, 'peer');
  git(base, 'clone', '-q', origin, peer);
  commitFile(peer, 'plugin/skills/git-sync/SKILL.md', 'v1');
  commitFile(peer, 'README.md', 'readme');
  git(peer, 'push', '-q', 'origin', 'HEAD:main');
  const stale = path.join(base, 'stale');
  git(base, 'clone', '-q', origin, stale);
  let tip = '';
  for (let i = 0; i < merged; i++) tip = commitFile(peer, 'plugin/skills/git-sync/SKILL.md', `v${i + 2} carry-trunk`);
  git(peer, 'push', '-q', 'origin', 'HEAD:main');
  return { stale, tip };
}

const PLUGIN = {
  '.claude-plugin/plugin.json': '{"name":"x"}',
  'skills/a/SKILL.md': 'a',
  'skills/b/tools/b.mjs': 'b',
};

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
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

  if (test('publishedDigests covers .claude-plugin, hooks, lib and skills, and ignores files beside them', () => {
    assert.deepStrictEqual(PUBLISHED_PATHS, ['.claude-plugin', 'hooks', 'lib', 'skills']);
    const clean = publishedDigests(tree(PLUGIN));
    const marked = publishedDigests(tree({ ...PLUGIN, '.in_use': '', '.orphaned_at': '1' }));
    assert.deepStrictEqual(Object.keys(clean), ['.claude-plugin', 'hooks', 'lib', 'skills']);
    assert.deepStrictEqual(marked, clean);
  })) p++; else f++;

  if (test('publishedDigests: an edit under hooks/ is drift', () => {
    const clean = publishedDigests(tree(PLUGIN));
    const edited = publishedDigests(tree({ ...PLUGIN, 'hooks/register.ts': 'export const register = () => {}' }));
    assert.notStrictEqual(edited.hooks, clean.hooks);
    assert.deepStrictEqual(driftedPaths(edited, clean), ['hooks']);
  })) p++; else f++;

  if (test('publishedDigests: engine-written types under .claude-plugin/types/ are not drift', () => {
    const clean = publishedDigests(tree(PLUGIN));
    const typed = publishedDigests(tree({ ...PLUGIN, '.claude-plugin/types/claude-code.d.ts': 'declare module "claude-code" {}' }));
    assert.deepStrictEqual(typed, clean);
  })) p++; else f++;

  if (test('driftedPaths names only the differing paths, in PUBLISHED_PATHS order, and an absent path is drift', () => {
    const repo = { '.claude-plugin': 'm', hooks: 'h', skills: 's' };
    assert.deepStrictEqual(driftedPaths(repo, { '.claude-plugin': 'm', hooks: 'h', skills: 's' }), []);
    assert.deepStrictEqual(driftedPaths(repo, { '.claude-plugin': 'm', hooks: 'h', skills: 'S' }), ['skills']);
    assert.deepStrictEqual(driftedPaths(repo, { skills: '', hooks: '', '.claude-plugin': '' }), ['.claude-plugin', 'hooks', 'skills']);
  })) p++; else f++;

  const message = (gate: ReturnType<typeof checkoutGate>): string => {
    assert.strictEqual(gate.kind, 'refuse', `expected a refusal, got ${gate.kind}`);
    return (gate as { message: string }).message;
  };

  if (test('checkoutGate: a clean, pushed, up-to-date tree passes', () => {
    assert.deepStrictEqual(checkoutGate({ branch: 'main', dirty: [], ahead: 0, behind: 0 }), { kind: 'ok' });
  })) p++; else f++;

  if (test('checkoutGate: a branch other than main refuses first — the marketplace installs main', () => {
    const msg = message(checkoutGate({ branch: 'feat/x', dirty: [' M plugin/skills/a/SKILL.md'], ahead: 1, behind: 0 }));
    assert.match(msg, /feat\/x/);
    assert.match(msg, /main/);
    assert.doesNotMatch(msg, /SKILL\.md/);
  })) p++; else f++;

  if (test('checkoutGate: uncommitted files under plugin/ are named, and outrank ahead/behind', () => {
    const msg = message(checkoutGate({ branch: 'main', dirty: [' M plugin/skills/kaizen/SKILL.md', '?? plugin/skills/new/'], ahead: 2, behind: 1 }));
    assert.match(msg, /plugin\/skills\/kaizen\/SKILL\.md/);
    assert.match(msg, /plugin\/skills\/new\//);
    assert.match(msg, /commit/i);
    assert.doesNotMatch(msg, /git push/);
  })) p++; else f++;

  if (test('checkoutGate: unpushed commits refuse with the push command, and outrank behind', () => {
    const msg = message(checkoutGate({ branch: 'main', dirty: [], ahead: 3, behind: 1 }));
    assert.match(msg, /3 commit/);
    assert.match(msg, /git push/);
  })) p++; else f++;

  if (test('checkoutGate: a clean main that is only behind origin/main fast-forwards rather than refusing', () => {
    assert.deepStrictEqual(checkoutGate({ branch: 'main', dirty: [], ahead: 0, behind: 2 }), { kind: 'fast-forward' });
  })) p++; else f++;

  if (test('bringCheckoutCurrent: a checkout that never pulled a merged PR is fetched and fast-forwarded to it', () => {
    const { stale, tip } = staleCheckout(2);
    // The 2026-10-15 shape: without a fetch, this clone believes it is level with origin/main.
    assert.strictEqual(git(stale, 'rev-list', '--count', 'HEAD..origin/main'), '0');
    const result = bringCheckoutCurrent(stale);
    assert.deepStrictEqual(result, { fastForwarded: 2, head: tip });
    assert.strictEqual(fs.readFileSync(path.join(stale, 'plugin/skills/git-sync/SKILL.md'), 'utf8'), 'v3 carry-trunk');
  })) p++; else f++;

  if (test('bringCheckoutCurrent: an uncommitted edit outside plugin/ survives the fast-forward', () => {
    const { stale, tip } = staleCheckout();
    fs.writeFileSync(path.join(stale, 'README.md'), 'local edit');
    assert.deepStrictEqual(bringCheckoutCurrent(stale), { fastForwarded: 1, head: tip });
    assert.strictEqual(fs.readFileSync(path.join(stale, 'README.md'), 'utf8'), 'local edit');
  })) p++; else f++;

  if (test('bringCheckoutCurrent: an uncommitted edit the fast-forward would overwrite refuses, and nothing moves', () => {
    const { stale } = staleCheckout();
    const before = git(stale, 'rev-parse', 'HEAD');
    // Outside plugin/, so checkoutGate passes it and only git's own overwrite check stands between it and the merge.
    commitFile(path.join(stale, '..', 'peer'), 'README.md', 'upstream');
    git(path.join(stale, '..', 'peer'), 'push', '-q', 'origin', 'HEAD:main');
    fs.writeFileSync(path.join(stale, 'README.md'), 'local edit');
    const result = bringCheckoutCurrent(stale);
    assert.ok(result.refused, 'refuses');
    assert.match(result.refused!, /2 commit\(s\) behind/);
    assert.match(result.refused!, /git pull --ff-only/);
    assert.strictEqual(git(stale, 'rev-parse', 'HEAD'), before);
    assert.strictEqual(fs.readFileSync(path.join(stale, 'README.md'), 'utf8'), 'local edit');
  })) p++; else f++;

  if (test('bringCheckoutCurrent: an already-level checkout reports 0 and its HEAD', () => {
    const { stale, tip } = staleCheckout();
    git(stale, 'pull', '-q', '--ff-only');
    assert.deepStrictEqual(bringCheckoutCurrent(stale), { fastForwarded: 0, head: tip });
  })) p++; else f++;

  if (test('bringCheckoutCurrent: an unreachable origin refuses rather than trusting a stale origin/main', () => {
    const { stale } = staleCheckout();
    git(stale, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'sync-plugin-no-such-origin.git'));
    const result = bringCheckoutCurrent(stale);
    assert.ok(result.refused, 'refuses');
    assert.match(result.refused!, /could not fetch origin\/main/);
  })) p++; else f++;

  if (test('main brings the checkout current before it compares digests — the order the 2026-10-15 "in sync" bug got wrong', () => {
    const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const source = fs.readFileSync(path.join(root, 'scripts', 'sync-plugin.ts'), 'utf8');
    const body = source.slice(source.indexOf('function main('));
    const current = body.indexOf('bringCheckoutCurrent(REPO_ROOT)');
    const digests = body.indexOf('publishedDigests(PLUGIN_ROOT)');
    assert.ok(current > 0 && digests > 0, 'both calls are in main');
    assert.ok(current < digests, 'bringCheckoutCurrent runs first');
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

  if (await testAsync('postReconcile: one POST of { apply: true } to /api/routines/reconcile on 127.0.0.1, resolves true', async () => {
    const seen: Array<{ method?: string; url?: string; type?: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { seen.push({ method: req.method, url: req.url, type: String(req.headers['content-type']), body }); res.end('{}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      assert.strictEqual(await postReconcile((server.address() as net.AddressInfo).port), true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].url, '/api/routines/reconcile');
    assert.match(seen[0].type!, /application\/json/);
    assert.deepStrictEqual(JSON.parse(seen[0].body), { apply: true });
  })) p++; else f++;

  if (await testAsync('postReconcile: a closed port resolves false within the timeout, never throws', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const started = Date.now();
    assert.strictEqual(await postReconcile(port, 500), false);
    assert.ok(Date.now() - started < 1500, 'resolved inside the timeout window');
  })) p++; else f++;

  if (await testAsync('postReconcile: a listener that never answers resolves false at the timeout', async () => {
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      assert.strictEqual(await postReconcile((server.address() as net.AddressInfo).port, 300), false);
      assert.ok(Date.now() - started < 1500, 'gave up near the timeout');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  })) p++; else f++;

  if (test('main POSTs the reconcile with the API port from loadConfig after a successful reinstall, and ignores the result', () => {
    const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const source = fs.readFileSync(path.join(root, 'scripts', 'sync-plugin.ts'), 'utf8');
    const body = source.slice(source.indexOf('function main('));
    assert.match(body, /postReconcile\(loadConfig\(.*\)\.port\)/);
    assert.ok(body.indexOf('postReconcile(') > body.indexOf("installed v${after.version}"), 'after the success line');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
