/**
 * Pins the FE/BE boundary rule in `.claude/CLAUDE.md` (Code rules, "Cross-boundary imports use `import type`"): an import from one of `client/`,
 * `server/` and `shared/` into another is type-only, and the one exception is a runtime import of the four zero-dep modules both sides run —
 * `shared/frontmatter.ts`, `shared/gitUpstream.ts`, `shared/cron.ts` and `shared/routine-file.ts`. A runtime import of a fifth shared module, or of server
 * code from the client (or the reverse), would otherwise pass `pnpm typecheck` and `pnpm build` alike and quietly couple the two bundles.
 *
 * Type-only means `import type` / `export type`, or braces whose every specifier is `type X`: all three are erased at compile time. A side-effect
 * `import '…'`, a dynamic `import('…')` and `export … from` are runtime.
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

const DOMAINS = ['client', 'server', 'shared'] as const;
type Domain = (typeof DOMAINS)[number];

/** The shared modules either side may import at runtime, by repo-relative path without extension. */
export const RUNTIME_SHARED = ['shared/cron', 'shared/frontmatter', 'shared/gitUpstream', 'shared/routine-file'];

/** Blanks `/* … *\/` and `// …` comments; `://` inside a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function domainOf(rel: string): Domain | null {
  const top = rel.split('/')[0];
  return (DOMAINS as readonly string[]).includes(top) ? top as Domain : null;
}

/** Whether an import/export clause (the text between the keyword and `from`) is erased at compile time. */
function typeOnly(clause: string): boolean {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true;
  const braces = /^\{([^}]*)\}$/.exec(c);
  if (!braces) return false;
  const specs = braces[1].split(',').map(s => s.trim()).filter(Boolean);
  return specs.length > 0 && specs.every(s => /^type\s/.test(s));
}

/** Every relative import in `src` (comments stripped first), each with whether it is type-only. */
export function importsOf(src: string): { spec: string; typeOnly: boolean }[] {
  const text = stripComments(src);
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+([^;'"]*?)\s*from\s*(['"])([^'"]+)\2/g)) {
    out.push({ spec: m[3], typeOnly: typeOnly(m[1]) });
  }
  for (const m of text.matchAll(/(?:^|[;\n}])\s*import\s*(['"])([^'"]+)\1/g)) out.push({ spec: m[2], typeOnly: false });
  for (const m of text.matchAll(/(?<![\w$.])(typeof\s+)?import\s*\(\s*(['"])([^'"]+)\2\s*\)/g)) out.push({ spec: m[3], typeOnly: Boolean(m[1]) });
  return out.filter(i => i.spec.startsWith('.'));
}

/**
 * The boundary violations among `files` (repo-relative path → text), as `<file> → <target>` lines, sorted: a runtime import whose target sits in another
 * of the three domains and is not one of `RUNTIME_SHARED`.
 */
export function scanBoundary(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const from = domainOf(rel);
    if (!from) continue;
    for (const imp of importsOf(text)) {
      if (imp.typeOnly) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), imp.spec));
      const to = domainOf(target);
      if (!to || to === from) continue;
      if (to === 'shared' && RUNTIME_SHARED.includes(target.replace(/\.(js|ts|mjs)$/, ''))) continue;
      out.push(`${rel} → ${target}`);
    }
  }
  return out.sort();
}

function sourceFiles(root: string, dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') sourceFiles(root, rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    }
  }
  return out;
}

export function run(): number {
  console.log('\n=== boundary imports ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const cases: [string, string, string, string[]][] = [
    ['client: import type from shared/types passes', 'client/src/a.ts', `import type { Session } from '../../shared/types';`, []],
    ['client: braces of type specifiers pass', 'client/src/a.ts', `import {\n  type Session,\n  type Job,\n} from '../../shared/types';`, []],
    ['client: runtime import of a fifth shared module fails', 'client/src/a.ts', `import { Session } from '../../shared/types';`, ['client/src/a.ts → shared/types']],
    ['client: one runtime specifier among type ones fails', 'client/src/a.ts', `import { type A, b } from '../../shared/types';`, ['client/src/a.ts → shared/types']],
    ['client: runtime import of a named shared module passes', 'client/src/a.ts', `import { parseCron } from '../../shared/cron';`, []],
    ['server: runtime import of a named shared module with .js passes', 'server/lib/a.ts', `import { parseJob, type JobError } from '../../shared/routine-file.js';`, []],
    ['client: runtime import of server code fails', 'client/src/a.ts', `import { GIT_FETCH_SECS } from '../../server/lib/settings.js';`, ['client/src/a.ts → server/lib/settings.js']],
    ['server: runtime import of client code fails', 'server/a.ts', `import { fmt } from '../client/src/lib/fmt';`, ['server/a.ts → client/src/lib/fmt']],
    ['shared: runtime import of server code fails', 'shared/a.ts', `import { x } from '../server/lib/x.js';`, ['shared/a.ts → server/lib/x.js']],
    ['server: import type from client passes', 'server/a.ts', `import type { Row } from '../client/src/lib/rows';`, []],
    ['a side-effect import across the boundary fails', 'client/src/a.ts', `import '../../server/lib/x.js';`, ['client/src/a.ts → server/lib/x.js']],
    ['a dynamic import across the boundary fails', 'client/src/a.ts', `const m = await import('../../server/lib/x.js');`, ['client/src/a.ts → server/lib/x.js']],
    ['typeof import() is a type and passes', 'client/src/a.ts', `type M = typeof import('../../server/lib/x.js');`, []],
    ['a runtime re-export across the boundary fails', 'client/src/a.ts', `export { x } from '../../server/lib/x.js';`, ['client/src/a.ts → server/lib/x.js']],
    ['export type across the boundary passes', 'client/src/a.ts', `export type { X } from '../../server/lib/x.js';`, []],
    ['an import inside one domain passes', 'server/lib/a.ts', `import { x } from './b.js';`, []],
    ['a commented-out import does not count', 'client/src/a.ts', `// import { x } from '../../server/lib/x.js';`, []],
  ];
  for (const [name, file, src, want] of cases) {
    if (test(`scanner: ${name}`, () => {
      assert.deepStrictEqual(scanBoundary({ [file]: src }), want);
    })) p++; else f++;
  }

  if (test('client/, server/ and shared/ cross the boundary only with import type or the four runtime-shared modules', () => {
    const files: Record<string, string> = {};
    for (const dir of DOMAINS) sourceFiles(root, dir, files);
    assert.ok(Object.keys(files).length > 100, `only ${Object.keys(files).length} source files found`);
    const stray = scanBoundary(files);
    assert.deepStrictEqual(stray, [], `make it \`import type\`, or move the code into one of ${RUNTIME_SHARED.join(', ')}:\n    ${stray.join('\n    ')}`);
  })) p++; else f++;

  if (test('every runtime-shared module still exists — a stale name would let a new module pass under it', () => {
    for (const mod of RUNTIME_SHARED) assert.ok(fs.existsSync(path.join(root, `${mod}.ts`)), `${mod}.ts`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
