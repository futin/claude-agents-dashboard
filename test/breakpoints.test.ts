/**
 * Guards the breakpoint ladder's token comment block in `client/src/styles.css`,
 * plus (since the desktop-first → mobile-first inversion landed) the `@media`
 * queries that are supposed to draw every literal from it.
 *
 * The seven tiers live as prose, not CSS custom properties — `@media` cannot
 * read `var()` in its condition, so the block above `:root` is the single
 * source of truth and every query in the file repeats one of its numbers as a
 * literal. Tier blocks are section-local by convention (appended after each
 * section's own base rules rather than pooled into one block per tier — see
 * `.claude/CLAUDE.md`), so the query-side cases below assert on the *set* of
 * values in use, never on a count of blocks or queries: a count would fail
 * the moment a new section is added, which is exactly the wrong thing to
 * guard.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NARROW_PX, SHELL_NARROW_PX } from '../client/src/hooks/useNarrow.js';

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

/** The ladder's seven values, in ascending tier order. */
const LADDER_VALUES = [640, 768, 1024, 1280, 1536, 1537, 1921];

/**
 * A CSS source with every `/* ... *\/` block comment removed.
 *
 * `styles.css`'s block comments wrap prose across several lines without a
 * leading `*` on each continuation line (unlike the JSDoc-style comments
 * `tailnet.test.ts` strips line-by-line) — its derivation notes read as plain
 * indented sentences, e.g. "Below 700px `AsideStrip` replaces...". A
 * line-prefix filter leaves that prose in place, which is exactly the false
 * positive this case exists to avoid. Removing matched `/* *\/` spans strips
 * it regardless of per-line formatting.
 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every parenthesised condition clause from every `@media` prelude in the
 * file, comments excluded — one array entry per clause, not per rule.
 *
 * A prelude can hold more than one `(...)` clause: `and`-joined ranges
 * (`@media (min-width:768px) and (max-width:1023px)`) and comma-separated
 * query lists (`@media (a), (b)`) both put multiple parenthesised groups
 * before the same `{`. The original version of this helper matched only the
 * first `(...)` after `@media`, so a compound query's later clauses —
 * including a reintroduced `max-width` — were silently dropped and never
 * reached any assertion. This version first isolates each rule's whole
 * prelude (`@media` up to the next `{`), then pulls every `(...)` clause out
 * of that prelude, so `and`-joins and comma lists both surface every clause
 * they contain to every case that consumes this helper.
 *
 * Deliberately not specially handled:
 * - `not` / `only` keywords sit outside the parens and don't affect clause
 *   extraction either way.
 * - Range syntax (`@media (400px <= width <= 700px)`) is not parsed into a
 *   semantic min/max — it comes back as one opaque clause. It won't match
 *   `min-width:<n>px` in `widthQueries()`'s consumers, so it can't slip a
 *   disguised upper bound past case 1 undetected: the shape mismatch trips
 *   `every width query is min-width`'s `startsWith('min-width:')` assertion
 *   (or, if it hasn't been added to the ladder, case 2's shape guard), so it
 *   fails loud rather than passing silently. Nothing in the current file
 *   uses this syntax.
 */
function mediaConditions(): string[] {
  const css = stripCssComments(fs.readFileSync(STYLES_PATH, 'utf8'));
  const preludeRe = /@media\s*([^{]+)\{/g;
  const clauseRe = /\(([^()]+)\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = preludeRe.exec(css)) !== null) {
    const prelude = m[1];
    let c: RegExpExecArray | null;
    clauseRe.lastIndex = 0;
    while ((c = clauseRe.exec(prelude)) !== null) out.push(c[1].trim());
  }
  return out;
}

/** `mediaConditions()` minus the two deliberately-untouched non-width families. */
function widthQueries(): string[] {
  return mediaConditions().filter(
    (q) => !q.includes('prefers-reduced-motion') && !q.includes('pointer')
  );
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

  if (test('useShellNarrow mirrors the shell tier', () => {
    // 640, not 768: this is the rail-to-top-bar switch, and it decides which of
    // its two homes the one account chip is drawn in (App.tsx). Reading it off
    // NARROW_PX would have handed the chip to the phone bar across the whole
    // 640–767 band, where that bar is already `display:none`.
    assert.strictEqual(SHELL_NARROW_PX, 639.98);
    const source = fs.readFileSync(NARROW_HOOK_PATH, 'utf8');
    assert.match(source, /`\(max-width:\$\{SHELL_NARROW_PX\}px\)`/);
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

  if (test('every width query is min-width', () => {
    const queries = widthQueries();
    assert.ok(queries.length > 0, 'expected at least one width @media query');
    for (const q of queries) {
      assert.ok(!q.includes('max-width'), `found a max-width query: (${q})`);
      assert.ok(q.startsWith('min-width:'), `expected a min-width query, got: (${q})`);
    }
  })) p++; else f++;

  if (test('every width query uses a ladder value', () => {
    const queries = widthQueries();
    for (const q of queries) {
      const m = /^min-width:(\d+(?:\.\d+)?)px$/.exec(q);
      assert.ok(m, `unexpected query shape: (${q})`);
      const value = Number(m![1]);
      assert.ok(LADDER_VALUES.includes(value), `${value} (from "${q}") is not a ladder value`);
    }
  })) p++; else f++;

  if (test('no orphan tier', () => {
    const tierValues = parseTiers(ladderBlock()).map((t) => t.value);
    const queryValues = widthQueries().map((q) => {
      const m = /^min-width:(\d+(?:\.\d+)?)px$/.exec(q);
      assert.ok(m, `unexpected query shape: (${q})`);
      return Number(m![1]);
    });
    const usedInQueries = new Set(queryValues);
    for (const v of tierValues) {
      assert.ok(usedInQueries.has(v), `tier value ${v} appears in no @media query`);
    }
    const inBlock = new Set(tierValues);
    for (const v of queryValues) {
      assert.ok(inBlock.has(v), `query value ${v} is not one of the tiers in the token block`);
    }
  })) p++; else f++;

  if (test('the retired widths are gone', () => {
    const css = stripCssComments(fs.readFileSync(STYLES_PATH, 'utf8'));
    for (const n of [700, 900, 1100, 1201, 1330, 1568]) {
      assert.strictEqual(
        new RegExp(`\\b${n}px\\b`).test(css), false,
        `retired width ${n}px still appears outside a comment`
      );
    }
  })) p++; else f++;

  if (test('the measure dropped', () => {
    const css = stripCssComments(fs.readFileSync(STYLES_PATH, 'utf8'));
    const rule = /\.wrap\.wide,\.wrap\.broad\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.wrap.wide,.wrap.broad rule not found');
    assert.match(rule![1], /(?:^|;)max-width:1248px(?:;|$)/, 'expected max-width:1248px on .wrap.wide,.wrap.broad');
    // 1280 legitimately survives as the `xl` @media min-width value; it must
    // never again show up as a max-width *property* on .wrap.
    assert.strictEqual(
      /max-width:\s*1280px/.test(css), false,
      'found a max-width:1280px property — 1280 should only remain as the xl query value'
    );
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
