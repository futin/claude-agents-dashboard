/**
 * server/lib/plugin-trim.ts — the allowlist read, the deny map, the cached inventory, the trim file and its prune, the resume lookup. The lister is
 * stubbed (`setPluginLister`), so no real `claude` runs; `DASHBOARD_STATE_DIR` and `BM_HEADLESS_FILE` point at a tmpdir.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INVENTORY_TTL_MS, denyMap, existingTrimFile, parsePluginList, resolveTrimFile, setPluginLister, trimDir, trimMap, writeTrimFile,
  type PluginLister
} from '../../server/lib/plugin-trim.js';
import type { Config } from '../../server/lib/config.js';

async function testAsync(name: string, fn: () => Promise<void> | void): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const INVENTORY = [
  { id: 'backlog-manager@bm', scope: 'user', enabled: true },
  { id: 'superpowers@official', scope: 'user', enabled: true },
  { id: 'caveman@caveman', scope: 'user', enabled: true },
  { id: 'timify-jira@inline', scope: 'session', enabled: true },
  { id: 'timify-core@synced', scope: 'user', enabled: true },
  { id: 'cc-plugin-sec-default@builtin', scope: 'user', enabled: true },
  { id: 'old@bm', scope: 'user', enabled: false },
];
const CONFIG = { claudeBin: 'claude' } as Config;
const REF = { path: '/proj/a' };
const ENTRIES = INVENTORY.map(p => ({ id: p.id, enabled: p.enabled }));

/** A lister answering `stdout` and counting its calls. */
function counting(stdout: string = JSON.stringify(INVENTORY)): PluginLister & { calls: number } {
  const fn = Object.assign(async () => { fn.calls++; return stdout; }, { calls: 0 });
  return fn;
}

/** Run `fn` with a fresh state dir and headless-file path under one tmpdir, `console.warn` recorded; everything restored after. */
async function withTmp(fn: (t: { dir: string; headless: string; warns: string[]; env: NodeJS.ProcessEnv }) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-trim-'));
  const headless = path.join(dir, 'headless.json');
  const prevState = process.env.DASHBOARD_STATE_DIR;
  const prevWarn = console.warn;
  const warns: string[] = [];
  process.env.DASHBOARD_STATE_DIR = dir;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    setPluginLister(counting());
    await fn({ dir, headless, warns, env: { ...process.env, BM_HEADLESS_FILE: headless } });
  } finally {
    console.warn = prevWarn;
    if (prevState === undefined) delete process.env.DASHBOARD_STATE_DIR; else process.env.DASHBOARD_STATE_DIR = prevState;
    setPluginLister(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(): Promise<number> {
  console.log('\n=== plugin-trim.ts ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('no headless.json: the default allowlist switches off exactly the three others', () => withTmp(async t => {
    assert.deepStrictEqual(await trimMap(CONFIG, REF, [], t.env), {
      'caveman@caveman': false, 'timify-jira@inline': false, 'timify-core@synced': false
    });
    assert.deepStrictEqual(t.warns, [], 'an absent file is the default, not a malformed one');
  })));

  check(await testAsync('keepPlugins matches by bare name or full id, never by a different marketplace', () => {
    assert.ok(!('timify-jira@inline' in denyMap(ENTRIES, ['backlog-manager', 'superpowers', 'timify-jira'])));
    assert.ok(!('timify-jira@inline' in denyMap(ENTRIES, ['backlog-manager', 'superpowers', 'timify-jira@inline'])));
    assert.strictEqual(denyMap(ENTRIES, ['backlog-manager', 'superpowers', 'timify-jira@other'])['timify-jira@inline'], false);
  }));

  check(await testAsync('an empty allowlist still keeps backlog-manager, and switches superpowers off', () => withTmp(async t => {
    fs.writeFileSync(t.headless, JSON.stringify({ enabled: true, plugins: [] }));
    const map = await trimMap(CONFIG, REF, [], t.env);
    assert.ok(map && !('backlog-manager@bm' in map));
    assert.strictEqual(map?.['superpowers@official'], false);
  })));

  check(await testAsync('a @builtin plugin and an already-disabled one never appear, whatever the list', () => {
    for (const allow of [[], ['superpowers'], ['caveman', 'timify-core']]) {
      const map = denyMap(ENTRIES, allow);
      assert.ok(!('cc-plugin-sec-default@builtin' in map), `builtin kept for ${JSON.stringify(allow)}`);
      assert.ok(!('old@bm' in map), `disabled not written for ${JSON.stringify(allow)}`);
    }
  }));

  check(await testAsync('enabled: false is no trim: null, no file, the lister never asked', () => withTmp(async t => {
    const lister = counting();
    setPluginLister(lister);
    fs.writeFileSync(t.headless, JSON.stringify({ enabled: false, plugins: ['superpowers'] }));
    assert.strictEqual(await resolveTrimFile(CONFIG, REF, 'sid-1', [], t.env), null);
    assert.ok(!fs.existsSync(trimDir()) || fs.readdirSync(trimDir()).length === 0);
    assert.strictEqual(lister.calls, 0);
  })));

  check(await testAsync('a malformed headless.json is no trim with exactly one warn naming the file', async () => {
    const bad = ['{not json', JSON.stringify({ enabled: true, plugins: 'superpowers' }), JSON.stringify({ enabled: true, plugins: ['a b'] }),
      JSON.stringify({ enabled: true, plugins: Array.from({ length: 33 }, (_, i) => `p${i}`) }), JSON.stringify({ plugins: [] })];
    for (const text of bad) {
      await withTmp(async t => {
        fs.writeFileSync(t.headless, text);
        assert.strictEqual(await resolveTrimFile(CONFIG, REF, 'sid-1', [], t.env), null, text);
        assert.strictEqual(t.warns.length, 1, `one warn for ${text}`);
        assert.ok(t.warns[0].includes(t.headless), 'the warn names the file');
      });
    }
  }));

  check(await testAsync('a failing lister is no trim with one warn: rejects, non-zero, not JSON, not an array, timeout', async () => {
    const nonZero = Object.assign(new Error('Command failed: claude plugin list --json'), { code: 1 });
    const timeout = Object.assign(new Error('Command failed: claude plugin list --json'), { killed: true, signal: 'SIGTERM' });
    const listers: PluginLister[] = [
      async () => { throw new Error('spawn claude ENOENT'); },
      async () => { throw nonZero; },
      async () => 'not json',
      async () => JSON.stringify({ plugins: INVENTORY }),
      async () => { throw timeout; },
    ];
    for (const [i, l] of listers.entries()) {
      await withTmp(async t => {
        setPluginLister(l);
        assert.strictEqual(await resolveTrimFile(CONFIG, REF, 'sid-1', [], t.env), null, `lister ${i}`);
        assert.strictEqual(t.warns.length, 1, `one warn for lister ${i}`);
      });
    }
  }));

  check(await testAsync('an inventory of only allowlisted and builtin plugins is no trim and no file', () => withTmp(async t => {
    setPluginLister(counting(JSON.stringify([INVENTORY[0], INVENTORY[1], INVENTORY[5], INVENTORY[6]])));
    assert.strictEqual(await resolveTrimFile(CONFIG, REF, 'sid-1', [], t.env), null);
    assert.ok(!fs.existsSync(path.join(trimDir(), 'sid-1.json')));
  })));

  check(await testAsync('success writes <stateDir>/.plugin-trim/<id>.json holding enabledPlugins and nothing else', () => withTmp(async t => {
    const file = await resolveTrimFile(CONFIG, REF, 'sid-1', [], t.env);
    assert.strictEqual(file, path.join(t.dir, '.plugin-trim', 'sid-1.json'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file as string, 'utf8')), {
      enabledPlugins: { 'caveman@caveman': false, 'timify-jira@inline': false, 'timify-core@synced': false }
    });
  })));

  check(await testAsync('the inventory is cached per project path for 10 minutes', () => withTmp(async t => {
    const lister = counting();
    setPluginLister(lister);
    const t0 = 1_000_000;
    await trimMap(CONFIG, REF, [], t.env, t0);
    await trimMap(CONFIG, REF, [], t.env, t0 + INVENTORY_TTL_MS - 1);
    assert.strictEqual(lister.calls, 1, 'one call inside the window');
    await trimMap(CONFIG, { path: '/proj/b' }, [], t.env, t0 + 1);
    assert.strictEqual(lister.calls, 2, 'another path asks again');
    await trimMap(CONFIG, REF, [], t.env, t0 + INVENTORY_TTL_MS);
    assert.strictEqual(lister.calls, 3, 'an expired entry asks again');
  })));

  check(await testAsync('two concurrent resolves on a cold entry share one lister call', () => withTmp(async t => {
    const lister = counting();
    setPluginLister(lister);
    await Promise.all([trimMap(CONFIG, REF, [], t.env), trimMap(CONFIG, REF, [], t.env)]);
    assert.strictEqual(lister.calls, 1);
  })));

  check(await testAsync('a write prunes a 31-day-old trim file and keeps a 29-day-old one', () => withTmp(() => {
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    fs.mkdirSync(trimDir(), { recursive: true });
    const old = path.join(trimDir(), 'old.json');
    const recent = path.join(trimDir(), 'recent.json');
    for (const [file, age] of [[old, 31], [recent, 29]] as const) {
      fs.writeFileSync(file, '{}');
      const at = new Date(now - age * day);
      fs.utimesSync(file, at, at);
    }
    assert.ok(writeTrimFile('sid-2', { 'caveman@caveman': false }, now));
    assert.ok(!fs.existsSync(old), '31 days old is pruned');
    assert.ok(fs.existsSync(recent), '29 days old is kept');
  })));

  check(await testAsync('existingTrimFile: the path with its mtime refreshed when the file exists, null otherwise', () => withTmp(() => {
    assert.strictEqual(existingTrimFile('sid-3'), null);
    const file = writeTrimFile('sid-3', { 'caveman@caveman': false }) as string;
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000);
    fs.utimesSync(file, old, old);
    const now = Date.now();
    assert.strictEqual(existingTrimFile('sid-3', now), file);
    assert.ok(Math.abs(fs.statSync(file).mtimeMs - now) < 2000, 'mtime refreshed');
    assert.strictEqual(existingTrimFile('../sid-3'), null, 'an id outside the charset is never a path');
  })));

  check(await testAsync('parsePluginList: duplicates dropped, 32 kept, 33 or a bad shape refused', () => {
    assert.deepStrictEqual(parsePluginList(['a', 'b@m', 'a']), ['a', 'b@m']);
    assert.strictEqual(parsePluginList(Array.from({ length: 32 }, (_, i) => `p${i}`))?.length, 32);
    for (const bad of ['a', Array.from({ length: 33 }, (_, i) => `p${i}`), ['a b'], ['a@b@c'], [1], null]) {
      assert.strictEqual(parsePluginList(bad), null, JSON.stringify(bad));
    }
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
