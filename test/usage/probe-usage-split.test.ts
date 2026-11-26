/**
 * `scripts/probe-usage-split.ts` — its `--days` argument and its transcript event reader (`usageEvents`). The fit itself is a report over this machine's
 * live logs and has no fixture here.
 *
 * `Number('7d')` is NaN and every window test against NaN is false, so a typo used to widen the window to the whole history. The flag is now parsed by
 * `scripts/lib/cli-args.ts`'s `parseDays`, which exits 2 before anything is read — so each case passes an empty `--dir` and still must not reach it.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { usageEvents } from '../../scripts/probe-usage-split.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'probe-usage-split.ts');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function probe(...args: string[]): { status: number; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pus-days-'));
  const r = spawnSync('npx', ['tsx', SCRIPT, '--dir', dir, ...args], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function run(): number {
  console.log('\n=== probe-usage-split.ts --days ===\n');
  let p = 0, f = 0;

  if (test('--days 7d is refused with exit 2 and names the value', () => {
    const { status, stdout, stderr } = probe('--days', '7d');
    assert.strictEqual(status, 2, stdout + stderr);
    assert.ok(stderr.includes('"7d"'), stderr);
    assert.strictEqual(stdout, '', 'nothing is read or printed before the refusal');
  })) p++; else f++;

  if (test('--days with no value is refused with exit 2 as "got nothing"', () => {
    const { status, stdout, stderr } = probe('--days');
    assert.strictEqual(status, 2, stdout + stderr);
    assert.ok(stderr.includes('got nothing'), stderr);
  })) p++; else f++;

  const T0 = Date.parse('2026-11-20T10:00:00Z');
  const turn = { role: 'assistant', id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } };
  const lines = (...recs: unknown[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';

  if (test('usageEvents: an assistant turn, its api-request-blob replay and a record with no usage yield one event', () => {
    const text = lines(
      { type: 'assistant', timestamp: new Date(T0).toISOString(), message: turn },
      { type: 'api-request-blob', message: turn },
      { type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: new Date(T0).toISOString(), message: { role: 'assistant', id: 'msg_2', model: 'claude-opus-4-8' } }
    );
    assert.deepStrictEqual(usageEvents(text, T0 - 1000, new Set()), [{ ts: T0, model: 'claude-opus-4-8' }]);
  })) p++; else f++;

  if (test('usageEvents: a message id already seen in another file is a replay; a turn before the window is dropped', () => {
    const text = lines({ type: 'assistant', timestamp: new Date(T0).toISOString(), message: turn });
    assert.deepStrictEqual(usageEvents(text, T0 - 1000, new Set(['msg_1'])), []);
    assert.deepStrictEqual(usageEvents(text, T0 + 1, new Set()), []);
  })) p++; else f++;

  if (test('usageEvents: a token count written as a string is no count, as in every usage reader (assistantUsage), so the turn has no tokens', () => {
    const text = lines({ type: 'assistant', timestamp: new Date(T0).toISOString(), message: { ...turn, usage: { input_tokens: '10', output_tokens: '5' } } });
    assert.deepStrictEqual(usageEvents(text, T0 - 1000, new Set()), []);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
