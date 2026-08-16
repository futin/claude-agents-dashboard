import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ANSWER_SECS, DEFAULT_IDLE_SECS, DEFAULT_NOTIFY, MAX_ANSWER_SECS, MAX_IDLE_SECS,
  MIN_ANSWER_SECS, SETTINGS_FILE,
  clampAnswerSecs, clampIdleSecs, detectAnswerOverride, detectIdleOverride,
  getSettings, resetSettings, setSettings
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
  const prevAnswerEnv = process.env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT;
  try {
    process.chdir(dir);
    // The override probe reads these; a developer with one exported would
    // otherwise see every override assertion flip.
    delete process.env.CLAUDE_DASHBOARD_IDLE_SECS;
    delete process.env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT;
    resetSettings();
    fn(dir);
  } finally {
    process.chdir(prev);
    if (prevEnv === undefined) delete process.env.CLAUDE_DASHBOARD_IDLE_SECS;
    else process.env.CLAUDE_DASHBOARD_IDLE_SECS = prevEnv;
    if (prevAnswerEnv === undefined) delete process.env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT;
    else process.env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT = prevAnswerEnv;
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
      assert.strictEqual(s.answerSecs, DEFAULT_ANSWER_SECS);
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

  if (test('the answer window clamps to the same range pending.ts enforces', () => {
    assert.strictEqual(clampAnswerSecs(0), MIN_ANSWER_SECS, 'there is no zero-length wait');
    assert.strictEqual(clampAnswerSecs(-5), MIN_ANSWER_SECS);
    assert.strictEqual(clampAnswerSecs(99_999), MAX_ANSWER_SECS);
    assert.strictEqual(clampAnswerSecs(120.4), 120, 'seconds are whole');
    assert.strictEqual(clampAnswerSecs('300'), 300, 'a JSON string still parses');
    assert.strictEqual(clampAnswerSecs('soon'), null);
    assert.strictEqual(clampAnswerSecs(undefined), null);
  })) p++; else f++;

  if (test('either key can be saved on its own, leaving the other alone', () => {
    inTmpCwd(() => {
      const a = setSettings({ answerSecs: 120 })!;
      assert.strictEqual(a.answerSecs, 120);
      assert.strictEqual(a.idleSecs, DEFAULT_IDLE_SECS, 'an absent key keeps its stored value');

      const b = setSettings({ idleSecs: 30 })!;
      assert.strictEqual(b.idleSecs, 30);
      assert.strictEqual(b.answerSecs, 120, 'and the earlier save is not clobbered');

      resetSettings(); // simulate the server restarting
      const after = getSettings();
      assert.strictEqual(after.idleSecs, 30);
      assert.strictEqual(after.answerSecs, 120);
    });
  })) p++; else f++;

  if (test('a present-but-unusable key rejects the whole patch', () => {
    inTmpCwd(() => {
      setSettings({ idleSecs: 30, answerSecs: 120 });
      assert.strictEqual(setSettings({ idleSecs: 10, answerSecs: 'soon' }), null);
      resetSettings();
      assert.strictEqual(getSettings().idleSecs, 30, 'no half-applied save');
    });
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
        const s = getSettings();
        assert.strictEqual(s.idleSecs, DEFAULT_IDLE_SECS, JSON.stringify(body));
        assert.strictEqual(s.answerSecs, DEFAULT_ANSWER_SECS, JSON.stringify(body));
      });
    }
  })) p++; else f++;

  if (test('each key falls back independently, so an older file still loads', () => {
    inTmpCwd(dir => {
      // Written by a build that only knew about idleSecs.
      fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ idleSecs: 45 }));
      resetSettings();
      const s = getSettings();
      assert.strictEqual(s.idleSecs, 45);
      assert.strictEqual(s.answerSecs, DEFAULT_ANSWER_SECS);
    });
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

  if (test('the answer window has its own override probe, on its own var', () => {
    inTmpCwd(dir => {
      const home = path.join(dir, 'home');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ env: { CLAUDE_DASHBOARD_ANSWER_TIMEOUT: '300' } })
      );
      assert.deepStrictEqual(detectAnswerOverride(home), { value: '300', source: 'settings.json' });
      assert.strictEqual(detectIdleOverride(home), null, 'the two vars must not cross-warn');
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

  if (test('notify defaults to every switch off', () => {
    inTmpCwd(() => {
      const s = getSettings();
      assert.deepStrictEqual(s.notify, DEFAULT_NOTIFY);
      assert.strictEqual(s.notify.enabled, false);
      assert.strictEqual(s.notify.events.question, false);
    });
  })) p++; else f++;

  if (test('a notify patch merges instead of replacing', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true } });
      setSettings({ notify: { events: { question: true } } });
      const s = getSettings();
      assert.strictEqual(s.notify.enabled, true, 'enabled survived the second patch');
      assert.strictEqual(s.notify.events.question, true);
      assert.strictEqual(s.notify.events.stop, false, 'untouched events stay off');
    });
  })) p++; else f++;

  if (test('a stored notify policy survives a restart', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true, requireAfk: true } });
      resetSettings(); // simulate the server restarting
      const s = getSettings();
      assert.strictEqual(s.notify.enabled, true);
      assert.strictEqual(s.notify.requireAfk, true);
    });
  })) p++; else f++;

  if (test('a bad notify value rejects the whole patch', () => {
    inTmpCwd(() => {
      setSettings({ notify: { enabled: true } });
      assert.strictEqual(setSettings({ notify: { enabled: 'yes' } }), null);
      assert.strictEqual(getSettings().notify.enabled, true, 'previous value untouched');
    });
  })) p++; else f++;

  if (test('a bad or unknown event key rejects the whole patch', () => {
    inTmpCwd(() => {
      assert.strictEqual(setSettings({ notify: { events: { question: 1 } } }), null);
      assert.strictEqual(setSettings({ notify: { events: { nope: true } } }), null);
    });
  })) p++; else f++;

  if (test('an unreadable settings file yields notify defaults', () => {
    inTmpCwd(dir => {
      fs.writeFileSync(path.join(dir, SETTINGS_FILE), '{not json', 'utf8');
      resetSettings();
      assert.deepStrictEqual(getSettings().notify, DEFAULT_NOTIFY);
    });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
