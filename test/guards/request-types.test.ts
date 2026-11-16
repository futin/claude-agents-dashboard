/**
 * Every request body `shared/types.ts` declares is named by the server that parses it.
 *
 * The defect this file exists to prevent: four handlers cast their body to an inline shape (`{ dirName?: unknown; kind?: unknown }`) while `shared` already
 * had a type for it, so renaming a field in `shared` compiled, passed the client's tests, and broke the route (#473). A `<Name>Request` or `<Name>Patch` that
 * no `server/` file names is a body the server reads by some other shape. Comments do not count: a JSDoc mention ties nothing.
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

/** The request-body types `shared/types.ts` exports: every `interface` or `type` whose name ends in `Request` or `Patch`. */
export function requestTypeNames(sharedSrc: string): string[] {
  return [...sharedSrc.matchAll(/^export (?:interface|type) (\w+(?:Request|Patch))\b/gm)].map(m => m[1]);
}

/** The names no file's code (comments stripped) mentions as a whole word, in declaration order. */
export function unreferenced(names: string[], files: Record<string, string>): string[] {
  const code = Object.values(files).map(stripComments);
  return names.filter(n => !code.some(src => new RegExp(`\\b${n}\\b`).test(src)));
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
  console.log('\nrequest-types.test.ts');
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const names = requestTypeNames(fs.readFileSync(path.join(root, 'shared/types.ts'), 'utf8'));
  const files = serverFiles(root);
  let p = 0, f = 0;

  if (test('shared/types.ts declares the request bodies this guard is about', () => {
    for (const n of ['NotifyPatch', 'NotifyEventRequest', 'OpenFolderRequest', 'CodegraphRunRequest', 'GitQuickRequest', 'SpawnRequest']) {
      assert.ok(names.includes(n), `${n} not found by requestTypeNames`);
    }
  })) p++; else f++;

  if (test('every <Name>Request and <Name>Patch in shared/types.ts is named by code under server/', () => {
    assert.deepStrictEqual(unreferenced(names, files), []);
  })) p++; else f++;

  if (test('a server that stops naming OpenFolderRequest is caught, by name', () => {
    const without = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.replace(/\bOpenFolderRequest\b/g, 'X')]));
    assert.deepStrictEqual(unreferenced(names, without), ['OpenFolderRequest']);
  })) p++; else f++;

  if (test('a mention inside a comment is not a reference', () => {
    assert.deepStrictEqual(unreferenced(['FooRequest'], { 'a.ts': '/** reads a FooRequest */\n// FooRequest\nconst x = 1;' }), ['FooRequest']);
    assert.deepStrictEqual(unreferenced(['FooRequest'], { 'a.ts': 'const b = body as Unvalidated<FooRequest>;' }), []);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
