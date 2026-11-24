/**
 * Every timed client poll follows the `pollSeq` rule (`client/src/lib/pollSeq.ts`): its request goes through `pollFetch`, so it carries the 30s bound the
 * skip relies on. A hook that runs a `setInterval` and also calls a bare `fetch(` fails here by name, unless the allowlist below says why its fetch is no poll.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(ROOT, 'client', 'src', 'hooks');

/** Hooks whose interval is not a poll, each with the reason. A new entry needs one as concrete. */
const ALLOWED: Record<string, string> = {
  'useDictation.ts': 'its interval is the recording clock, and its one fetch is the /api/transcribe POST, not a poll',
};

/** True when the source runs a timer and also calls `fetch` directly (`window.fetch(` included, `pollFetch(` not). Comments are stripped first. */
export function bareFetchInTimedHook(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /\bsetInterval\s*\(/.test(code) && /(?<![\w$])fetch\s*\(/.test(code);
}

export function run(): number {
  console.log('\n=== timed hooks poll through pollFetch ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('the scanner flags a timed bare fetch and passes pollFetch, an untimed fetch and a commented one', () => {
    assert.strictEqual(bareFetchInTimedHook(`setInterval(poll, 3000);\nawait fetch('/api/x');`), true);
    assert.strictEqual(bareFetchInTimedHook(`setInterval(poll, 3000);\nawait window.fetch('/api/x');`), true);
    assert.strictEqual(bareFetchInTimedHook(`setInterval(poll, 3000);\nawait pollFetch('/api/x');`), false);
    assert.strictEqual(bareFetchInTimedHook(`await fetch('/api/x');`), false);
    assert.strictEqual(bareFetchInTimedHook(`setInterval(poll, 3000);\n// was fetch('/api/x')\nawait pollFetch('/api/x');`), false);
  }));

  const files = fs.readdirSync(HOOKS).filter(n => n.endsWith('.ts')).sort();

  r(test('every hook that calls setInterval polls through pollFetch or is allowlisted with a reason', () => {
    const bad = files.filter(n => !(n in ALLOWED) && bareFetchInTimedHook(fs.readFileSync(path.join(HOOKS, n), 'utf8')));
    assert.deepStrictEqual(bad, [],
      `${bad.join(', ')}: a timed poll calls a bare fetch — use pollFetch with createPollSeq (client/src/lib/pollSeq.ts), or add the file to ALLOWED in ` +
      'test/guards/poll-hooks.test.ts with a reason');
  }));

  r(test('every allowlist entry still names a hook that runs a timer and fetches (no dead entries)', () => {
    for (const n of Object.keys(ALLOWED)) {
      assert.ok(files.includes(n), `${n} is allowlisted but no longer exists`);
      assert.ok(bareFetchInTimedHook(fs.readFileSync(path.join(HOOKS, n), 'utf8')), `${n} is allowlisted but no longer needs it`);
    }
  }));

  // Mirror case: the guard is about timed polls, not every fetch in the folder.
  r(test('a hook that fetches without a timer (useConfigs.ts) does not trip the guard', () => {
    const src = fs.readFileSync(path.join(HOOKS, 'useConfigs.ts'), 'utf8');
    assert.match(src, /(?<![\w$])fetch\s*\(/, 'useConfigs.ts no longer calls fetch — pick another untimed fetching hook for this case');
    assert.doesNotMatch(src, /\bsetInterval\s*\(/);
    assert.strictEqual(bareFetchInTimedHook(src), false);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
