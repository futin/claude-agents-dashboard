/**
 * A routine's name is checked by one regex, `NAME_RE` in `shared/routine-file.ts`. Four private copies of it under `server/` once meant a rule change on
 * the shared side compiled and left the server validating the old grammar (#542). Comments do not count: a JSDoc that quotes the grammar validates nothing.
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

/** Blanks `/* … *\/` and `// …` comments; `://` inside a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NAME_LITERAL = '/^[a-z0-9-]+$/';

/** The files whose code (comments stripped) holds its own copy of the routine-name regex literal, sorted. */
export function nameRegexCopies(files: Record<string, string>): string[] {
  return Object.entries(files).filter(([, src]) => stripComments(src).includes(NAME_LITERAL)).map(([file]) => file).sort();
}

function serverFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.join(root, 'server'));
  return out;
}

export function run(): number {
  console.log('\nroutine-name.test.ts');
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  let p = 0, f = 0;

  if (test('no file under server/ keeps its own copy of the routine-name regex', () => {
    assert.deepStrictEqual(nameRegexCopies(serverFiles(root)), []);
  })) p++; else f++;

  if (test('a private copy is caught, by file; a NAME_RE use and a commented copy are not', () => {
    assert.deepStrictEqual(nameRegexCopies({ 'server/lib/a.ts': 'const SAFE_NAME = /^[a-z0-9-]+$/;' }), ['server/lib/a.ts']);
    assert.deepStrictEqual(nameRegexCopies({ 'server/lib/b.ts': 'if (!NAME_RE.test(name)) return;' }), []);
    assert.deepStrictEqual(nameRegexCopies({ 'server/lib/c.ts': '// names match /^[a-z0-9-]+$/\nconst x = 1;' }), []);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
