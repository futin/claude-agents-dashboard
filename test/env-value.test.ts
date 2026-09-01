/**
 * `scripts/env-value.ts` — the one reader the installer and the server share.
 *
 * The bug this file exists to prevent: `scripts/install-hooks.sh` used to read
 * `ANSWER_TOKEN` out of `.env` with its own `grep | cut | tr` pipeline while the
 * server read the same line through `parseEnv`. The two disagreed on a leading
 * space (installer saw nothing and reported "no ANSWER_TOKEN in .env"), on an
 * inner space inside quotes (`tr -d` ate it), and on a duplicated key (`head -1`
 * took the first, `parseEnv` the last). Each disagreement wrote no token file or
 * a wrong one, and every write endpoint then answered 403 to hooks that could
 * not build an auth header.
 *
 * So the assertions below are not really about a CLI's output format. Each of
 * the first three is pinned **equal to `parseEnv`'s own answer** for the same
 * text: the test fails the moment the two readers diverge again, which is the
 * only property that actually matters.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv } from '../server/lib/config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const SCRIPT = path.join(REPO, 'scripts', 'env-value.ts');

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the reader against `envPath`. `extraEnv` is overlaid on a copy of the
 * current environment with `ANSWER_TOKEN` deliberately cleared first — a
 * developer who exports one must not decide this suite.
 */
function envValue(key: string, envPath: string, extraEnv: Record<string, string> = {}): Result {
  const env = { ...process.env, ...extraEnv };
  if (!(key in extraEnv)) delete env[key];
  const r = spawnSync(TSX, [SCRIPT, key, '--env', envPath], { encoding: 'utf8', env });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== env-value.ts (the shared .env reader) ===\n');
  let p = 0, f = 0;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-envval-'));
  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  try {
    // The three rows of the divergence table in backlog bug-6, each asserted
    // both for its literal value and for parity with the server's own reader.
    if (test('a leading space still yields the value (the reported bug)', () => {
      const body = ' ANSWER_TOKEN=abc\n';
      const r = envValue('ANSWER_TOKEN', write('lead.env', body));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'abc');
      assert.strictEqual(r.stdout, parseEnv(body).ANSWER_TOKEN, 'must match parseEnv');
    })) p++; else f++;

    if (test('an inner space inside quotes survives', () => {
      const body = 'ANSWER_TOKEN="a b"\n';
      const r = envValue('ANSWER_TOKEN', write('quoted.env', body));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'a b');
      assert.strictEqual(r.stdout, parseEnv(body).ANSWER_TOKEN, 'must match parseEnv');
    })) p++; else f++;

    if (test('a duplicated key resolves to the last one, as the server does', () => {
      const body = 'ANSWER_TOKEN=one\nANSWER_TOKEN=two\n';
      const r = envValue('ANSWER_TOKEN', write('dup.env', body));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'two');
      assert.strictEqual(r.stdout, parseEnv(body).ANSWER_TOKEN, 'must match parseEnv');
    })) p++; else f++;

    // Each of these asserts the *reported* unset, not merely exit 1 — a crashed
    // interpreter also exits nonzero with an empty stdout, and a check that
    // cannot tell the two apart would go green on a reader that never ran.
    const assertUnset = (r: Result): void => {
      assert.strictEqual(r.status, 1);
      assert.strictEqual(r.stdout, '');
      assert.ok(/unset/.test(r.stderr), `stderr should report the key as unset, got: ${r.stderr}`);
    };

    if (test('a commented-out key is unset: empty stdout, exit 1', () => {
      assertUnset(envValue('ANSWER_TOKEN', write('commented.env', '# ANSWER_TOKEN=abc\n')));
    })) p++; else f++;

    if (test('a missing .env is unset rather than an error: empty stdout, exit 1', () => {
      assertUnset(envValue('ANSWER_TOKEN', path.join(dir, 'does-not-exist.env')));
    })) p++; else f++;

    if (test('an empty value is unset, not an empty success', () => {
      assertUnset(envValue('ANSWER_TOKEN', write('empty.env', 'ANSWER_TOKEN=\n')));
    })) p++; else f++;

    // `loadConfig` overlays process.env on the file, so the shell that exported
    // a token gets the answer the server would give — not the stale file one.
    if (test('process.env beats the file, mirroring loadConfig precedence', () => {
      const file = write('override.env', 'ANSWER_TOKEN=from-file\n');
      const r = envValue('ANSWER_TOKEN', file, { ANSWER_TOKEN: 'from-shell' });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'from-shell');
    })) p++; else f++;

    if (test('the winning source is named on stderr, and the value never appears there', () => {
      const file = write('src.env', 'ANSWER_TOKEN=sekrit\n');
      const fromFile = envValue('ANSWER_TOKEN', file);
      assert.ok(fromFile.stderr.includes(file), `stderr should name the .env path: ${fromFile.stderr}`);
      assert.ok(!fromFile.stderr.includes('sekrit'), 'the value must never reach stderr');

      const fromShell = envValue('ANSWER_TOKEN', file, { ANSWER_TOKEN: 'shell-one' });
      assert.ok(/process\.env/.test(fromShell.stderr), `stderr should name process.env: ${fromShell.stderr}`);
      assert.ok(!fromShell.stderr.includes('shell-one'), 'the value must never reach stderr');
    })) p++; else f++;

    if (test('any key works, not just ANSWER_TOKEN', () => {
      const r = envValue('NTFY_TOPIC', write('other.env', ' NTFY_TOPIC = my-topic \n'));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'my-topic');
    })) p++; else f++;

    if (test('a missing key argument is a usage error (exit 2), not a silent unset', () => {
      const r = spawnSync(TSX, [SCRIPT], { encoding: 'utf8', env: process.env });
      assert.strictEqual(r.status, 2, 'exit 2 separates "you called it wrong" from "the key is unset"');
      assert.strictEqual(r.stdout, '');
    })) p++; else f++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
