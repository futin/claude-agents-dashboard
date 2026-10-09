/**
 * Pins the server's npm dependencies to the one named exception in `.claude/CLAUDE.md` (§Code rules, "Keep new deps out of `server/`"): `lookout-widgets`,
 * which has no runtime deps of its own. Any other bare specifier under `server/` — static, re-export, side-effect or dynamic — fails here, naming the file.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ALLOWED = ['lookout-widgets'];
const PINNED_SPEC = 'github:futin/lookout-widgets#v0.1.0';

const STATIC = /(?:^|[^\w$.])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g;
const DYNAMIC = /(?:^|[^\w$.])import\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Bare specifiers in one source text: not relative, not absolute, not `node:`. Comments are blanked first; `://` in a string survives. */
export function bareSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  for (const re of [STATIC, DYNAMIC]) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out].filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:')).sort();
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(abs, out);
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

export function run(): number {
  console.log('\n=== server npm deps ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const cases: [string, string, string[]][] = [
    ['a node: import is not bare', `import x from 'node:fs';`, []],
    ['a relative import is not bare', `import { a } from './a.js';`, []],
    ['import type still counts', `import type { T } from 'lookout-widgets';`, ['lookout-widgets']],
    ['export * from counts', `export * from 'left-pad';`, ['left-pad']],
    ['a dynamic import counts', `const c = await import('chalk');`, ['chalk']],
    ['a side-effect import counts', `import 'left-pad';`, ['left-pad']],
    ['a multi-line named import counts', `import {\n  a,\n  b,\n} from 'lodash';`, ['lodash']],
    ['a commented import does not count', `// import x from 'left-pad';\n/* import('chalk') */`, []],
    ['an export const with a string is not an import', `export const name = 'left-pad';`, []],
  ];
  for (const [name, src, want] of cases) {
    if (test(name, () => assert.deepStrictEqual(bareSpecifiers(src), want))) p++; else f++;
  }

  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const file of tsFiles(path.join(root, 'server'))) {
    for (const spec of bareSpecifiers(fs.readFileSync(file, 'utf8'))) {
      seen.add(spec);
      if (!ALLOWED.includes(spec)) offenders.push(`${path.relative(root, file)}: ${spec}`);
    }
  }
  if (test('server/ imports no npm package but lookout-widgets', () => assert.deepStrictEqual(offenders, []))) p++; else f++;
  // Equality, not just a subset: an exception nobody uses any more should be removed from CLAUDE.md, not left standing.
  if (test('server/ does import lookout-widgets', () => assert.deepStrictEqual([...seen].sort(), ALLOWED))) p++; else f++;

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  if (test(`package.json pins lookout-widgets to ${PINNED_SPEC}`, () => assert.strictEqual(pkg.dependencies?.['lookout-widgets'], PINNED_SPEC))) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
