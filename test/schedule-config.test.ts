/**
 * server/lib/schedule-config.ts — machine detection, folder layout and the baked environment. The platform, /proc/version and process env are injected, so
 * nothing here depends on the host the suite runs on.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';
import type { Config } from '../server/lib/config.js';
import { machineName, scheduleDirs, scheduleEnv, scheduleStateRoot } from '../server/lib/schedule-config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Load a Config from an `.env` body in a tmpdir, with the keys under test cleared from process.env so the host never leaks in. */
function cfg(envBody: string): Config {
  const keys = ['SCHEDULES_DIR', 'SCHEDULE_MACHINE', 'SCHEDULES_OWNER', 'SCHEDULES_STATE_ROOT', 'CLAUDE_BIN', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE'];
  const saved = keys.map(k => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-config-'));
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

  t('SCHEDULE_MACHINE=wsl wins over Darwin', () => {
    assert.deepStrictEqual(machineName(cfg('SCHEDULE_MACHINE=wsl\n'), macHost), { name: 'wsl', error: null });
  });
  t('SCHEDULE_MACHINE=mac wins over a microsoft kernel', () => {
    assert.deepStrictEqual(machineName(cfg('SCHEDULE_MACHINE=mac\n'), linuxHost('Linux version 5.15 microsoft-standard-WSL2')), { name: 'mac', error: null });
  });
  t('SCHEDULE_MACHINE=linux is reported as bad', () => {
    const r = machineName(cfg('SCHEDULE_MACHINE=linux\n'), macHost);
    assert.strictEqual(r.error, 'bad SCHEDULE_MACHINE');
  });
  t('a wrong-case SCHEDULE_MACHINE is bad too, matching the wrapper that ignores it', () => {
    assert.strictEqual(machineName(cfg('SCHEDULE_MACHINE=MAC\n'), macHost).error, 'bad SCHEDULE_MACHINE');
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

  t('scheduleEnv has exactly the nine keys', () => {
    const env = scheduleEnv(cfg(''), { ...macHost, ...homed });
    assert.deepStrictEqual(Object.keys(env).sort(),
      ['CLAUDE_BIN', 'HOME', 'LOGNAME', 'PATH', 'SCHEDULES_DIR', 'SCHEDULE_MACHINE', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE', 'USER']);
  });
  t('scheduleEnv takes only PATH, HOME and USER from the process env, the rest from Config', () => {
    const c = cfg('CLAUDE_BIN=/opt/claude\nSPAWN_MAX_PERMISSION=acceptEdits\nSYNC_PERMISSION_MODE=plan\nSCHEDULE_MACHINE=wsl\nSCHEDULES_DIR=/srv/jobs\n');
    const env = scheduleEnv(c, { ...macHost, homedir: () => '/ignored', username: () => 'ignored', env: { PATH: '/usr/bin:/bin', HOME, USER: 'ada', CLAUDE_BIN: 'from-process', SECRET: 'x', SCHEDULES_DIR: '/nope' } });
    assert.deepStrictEqual(env, {
      PATH: '/usr/bin:/bin', HOME, USER: 'ada', LOGNAME: 'ada', CLAUDE_BIN: '/opt/claude', SPAWN_MAX_PERMISSION: 'acceptEdits', SYNC_PERMISSION_MODE: 'plan',
      SCHEDULE_MACHINE: 'wsl', SCHEDULES_DIR: '/srv/jobs'
    });
  });
  t('scheduleEnv bakes the resolved machine and an expanded schedules dir when nothing is set', () => {
    const env = scheduleEnv(cfg(''), { ...macHost, ...homed, env: { HOME, PATH: '/bin' } });
    assert.strictEqual(env.SCHEDULE_MACHINE, 'mac');
    assert.strictEqual(env.SCHEDULES_DIR, path.join(HOME, 'claude-global', 'schedules'));
    assert.strictEqual(env.CLAUDE_BIN, '');
    assert.strictEqual(env.SPAWN_MAX_PERMISSION, 'auto');
    assert.strictEqual(env.SYNC_PERMISSION_MODE, 'auto');
  });
  t('scheduleEnv falls back to os.homedir when HOME is unset', () => {
    assert.strictEqual(scheduleEnv(cfg(''), { ...macHost, homedir: () => '/h', env: { PATH: '/bin' } }).HOME, '/h');
  });
  // The claude CLI reads its claude.ai login from the macOS Keychain by $USER; a job without it fails "Not logged in · Please run /login".
  t('scheduleEnv falls back to LOGNAME, then the OS account, when USER is unset', () => {
    const fromLogname = scheduleEnv(cfg(''), { ...macHost, ...homed, username: () => 'os', env: { HOME, PATH: '/bin', LOGNAME: 'lg' } });
    assert.deepStrictEqual([fromLogname.USER, fromLogname.LOGNAME], ['lg', 'lg']);
    const fromOs = scheduleEnv(cfg(''), { ...macHost, ...homed, username: () => 'os', env: { HOME, PATH: '/bin' } });
    assert.deepStrictEqual([fromOs.USER, fromOs.LOGNAME], ['os', 'os']);
  });

  t('SCHEDULES_DIR default expands ~; an absolute one is kept; ~/x expands', () => {
    assert.strictEqual(scheduleDirs(cfg(''), homed).schedules, path.join(HOME, 'claude-global', 'schedules'));
    assert.strictEqual(scheduleDirs(cfg('SCHEDULES_DIR=/srv/jobs\n'), homed).schedules, '/srv/jobs');
    assert.strictEqual(scheduleDirs(cfg('SCHEDULES_DIR=~/mine\n'), homed).schedules, path.join(HOME, 'mine'));
  });
  t('state folders sit under ~/.claude/schedules by default', () => {
    const d = scheduleDirs(cfg(''), homed);
    const root = path.join(HOME, '.claude', 'schedules');
    assert.deepStrictEqual([d.state, d.runs, d.locks, d.launchd], [root, path.join(root, 'runs'), path.join(root, 'locks'), path.join(root, 'launchd')]);
  });
  t('SCHEDULES_STATE_ROOT moves the whole state folder and nothing else', () => {
    const c = cfg('SCHEDULES_STATE_ROOT=/tmp/seam\n');
    assert.strictEqual(scheduleStateRoot(c, homed), '/tmp/seam');
    const d = scheduleDirs(c, homed);
    assert.deepStrictEqual([d.state, d.runs, d.locks, d.launchd], ['/tmp/seam', '/tmp/seam/runs', '/tmp/seam/locks', '/tmp/seam/launchd']);
    assert.strictEqual(d.schedules, path.join(HOME, 'claude-global', 'schedules'));
  });

  t('Config defaults: owner off, machine and state seam empty', () => {
    const c = cfg('');
    assert.deepStrictEqual([c.schedulesOwner, c.scheduleMachine, c.schedulesStateRoot, c.schedulesDir], [false, '', '', '~/claude-global/schedules']);
    assert.strictEqual(cfg('SCHEDULES_OWNER=true\n').schedulesOwner, true);
  });

  console.log(`\nschedule-config: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
