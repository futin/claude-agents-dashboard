import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { STATE_FILE, getState, resetState, setEnabled } from '../server/lib/remoteState.js';
import { dismissAll, register, resetStore } from '../server/lib/pending.js';
import type { Config } from '../server/lib/config.js';
import type { WaitResult } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Only the two fields remoteState reads. */
function cfg(remoteAnswer: boolean): Config {
  return { remoteAnswer, answerToken: '' } as Config;
}

/** Run `fn` with `DASHBOARD_STATE_DIR` set to `value` (deleted when undefined), restoring the caller's value after (#407). */
function withStateDir(value: string | undefined, fn: () => void): void {
  const prev = process.env.DASHBOARD_STATE_DIR;
  try {
    if (value === undefined) delete process.env.DASHBOARD_STATE_DIR;
    else process.env.DASHBOARD_STATE_DIR = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_STATE_DIR;
    else process.env.DASHBOARD_STATE_DIR = prev;
  }
}

/** The state file is resolved from cwd, so tests run inside a tmpdir. */
function inTmpCwd(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ra-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    resetState();
    fn(dir);
  } finally {
    process.chdir(prev);
    resetState();
  }
}

export function run(): number {
  console.log('\n=== remoteState.ts ===\n');
  let p = 0, f = 0;

  if (test('defaults to the env gate when nothing is stored', () => {
    inTmpCwd(() => {
      assert.deepStrictEqual(getState(cfg(true)), { available: true, enabled: true, remoteAnswer: true, persisted: true });
    });
    inTmpCwd(() => {
      const s = getState(cfg(false));
      assert.strictEqual(s.available, false);
      assert.strictEqual(s.remoteAnswer, false, 'env off means off regardless of the toggle');
    });
  })) p++; else f++;

  if (test('a stored toggle survives a restart and beats the env default', () => {
    inTmpCwd(dir => {
      setEnabled(cfg(true), false);
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')).enabled, false);
      resetState(); // simulate the server restarting
      assert.strictEqual(getState(cfg(true)).enabled, false);
      assert.strictEqual(getState(cfg(true)).remoteAnswer, false);
    });
  })) p++; else f++;

  if (test('toggling back on rewrites the file', () => {
    inTmpCwd(() => {
      setEnabled(cfg(true), false);
      const s = setEnabled(cfg(true), true)!;
      assert.strictEqual(s.enabled, true);
      assert.strictEqual(s.remoteAnswer, true);
      resetState();
      assert.strictEqual(getState(cfg(true)).enabled, true);
    });
  })) p++; else f++;

  if (test('the env kill switch refuses the toggle outright', () => {
    inTmpCwd(dir => {
      assert.strictEqual(setEnabled(cfg(false), true), null);
      assert.strictEqual(fs.existsSync(path.join(dir, STATE_FILE)), false, 'a refused toggle must not write');
    });
  })) p++; else f++;

  if (test('a malformed or empty state file falls back to the env default', () => {
    for (const body of ['', 'not json', '{}', '{"enabled":"yes"}', '[]']) {
      inTmpCwd(dir => {
        fs.writeFileSync(path.join(dir, STATE_FILE), body);
        resetState();
        assert.strictEqual(getState(cfg(true)).enabled, true, JSON.stringify(body));
      });
    }
  })) p++; else f++;

  if (test('an unwritable path keeps working and reports persisted:false', () => {
    inTmpCwd(dir => {
      // A directory where the file should be → writeFileSync throws (EISDIR).
      fs.mkdirSync(path.join(dir, STATE_FILE));
      const s = setEnabled(cfg(true), false)!;
      assert.strictEqual(s.enabled, false, 'the toggle still applies this run');
      assert.strictEqual(s.persisted, false, 'and the UI is told it will not survive a restart');
    });
  })) p++; else f++;

  if (test('switching off releases every waiting question', () => {
    resetStore();
    const seen: WaitResult[] = [];
    register('s1', [{ header: 'A', question: 'q1', multiSelect: false, options: [] }], 30_000, r => seen.push(r));
    register('s2', [{ header: 'B', question: 'q2', multiSelect: false, options: [] }], 30_000, r => seen.push(r));
    assert.strictEqual(dismissAll(), 2);
    assert.deepStrictEqual(seen, [{ status: 'dismissed' }, { status: 'dismissed' }]);
    assert.strictEqual(dismissAll(), 0, 'nothing left to release');
    resetStore();
  })) p++; else f++;

  if (test('DASHBOARD_STATE_DIR set: the toggle file goes there, not to the cwd (#407)', () => {
    const stateA = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ra-state-'));
    try {
      withStateDir(stateA, () => {
        inTmpCwd(cwdB => {
          setEnabled(cfg(true), false);
          assert.ok(fs.existsSync(path.join(stateA, STATE_FILE)), 'the write must land in DASHBOARD_STATE_DIR');
          assert.ok(!fs.existsSync(path.join(cwdB, STATE_FILE)), 'nothing may appear in the cwd');
          resetState(); // simulate the server restarting
          assert.strictEqual(getState(cfg(true)).enabled, false, 'and it is read back from there');
        });
      });
    } finally { fs.rmSync(stateA, { recursive: true, force: true }); }
  })) p++; else f++;

  if (test('DASHBOARD_STATE_DIR unset: the toggle file stays in the cwd', () => {
    withStateDir(undefined, () => {
      inTmpCwd(cwdB => {
        setEnabled(cfg(true), false);
        assert.ok(fs.existsSync(path.join(cwdB, STATE_FILE)));
      });
    });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
