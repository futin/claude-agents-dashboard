#!/usr/bin/env node
/**
 * verify-deck.mjs — the tutor-deck pre-handover checklist, mechanised.
 *
 * Usage: node verify-deck.mjs <deck.html> [repoRoot]
 *
 * Runs the seven checklist items from the tutor skill's `references/deck.md` §8,
 * plus two the checklist states in prose but leaves to the eye: the per-section
 * card shape from SKILL.md's Pedagogy, and excerpt fidelity — every `<pre>`'s
 * lines must appear verbatim, in order, inside the range its first line cites.
 * `(compacted here)` licenses dropping lines, never rewrapping them, and that is
 * what this checks: 5 of 15 excerpts failed it on lesson 1's first pass.
 *
 * `repoRoot` is what citations resolve against. It defaults to this repo, found by
 * walking up for `package.json` — never a fixed `../..` hop count, which silently
 * repoints the moment a tool moves. Pass it explicitly to check a deck against the
 * commit it actually stamps rather than against the working tree:
 *
 *   git archive <sha> | tar -x -C /tmp/at-sha
 *   node docs/guides/tutor/tools/verify-deck.mjs <deck.html> /tmp/at-sha
 *
 * That distinction is not academic. A working tree carrying an unmerged branch's
 * refactor reports drift a deck stamped at `main` does not actually have — which
 * nearly baked another branch's `usage.ts` rewrite into lesson 1.
 *
 * Read-only. Exits 1 on any FAIL; a WARN wants an eye but does not fail the run.
 */
import fs from 'node:fs';
import path from 'node:path';

/** This repo's root, found by walking up for `package.json`. */
function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      /* unreadable — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd(); // hit the filesystem root
    dir = parent;
  }
}

const [, , deckArg, repoRootArg] = process.argv;
if (!deckArg) {
  console.error('usage: node verify-deck.mjs <deck.html> [repoRoot]');
  process.exit(2);
}
const repoRoot = repoRootArg ? path.resolve(repoRootArg) : findRepoRoot(import.meta.dirname);
const deckPath = path.resolve(deckArg);
const html = fs.readFileSync(deckPath, 'utf8');
const lines = html.split('\n');

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { fails++; console.log(`  FAIL  ${m}`); };
const warn = (m) => { warns++; console.log(`  WARN  ${m}`); };
const head = (m) => console.log(`\n${m}`);

// ── helpers ─────────────────────────────────────────────────────────────────

/** Character offsets of every <pre>…</pre> region. */
function preRegions(text) {
  const out = [];
  const re = /<pre>([\s\S]*?)<\/pre>/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: re.lastIndex, body: m[1] });
  return out;
}
const PRES = preRegions(html);
const inPre = (offset) => PRES.some((r) => offset >= r.start && offset < r.end);

/** Character offsets of every <script>…</script> region (JS, not JSON). */
function scriptRegions(text) {
  const out = [];
  const re = /<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: re.lastIndex, body: m[1] });
  return out;
}
const SCRIPTS = scriptRegions(html);
const inScript = (offset) => SCRIPTS.some((r) => offset >= r.start && offset < r.end);

const offsetToLine = (offset) => html.slice(0, offset).split('\n').length;

function unescapeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Visible text of an HTML fragment, tags stripped and entities resolved. */
function textOf(fragment) {
  return unescapeEntities(fragment.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
const wordCount = (s) => (s === '' ? 0 : s.split(/\s+/).length);

const fileLineCache = new Map();
function lineCount(rel) {
  if (fileLineCache.has(rel)) return fileLineCache.get(rel);
  let n = null;
  try {
    n = fs.readFileSync(path.join(repoRoot, rel), 'utf8').split('\n').length;
  } catch { n = null; }
  fileLineCache.set(rel, n);
  return n;
}

// ── stamp (needed by later checks) ──────────────────────────────────────────

head('item 2 — stamp integrity');
let stamp = null;
{
  const m = html.match(/<script type="application\/json" id="provenance">([\s\S]*?)<\/script>/);
  if (!m) {
    fail('no <script type="application/json" id="provenance"> block');
  } else {
    try {
      stamp = JSON.parse(m[1]);
      ok('provenance JSON parses');
    } catch (e) {
      fail(`provenance JSON does not parse: ${e.message}`);
    }
  }
}
if (stamp) {
  const top = new Set(stamp.sources ?? []);
  let subsetOk = true;
  for (const sec of stamp.sections ?? []) {
    for (const s of sec.sources ?? []) {
      if (!top.has(s)) { fail(`sections[${sec.id}].sources has "${s}" missing from top-level sources`); subsetOk = false; }
    }
  }
  if (subsetOk) ok('every sections[].sources entry present in top-level sources');

  // union equality is the stamp's own rule (§6): top-level IS the union
  const union = new Set((stamp.sections ?? []).flatMap((s) => s.sources ?? []));
  const extra = [...top].filter((s) => !union.has(s));
  if (extra.length) warn(`top-level sources not drawn on by any section: ${extra.join(', ')}`);

  let pathsOk = true;
  for (const s of top) {
    if (lineCount(s) === null) { fail(`stamp source does not exist at HEAD: ${s}`); pathsOk = false; }
  }
  if (pathsOk) ok('every stamp source exists on disk');

  const ids = (stamp.sections ?? []).map((s) => s.id);
  const wrappers = [...html.matchAll(/<section id="(s\d+)">/g)].map((m) => m[1]);
  if (JSON.stringify(ids) === JSON.stringify(wrappers)) ok(`section ids match wrappers in order (${ids.join(', ')})`);
  else fail(`stamp ids ${JSON.stringify(ids)} != wrappers ${JSON.stringify(wrappers)}`);
}

// ── item 1: no external references ──────────────────────────────────────────

head('item 1 — no external references');
{
  const bad = [];
  const re = /https?:\/\//g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (inPre(m.index)) continue;
    const ctx = html.slice(Math.max(0, m.index - 60), m.index + 60);
    if (/xmlns(:\w+)?=["']https?:\/\/www\.w3\.org/.test(ctx)) continue;
    bad.push(`${deckPath}:${offsetToLine(m.index)} — ${html.slice(m.index, m.index + 70).split('\n')[0]}`);
  }
  if (bad.length) bad.forEach((b) => fail(b));
  else ok('every http(s) match is inside a <pre> or an SVG xmlns');

  const attr = [];
  for (const m2 of html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)) {
    if (inPre(m2.index)) continue;
    const v = m2[1];
    if (v.startsWith('#') || v.startsWith('./') || v.startsWith('../') || /^[\w][\w./-]*\.html$/.test(v)) continue;
    attr.push(`${deckPath}:${offsetToLine(m2.index)} — ${m2[0].trim()}`);
  }
  if (attr.length) attr.forEach((a) => fail(`non-local src/href: ${a}`));
  else ok('no non-local src/href attributes');
}

// ── item 5: file:// safe — no network calls in inline JS ─────────────────────

head('item 5 — opens from file:// (no network calls in inline JS)');
{
  const bad = [];
  for (const m of html.matchAll(/fetch\(|XMLHttpRequest|WebSocket\(|\bimport\(/g)) {
    if (inPre(m.index)) continue;
    if (!inScript(m.index)) continue;
    bad.push(`${deckPath}:${offsetToLine(m.index)} — ${m[0]}`);
  }
  if (bad.length) bad.forEach((b) => fail(`network call in inline JS: ${b}`));
  else ok('no fetch/XMLHttpRequest/WebSocket/dynamic import in any <script>');
}

// ── item 7: meta tags ───────────────────────────────────────────────────────

head('item 7 — meta tags');
{
  if (/charset=.?utf-8/i.test(html)) ok('charset meta present'); else fail('no charset meta');
  if (/name="viewport"/.test(html)) ok('viewport meta present'); else fail('no viewport meta');
  if (/^<!DOCTYPE html>\n<!-- tutor-deck -->/.test(html)) ok('tutor-deck marker on line 2');
  else fail('line 2 is not the literal <!-- tutor-deck --> comment');
}

// ── quiz cards: items 3, 4, 6 ───────────────────────────────────────────────

head('items 3 / 4 / 6 — quiz cards');
const quizCards = [...html.matchAll(/<div class="card card-quiz">([\s\S]*?)\n  <\/div>\n/g)].map((m) => m[1]);
{
  // more robust: split on the quiz-options blocks instead
  const optBlocks = [...html.matchAll(/<div class="quiz-options">([\s\S]*?)<\/div>\s*<\/div>\s*(?=<)/g)];
  const positions = [];
  let cardNo = 0;
  const optionRe = /<div class="quiz-option" data-correct="(true|false)">([\s\S]*?)<\/div>\s*(?=<div class="quiz-option"|$)/g;

  // Parse each quiz card by locating `.quiz-options` and slicing options by marker.
  const cardStarts = [...html.matchAll(/<div class="card card-quiz">/g)].map((m) => m.index);
  for (const start of cardStarts) {
    cardNo++;
    const optsStart = html.indexOf('<div class="quiz-options">', start);
    if (optsStart === -1) { fail(`quiz card #${cardNo} has no .quiz-options`); continue; }
    // options region ends at the next card start (or EOF)
    const nextCard = cardStarts.find((s) => s > start) ?? html.length;
    const region = html.slice(optsStart, nextCard === html.length ? html.length : nextCard);
    const markers = [...region.matchAll(/<div class="quiz-option" data-correct="(true|false)">/g)];
    if (markers.length < 3) fail(`quiz card #${cardNo} (line ${offsetToLine(start)}) has ${markers.length} options — floor is 3`);
    const opts = markers.map((mk, i) => {
      const from = mk.index + mk[0].length;
      const to = i + 1 < markers.length ? markers[i + 1].index : region.length;
      return { correct: mk[1] === 'true', body: region.slice(from, to) };
    });
    const correctIdx = opts.findIndex((o) => o.correct);
    if (correctIdx === -1) { fail(`quiz card #${cardNo} has no data-correct="true" option`); continue; }
    if (opts.filter((o) => o.correct).length > 1) fail(`quiz card #${cardNo} has more than one correct option`);
    positions.push(correctIdx + 1);
    if (correctIdx === 0) fail(`quiz card #${cardNo} (line ${offsetToLine(start)}) puts the correct option FIRST`);

    // item 3: feedback non-empty
    const measured = opts.map((o, i) => {
      const btn = o.body.match(/<button class="quiz-option-btn">([\s\S]*?)<\/button>/);
      const fb = o.body.match(/<p class="quiz-feedback">([\s\S]*?)<\/p>/);
      if (!btn) fail(`quiz card #${cardNo} option ${i + 1} has no button label`);
      if (!fb) fail(`quiz card #${cardNo} option ${i + 1} has no .quiz-feedback`);
      const labelText = btn ? textOf(btn[1]) : '';
      const fbText = fb ? textOf(fb[1]) : '';
      if (fbText === '') fail(`quiz card #${cardNo} option ${i + 1} has empty feedback`);
      if (labelText === '') fail(`quiz card #${cardNo} option ${i + 1} has empty label`);
      return { label: wordCount(labelText), fb: wordCount(fbText), correct: o.correct };
    });

    // item 6: correct not the SOLE longest by label words or feedback words
    for (const key of ['label', 'fb']) {
      const max = Math.max(...measured.map((x) => x[key]));
      const atMax = measured.filter((x) => x[key] === max);
      if (atMax.length === 1 && atMax[0].correct) {
        fail(`quiz card #${cardNo} (line ${offsetToLine(start)}): correct option is the SOLE longest by ${key === 'fb' ? 'feedback' : 'label'} words (${max} vs ${measured.filter((x) => !x.correct).map((x) => x[key]).join('/')})`);
      }
    }
  }
  if (positions.length === 0) fail('no quiz cards found');
  else {
    ok(`${positions.length} quiz cards; correct-option positions: ${positions.join(',')}`);
    if (new Set(positions).size > 1) ok(`positions take ${new Set(positions).size} distinct values`);
    else fail('correct-option position never varies');
  }
  void quizCards; void optBlocks; void optionRe;
}

// ── item 3b: qa cards ───────────────────────────────────────────────────────

head('item 3b — qa cards non-empty');
{
  let n = 0;
  for (const m of html.matchAll(/<details class="qa-item">([\s\S]*?)<\/details>/g)) {
    n++;
    const sum = m[1].match(/<summary>([\s\S]*?)<\/summary>/);
    const body = m[1].match(/<p>([\s\S]*?)<\/p>/);
    const line = offsetToLine(m.index);
    if (!sum || textOf(sum[1]) === '') fail(`qa-item at line ${line} has an empty <summary>`);
    if (!body || textOf(body[1]) === '') fail(`qa-item at line ${line} has an empty answer <p>`);
    if (body && wordCount(textOf(body[1])) > 120) fail(`qa-item at line ${line} answer is ${wordCount(textOf(body[1]))} words (cap 120)`);
  }
  if (/<summary>\s*<\/summary>/.test(html)) fail('an empty <summary> exists');
  if (/<details class="qa-item">[ \t]*<summary>/.test(html)) warn('a qa-item opens <summary> on the same line as <details>');
  ok(`${n} qa-item blocks checked`);
}

// ── structure ───────────────────────────────────────────────────────────────

head('structure');
{
  const sections = [...html.matchAll(/<section id="(s\d+)">([\s\S]*?)<\/section>/g)];
  const n = sections.length;
  const dividers = (html.match(/class="card card-divider"/g) ?? []).length;
  if (dividers === n - 1) ok(`${n} sections, ${dividers} dividers (N-1)`);
  else fail(`${n} sections but ${dividers} divider cards (expected ${n - 1})`);

  const openers = (html.match(/class="card card-mental[^"]*"/g) ?? []).length;
  if (openers === 1) ok('exactly one mental-model opener'); else fail(`${openers} mental-model cards`);
  const recaps = (html.match(/class="card card-recap"/g) ?? []).length;
  if (recaps === 1) ok('exactly one recap card'); else fail(`${recaps} recap cards`);

  // opener must be the first card and carry `active`
  const firstCard = html.match(/<div class="card ([^"]*)"/);
  if (firstCard && /card-mental/.test(firstCard[1]) && /\bactive\b/.test(firstCard[1])) ok('opener is the first card and is active');
  else fail(`first card is "${firstCard?.[1]}" — expected card-mental … active`);

  // recap outside every section wrapper
  const recapIdx = html.indexOf('class="card card-recap"');
  const insideAny = sections.some((s) => recapIdx > s.index && recapIdx < s.index + s[0].length);
  if (insideAny) fail('recap card sits inside a <section> wrapper'); else ok('recap card is outside every section wrapper');

  for (const s of sections) {
    const id = s[1], body = s[2];
    const qa = (body.match(/class="card card-qa"/g) ?? []).length;
    if (qa > 1) fail(`${id} has ${qa} qa cards (max 1)`);
    if (qa === 1) {
      const cardIdxs = [...body.matchAll(/<div class="card card-(\w+)"/g)].map((m) => m[1]);
      if (cardIdxs[cardIdxs.length - 1] !== 'qa') fail(`${id}: qa card is not the last card in the wrapper (order: ${cardIdxs.join(',')})`);
    }
    const divs = (body.match(/class="card card-divider"/g) ?? []).length;
    if (id === 's1' && divs !== 0) fail('s1 carries a divider card');
    if (id !== 's1' && divs !== 1) fail(`${id} has ${divs} dividers (expected 1)`);
    if (id !== 's1') {
      const cardIdxs = [...body.matchAll(/<div class="card card-(\w+)"/g)].map((m) => m[1]);
      if (cardIdxs[0] !== 'divider') fail(`${id}: divider is not the first card (order: ${cardIdxs.join(',')})`);
    }
    const quizzes = (body.match(/class="card card-quiz"/g) ?? []).length;
    const concepts = (body.match(/class="card card-concept"/g) ?? []).length;
    if (quizzes < 1 || quizzes > 2) fail(`${id} has ${quizzes} quiz cards (Pedagogy: 1–2)`);
    if (concepts < 2 || concepts > 4) fail(`${id} has ${concepts} concept cards (Pedagogy: 2–4)`);
    // never more than 3 concept cards without a question
    const seq = [...body.matchAll(/<div class="card card-(\w+)"/g)].map((m) => m[1]);
    let run = 0;
    for (const k of seq) {
      if (k === 'concept') { run++; if (run > 3) { fail(`${id}: ${run} concept cards with no question between`); break; } }
      else if (k === 'quiz') run = 0;
    }
    // recap links this section
    if (!new RegExp(`data-target="${id}"`).test(html)) fail(`recap card has no jump button for ${id}`);
  }
  ok('per-section card shape checked');

  // the deck's FIRST question must come after the first concept card
  const cardSeq = [...html.matchAll(/<div class="card card-(\w+)/g)].map((m) => m[1]);
  const firstQuiz = cardSeq.indexOf('quiz');
  const conceptsBefore = cardSeq.slice(0, firstQuiz).filter((k) => k === 'concept').length;
  if (conceptsBefore === 1) ok('first question comes after exactly one concept card');
  else warn(`first question comes after ${conceptsBefore} concept cards (SKILL.md wants 1)`);
}

// ── excerpt fidelity + citation bounds ──────────────────────────────────────

head('excerpt fidelity (every <pre> matches its cited range verbatim)');
{
  const byBase = new Map();
  for (const s of stamp?.sources ?? []) {
    const b = path.basename(s);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(s);
  }
  let checked = 0;
  for (const r of PRES) {
    const bodyLines = unescapeEntities(r.body).replace(/^\n/, '').split('\n');
    const first = bodyLines[0] ?? '';
    const cite = first.match(/^\s*(?:\/\/|#|<!--)\s*([\w./-]+):(\d+)(?:-(\d+))?(.*)$/);
    const lineNo = offsetToLine(r.start);
    if (!cite) {
      if (/invented|for format demonstration/.test(first)) continue;
      fail(`<pre> at line ${lineNo} has no source-range label on its first line: "${first.slice(0, 60)}"`);
      continue;
    }
    const [, ref, fromS, toS, tail] = cite;
    const abridged = /\(compacted here\)/.test(tail);
    const base = path.basename(ref);
    const candidates = ref.includes('/') ? [ref] : (byBase.get(base) ?? []);
    if (candidates.length === 0) { fail(`<pre> at line ${lineNo} cites "${ref}" which is not in the stamp's sources`); continue; }
    if (candidates.length > 1) { fail(`<pre> at line ${lineNo} cites ambiguous basename "${ref}" (${candidates.join(', ')})`); continue; }
    const rel = candidates[0];
    let src;
    try { src = fs.readFileSync(path.join(repoRoot, rel), 'utf8').split('\n'); }
    catch { fail(`<pre> at line ${lineNo}: cannot read ${rel}`); continue; }
    const from = Number(fromS), to = toS ? Number(toS) : Number(fromS);
    if (from < 1 || to > src.length || to < from) {
      fail(`<pre> at line ${lineNo}: range ${rel}:${from}-${to} out of bounds (file has ${src.length} lines)`);
      continue;
    }
    const range = src.slice(from - 1, to).map((l) => l.replace(/\s+$/, ''));
    const excerpt = bodyLines.slice(1).map((l) => l.replace(/\s+$/, ''));
    // drop trailing blank lines from the excerpt
    while (excerpt.length && excerpt[excerpt.length - 1] === '') excerpt.pop();
    const isEllipsis = (l) => /^\s*(?:\/\/|#|\*)?\s*(?:…|\.\.\.)\s*$/.test(l) || /^\s*…\s*$/.test(l);

    let cursor = 0;
    let bad = null;
    for (const el of excerpt) {
      if (isEllipsis(el)) continue;
      let found = -1;
      for (let i = cursor; i < range.length; i++) {
        if (range[i] === el) { found = i; break; }
      }
      if (found === -1) { bad = el; break; }
      cursor = found + 1;
    }
    if (bad !== null) {
      fail(`<pre> at line ${lineNo} (${rel}:${from}-${to}): line not found verbatim in range → ${JSON.stringify(bad.slice(0, 90))}`);
      continue;
    }
    const nonEllipsis = excerpt.filter((l) => !isEllipsis(l)).length;
    if (!abridged && nonEllipsis !== range.length) {
      fail(`<pre> at line ${lineNo} (${rel}:${from}-${to}): ${nonEllipsis} lines shown for a ${range.length}-line range, and not labelled "(compacted here)"`);
      continue;
    }
    if (abridged && nonEllipsis === range.length) warn(`<pre> at line ${lineNo} (${rel}:${from}-${to}) is labelled "(compacted here)" but shows the whole range`);
    checked++;
  }
  ok(`${checked} excerpts match their cited ranges verbatim`);
}

head('citation bounds (every file:line reference in the prose)');
{
  const seen = new Map();
  const re = /([\w-]+(?:\/[\w.-]+)*\.(?:ts|tsx|css|md|json|html|mjs))(?:<\/code>)?:(\d+)(?:[-–](\d+))?/g;
  let m;
  let bad = 0, n = 0;
  while ((m = re.exec(html)) !== null) {
    const [, ref, fromS, toS] = m;
    const base = path.basename(ref);
    let rel = ref;
    if (!ref.includes('/')) {
      const cands = (stamp?.sources ?? []).filter((s) => path.basename(s) === base);
      if (cands.length !== 1) {
        if (cands.length === 0) { /* not one of ours — e.g. a test file mentioned in prose */ }
        seen.set(ref, (seen.get(ref) ?? 0) + 1);
        continue;
      }
      rel = cands[0];
    }
    const lc = lineCount(rel);
    if (lc === null) continue;
    n++;
    const from = Number(fromS), to = toS ? Number(toS) : Number(fromS);
    if (from < 1 || to > lc || to < from) {
      fail(`citation ${ref}:${fromS}${toS ? '-' + toS : ''} at line ${offsetToLine(m.index)} out of bounds (${rel} has ${lc} lines)`);
      bad++;
    }
  }
  if (bad === 0) ok(`${n} resolvable file:line citations all in bounds`);
  for (const [ref, count] of seen) warn(`citation basename "${ref}" (×${count}) not resolvable against the stamp's sources — check by hand`);
}

head(`\n${fails === 0 ? 'ALL CHECKS PASS' : fails + ' FAILURE(S)'}${warns ? ` · ${warns} warning(s)` : ''}`);
process.exit(fails === 0 ? 0 : 1);
