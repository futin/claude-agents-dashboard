/**
 * Pins which `server/` files may walk the whole transcript tree: a `listTranscripts(` call, a `listUsageTranscripts(` call (which walks it and every
 * session's subagents dir besides), or a `findTranscript(` with no refs argument (which falls back to its own walk of every project dir).
 *
 * Every request path, the `/api/sessions` poll included, reads the shared listing in `server/lib/transcript-listing.ts`, which walks afresh once it is
 * past its max age (1 s for the poll). A new direct call elsewhere quietly brings back a per-request walk — a pin toggle cost four of them before #472.
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
  'server/lib/scan.ts', // defines them; `listUsageTranscripts` builds on `listTranscripts`
  'server/lib/transcript-listing.ts', // the shared listing's fallback walk
  'server/lib/analytics.ts', // the Analytics report, not a poll path
  'server/lib/management.ts', // `transcriptsOf`, for a caller that passes no listing
  'server/lib/usage-ledger.ts', // the usage ledger's own tick, which needs subagent transcripts the shared listing leaves out
  'server/lib/notify.ts', // `resolveLabel`: one lookup per push actually sent, never per request
  'server/lib/handover.ts', // `stepHandOver`: one lookup per hand-over poll step, bounded by HANDOVER_MAX_MS
]);

/** Blanks `/* … *\/` and `// …` comments; `://` inside a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Top-level argument count of the call whose `(` sits at `open` in `src`; parentheses, brackets and braces nest. */
function argCount(src: string, open: number): number {
  let depth = 0, commas = 0, any = false;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return any ? commas + 1 : 0;
      depth--;
    } else if (c === ',' && depth === 0) commas++;
    else if (!/\s/.test(c)) any = true;
  }
  return any ? commas + 1 : 0;
}

/** Whether `src` (comments already stripped) walks the whole tree: any `listTranscripts(` or `listUsageTranscripts(`, or a `findTranscript(` given fewer than 3 arguments. */
function walks(src: string): boolean {
  if (/(?<![\w$.])(?:listTranscripts|listUsageTranscripts)\s*\(/.test(src)) return true;
  for (const m of src.matchAll(/(?<![\w$.])findTranscript\s*\(/g)) {
    if (argCount(src, m.index + m[0].length - 1) < 3) return true;
  }
  return false;
}

/** The files, among `files` (repo-relative path → text), that walk the whole transcript tree outside a comment, sorted. */
export function scanWalkers(files: Record<string, string>): string[] {
  return Object.entries(files).filter(([, text]) => walks(stripComments(text))).map(([rel]) => rel).sort();
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
    ['a longer name does not count', `sharedListTranscripts(root); refindTranscript(root, id); findTranscriptByPrefix(refs, p);`, []],
    ['an import without a call does not count', `import { listTranscripts, findTranscript, listUsageTranscripts } from './scan.js';`, []],
    ['a listUsageTranscripts call counts', `for (const ref of listUsageTranscripts(root)) {}`, ['a.ts']],
    ['a findTranscript with no refs counts', `const t = findTranscript(projectsRoot(), w.id);`, ['a.ts']],
    ['a findTranscript with refs does not count', `const t = findTranscript(root, id, sharedListing(root, now));`, []],
    ['a nested call with commas inside an argument still counts as two', `findTranscript(join(a, b), pick(x, y))`, ['a.ts']],
    ['one bare findTranscript among refs-passing ones counts', `findTranscript(r, id, refs); findTranscript(r, id);`, ['a.ts']],
  ];
  for (const [name, src, want] of cases) {
    if (test(`scanner: ${name}`, () => {
      assert.deepStrictEqual(scanWalkers({ 'a.ts': src }), want);
    })) p++; else f++;
  }

  if (test('under server/, only the allowed files walk the whole transcript tree', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    const stray = scanWalkers(files).filter(rel => !ALLOWED.has(rel));
    assert.deepStrictEqual(stray, [], `walk the shared listing (sharedListing / resolveTranscript) instead: ${stray.join(', ')}`);
  })) p++; else f++;

  if (test('every allowed file still walks it — a stale entry would let a new walker hide behind its name', () => {
    const files: Record<string, string> = {};
    for (const rel of ALLOWED) files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.deepStrictEqual(scanWalkers(files), [...ALLOWED].sort());
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
