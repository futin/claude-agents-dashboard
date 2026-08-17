/**
 * citations.mjs — verify every `file:N-M` excerpt label in the guide still points
 * at the code it quotes.
 *
 *   node docs/learning/hooks/tools/citations.mjs          # report
 *   node docs/learning/hooks/tools/citations.mjs --fix     # rewrite stale labels
 *
 * Line numbers rot fast: a source file gaining forty lines silently repoints half
 * a guide at unrelated code. Each excerpt is classified:
 *
 *   fresh     anchor found at (or within slack of) the cited line — nothing to do
 *   stale     the code is still there but moved — `--fix` rewrites the label
 *   gone      most of the excerpt is no longer in the file — a person must look,
 *             because the prose around it may be wrong too
 *   abridged  the label declares itself unverifiable — reported, never a failure
 *
 * Anchoring notes, each of which is a mistake this would otherwise make:
 *  - Do NOT anchor on the excerpt's first line. Lines recur (`  esac`, `INPUT=$(cat)`),
 *    and a first-match anchor confidently proposes a backwards "fix" into the
 *    wrong function.
 *  - Do NOT anchor on the longest line either — that is often the abridged
 *    signature, the one line most likely to have been reshaped.
 *  - What works: two independent signals. *Coverage* (how many distinctive lines
 *    still exist anywhere in the file) decides `gone`. The *most unique line that
 *    is present* — fewest occurrences, ties broken by length — decides WHERE,
 *    offset by its index within the excerpt.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * Walk up to the repo root rather than hardcoding a hop count. Citation paths are
 * repo-relative, so a wrong root reports every excerpt as `gone` — which is what
 * happened when this guide moved from `learning-docs/hooks/` to
 * `docs/learning/hooks/` and the fixed `../..` silently pointed at `docs/`.
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

const DOCS = ['README.md', 'guide/lifecycle.md', 'guide/answer-channel.md',
  'guide/held-socket.md', 'guide/stop-loop.md', 'guide/fail-open.md', 'guide/config.md'];

/** Slack, in lines, before a citation counts as moved rather than fresh. */
const SLACK = 2;
/** Below this share of distinctive lines still present, the excerpt is `gone`. */
const GONE_BELOW = 0.5;

const norm = s => s.trim().replace(/\s+/g, ' ');

const results = [];

for (const doc of DOCS) {
  const docPath = path.join(ROOT, doc);
  let text = fs.readFileSync(docPath, 'utf8');
  const lines = text.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    if (!/^```/.test(lines[i])) continue;
    const fenceStart = i;
    const body = [];
    i++;
    while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
    if (!body.length) continue;

    // The label is the fence's first line: `# path:N-M` or `// path:N-M`, with an
    // optional trailing parenthetical that may declare the excerpt abridged.
    const label = body[0].match(/^\s*(?:#|\/\/)\s*([\w./-]+):(\d+)(?:-(\d+))?(\s*\(.*\))?\s*$/);
    if (!label) continue;

    const [, rel, startStr, endStr, tail = ''] = label;
    const start = Number(startStr);
    const abridged = /abridged|compacted/i.test(tail);
    const srcPath = path.join(REPO, rel);

    if (!fs.existsSync(srcPath)) {
      results.push({ doc, rel, start, status: 'gone', detail: 'source file not found' });
      continue;
    }

    const src = fs.readFileSync(srcPath, 'utf8').split('\n');
    const excerpt = body.slice(1);

    // Distinctive excerpt lines: skip blanks and lone punctuation, which recur
    // everywhere and carry no positional information.
    const distinctive = excerpt
      .map((l, idx) => ({ text: norm(l), idx }))
      .filter(e => e.text.length >= 8 && /[A-Za-z]/.test(e.text));
    if (!distinctive.length) continue;

    const counts = new Map();
    for (const e of distinctive) {
      const n = src.reduce((acc, sl) => acc + (norm(sl) === e.text ? 1 : 0), 0);
      counts.set(e.idx, n);
    }
    const present = distinctive.filter(e => counts.get(e.idx) > 0);
    const coverage = present.length / distinctive.length;

    if (abridged) {
      results.push({
        doc, rel, start, status: 'abridged',
        detail: `${present.length}/${distinctive.length} lines found (label declares it abridged)`
      });
      continue;
    }

    if (coverage < GONE_BELOW) {
      results.push({
        doc, rel, start, status: 'gone',
        detail: `only ${present.length}/${distinctive.length} distinctive lines still in the file`
      });
      continue;
    }

    // Most unique present line decides WHERE. Fewest occurrences wins; ties go to
    // the longest (more specific) line.
    const anchorEntry = present
      .slice()
      .sort((a, b) => (counts.get(a.idx) - counts.get(b.idx)) || (b.text.length - a.text.length))[0];
    const hitLine = src.findIndex(sl => norm(sl) === anchorEntry.text) + 1;
    const impliedStart = hitLine - anchorEntry.idx;

    if (Math.abs(impliedStart - start) <= SLACK) {
      results.push({ doc, rel, start, status: 'fresh' });
      continue;
    }

    const end = endStr ? Number(endStr) : start;
    const impliedEnd = impliedStart + (end - start);
    results.push({
      doc, rel, start, status: 'stale',
      detail: `cited ${start}-${end}, found at ${impliedStart}-${impliedEnd}`
    });

    if (FIX) {
      // Never rewrite a `gone` excerpt — bumping the line number of code that
      // actually changed makes stale content look freshly verified.
      const oldRef = endStr ? `${rel}:${start}-${end}` : `${rel}:${start}`;
      const newRef = endStr ? `${rel}:${impliedStart}-${impliedEnd}` : `${rel}:${impliedStart}`;
      lines[fenceStart + 1] = lines[fenceStart + 1].replace(oldRef, newRef);
      changed = true;
    }
  }

  if (FIX && changed) {
    fs.writeFileSync(docPath, lines.join('\n'), 'utf8');
    console.log(`  rewrote labels in ${doc}`);
  }
}

/* ------------------------------------------------------------------ report */

const by = s => results.filter(r => r.status === s);
const order = ['gone', 'stale', 'abridged', 'fresh'];
const mark = { fresh: 'ok  ', stale: 'MOVED', gone: 'GONE', abridged: 'abr ' };

for (const status of order) {
  for (const r of by(status)) {
    if (status === 'fresh') continue;
    console.log(`  ${mark[status]} ${r.doc} → ${r.rel}:${r.start}${r.detail ? `  (${r.detail})` : ''}`);
  }
}
console.log(
  `\n${results.length} citations: ${by('fresh').length} fresh, ${by('stale').length} moved, `
  + `${by('gone').length} gone, ${by('abridged').length} abridged`
);

if (by('gone').length) {
  console.error('\nGONE citations need a human: the prose around them may also be wrong.');
  process.exit(1);
}
if (by('stale').length && !FIX) {
  console.error('\nRun with --fix to rewrite the moved labels.');
  process.exit(1);
}
