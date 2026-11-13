/**
 * #407 — the production container kept its state files in `/app`, the container's unmounted writable layer, so `docker compose up --build` wiped
 * settings, the remote toggle and the usage ledger/history/profile with no error. Two halves pin the fix: `stateDir` (the override every state path
 * builder goes through), and the Dockerfile/compose source text that sets it only in the runtime stage and puts a read-write volume behind it.
 *
 * Source text for the Docker half, the `test/infra/tailnet.test.ts` pattern: no test here runs Docker.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateDir } from '../../server/lib/paths.js';
import { findRepoRoot } from '../guards/docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Run `fn` with `DASHBOARD_STATE_DIR` set to `value` (deleted when undefined), restoring the caller's value after. */
function withEnv(value: string | undefined, fn: () => void): void {
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

/** The Dockerfile's text from `FROM … AS <stage>` up to the next `FROM`. */
function stage(dockerfile: string, name: string): string {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}\\s*$`, 'm'));
  assert.ok(start >= 0, `no "AS ${name}" stage in the Dockerfile`);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
}

export function run(): number {
  console.log('\n=== docker state (#407) ===\n');
  let p = 0, f = 0;

  if (test('stateDir: unset, empty or whitespace-only returns the fallback verbatim', () => {
    withEnv(undefined, () => assert.strictEqual(stateDir('/fallback/x'), '/fallback/x'));
    withEnv('', () => assert.strictEqual(stateDir('/fallback/x'), '/fallback/x'));
    withEnv('   ', () => assert.strictEqual(stateDir('/fallback/x'), '/fallback/x'));
  })) p++; else f++;

  if (test('stateDir: an absolute value wins, a relative one resolves against the cwd', () => {
    withEnv('/abs/dir', () => assert.strictEqual(stateDir('/fallback/x'), '/abs/dir'));
    withEnv('  /abs/dir  ', () => assert.strictEqual(stateDir('/fallback/x'), '/abs/dir'));
    withEnv('rel/dir', () => assert.strictEqual(stateDir('/fallback/x'), path.resolve('rel/dir')));
  })) p++; else f++;

  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  if (test('Dockerfile: the runtime stage sets DASHBOARD_STATE_DIR=/data, the dev stage does not', () => {
    assert.match(stage(dockerfile, 'runtime'), /^ENV DASHBOARD_STATE_DIR=\/data\s*$/m);
    assert.doesNotMatch(stage(dockerfile, 'dev'), /DASHBOARD_STATE_DIR/, 'dev bind-mounts the repo; its repo-root files already persist');
  })) p++; else f++;

  if (test('docker-compose.yml: a declared named volume is mounted read-write at /data', () => {
    const mount = compose.match(/^\s*-\s*([A-Za-z0-9_.-]+):\/data(:\S+)?\s*$/m);
    assert.ok(mount, 'no volume mounted at /data');
    assert.ok(!(mount[2] ?? '').includes('ro'), `the /data mount must be read-write, got "${mount[0].trim()}"`);
    const top = compose.slice(compose.search(/^volumes:\s*$/m));
    assert.ok(/^volumes:\s*$/m.test(compose), 'no top-level volumes: key');
    assert.match(top, new RegExp(`^\\s+${mount[1]}:\\s*$`, 'm'), `volume "${mount[1]}" is not declared under the top-level volumes:`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
