/**
 * The `settings.json` merge of `scripts/install-hooks.sh` — what it does with a file it cannot merge into (backlog #507).
 *
 * The bug: the script runs under `set -u` only, so a failed jq never stopped it. A trailing comma made every row take the add path, `add_entry`'s jq exited 5
 * with no stdout, `current` became "", and the write guard (`jq empty`, which accepts empty input) let it through — settings.json was replaced by a newline,
 * every user key gone, and each re-run wrote the newline again. So this file drives the real script WITHOUT `--dry-run`, against a throwaway
 * `CLAUDE_CONFIG_DIR` and `HOME`, and asserts on the bytes left on disk:
 *
 *   - a file that is not exactly one JSON object is refused up front, byte-identical afterwards, no backup, no links — in every mode;
 *   - a valid object jq cannot merge our rows into is refused per row (install and `--uninstall`), never written, links untouched;
 *   - a valid file still installs, keeping every user key.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The six installed link names — `LINKS` in the script. */
const LINK_NAMES = ['ask-remote.sh', 'plan-remote.sh', 'permission-notify.sh', 'stop-notify.sh', 'remote-decision.sh', 'kill-guard.sh'];

interface Scratch {
  repo: string;
  claude: string;
  settings: string;
  cleanup(): void;
}

function makeScratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-installer-settings-'));
  const repo = path.join(dir, 'repo');
  const claude = path.join(dir, 'claude');
  // `scripts/` is copied, not linked: the script finds its root with `cd "$(dirname "$0")/.."`, which a symlinked dir would send to the real checkout.
  fs.cpSync(path.join(REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const entry of ['node_modules', 'server', 'shared', 'package.json']) {
    fs.symlinkSync(path.join(REPO, entry), path.join(repo, entry));
  }
  fs.mkdirSync(claude, { recursive: true });
  return { repo, claude, settings: path.join(claude, 'settings.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface Result {
  status: number | null;
  out: string;
}

function install(s: Scratch, ...flags: string[]): Result {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: s.claude, HOME: path.join(s.repo, '..') };
  delete env.ANSWER_TOKEN;
  const r = spawnSync('bash', [path.join(s.repo, 'scripts', 'install-hooks.sh'), ...flags], { encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const backups = (s: Scratch): string[] => fs.readdirSync(s.claude).filter(n => n.startsWith('settings.json.bak.'));
const links = (s: Scratch): string[] => {
  const dir = path.join(s.claude, 'hooks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => fs.lstatSync(path.join(dir, n)).isSymbolicLink()) : [];
};
const commands = (settings: unknown): string[] =>
  Object.values((settings as { hooks?: Record<string, { hooks: { command: string }[] }[]> }).hooks ?? {})
    .flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));

/**
 * Run the script on `body` and assert the refusal: non-zero exit, a REFUSED line, the file byte-identical, no backup written, and the hooks/ links exactly
 * as they were — a refusal that lands after the symlinks leaves an install half-done (links with no entries, or entries pointing at removed links).
 */
function assertRefused(s: Scratch, body: string, flags: string[] = []): Result {
  fs.writeFileSync(s.settings, body);
  const before = links(s).sort();
  const r = install(s, ...flags);
  assert.notStrictEqual(r.status, 0, `expected a non-zero exit, got 0:\n${r.out}`);
  assert.match(r.out, /REFUSED/, `expected a REFUSED line:\n${r.out}`);
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), body, 'settings.json must be left byte-identical');
  assert.deepStrictEqual(backups(s), [], 'a refused run writes no backup');
  assert.deepStrictEqual(links(s).sort(), before, 'the refusal comes before the symlinks: no link made or removed');
  return r;
}

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== install-hooks.sh: a settings.json it cannot merge into is refused, never replaced ===\n');

  if (spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.log('  ⚠ SKIPPED — jq is not installed, and install-hooks.sh exits before the merge without it. These cases did not run.');
    return 0;
  }

  let p = 0, f = 0;
  const fresh = (fn: (s: Scratch) => void) => () => { const s = makeScratch(); try { fn(s); } finally { s.cleanup(); } };

  if (test('a trailing comma (a hand edit) is refused and the file left byte-identical', fresh(s => {
    assertRefused(s, '{\n  "model": "opus",\n  "permissions": {"allow": []},\n}\n');
  }))) p++; else f++;

  if (test('a re-run on a refused file refuses again, never degrading it', fresh(s => {
    const body = '{"model": "opus",}';
    assertRefused(s, body);
    assertRefused(s, body);
  }))) p++; else f++;

  if (test('a whitespace-only file (what the old bug left behind) is refused, not read as {}', fresh(s => {
    assertRefused(s, '\n');
  }))) p++; else f++;

  if (test('valid JSON that is not an object is refused', fresh(s => {
    assertRefused(s, '[]\n');
    assertRefused(s, '"settings"\n');
  }))) p++; else f++;

  if (test('two concatenated objects (a snippet pasted after the original) are refused, not read as the last one', fresh(s => {
    assertRefused(s, '{"model": "opus"}\n{"hooks": {}}\n');
  }))) p++; else f++;

  if (test('--uninstall and --dry-run refuse a malformed file too', fresh(s => {
    assertRefused(s, '{"model": "opus",}', ['--uninstall']);
    assertRefused(s, '{"model": "opus",}', ['--dry-run']);
  }))) p++; else f++;

  if (test('an object whose hooks block jq cannot merge into is refused per row, not written empty', fresh(s => {
    assertRefused(s, '{"model": "opus", "hooks": {"Stop": "oops"}}\n');
  }))) p++; else f++;

  if (test('--uninstall refuses a hooks block jq cannot read, keeping the entries and the links', fresh(s => {
    const ok = install(s);
    assert.strictEqual(ok.status, 0, ok.out);
    assert.strictEqual(links(s).length, LINK_NAMES.length);
    // A string hook under an event we never register: jq errors (exit 5) reading it, which must not pass for "not registered".
    const merged = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
    merged.hooks.Foo = [{ hooks: ['x'] }];
    const body = JSON.stringify(merged, null, 2) + '\n';
    for (const b of backups(s)) fs.rmSync(path.join(s.claude, b));
    assert.strictEqual(links(s).length, LINK_NAMES.length);
    assertRefused(s, body, ['--uninstall']);
  }))) p++; else f++;

  if (test('a valid file keeps every user key and gains all eight entries, with a backup', fresh(s => {
    fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
    const r = install(s);
    assert.strictEqual(r.status, 0, r.out);
    const after = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
    assert.strictEqual(after.model, 'opus');
    assert.deepStrictEqual(after.permissions, { allow: ['Bash(ls)'] });
    const cmds = commands(after);
    assert.ok(cmds.includes('mine'), 'a hook the user registered is kept');
    assert.strictEqual(cmds.length, 9, `eight entries plus the user's own, got:\n${cmds.join('\n')}`);
    assert.strictEqual(backups(s).length, 1);
    assert.strictEqual(links(s).length, LINK_NAMES.length);
    const again = install(s);
    assert.strictEqual(again.status, 0, again.out);
    assert.match(again.out, /no changes needed/, 'a re-run changes nothing');
  }))) p++; else f++;

  if (test('no settings file and a zero-byte one both install from {}', fresh(s => {
    for (const setup of [() => fs.rmSync(s.settings, { force: true }), () => fs.writeFileSync(s.settings, '')]) {
      setup();
      const r = install(s);
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(commands(JSON.parse(fs.readFileSync(s.settings, 'utf8'))).length, 8);
    }
  }))) p++; else f++;

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
