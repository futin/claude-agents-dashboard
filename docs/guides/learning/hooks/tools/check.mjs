/**
 * check.mjs — verify the generated page against the markdown it came from.
 *
 *   node docs/guides/learning/hooks/tools/check.mjs
 *
 * Exits non-zero on failure. Four checks, each guarding a failure that actually
 * happens when a minimal markdown renderer is 90% right:
 *   1. no `.md` links survive, and every in-page anchor resolves to a real id;
 *   2. fidelity — no markdown prose went missing from the page;
 *   3. no leaked markdown syntax in the visible text;
 *   4. no external assets — the offline guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PAGE = path.join(ROOT, 'index.html');

const DOCS = ['README.md', 'guide/lifecycle.md', 'guide/answer-channel.md',
  'guide/held-socket.md', 'guide/stop-loop.md', 'guide/fail-open.md', 'guide/config.md'];

const html = fs.readFileSync(PAGE, 'utf8');
const failures = [];
const notes = [];

/* --------------------------------------------------- 1. links and anchors */

const mdLinks = [...html.matchAll(/href="([^"]*\.md(?:#[^"]*)?)"/g)].map(m => m[1]);
if (mdLinks.length) failures.push(`${mdLinks.length} .md link(s) survived into the page: ${mdLinks.slice(0, 5).join(', ')}`);

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const badAnchors = [...html.matchAll(/href="#([^"]+)"/g)]
  .map(m => m[1])
  .filter(a => a !== 'top' && !ids.has(a));
if (badAnchors.length) failures.push(`${badAnchors.length} dead in-page anchor(s): ${[...new Set(badAnchors)].slice(0, 5).join(', ')}`);
notes.push(`${ids.size} ids, ${[...html.matchAll(/href="#/g)].length} in-page links`);

/* ------------------------------------------------------------ 2. fidelity */

/** Visible text: drop script/style/svg/pre, then tags. */
function visibleText(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/**
 * Normalize to a bag of words. Both sides go through this, which is the whole
 * point: an ordered-substring probe fails on things the renderer legitimately
 * reshapes (a markdown `1.` becomes an <ol>, table cells become separate <td>s
 * so tag-stripping inserts spaces mid-row, a link's URL never appears as text).
 * What we actually need to catch is a block that silently did not render at all,
 * and word-set containment catches that without the false alarms.
 */
function words(s) {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

const pageWordSet = new Set(words(visibleText(html)));

/** Lines a generator legitimately does not reproduce. */
function skippable(line, inFence) {
  const t = line.trim();
  if (!t) return true;
  if (inFence) return true;                        // fence bodies: <pre> for code, SVG for mermaid
  if (t.startsWith('<!--')) return true;           // provenance stamp is metadata
  if (/^#\s/.test(t)) return true;                 // per-file H1 replaced by the doc title
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(t)) return true; // table separator row
  if (/^-{3,}$/.test(t)) return true;              // horizontal rule
  if (t.includes('./index.html')) return true;     // the page's self-reference is dropped
  return false;
}

let missing = 0;
let checked = 0;
const missingSamples = [];
for (const doc of DOCS) {
  const lines = fs.readFileSync(path.join(ROOT, doc), 'utf8').split('\n');
  let inFence = false;
  let inSelfRef = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    // The blockquote containing ./index.html is dropped whole, so skip its lines.
    if (line.trim().startsWith('>')) {
      if (line.includes('./index.html')) inSelfRef = true;
      if (inSelfRef) continue;
    } else {
      inSelfRef = false;
    }
    if (skippable(line, inFence)) continue;

    // Distinctive words only: 4+ chars, so "the/and/a" can't carry a line.
    const distinctive = words(line).filter(w => w.length >= 4 && !/^\d+$/.test(w));
    if (distinctive.length < 3) continue;
    checked++;
    const absent = distinctive.filter(w => !pageWordSet.has(w));
    // One stray absence is a hyphenation/entity artifact; a fifth of the line
    // missing means the block did not render.
    if (absent.length > Math.max(1, Math.floor(distinctive.length * 0.2))) {
      missing++;
      if (missingSamples.length < 6) {
        missingSamples.push(`${doc}: ${line.trim().slice(0, 70)}  [absent: ${absent.slice(0, 5).join(', ')}]`);
      }
    }
  }
}
if (missing) failures.push(`fidelity: ${missing}/${checked} markdown line(s) not found in the page:\n    ` + missingSamples.join('\n    '));
else notes.push(`fidelity: ${checked} prose lines all present`);

/* ------------------------------------------------- 3. leaked markdown */

// Strip pre/code AND svg: code and hand-authored figure labels legitimately
// contain these characters.
const prose = html
  .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
  .replace(/<code[\s\S]*?<\/code>/g, ' ')
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ');

for (const [pat, name] of [[/\*\*/g, 'bold **'], [/\]\(/g, 'link ]('], [/^\s*\|/gm, 'table pipe']]) {
  const hits = prose.match(pat);
  if (hits) failures.push(`leaked markdown (${name}): ${hits.length} occurrence(s)`);
}
if (/\u0000/.test(html)) failures.push('NUL placeholder leaked into the page');

/* -------------------------------------------------- 4. offline guarantee */

const ext = [
  [/<script[^>]+src=/i, 'external <script src>'],
  [/<link[^>]+rel=["']?stylesheet/i, 'external stylesheet'],
  [/<img/i, '<img> element'],
  [/url\(\s*['"]?https?:/i, 'remote url() in CSS'],
  [/@import/i, 'CSS @import']
];
for (const [pat, name] of ext) if (pat.test(html)) failures.push(`external asset: ${name}`);

/* ------------------------------------------------------------------ report */

for (const n of notes) console.log(`  ok  ${n}`);
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nall checks passed');
