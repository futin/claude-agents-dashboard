/**
 * Pins zero runtime import cycles under `server/` and `shared/`. A cycle means one module of it evaluates before the other has finished, so a top-level read
 * of an import sees `undefined` depending on which file was loaded first — and the last one arrived quietly, when a lib module reached into `management.ts`
 * for `claudeHome` (#319). `import type` / `export type` are erased at compile time and never count; dynamic `import()` runs after evaluation and never
 * counts either. Each cycle fails naming its files as `a.ts -> b.ts -> … -> a.ts`.
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

// The clause before `from` never holds `=`, `(` or `:`, so a `export type X = …` or an interface with no semicolon cannot run on into the next import.
const STATIC = /(?:^|[^\w$.])(import|export)(\s+type\b)?\s*(?:[^'"`;=():]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g;

/** Relative specifiers a source text loads at runtime: static `import`/`export … from` and side-effect imports, never their `type` forms. */
export function runtimeSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  for (const m of code.matchAll(STATIC)) if (!m[2] && m[3].startsWith('.')) out.add(m[3]);
  return [...out].sort();
}

/**
 * One cycle per strongly connected component that has one (Tarjan), each walked from its alphabetically first file and closed back on it. One per
 * component, not every elementary cycle: that is enough to name the files, and the count stays readable when a change knots many together.
 */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [];
  const comps: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) !== idx.get(v)) return;
    const comp: string[] = [];
    let w: string;
    do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) comps.push(comp.sort());
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v);

  return comps.sort((a, b) => a[0].localeCompare(b[0])).map(comp => {
    const members = new Set(comp);
    const start = comp[0];
    // BFS inside the component for the shortest way back to start.
    const prev = new Map<string, string>();
    const queue = [start];
    let last: string | null = null;
    while (queue.length && last === null) {
      const v = queue.shift()!;
      for (const w of [...(graph.get(v) ?? [])].sort()) {
        if (!members.has(w)) continue;
        if (w === start) { last = v; break; }
        if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
      }
    }
    const back: string[] = [];
    for (let v: string | undefined = last!; v !== undefined && v !== start; v = prev.get(v)) back.push(v);
    return [start, ...back.reverse(), start];
  });
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(abs, out);
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** The runtime import graph over `server/` and `shared/`, repo-relative paths; a `.js` specifier resolves to the `.ts` beside it, anything else is skipped. */
export function importGraph(root: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const abs of ['server', 'shared'].flatMap(d => tsFiles(path.join(root, d)))) {
    const edges: string[] = [];
    for (const spec of runtimeSpecifiers(fs.readFileSync(abs, 'utf8'))) {
      const target = path.resolve(path.dirname(abs), spec.replace(/\.js$/, '.ts'));
      if (fs.existsSync(target)) edges.push(path.relative(root, target));
    }
    graph.set(path.relative(root, abs), edges);
  }
  return graph;
}

export function run(): number {
  console.log('\n=== import cycles ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const specCases: [string, string, string[]][] = [
    ['a named import counts', `import { a } from './a.js';`, ['./a.js']],
    ['import type does not count', `import type { T } from './t.js';`, []],
    ['export type does not count', `export type { T } from './t.js';`, []],
    ['export … from counts', `export { a } from './a.js';\nexport * from './b.js';`, ['./a.js', './b.js']],
    ['a side-effect import counts', `import './tmp-root.js';`, ['./tmp-root.js']],
    ['a multi-line named import counts', `import {\n  a,\n  b,\n} from '../lib/x.js';`, ['../lib/x.js']],
    ['a bare or node: import is not relative', `import fs from 'node:fs';\nimport x from 'lookout-widgets';`, []],
    ['a dynamic import does not count', `const m = await import('./late.js');`, []],
    ['a commented import does not count', `// import { a } from './a.js';\n/* import './b.js'; */`, []],
    ['a type named typeFoo is still a runtime import', `import typeFoo from './tf.js';`, ['./tf.js']],
    ['an unterminated export type does not hide the next import', `export type A = { b: number }\nimport { c } from './c.js';`, ['./c.js']],
    ['an interface does not hide the next re-export', `export interface I {\n  a: string\n}\nexport { d } from './d.js';`, ['./d.js']],
  ];
  for (const [name, src, want] of specCases) {
    if (test(name, () => assert.deepStrictEqual(runtimeSpecifiers(src), want))) p++; else f++;
  }

  const g = (edges: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(edges));
  const cycleCases: [string, Map<string, string[]>, string[][]][] = [
    ['an acyclic graph has no cycle', g({ a: ['b', 'c'], b: ['c'], c: [] }), []],
    ['a 2-cycle is named from its first file', g({ b: ['a'], a: ['b'] }), [['a', 'b', 'a']]],
    ['a 3-cycle is walked in edge order', g({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] }), [['a', 'b', 'c', 'a']]],
    ['a self-import is a cycle', g({ a: ['a'] }), [['a', 'a']]],
    ['two separate cycles are both named', g({ a: ['b'], b: ['a'], x: ['y'], y: ['x'] }), [['a', 'b', 'a'], ['x', 'y', 'x']]],
  ];
  for (const [name, graph, want] of cycleCases) {
    if (test(name, () => assert.deepStrictEqual(findCycles(graph), want))) p++; else f++;
  }

  const cycles = findCycles(importGraph(root)).map(c => c.join(' -> '));
  if (test('server/ and shared/ have no runtime import cycle', () => assert.deepStrictEqual(cycles, [], '\n      ' + cycles.join('\n      ')))) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
