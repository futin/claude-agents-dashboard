/**
 * Guards that every `lazy()` chunk in the client renders under `LoadBoundary`. A chunk that fails to load — a tab left open across a rebuild asks for a hash
 * the new build no longer has — otherwise throws past every Suspense and React 18 unmounts the whole root, leaving a white page.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Nearest ancestor of `from` that holds a `package.json`. */
function findRepoRoot(from: string): string {
  let dir = from;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('no package.json above ' + from);
    dir = up;
  }
  return dir;
}

const CLIENT_SRC = path.join(findRepoRoot(path.dirname(fileURLToPath(import.meta.url))), 'client', 'src');

/** Every `.tsx` under `client/src`, as paths relative to it. */
function tsxFiles(dir: string = CLIENT_SRC): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(path.relative(CLIENT_SRC, full));
  }
  return out;
}

const LAZY = /\blazy\(\s*\(\)\s*=>\s*import\(/;

export function run(): number {
  console.log('\nlazy-boundary guard');
  let p = 0, f = 0;

  const lazyFiles = tsxFiles().filter(rel => LAZY.test(fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8')));

  if (test('the scan finds the lazy chunks it is meant to guard', () => {
    assert.ok(lazyFiles.includes('App.tsx'), 'App.tsx defines the lazy sections');
    assert.ok(lazyFiles.length >= 4, `only ${lazyFiles.length} files with lazy() found`);
  })) p++; else f++;

  if (test('every file that defines a lazy() chunk renders at least as many LoadBoundary elements as Suspense ones', () => {
    const bad = lazyFiles.filter(rel => {
      const src = fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8');
      const boundaries = (src.match(/<LoadBoundary\b/g) ?? []).length;
      const suspenses = (src.match(/<Suspense\b/g) ?? []).length;
      // App.tsx wraps its whole section switch, every Suspense in it, in one boundary keyed by section.
      return rel === 'App.tsx' ? boundaries < 1 : boundaries < suspenses;
    });
    assert.deepStrictEqual(bad, [], `lazy() without a LoadBoundary in: ${bad.join(', ')}`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
