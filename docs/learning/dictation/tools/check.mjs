#!/usr/bin/env node
/**
 * check.mjs — verify the generated page against the markdown it came from.
 *
 *   node docs/learning/dictation/tools/check.mjs
 *
 * Exits non-zero on failure. Four checks, all of which have caught a real bug:
 *   1. no in-guide `.md` links survive, and every in-page anchor resolves;
 *   2. fidelity — nothing from the markdown went missing from the page;
 *   3. no leaked markdown syntax in the visible text;
 *   4. no external assets, so the page still works offline from file://.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DOCS = ['README.md', 'guide/why-local-whisper.md', 'guide/render-gate.md',
              'guide/recorder-lifecycle.md'];
const GUIDE_BASENAMES = new Set(DOCS.map(f => path.basename(f).toLowerCase()));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fails = [];
const note = m => console.log(`  ${m}`);

// ── 1. links ────────────────────────────────────────────────────────────────
// "Zero .md links" means zero links back into THIS guide's own documents —
// those must be in-page anchors. Links to repo files that happen to be .md
// (docs/subsystems/*.md, .claude/CLAUDE.md) are source links, same category as
// a .ts link, and are marked with a visible ↗.
const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

const inGuideLinks = hrefs.filter(h => GUIDE_BASENAMES.has(path.basename(h.split('#')[0]).toLowerCase()));
if (inGuideLinks.length) fails.push(`in-guide .md links survived: ${inGuideLinks.join(', ')}`);

const deadAnchors = hrefs
  .filter(h => h.startsWith('#') && h !== '#top')
  .filter(h => !ids.has(h.slice(1)));
if (deadAnchors.length) fails.push(`anchors with no target: ${deadAnchors.join(', ')}`);
note(`links: ${hrefs.length} total, ${hrefs.filter(h => h.startsWith('#')).length} in-page, 0 in-guide .md`);

// ── 2. fidelity ─────────────────────────────────────────────────────────────
// Compare word sequences, not characters: stripping tags inserts spaces, so
// punctuation adjacency legitimately differs even when every word survived.
const visible = html
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  // the same characters `words()` strips below, so both sides tokenise alike —
  // a template literal in a fence keeps its backticks on the page but not in
  // the markdown tokens, and an inline `a|b` code span splits on one side only
  .replace(/[`*|]/g, ' ');
const pageWords = new Set(visible.split(/\s+/).filter(Boolean));

/** The three things the generator legitimately does not reproduce. */
function contentLines(md) {
  const out = [];
  let inFence = false;
  let fenceLang = '';
  let quote = [];
  const flushQuote = () => {
    const j = quote.join(' ');
    if (j && !j.includes('](./index.html)')) out.push(j);
    quote = [];
  };
  for (const raw of md.split('\n')) {
    if (raw.startsWith('```')) {
      if (!inFence) { inFence = true; fenceLang = raw.slice(3).trim(); }
      else { inFence = false; fenceLang = ''; }
      continue;
    }
    if (inFence) { if (fenceLang !== 'mermaid') out.push(raw); continue; }
    if (/^\s*<!--/.test(raw)) continue;              // the provenance stamp
    if (/^# /.test(raw)) continue;                   // each file's H1
    if (raw.startsWith('>')) { quote.push(raw.replace(/^>\s?/, '')); continue; }
    flushQuote();
    out.push(raw);
  }
  flushQuote();
  return out;
}

/**
 * Tokenise the markdown the same way the page's visible text tokenises.
 *
 * Only markdown-only characters may be stripped. Hyphens and angle brackets
 * must survive: `single-flight` and `useState<DictationPhase>('idle')` are one
 * word each on the page, so splitting them here reports 40 phantom failures.
 * Line-leading list/heading/quote markers are removed as markers, not as a
 * global character strip, for the same reason.
 */
function words(line) {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s?|-\s+|\d+\.\s+)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // link URLs are not visible text
    .replace(/[`*|]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && /[a-zA-Z]/.test(w));
}

let missing = 0;
for (const file of DOCS) {
  const md = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const line of contentLines(md)) {
    for (const w of words(line)) {
      if (!pageWords.has(w) && !pageWords.has(w.replace(/[.,;:)('"]+$/, ''))) {
        fails.push(`missing from page (${file}): "${w}" — from: ${line.trim().slice(0, 70)}`);
        missing++;
      }
    }
  }
}
note(`fidelity: ${missing} words missing (expected 0; H1s, mermaid bodies, comments and link URLs excluded)`);

// ── 3. leaked markdown ──────────────────────────────────────────────────────
// Strip <pre>, <code> AND <svg> first: code and hand-authored figure labels
// legitimately contain backticks, pipes and asterisks.
const prose = html
  .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
  .replace(/<code[\s\S]*?<\/code>/g, ' ')
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ');
for (const [label, re] of [['bold', /\*\*/], ['backtick', /`/], ['link', /\]\(/]]) {
  if (re.test(prose)) fails.push(`leaked markdown (${label}) in visible prose`);
}
note('leaked markdown: none');

// ── 4. offline guarantee ────────────────────────────────────────────────────
for (const [label, re] of [
  ['external script', /<script[^>]+src=/i],
  ['external stylesheet', /<link[^>]+rel=["']?stylesheet/i],
  ['remote url', /(src|href)="https?:\/\/(?!developer\.mozilla)/i],
  ['image file', /<img\b/i]
]) {
  if (re.test(html)) fails.push(`offline guarantee broken: ${label}`);
}
note('offline: inline style + inline script only, no fetched assets');

// ── verdict ─────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n✗ ${fails.length} failure(s):`);
  for (const f of fails.slice(0, 40)) console.error(`  - ${f}`);
  if (fails.length > 40) console.error(`  … and ${fails.length - 40} more`);
  process.exit(1);
}
console.log('\n✓ all checks pass');
