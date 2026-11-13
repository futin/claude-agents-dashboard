/**
 * Resolves every relative markdown link under `docs/` against the real tree.
 *
 * The repo root is found by walking up for `package.json` — never a fixed
 * `../..` hop count from this file, so moving the test cannot silently
 * repoint what it checks (the same rule `docs/guides/*` tooling follows).
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
export function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}

/** Markdown files under `dir`, recursively, as absolute paths. */
function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(abs, out);
    else if (/\.mdx?$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

/**
 * Blanks out fenced blocks and inline code spans, keeping newlines so line
 * numbers survive. A markdown link *shown as an example* inside backticks is
 * not a link, and a regex in a code fence can look like one.
 */
export function stripCode(content: string): string {
  const lines = content.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const open = line.match(/^\s*(```+|~~~+)/);
      if (fence !== null) {
        if (open && open[1].startsWith(fence[0]) && open[1].length >= fence.length) fence = null;
        return '';
      }
      if (open) { fence = open[1]; return ''; }
      return line.replace(/`[^`]*`/g, '');
    })
    .join('\n');
}

export interface MdLink { line: number; target: string }

/** Relative link targets (anchor stripped), skipping URLs and anchor-only links. */
export function extractLinks(content: string): MdLink[] {
  const re = /\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const found: MdLink[] = [];
  stripCode(content).split('\n').forEach((line, i) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const raw = m[1].trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      const target = raw.split('#')[0];
      if (target.length === 0) continue;
      found.push({ line: i + 1, target });
    }
  });
  return found;
}

export function run(): number {
  console.log('\n=== docs links ===\n');
  let p = 0, f = 0;

  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const docsDir = path.join(root, 'docs');

  if (test('repo root is found by walking up for package.json', () => {
    assert.ok(fs.existsSync(path.join(root, 'package.json')));
    assert.ok(fs.existsSync(docsDir), `expected ${docsDir} to exist`);
  })) p++; else f++;

  if (test('code fences and inline code are not scanned for links', () => {
    const src = [
      '```js',
      'const RE = /[a](b)/;',
      '```',
      'prose `[api.ts](server/api.ts)` shown as an example',
      '[real](./real.md)',
    ].join('\n');
    assert.deepStrictEqual(extractLinks(src), [{ line: 5, target: './real.md' }]);
  })) p++; else f++;

  if (test('URL, mailto and anchor-only links are skipped', () => {
    const src = '[a](https://x.dev) [b](mailto:x@y.z) [c](#section) [d](../real.md#frag)';
    assert.deepStrictEqual(extractLinks(src), [{ line: 1, target: '../real.md' }]);
  })) p++; else f++;

  if (test('every relative link under docs/ resolves to a real path', () => {
    const dead: string[] = [];
    for (const abs of markdownFiles(docsDir)) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const dir = path.posix.dirname(rel);
      for (const { line, target } of extractLinks(fs.readFileSync(abs, 'utf8'))) {
        const resolved = path.posix.normalize(path.posix.join(dir, decodeURIComponent(target)));
        if (!fs.existsSync(path.join(root, ...resolved.split('/')))) {
          dead.push(`${rel}:${line} -> ${target} (resolves to ${resolved})`);
        }
      }
    }
    assert.deepStrictEqual(dead, [], `${dead.length} dead link(s):\n      ${dead.join('\n      ')}`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
