/**
 * server/lib/routine-config.ts — machine detection, folder layout and the baked environment. The platform, /proc/version and process env are injected, so
 * nothing here depends on the host the suite runs on.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import type { Config } from '../server/lib/config.js';
import { machineName, migrateLegacyState, routineDirs, routineEnv, routineStateRoot } from '../server/lib/routine-config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Load a Config from an `.env` body in a tmpdir, with the keys under test cleared from process.env so the host never leaks in. */
function cfg(envBody: string): Config {
  const keys = ['ROUTINES_DIR', 'ROUTINE_MACHINE', 'ROUTINES_OWNER', 'ROUTINES_STATE_ROOT', 'SCHEDULES_DIR', 'SCHEDULE_MACHINE', 'SCHEDULES_OWNER',
    'SCHEDULES_STATE_ROOT', 'CLAUDE_BIN', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE', 'SPAWN_OWN_ENTRYPOINT'];
  const saved = keys.map(k => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-config-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, envBody);
  try { return loadConfig({ envPath }); }
  finally { for (const [k, v] of saved) if (v !== undefined) process.env[k] = v; }
}

const macHost = { platform: 'darwin' as const, readProcVersion: () => null };
const linuxHost = (proc: string | null) => ({ platform: 'linux' as const, readProcVersion: () => proc });
const HOME = '/home/tester';
const homed = { homedir: () => HOME, env: { HOME } as Record<string, string | undefined> };

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('ROUTINE_MACHINE=wsl wins over Darwin', () => {
    assert.deepStrictEqual(machineName(cfg('ROUTINE_MACHINE=wsl\n'), macHost), { name: 'wsl', error: null });
  });
  t('ROUTINE_MACHINE=mac wins over a microsoft kernel', () => {
    assert.deepStrictEqual(machineName(cfg('ROUTINE_MACHINE=mac\n'), linuxHost('Linux version 5.15 microsoft-standard-WSL2')), { name: 'mac', error: null });
  });
  t('ROUTINE_MACHINE=linux is reported as bad', () => {
    const r = machineName(cfg('ROUTINE_MACHINE=linux\n'), macHost);
    assert.strictEqual(r.error, 'bad ROUTINE_MACHINE');
  });
  t('a wrong-case ROUTINE_MACHINE is bad too, matching the wrapper that ignores it', () => {
    assert.strictEqual(machineName(cfg('ROUTINE_MACHINE=MAC\n'), macHost).error, 'bad ROUTINE_MACHINE');
  });
  t('unset on Darwin is mac', () => {
    assert.deepStrictEqual(machineName(cfg(''), macHost), { name: 'mac', error: null });
  });
  t('unset with microsoft in /proc/version is wsl', () => {
    assert.deepStrictEqual(machineName(cfg(''), linuxHost('Linux version 5.15.90.1-microsoft-standard-WSL2')), { name: 'wsl', error: null });
  });
  t('unset on plain Linux, or with no /proc/version, is wsl', () => {
    assert.deepStrictEqual(machineName(cfg(''), linuxHost('Linux version 6.1 generic')), { name: 'wsl', error: null });
    assert.deepStrictEqual(machineName(cfg(''), linuxHost(null)), { name: 'wsl', error: null });
  });

  t('routineEnv has exactly the nine keys', () => {
    const env = routineEnv(cfg(''), { ...macHost, ...homed });
    assert.deepStrictEqual(Object.keys(env).sort(),
      ['CLAUDE_BIN', 'HOME', 'LOGNAME', 'PATH', 'ROUTINES_DIR', 'ROUTINE_MACHINE', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE', 'USER']);
  });
  t('SPAWN_OWN_ENTRYPOINT=true adds exactly CLAUDE_CODE_ENTRYPOINT=claude-agents-dashboard; unset or false adds nothing', () => {
    const base = routineEnv(cfg(''), { ...macHost, ...homed });
    const on = routineEnv(cfg('SPAWN_OWN_ENTRYPOINT=true\n'), { ...macHost, ...homed });
    assert.deepStrictEqual(on, { ...base, CLAUDE_CODE_ENTRYPOINT: 'claude-agents-dashboard' });
    assert.deepStrictEqual(routineEnv(cfg('SPAWN_OWN_ENTRYPOINT=false\n'), { ...macHost, ...homed }), base);
    // Never inherited: a server started from a desktop-app shell must not pass its own marker to a routine.
    const leaky = routineEnv(cfg(''), { ...macHost, ...homed, env: { HOME, PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } });
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in leaky));
  });
  t('routineEnv takes only PATH, HOME and USER from the process env, the rest from Config', () => {
    const c = cfg('CLAUDE_BIN=/opt/claude\nSPAWN_MAX_PERMISSION=acceptEdits\nSYNC_PERMISSION_MODE=plan\nROUTINE_MACHINE=wsl\nROUTINES_DIR=/srv/jobs\n');
    const env = routineEnv(c, { ...macHost, homedir: () => '/ignored', username: () => 'ignored', env: { PATH: '/usr/bin:/bin', HOME, USER: 'ada', CLAUDE_BIN: 'from-process', SECRET: 'x', ROUTINES_DIR: '/nope' } });
    assert.deepStrictEqual(env, {
      PATH: '/usr/bin:/bin', HOME, USER: 'ada', LOGNAME: 'ada', CLAUDE_BIN: '/opt/claude', SPAWN_MAX_PERMISSION: 'acceptEdits', SYNC_PERMISSION_MODE: 'plan',
      ROUTINE_MACHINE: 'wsl', ROUTINES_DIR: '/srv/jobs'
    });
  });
  t('routineEnv bakes the resolved machine and an expanded routines dir when nothing is set', () => {
    const env = routineEnv(cfg(''), { ...macHost, ...homed, env: { HOME, PATH: '/bin' } });
    assert.strictEqual(env.ROUTINE_MACHINE, 'mac');
    assert.strictEqual(env.ROUTINES_DIR, path.join(HOME, 'claude-global', 'routines'));
    assert.strictEqual(env.CLAUDE_BIN, '');
    assert.strictEqual(env.SPAWN_MAX_PERMISSION, 'auto');
    assert.strictEqual(env.SYNC_PERMISSION_MODE, 'auto');
  });
  t('routineEnv falls back to os.homedir when HOME is unset', () => {
    assert.strictEqual(routineEnv(cfg(''), { ...macHost, homedir: () => '/h', env: { PATH: '/bin' } }).HOME, '/h');
  });
  // The claude CLI reads its claude.ai login from the macOS Keychain by $USER; a job without it fails "Not logged in · Please run /login".
  t('routineEnv falls back to LOGNAME, then the OS account, when USER is unset', () => {
    const fromLogname = routineEnv(cfg(''), { ...macHost, ...homed, username: () => 'os', env: { HOME, PATH: '/bin', LOGNAME: 'lg' } });
    assert.deepStrictEqual([fromLogname.USER, fromLogname.LOGNAME], ['lg', 'lg']);
    const fromOs = routineEnv(cfg(''), { ...macHost, ...homed, username: () => 'os', env: { HOME, PATH: '/bin' } });
    assert.deepStrictEqual([fromOs.USER, fromOs.LOGNAME], ['os', 'os']);
  });

  t('ROUTINES_DIR default expands ~; an absolute one is kept; ~/x expands', () => {
    assert.strictEqual(routineDirs(cfg(''), homed).routines, path.join(HOME, 'claude-global', 'routines'));
    assert.strictEqual(routineDirs(cfg('ROUTINES_DIR=/srv/jobs\n'), homed).routines, '/srv/jobs');
    assert.strictEqual(routineDirs(cfg('ROUTINES_DIR=~/mine\n'), homed).routines, path.join(HOME, 'mine'));
  });
  t('state folders sit under ~/.claude/routines by default', () => {
    const d = routineDirs(cfg(''), homed);
    const root = path.join(HOME, '.claude', 'routines');
    assert.deepStrictEqual([d.state, d.runs, d.locks, d.launchd], [root, path.join(root, 'runs'), path.join(root, 'locks'), path.join(root, 'launchd')]);
  });
  t('ROUTINES_STATE_ROOT moves the whole state folder and nothing else', () => {
    const c = cfg('ROUTINES_STATE_ROOT=/tmp/seam\n');
    assert.strictEqual(routineStateRoot(c, homed), '/tmp/seam');
    const d = routineDirs(c, homed);
    assert.deepStrictEqual([d.state, d.runs, d.locks, d.launchd], ['/tmp/seam', '/tmp/seam/runs', '/tmp/seam/locks', '/tmp/seam/launchd']);
    assert.strictEqual(d.routines, path.join(HOME, 'claude-global', 'routines'));
  });

  t('Config defaults: owner off, machine and state seam empty', () => {
    const c = cfg('');
    assert.deepStrictEqual([c.routinesOwner, c.routineMachine, c.routinesStateRoot, c.routinesDir], [false, '', '', '~/claude-global/routines']);
    assert.strictEqual(cfg('ROUTINES_OWNER=true\n').routinesOwner, true);
  });

  t('the names from before Schedules became Routines still read, and the new ones win', () => {
    const old = cfg('SCHEDULES_DIR=/old/jobs\nSCHEDULE_MACHINE=wsl\nSCHEDULES_OWNER=true\nSCHEDULES_STATE_ROOT=/old/state\n');
    assert.deepStrictEqual([old.routinesDir, old.routineMachine, old.routinesOwner, old.routinesStateRoot], ['/old/jobs', 'wsl', true, '/old/state']);
    const both = cfg('SCHEDULES_DIR=/old/jobs\nROUTINES_DIR=/new/jobs\nSCHEDULE_MACHINE=wsl\nROUTINE_MACHINE=mac\n');
    assert.deepStrictEqual([both.routinesDir, both.routineMachine], ['/new/jobs', 'mac']);
  });

  // A host whose only existing paths are `present`, so the old-name fallback is driven without touching the disk.
  const withPaths = (...present: string[]) => ({ ...homed, exists: (q: string) => present.includes(q) });
  const oldState = path.join(HOME, '.claude', 'schedules');
  const newState = path.join(HOME, '.claude', 'routines');
  const oldJobs = path.join(HOME, 'claude-global', 'schedules');
  const newJobs = path.join(HOME, 'claude-global', 'routines');

  t('default folders: the old name while only it exists, the new one otherwise', () => {
    const only = routineDirs(cfg(''), withPaths(oldState, oldJobs));
    assert.deepStrictEqual([only.state, only.routines], [oldState, oldJobs]);
    const both = routineDirs(cfg(''), withPaths(oldState, newState, oldJobs, newJobs));
    assert.deepStrictEqual([both.state, both.routines], [newState, newJobs]);
    const none = routineDirs(cfg(''), withPaths());
    assert.deepStrictEqual([none.state, none.routines], [newState, newJobs]);
  });
  t('mirror: a set ROUTINES_DIR or seam is never swapped for the old folder', () => {
    const d = routineDirs(cfg('ROUTINES_DIR=~/claude-global/routines-x\nROUTINES_STATE_ROOT=/tmp/seam\n'), withPaths(oldState, oldJobs));
    assert.deepStrictEqual([d.state, d.routines], ['/tmp/seam', path.join(HOME, 'claude-global', 'routines-x')]);
  });

  /** A real `$HOME` in a tmpdir with `~/.claude/schedules` laid out, for the one-time move. */
  const realHome = (lock: boolean): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-migrate-'));
    fs.mkdirSync(path.join(home, '.claude', 'schedules', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'schedules', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'schedules', 'runs', 'mac.jsonl'), '{}\n');
    if (lock) fs.writeFileSync(path.join(home, '.claude', 'schedules', 'locks', 'nightly.lock'), '{"pid":1}');
    return home;
  };
  const hostAt = (home: string) => ({ homedir: () => home, env: { HOME: home } as Record<string, string | undefined> });

  t('migrateLegacyState moves ~/.claude/schedules to ~/.claude/routines, history and all, once', () => {
    const home = realHome(false);
    assert.strictEqual(migrateLegacyState(cfg(''), hostAt(home)), true);
    assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'routines', 'runs', 'mac.jsonl'), 'utf8'), '{}\n');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', 'schedules')), false);
    assert.strictEqual(migrateLegacyState(cfg(''), hostAt(home)), false, 'a second start finds nothing to move');
  });
  t('migrateLegacyState leaves the old folder while a job holds a lock, while the new one exists, and under the seam', () => {
    const locked = realHome(true);
    assert.strictEqual(migrateLegacyState(cfg(''), hostAt(locked)), false);
    assert.strictEqual(fs.existsSync(path.join(locked, '.claude', 'schedules', 'runs', 'mac.jsonl')), true);
    const both = realHome(false);
    fs.mkdirSync(path.join(both, '.claude', 'routines'));
    assert.strictEqual(migrateLegacyState(cfg(''), hostAt(both)), false);
    assert.strictEqual(fs.existsSync(path.join(both, '.claude', 'schedules', 'runs', 'mac.jsonl')), true);
    const seam = realHome(false);
    assert.strictEqual(migrateLegacyState(cfg('ROUTINES_STATE_ROOT=/tmp/seam\n'), hostAt(seam)), false);
    assert.strictEqual(fs.existsSync(path.join(seam, '.claude', 'schedules')), true);
  });

  console.log(`\nroutine-config: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
