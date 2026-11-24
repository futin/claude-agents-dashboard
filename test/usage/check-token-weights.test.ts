/**
 * `scripts/check-token-weights.ts` — the guard that keeps `TYPE_WEIGHTS.cc`
 * falsifiable.
 *
 * The constant is 2 (the 1-hour cache-write tier) because 99.96% of this
 * machine's cache-write tokens are written at that TTL. The ledger records only
 * the flat `cache_creation_input_tokens`, so nothing downstream can notice if
 * that stops being true — which makes this script, not a unit test on the
 * constant, the thing that has to fail when the mix moves.
 *
 * Driven as the real CLI against tmpdir transcript trees, because the exit code
 * is half of what it promises: the failing case has to *fail the command*, not
 * merely print a different number.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-token-weights.ts');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

interface Write {
  /** Flat `cache_creation_input_tokens`. */
  cc: number;
  /** Nested `cache_creation` breakdown, or **omitted entirely** for the older format. */
  ttl?: { m5?: number; h1?: number };
}

/** One assistant record with the usage shape Claude Code writes today. */
function line(model: string, id: string, w: Write, tsMs: number): string {
  const usage: Record<string, unknown> = {
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_input_tokens: w.cc,
    cache_read_input_tokens: 1000
  };
  if (w.ttl) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: w.ttl.m5 ?? 0,
      ephemeral_1h_input_tokens: w.ttl.h1 ?? 0
    };
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'assistant', id, model, usage }
  });
}

/** A throwaway `~/.claude/projects` holding one transcript. */
function fixture(lines: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-'));
  const dir = path.join(root, '-tmp-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), lines.join('\n') + '\n');
  return root;
}

function runCheck(root: string): { status: number; out: string } {
  const r = spawnSync('npx', ['tsx', SCRIPT, '--root', root, '--days', '7'], {
    cwd: REPO, encoding: 'utf8'
  });
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

export function run(): number {
  console.log('\n=== check-token-weights.ts (the weight guard) ===\n');
  let p = 0, f = 0;
  const now = Date.now() - 60_000;

  if (test('a model writing 5-minute caches at scale fails the run, and is named', () => {
    const root = fixture([
      line('claude-opus-5', 'm1', { cc: 1_000_000, ttl: { m5: 1_000_000 } }, now),
      line('claude-opus-5', 'm2', { cc: 1_000_000, ttl: { m5: 1_000_000 } }, now)
    ]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 1, out);
    assert.ok(out.includes('claude-opus-5'), out);
    assert.ok(out.includes('1.2500'), 'must print the measured blend: ' + out);
    assert.ok(out.includes('2.0000'), 'must print the configured cc: ' + out);
  })) p++; else f++;

  if (test('the same volume at the 1-hour tier passes', () => {
    const root = fixture([
      line('claude-opus-5', 'm1', { cc: 1_000_000, ttl: { h1: 1_000_000 } }, now),
      line('claude-opus-5', 'm2', { cc: 1_000_000, ttl: { h1: 1_000_000 } }, now)
    ]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('100.00%'), out);
  })) p++; else f++;

  if (test('under the evidence floor, a 5m-only model does not fail the run', () => {
    const root = fixture([
      line('claude-opus-5', 'm1', { cc: 500_000, ttl: { m5: 500_000 } }, now)
    ]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    // Still reported — the floor suppresses the failure, not the measurement.
    assert.ok(out.includes('1.2500'), out);
  })) p++; else f++;

  if (test('an unpriced model warns without failing', () => {
    const root = fixture([
      line('claude-nonesuch-9', 'm1', { cc: 2_000_000, ttl: { h1: 2_000_000 } }, now)
    ]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('claude-nonesuch-9'), out);
    assert.ok(out.includes('CHECKED_MODEL_PREFIXES'), 'must say why it is unverified: ' + out);
  })) p++; else f++;

  if (test('an older line with no cache_creation object is not read as 5-minute', () => {
    const root = fixture([
      line('claude-opus-5', 'm1', { cc: 2_000_000 }, now),
      line('claude-opus-5', 'm2', { cc: 2_000_000 }, now)
    ]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('4,000,000'), 'the flat total is still counted: ' + out);
    assert.ok(out.includes('n/a'), 'and contributes to neither TTL bucket: ' + out);
  })) p++; else f++;

  if (test('duplicate message ids are counted once', () => {
    const root = fixture([
      line('claude-opus-5', 'dup', { cc: 2_000_000, ttl: { m5: 2_000_000 } }, now),
      line('claude-opus-5', 'dup', { cc: 2_000_000, ttl: { m5: 2_000_000 } }, now)
    ]);
    const { out } = runCheck(root);
    assert.ok(out.includes('2,000,000'), 'the id appears twice but counts once: ' + out);
  })) p++; else f++;

  // The usage line is read through `assistantUsage` (server/lib/usage-line.ts), so a count is a finite number or 0 and `usage` must be an object —
  // the same reading every other caller gets. Shown through the unpriced-model warning, which fires only when the model carries cache volume.
  if (test('a string cache_read_input_tokens adds 0, so an unpriced model with no other volume draws no warning', () => {
    const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: '500' };
    const root = fixture([JSON.stringify({
      type: 'assistant', timestamp: new Date(now).toISOString(), message: { role: 'assistant', id: 'm1', model: 'claude-nonesuch-9', usage }
    })]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('claude-nonesuch-9'), 'the record is still counted: ' + out);
    assert.ok(!out.includes('CHECKED_MODEL_PREFIXES'), 'a string count is not cache volume: ' + out);
  })) p++; else f++;

  if (test('a record whose usage is a string is skipped, not counted as a request', () => {
    const root = fixture([JSON.stringify({
      type: 'assistant', timestamp: new Date(now).toISOString(), message: { role: 'assistant', id: 'm1', model: 'claude-opus-5', usage: 'n/a' }
    })]);
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('nothing to check'), 'no request may be counted: ' + out);
  })) p++; else f++;

  if (test('an empty tree checks nothing and passes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-empty-'));
    const { status, out } = runCheck(root);
    assert.strictEqual(status, 0, out);
    assert.ok(out.includes('nothing to check'), out);
  })) p++; else f++;

  // `Number('7d')` is NaN, and every `x < NaN` window test is false, so a typo
  // used to scan the whole history under a "last NaN day(s)" header, exit 0.
  const withDays = (...days: string[]): { status: number; stdout: string; stderr: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-days-'));
    const r = spawnSync('npx', ['tsx', SCRIPT, '--root', root, '--days', ...days], { cwd: REPO, encoding: 'utf8' });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  if (test('--days 7d is refused with exit 2, names the value, and prints no table', () => {
    const { status, stdout, stderr } = withDays('7d');
    assert.strictEqual(status, 2, stdout + stderr);
    assert.ok(stderr.includes('"7d"'), stderr);
    assert.strictEqual(stdout, '');
  })) p++; else f++;

  if (test('--days 0 and --days -3 are refused with exit 2', () => {
    assert.strictEqual(withDays('0').status, 2);
    assert.strictEqual(withDays('-3').status, 2);
  })) p++; else f++;

  if (test('--days with no value after it is refused with exit 2, not defaulted to 7', () => {
    const { status, stderr } = withDays();
    assert.strictEqual(status, 2, stderr);
    assert.ok(stderr.includes('got nothing'), stderr);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-days-'));
    const r = spawnSync('npx', ['tsx', SCRIPT, '--days', '--root', root], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(r.status, 2, 'a flag where the value should be is no value: ' + r.stderr);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
