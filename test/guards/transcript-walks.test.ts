/**
 * Pins which `server/` files may walk the whole transcript tree with `listTranscripts(`.
 *
 * The `/api/sessions` poll walks it every 3 s on purpose and publishes the result (`server/lib/transcript-listing.ts`); every other request path reads
 * that shared listing. A new direct call elsewhere quietly brings back a per-request walk — a pin toggle cost four of them before #472.
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

/** The walkers, each with why it may walk. */
const ALLOWED = new Set([
  'server/lib/scan.ts', // defines it; `listUsageTranscripts` builds on it
  'server/lib/transcript-listing.ts', // the shared listing's fallback walk
  'server/lib/scan-snapshot.ts', // the sessions poll: the one fresh walk, which it publishes
  'server/lib/analytics.ts', // the Analytics report, not a poll path
  'server/lib/management.ts', // `transcriptsOf`, for a caller that passes no listing
]);

/** Blanks `/* … *\/` and `// …` comments; `://` inside a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The files, among `files` (repo-relative path → text), that call `listTranscripts(` outside a comment, sorted. */
export function scanWalkers(files: Record<string, string>): string[] {
  return Object.entries(files).filter(([, text]) => /(?<![\w$.])listTranscripts\s*\(/.test(stripComments(text))).map(([rel]) => rel).sort();
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
  console.log('\n=== transcript walks ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const cases: [string, string, string[]][] = [
    ['a call counts', `const t = listTranscripts(projectsRoot());`, ['a.ts']],
    ['a line comment does not count', `// listTranscripts(root) walks the tree`, []],
    ['a block comment does not count', `/** use listTranscripts(root) only here */`, []],
    ['a longer name does not count', `sharedListTranscripts(root); listUsageTranscripts(root);`, []],
    ['an import without a call does not count', `import { listTranscripts } from './scan.js';`, []],
  ];
  for (const [name, src, want] of cases) {
    if (test(`scanner: ${name}`, () => {
      assert.deepStrictEqual(scanWalkers({ 'a.ts': src }), want);
    })) p++; else f++;
  }

  if (test('under server/, only the allowed files call listTranscripts(', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    const stray = scanWalkers(files).filter(rel => !ALLOWED.has(rel));
    assert.deepStrictEqual(stray, [], `walk the shared listing (sharedListing / resolveTranscript) instead: ${stray.join(', ')}`);
  })) p++; else f++;

  if (test('every allowed file still calls it — a stale entry would let a new walker hide behind its name', () => {
    const files: Record<string, string> = {};
    for (const rel of ALLOWED) files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.deepStrictEqual(scanWalkers(files), [...ALLOWED].sort());
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
