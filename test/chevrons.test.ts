/**
 * Guards the one disclosure mark: every fold, caret and open/closed cue draws `Chevron`, never a text triangle.
 * The glyphs were a few pixels tall and hard to see, so a component that reintroduces one fails here by file name.
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

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const COMPONENTS = path.join(ROOT, 'client/src/components');
const TRIANGLES = ['▸', '▾', '▴', '◂', '▶', '▼'];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Drop `/* *\/` blocks and `//` line comments; the `//` pass skips `://` so a URL inside a string survives. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function run(): number {
  console.log('\nchevrons');
  let p = 0, f = 0;

  if (test('no component draws a text triangle', () => {
    const files = tsxFiles(COMPONENTS);
    assert.ok(files.length > 0, 'found no .tsx under client/src/components');
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const hit = TRIANGLES.find(g => code.includes(g));
      assert.strictEqual(hit, undefined, `${path.relative(ROOT, file)} draws the text triangle ${hit}; use <Chevron />`);
    }
  })) p++; else f++;

  if (test('Chevron keeps the account chip path', () => {
    const src = fs.readFileSync(path.join(COMPONENTS, 'Chevron.tsx'), 'utf8');
    assert.ok(src.includes('M2 4l3 3 3-3'), 'Chevron.tsx lost the account chip path');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
