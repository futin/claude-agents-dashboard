/**
 * The `settings.json` merge of `scripts/install-hooks.sh` — `add_entry`, `drop_entry`, `entry_present`, `has_entry` and `write_settings` (backlog #507, #508).
 *
 * The bug that started it: the script runs under `set -u` only, so a failed jq never stopped it. A trailing comma made every row take the add path,
 * `add_entry`'s jq exited 5 with no stdout, `current` became "", and the write guard (`jq empty`, which accepts empty input) let it through — settings.json
 * was replaced by a newline, every user key gone, and each re-run wrote the newline again. So this file drives the real script WITHOUT `--dry-run`, against
 * a throwaway `CLAUDE_CONFIG_DIR` and `HOME`, and asserts on the bytes left on disk:
 *
 *   - a file that is not exactly one JSON object is refused up front, byte-identical afterwards, no backup, no links — in every mode;
 *   - a valid object jq cannot merge our rows into is refused per row (install and `--uninstall`), never written, links untouched;
 *   - a valid file installs, and with our eight entries taken back out it is the user's file again, key order included — install, re-install and
 *     `--uninstall` alike, foreign hooks sharing a matcher group with ours kept in that group;
 *   - `--dry-run` writes nothing, `--force` is what replaces a real file on a link path, and the default `~/.claude` keeps the literal `$HOME` commands.
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

function runScript(s: Scratch, env: Record<string, string | undefined>, flags: string[]): Result {
  delete env.ANSWER_TOKEN;
  const r = spawnSync('bash', [path.join(s.repo, 'scripts', 'install-hooks.sh'), ...flags], { encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function install(s: Scratch, ...flags: string[]): Result {
  return runScript(s, { ...process.env, CLAUDE_CONFIG_DIR: s.claude, HOME: path.join(s.repo, '..') }, flags);
}

/** The default layout: no `CLAUDE_CONFIG_DIR`, so the script installs into `$HOME/.claude`. */
function installAtHome(s: Scratch, home: string): Result {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  return runScript(s, env, []);
}

interface Hook { type?: string; command: string; timeout?: number }
interface Group { matcher?: string; hooks: Hook[] }
interface Settings { hooks?: Record<string, Group[]>; [key: string]: unknown }

const read = (s: Scratch): Settings => JSON.parse(fs.readFileSync(s.settings, 'utf8')) as Settings;
const write = (s: Scratch, settings: Settings): void => fs.writeFileSync(s.settings, JSON.stringify(settings, null, 2) + '\n');

/** The command `entry_cmd` registers for `name` under a custom `CLAUDE_CONFIG_DIR` — the spelled-out path, not the literal `$HOME`. */
const ourCmd = (s: Scratch, name: string): string => `bash "${path.join(s.claude, 'hooks', name)}"`;

/** `ENTRIES` in the script: event, matcher, installed name. */
const ENTRY_ROWS: [string, string, string][] = [
  ['PreToolUse', 'AskUserQuestion', 'ask-remote.sh'],
  ['PreToolUse', 'Bash', 'kill-guard.sh'],
  ['PermissionRequest', 'ExitPlanMode', 'plan-remote.sh'],
  ['PermissionRequest', '', 'permission-notify.sh'],
  ['Notification', '', 'permission-notify.sh'],
  ['Stop', '', 'stop-notify.sh'],
  ['UserPromptSubmit', '', 'remote-decision.sh'],
  ['SessionStart', 'compact|resume|clear', 'remote-decision.sh'],
];
const expectedRows = (s: Scratch): string[] => ENTRY_ROWS.map(([ev, m, name]) => `${ev}|${m}|${ourCmd(s, name)}`).sort();

/** Every registration of one of our commands as `event|matcher|command`, sorted — a duplicate shows up as a repeated row. */
function ourRows(s: Scratch, settings: Settings): string[] {
  const mine = new Set(LINK_NAMES.map(n => ourCmd(s, n)));
  return Object.entries(settings.hooks ?? {})
    .flatMap(([ev, groups]) => groups.flatMap(g => g.hooks.filter(h => mine.has(h.command)).map(h => `${ev}|${g.matcher ?? ''}|${h.command}`)))
    .sort();
}

/** `settings` with our commands taken out, and the groups and events that leaves empty — what an install should be the exact inverse of. */
function withoutOurs(s: Scratch, settings: Settings): Settings {
  const mine = new Set(LINK_NAMES.map(n => ourCmd(s, n)));
  const copy = structuredClone(settings);
  for (const [ev, groups] of Object.entries(copy.hooks ?? {})) {
    const kept = groups.map(g => ({ ...g, hooks: g.hooks.filter(h => !mine.has(h.command)) })).filter(g => g.hooks.length > 0);
    if (kept.length > 0) copy.hooks![ev] = kept; else delete copy.hooks![ev];
  }
  return copy;
}

/**
 * A user's own settings.json: keys we never touch, a hook of theirs in the very groups ours join (`PreToolUse` `Bash`, the matcher-less `Stop`), one in
 * a `PreToolUse` group we never write, and one under an event we never register.
 */
const FOREIGN: Settings = {
  model: 'opus',
  env: { FOO: '1' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard', timeout: 3 }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'my-edit' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'my-stop' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'my-post' }] }],
  },
  statusLine: { type: 'command', command: 'my-status' },
};

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
  console.log('\n=== install-hooks.sh: the settings.json merge — refusals, install, re-install, --uninstall, --dry-run, --force ===\n');

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

  if (test('install into a user’s file adds each of the eight entries once, and taking them back out leaves their file, key order included', fresh(s => {
    write(s, FOREIGN);
    const r = install(s);
    assert.strictEqual(r.status, 0, r.out);
    const after = read(s);
    assert.deepStrictEqual(ourRows(s, after), expectedRows(s));
    assert.strictEqual(JSON.stringify(withoutOurs(s, after)), JSON.stringify(FOREIGN), 'nothing of the user’s was changed, moved or reordered');
    const group = (ev: string, m?: string) => after.hooks![ev].find(g => g.matcher === m)!.hooks.map(h => h.command);
    assert.deepStrictEqual(group('PreToolUse', 'Bash'), ['my-bash-guard', ourCmd(s, 'kill-guard.sh')], 'kill-guard joins the user’s Bash group, after theirs');
    assert.deepStrictEqual(group('Stop'), ['my-stop', ourCmd(s, 'stop-notify.sh')], 'stop-notify joins the user’s matcher-less Stop group');
  }))) p++; else f++;

  if (test('a re-install leaves the file byte-identical — no duplicate, no second backup, a hand-tuned timeout kept', fresh(s => {
    write(s, FOREIGN);
    assert.strictEqual(install(s).status, 0);
    const tuned = read(s);
    tuned.hooks!.Stop[0].hooks.find(h => h.command === ourCmd(s, 'stop-notify.sh'))!.timeout = 900;
    write(s, tuned);
    const before = fs.readFileSync(s.settings, 'utf8');
    const again = install(s);
    assert.strictEqual(again.status, 0, again.out);
    assert.match(again.out, /no changes needed/);
    assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), before);
    assert.strictEqual(backups(s).length, 1, 'only the first install wrote a backup');
    assert.deepStrictEqual(ourRows(s, read(s)), expectedRows(s));
  }))) p++; else f++;

  if (test('a re-install after one entry was removed by hand adds back that one alone — presence is per event, not per command', fresh(s => {
    assert.strictEqual(install(s).status, 0);
    const cut = read(s);
    delete cut.hooks!.Notification;
    write(s, cut);
    const r = install(s);
    assert.strictEqual(r.status, 0, r.out);
    assert.deepStrictEqual(r.out.match(/^ {2}add .*$/gm), ['  add      Notification -> permission-notify.sh (timeout 5s)'], r.out);
    assert.deepStrictEqual(ourRows(s, read(s)), expectedRows(s));
  }))) p++; else f++;

  if (test('--uninstall takes out our entries wherever they were and the links, leaving the user’s file exactly as it was', fresh(s => {
    write(s, FOREIGN);
    assert.strictEqual(install(s).status, 0);
    const hand = read(s);
    // One of ours registered by hand under an event the script never writes: uninstall is command-scoped, so it goes too.
    hand.hooks!.SubagentStop = [{ hooks: [{ type: 'command', command: ourCmd(s, 'stop-notify.sh') }] }];
    write(s, hand);
    const r = install(s, '--uninstall');
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(JSON.stringify(read(s)), JSON.stringify(FOREIGN), 'foreign hooks stay in their own groups, in their own order');
    assert.deepStrictEqual(links(s), []);
  }))) p++; else f++;

  if (test('--dry-run writes nothing — no settings change, no backup, no link — on install and on --uninstall', fresh(s => {
    write(s, FOREIGN);
    const body = fs.readFileSync(s.settings, 'utf8');
    const dry = install(s, '--dry-run');
    assert.strictEqual(dry.status, 0, dry.out);
    assert.match(dry.out, /add +PreToolUse \(Bash\) -> kill-guard\.sh/, 'the plan is still printed');
    assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), body);
    assert.deepStrictEqual(backups(s), []);
    assert.ok(!fs.existsSync(path.join(s.claude, 'hooks')), 'not even the hooks/ dir is made');

    assert.strictEqual(install(s).status, 0);
    const installed = fs.readFileSync(s.settings, 'utf8');
    const kept = backups(s);
    const dryUn = install(s, '--dry-run', '--uninstall');
    assert.strictEqual(dryUn.status, 0, dryUn.out);
    assert.match(dryUn.out, /remove +Stop -> stop-notify\.sh/);
    assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), installed);
    assert.deepStrictEqual(backups(s), kept);
    assert.strictEqual(links(s).length, LINK_NAMES.length);
  }))) p++; else f++;

  if (test('a real file on a link path is kept without --force and replaced with it; a link pointing elsewhere is relinked either way', fresh(s => {
    const hooks = path.join(s.claude, 'hooks');
    fs.mkdirSync(hooks);
    const real = path.join(hooks, 'stop-notify.sh');
    fs.writeFileSync(real, '# my copy\n');
    fs.symlinkSync('/nowhere/kill-guard-hook.sh', path.join(hooks, 'kill-guard.sh'));
    const r = install(s);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /SKIPPED +stop-notify\.sh/);
    assert.match(r.out, /relink +kill-guard\.sh/);
    assert.ok(!fs.lstatSync(real).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(real, 'utf8'), '# my copy\n');
    assert.strictEqual(fs.readlinkSync(path.join(hooks, 'kill-guard.sh')), path.join(s.repo, 'scripts', 'kill-guard-hook.sh'));
    assert.strictEqual(links(s).length, LINK_NAMES.length - 1);

    const forced = install(s, '--force');
    assert.strictEqual(forced.status, 0, forced.out);
    assert.match(forced.out, /replace +stop-notify\.sh/);
    assert.strictEqual(fs.readlinkSync(real), path.join(s.repo, 'scripts', 'stop-notify-hook.sh'));
    assert.strictEqual(links(s).length, LINK_NAMES.length);
  }))) p++; else f++;

  if (test('under the default ~/.claude the commands carry a literal $HOME, and a re-run recognises them', fresh(s => {
    const home = path.join(s.repo, '..');
    const r = installAtHome(s, home);
    assert.strictEqual(r.status, 0, r.out);
    const cmds = commands(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')));
    assert.strictEqual(cmds.length, 8);
    assert.deepStrictEqual([...new Set(cmds)].sort(), LINK_NAMES.map(n => `bash "$HOME/.claude/hooks/${n}"`).sort());
    const again = installAtHome(s, home);
    assert.strictEqual(again.status, 0, again.out);
    assert.match(again.out, /no changes needed/);
  }))) p++; else f++;

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
