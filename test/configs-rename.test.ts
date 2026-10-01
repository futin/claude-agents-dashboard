/**
 * Guards for the Management → Claude Configs rename (spec §4): the old route
 * string is gone from the client, the server/client never import from the
 * `plugin/` tree, and the rail names the tab `configs`.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '../client/src/lib/sections.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Source files (`.ts`/`.tsx`) under `dir`, recursively, as absolute paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(abs, out);
    else if (/\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

export function run(): number {
  console.log('\n=== configs rename ===\n');
  let p = 0, f = 0;

  if (test('no file under client/src names the old /api/management routes', () => {
    const offenders = sourceFiles(join(ROOT, 'client', 'src'))
      .filter(file => readFileSync(file, 'utf8').includes('/api/management'));
    assert.deepStrictEqual(offenders, []);
  })) p++; else f++;

  if (test('no import specifier under server/ or client/src reaches into plugin/', () => {
    const offenders: string[] = [];
    for (const dir of [join(ROOT, 'server'), join(ROOT, 'client', 'src')]) {
      for (const file of sourceFiles(dir)) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
          if (m[1].includes('plugin/')) offenders.push(`${file}: ${m[1]}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  })) p++; else f++;

  if (test('SECTIONS has a configs entry labelled Claude Configs', () => {
    assert.deepStrictEqual(SECTIONS.find(s => s.id === 'configs'), { id: 'configs', label: 'Claude Configs' });
  })) p++; else f++;

  // Task 2 flips this: the new Management tab re-adds the id.
  if (test('SECTIONS has no management entry yet', () => {
    assert.ok(!SECTIONS.some(s => (s.id as string) === 'management'));
  })) p++; else f++;

  if (test('OWNED_KEYS covers the configs.* keys and still sweeps the old management.* leftovers', () => {
    for (const k of ['configs.collapsed', 'configs.type', 'configs.scope', 'management.scope', 'management.type', 'management.collapsed']) {
      assert.ok(OWNED_KEYS.includes(k), `${k} missing from OWNED_KEYS`);
    }
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
