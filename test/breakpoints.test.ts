/**
 * Guards the breakpoint ladder's token comment block in `client/src/styles.css`.
 *
 * The seven tiers live as prose, not CSS custom properties — `@media` cannot
 * read `var()` in its condition, so the block above `:root` is the single
 * source of truth and every query in the file repeats one of its numbers as a
 * literal. This test only pins those numbers; it asserts nothing about
 * `@media` queries, which stay desktop-first (`max-width`) until a later task
 * migrates them onto this ladder.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NARROW_PX } from '../client/src/hooks/useNarrow.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Nearest ancestor of `from` that holds a `package.json`. */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}

const ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const STYLES_PATH = path.join(ROOT, 'client', 'src', 'styles.css');
const NARROW_HOOK_PATH = path.join(ROOT, 'client', 'src', 'hooks', 'useNarrow.ts');
const MANAGEMENT_VIEW_PATH = path.join(
  ROOT, 'client', 'src', 'components', 'management', 'ManagementView.tsx'
);

/** A file's source with `//` and `*`/`/*`-led comment lines stripped, as `tailnet.test.ts` does. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** The `/* -- Breakpoint ladder ... *\/` comment block, or throws if it's missing. */
function ladderBlock(): string {
  const css = fs.readFileSync(STYLES_PATH, 'utf8');
  const start = css.indexOf('Breakpoint ladder');
  assert.ok(start >= 0, 'breakpoint ladder token block not found in styles.css');
  const end = css.indexOf('*/', start);
  assert.ok(end >= 0, 'breakpoint ladder token block has no closing */');
  return css.slice(start, end);
}

interface Tier { name: string; value: number }

/** `tier <name>: <value>` lines inside the block, in file order. */
function parseTiers(block: string): Tier[] {
  const tiers: Tier[] = [];
  const re = /tier\s+(\w+):\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) tiers.push({ name: m[1], value: Number(m[2]) });
  return tiers;
}

export function run(): number {
  console.log('\n=== breakpoint ladder tokens ===\n');
  let p = 0, f = 0;

  if (test('documents all seven tiers', () => {
    const names = parseTiers(ladderBlock()).map((t) => t.name);
    assert.deepStrictEqual(names, ['sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']);
  })) p++; else f++;

  if (test('tier values are exact', () => {
    const values = parseTiers(ladderBlock()).map((t) => t.value);
    assert.deepStrictEqual(values, [640, 768, 1024, 1280, 1536, 1537, 1921]);
  })) p++; else f++;

  if (test('tiers are ascending', () => {
    const values = parseTiers(ladderBlock()).map((t) => t.value);
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i] > values[i - 1], `${values[i]} does not exceed ${values[i - 1]}`);
    }
  })) p++; else f++;

  if (test('the lock is derived', () => {
    const block = ladderBlock();
    assert.ok(/240/.test(block), 'expected the rail width 240 in the block');
    assert.ok(/1248/.test(block), 'expected the measure 1248 in the block');
    assert.ok(/1536/.test(block), 'expected the lock value 1536 in the block');
    assert.match(
      block,
      /240[^=]*\+[^=]*1248[^=]*=[^=]*1536/s,
      'expected an explicit 240 + ... + 1248 = 1536 arithmetic statement'
    );
  })) p++; else f++;

  if (test('useNarrow mirrors the density tier', () => {
    assert.strictEqual(NARROW_PX, 767.98);
    const source = fs.readFileSync(NARROW_HOOK_PATH, 'utf8');
    assert.match(source, /`\(max-width:\$\{NARROW_PX\}px\)`/);
  })) p++; else f++;

  if (test('ManagementView guards at the density tier', () => {
    const source = fs.readFileSync(MANAGEMENT_VIEW_PATH, 'utf8');
    assert.match(source, /\(max-width:767\.98px\)/);
  })) p++; else f++;

  if (test('no JS breakpoint uses a retired width', () => {
    const narrowSource = stripComments(fs.readFileSync(NARROW_HOOK_PATH, 'utf8'));
    const managementSource = stripComments(fs.readFileSync(MANAGEMENT_VIEW_PATH, 'utf8'));
    assert.strictEqual(narrowSource.match(/\b700\b/), null, 'useNarrow.ts still references 700');
    assert.strictEqual(
      managementSource.match(/\b700\b/), null, 'ManagementView.tsx still references 700'
    );
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
