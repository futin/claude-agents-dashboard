/**
 * `server/lib/idle.ts` is a leaf: the idle reading and the `atDesk` rule live there so every held-wait store (`wait-store.ts` → `idle.ts`) loads without
 * the push path behind `notify.ts` — the scanner, remote state, config and `node:https`. `notify.ts` depends on idle, never the reverse. Pinned as the exact
 * set of specifiers the file imports, type-only ones included, so a new edge back into the push path fails here by name.
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

/** Every module specifier a source text names in an `import`/`export … from`, a side-effect import or a dynamic `import()`, comments stripped. */
export function importSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  for (const m of code.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(?\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  return [...out].sort();
}

export function run(): number {
  console.log('\n=== idle.ts imports (a leaf below notify.ts) ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('the scanner sees named, type-only, side-effect and dynamic imports', () => {
    const src = `import a from 'x';\nimport type { B } from './b.js';\nimport './c.js';\nconst d = await import('./d.js');\n// import e from './e.js';`;
    assert.deepStrictEqual(importSpecifiers(src), ['./b.js', './c.js', './d.js', 'x']);
  }));

  r(test('server/lib/idle.ts imports exactly node:child_process and ./settings.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'idle.ts'), 'utf8');
    assert.deepStrictEqual(importSpecifiers(src), ['./settings.js', 'node:child_process']);
  }));

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
