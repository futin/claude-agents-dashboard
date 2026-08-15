import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_IDLE_SECS, MAX_IDLE_SECS, SETTINGS_FILE,
  clampIdleSecs, detectIdleOverride, getSettings, resetSettings, setSettings
} from '../server/lib/settings.js';
import { scanOverrides } from '../server/api.js';
import type { Config } from '../server/lib/config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** The settings file is resolved from cwd, so tests run inside a tmpdir. */
function inTmpCwd(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-set-'));
  const prev = process.cwd();
  const prevEnv = process.env.CLAUDE_DASHBOARD_IDLE_SECS;
  try {
    process.chdir(dir);
    // The override probe reads this; a developer with it exported would
    // otherwise see every override assertion flip.
    delete process.env.CLAUDE_DASHBOARD_IDLE_SECS;
    resetSettings();
    fn(dir);
  } finally {
    process.chdir(prev);
    if (prevEnv === undefined) delete process.env.CLAUDE_DASHBOARD_IDLE_SECS;
    else process.env.CLAUDE_DASHBOARD_IDLE_SECS = prevEnv;
    resetSettings();
  }
}

/** Only the fields scanOverrides reads. */
function cfg(): Config {
  return { maxSessions: 10, lookbackHours: 24, activeWindowMin: 5 } as Config;
}

export function run(): number {
  console.log('\n=== settings.ts ===\n');
  let p = 0, f = 0;

  if (test('defaults to 60s when nothing is stored', () => {
    inTmpCwd(() => {
      const s = getSettings();
      assert.strictEqual(s.idleSecs, DEFAULT_IDLE_SECS);
      assert.strictEqual(s.persisted, true);
    });
  })) p++; else f++;

  if (test('a stored value survives a restart', () => {
    inTmpCwd(dir => {
      setSettings({ idleSecs: 15 });
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).idleSecs, 15);
      resetSettings(); // simulate the server restarting
      assert.strictEqual(getSettings().idleSecs, 15);
    });
  })) p++; else f++;

  if (test('0 is a real value, not "unset" — it means skip the idle check', () => {
    inTmpCwd(() => {
      assert.strictEqual(setSettings({ idleSecs: 0 })!.idleSecs, 0);
      resetSettings();
      assert.strictEqual(getSettings().idleSecs, 0, 'a falsy stored value must not fall back to 60');
    });
  })) p++; else f++;

  if (test('values are clamped, not rejected', () => {
    assert.strictEqual(clampIdleSecs(-5), 0);
    assert.strictEqual(clampIdleSecs(99_999), MAX_IDLE_SECS);
    assert.strictEqual(clampIdleSecs(12.6), 13, 'seconds are whole');
    assert.strictEqual(clampIdleSecs('45'), 45, 'a JSON string still parses');
  })) p++; else f++;

  if (test('an unusable body is refused rather than silently ignored', () => {
    inTmpCwd(dir => {
      for (const body of [null, undefined, 'nope', {}, { idleSecs: 'soon' }, { other: 1 }]) {
        assert.strictEqual(setSettings(body), null, JSON.stringify(body ?? String(body)));
      }
      assert.strictEqual(fs.existsSync(path.join(dir, SETTINGS_FILE)), false, 'a refused write must not touch disk');
    });
  })) p++; else f++;

  if (test('a malformed file falls back to the default', () => {
    for (const body of ['', 'not json', '{}', '{"idleSecs":"yes"}', '[]']) {
      inTmpCwd(dir => {
        fs.writeFileSync(path.join(dir, SETTINGS_FILE), body);
        resetSettings();
        assert.strictEqual(getSettings().idleSecs, DEFAULT_IDLE_SECS, JSON.stringify(body));
      });
    }
  })) p++; else f++;

  if (test('an unwritable path keeps working and reports persisted:false', () => {
    inTmpCwd(dir => {
      fs.mkdirSync(path.join(dir, SETTINGS_FILE)); // writeFileSync now throws EISDIR
      const s = setSettings({ idleSecs: 20 })!;
      assert.strictEqual(s.idleSecs, 20, 'the value still applies this run');
      assert.strictEqual(s.persisted, false, 'and the UI is told it will not survive a restart');
    });
  })) p++; else f++;

  if (test('an env override in ~/.claude/settings.json is detected', () => {
    inTmpCwd(dir => {
      const home = path.join(dir, 'home');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const write = (body: string): void =>
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), body);

      assert.strictEqual(detectIdleOverride(home), null, 'no file, nothing to warn about');

      write(JSON.stringify({ env: { CLAUDE_DASHBOARD_IDLE_SECS: '90' } }));
      assert.deepStrictEqual(detectIdleOverride(home), { value: '90', source: 'settings.json' });

      // The hook resolves `${VAR:-…}`, so an empty string is NOT an override.
      write(JSON.stringify({ env: { CLAUDE_DASHBOARD_IDLE_SECS: '' } }));
      assert.strictEqual(detectIdleOverride(home), null);

      write(JSON.stringify({ env: { SOMETHING_ELSE: '1' } }));
      assert.strictEqual(detectIdleOverride(home), null);

      write('{ not json');
      assert.strictEqual(detectIdleOverride(home), null, 'unreadable config must not crash the health probe');
    });
  })) p++; else f++;

  if (test('the server’s own environment counts as an override too', () => {
    inTmpCwd(dir => {
      const home = path.join(dir, 'empty-home');
      process.env.CLAUDE_DASHBOARD_IDLE_SECS = '5';
      assert.deepStrictEqual(detectIdleOverride(home), { value: '5', source: 'environment' });
      delete process.env.CLAUDE_DASHBOARD_IDLE_SECS;
      assert.strictEqual(detectIdleOverride(home), null);
    });
  })) p++; else f++;

  console.log('\n=== scanOverrides (api.ts) ===\n');

  if (test('no params leaves the configured values alone', () => {
    assert.deepStrictEqual(scanOverrides(cfg(), undefined), cfg());
    const same = scanOverrides(cfg(), new URLSearchParams(''));
    assert.strictEqual(same.maxSessions, 10);
    assert.strictEqual(same.lookbackHours, 24);
    assert.strictEqual(same.activeWindowMin, 5);
  })) p++; else f++;

  if (test('params override each knob independently', () => {
    const c = scanOverrides(cfg(), new URLSearchParams('limit=3&lookback=48&active=15'));
    assert.strictEqual(c.maxSessions, 3);
    assert.strictEqual(c.lookbackHours, 48);
    assert.strictEqual(c.activeWindowMin, 15);
    const one = scanOverrides(cfg(), new URLSearchParams('limit=3'));
    assert.strictEqual(one.lookbackHours, 24, 'an absent param keeps the config value');
  })) p++; else f++;

  if (test('a hostile limit is capped, not honoured', () => {
    assert.strictEqual(scanOverrides(cfg(), new URLSearchParams('limit=100000')).maxSessions, 50);
    assert.strictEqual(scanOverrides(cfg(), new URLSearchParams('lookback=99999')).lookbackHours, 168);
    assert.strictEqual(scanOverrides(cfg(), new URLSearchParams('active=99999')).activeWindowMin, 120);
  })) p++; else f++;

  if (test('junk and non-positive values fall back to the config', () => {
    for (const q of ['limit=abc', 'limit=0', 'limit=-4', 'limit=', 'limit=NaN']) {
      assert.strictEqual(scanOverrides(cfg(), new URLSearchParams(q)).maxSessions, 10, q);
    }
  })) p++; else f++;

  if (test('the config object is copied, never mutated', () => {
    const base = cfg();
    scanOverrides(base, new URLSearchParams('limit=3'));
    assert.strictEqual(base.maxSessions, 10, 'the shared config must survive a request');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
