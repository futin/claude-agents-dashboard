#!/usr/bin/env node
/**
 * citations.mjs — verify every `// file.ts:N-M` excerpt label still points at
 * the code it quotes.
 *
 *   node docs/published-guides/learning/dictation/tools/citations.mjs
 *   node docs/published-guides/learning/dictation/tools/citations.mjs --fix
 *
 * Line numbers rot fast: a source file gaining 40 lines silently repoints half
 * a guide at unrelated code. Each excerpt is classified:
 *
 *   fresh     anchor found at or near the cited line          — nothing to do
 *   stale     the code is still there but moved               — --fix rewrites the label
 *   gone      most of the excerpt is no longer in the file    — a person must look,
 *                                                               the prose may be wrong too
 *   abridged  the label declares it unverifiable              — reported, never a failure
 *
 * Two signals, deliberately independent. COVERAGE (how many of the excerpt's
 * distinctive lines still exist anywhere in the file) decides `gone`. The MOST
 * UNIQUE PRESENT LINE — fewest occurrences, ties broken by length — decides
 * *where*, offset by its index within the excerpt.
 *
 * Anchoring on the excerpt's first line does not work: lines recur, and a
 * first-match anchor once proposed a confidently backwards "fix" into a
 * different function. Anchoring on the longest line misfires whenever that line
 * is an abridged signature.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * Walk up to the repo root rather than hardcoding a hop count. Citation paths are
 * repo-relative, so a wrong root reports every excerpt as `gone` — which is what a
 * fixed `../../..` did the moment this guide moved from `docs/learning/dictation/`
 * to `docs/published-guides/learning/dictation/` and the extra level made it point
 * at `docs/`.
 */
function findRepoRoot(from) {
  let dir = from;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found (no package.json above ' + from + ')');
}

const REPO = findRepoRoot(ROOT);
const FIX = process.argv.includes('--fix');
const DOCS = ['README.md', 'guide/why-local-whisper.md', 'guide/render-gate.md',
              'guide/recorder-lifecycle.md'];

/** `// path/to/file.ts:12-30  (comment elided)`, or a bare `:27` for one line. */
const LABEL = /^\/\/ (\S+?):(\d+)(?:-(\d+))?(\s+\(.*\))?\s*$/;
const norm = s => s.trim().replace(/\s+/g, ' ');

const results = [];

for (const docFile of DOCS) {
  const docPath = path.join(ROOT, docFile);
  const lines = fs.readFileSync(docPath, 'utf8').split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('```')) continue;
    const label = (lines[i + 1] || '').match(LABEL);
    if (!label) continue;

    const [, rel, fromStr, toStr, suffix] = label;
    const excerpt = [];
    for (let j = i + 2; j < lines.length && !lines[j].startsWith('```'); j++) excerpt.push(lines[j]);

    const srcPath = path.join(REPO, rel);
    if (!fs.existsSync(srcPath)) {
      results.push({ doc: docFile, rel, verdict: 'gone', detail: 'source file not found' });
      continue;
    }
    const src = fs.readFileSync(srcPath, 'utf8').split('\n');
    const counts = new Map();
    src.forEach(l => {
      const k = norm(l);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    });

    // distinctive = long enough that its presence means something
    const distinct = excerpt.map(norm).filter(l => l.length > 8);
    const present = distinct.filter(l => counts.has(l));
    const coverage = distinct.length ? present.length / distinct.length : 1;

    if (coverage < 0.6) {
      results.push({
        doc: docFile, rel, verdict: 'gone',
        detail: `only ${Math.round(coverage * 100)}% of the excerpt is still in the file`
      });
      continue;
    }

    // where: the most unique present line, offset by its index in the excerpt
    let anchor = null;
    for (let k = 0; k < excerpt.length; k++) {
      const key = norm(excerpt[k]);
      if (!key || key.length <= 8 || !counts.has(key)) continue;
      const c = counts.get(key);
      if (!anchor || c < anchor.count || (c === anchor.count && key.length > anchor.key.length)) {
        anchor = { key, count: c, index: k };
      }
    }
    if (!anchor) {
      results.push({ doc: docFile, rel, verdict: 'abridged', detail: 'no distinctive line to anchor on' });
      continue;
    }

    const at = src.findIndex(l => norm(l) === anchor.key);
    const start = at + 1 - anchor.index;
    const end = start + excerpt.length - 1;
    const cited = [Number(fromStr), toStr === undefined ? Number(fromStr) : Number(toStr)];
    const span = (a, b) => (a === b ? `${a}` : `${a}-${b}`);

    if (cited[0] === start && cited[1] === end) {
      results.push({ doc: docFile, rel, verdict: 'fresh', detail: span(start, end) });
    } else if (suffix) {
      // The label declares the excerpt abridged, so its length cannot be
      // trusted to derive an end line. Report, never fail, never rewrite.
      results.push({
        doc: docFile, rel, verdict: 'abridged',
        detail: `cited ${span(cited[0], cited[1])}, content now starts at ${start}`
      });
    } else {
      results.push({
        doc: docFile, rel, verdict: 'stale',
        detail: `${span(cited[0], cited[1])} → ${span(start, end)}`
      });
      if (FIX) {
        lines[i + 1] = `// ${rel}:${span(start, end)}`;
        changed = true;
      }
    }
  }

  if (changed) fs.writeFileSync(docPath, lines.join('\n'));
}

const by = v => results.filter(r => r.verdict === v);
for (const v of ['gone', 'stale', 'abridged', 'fresh']) {
  for (const r of by(v)) console.log(`${v.padEnd(9)} ${r.rel.padEnd(44)} ${r.detail}  (${r.doc})`);
}
console.log(`\n${by('fresh').length} fresh, ${by('stale').length} stale, ${by('abridged').length} abridged, ${by('gone').length} gone`);
if (FIX && by('stale').length) console.log('stale labels rewritten; `gone` excerpts left alone on purpose');
process.exit(by('gone').length || (!FIX && by('stale').length) ? 1 : 0);
