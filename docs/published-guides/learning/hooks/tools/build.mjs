/**
 * build.mjs — generate docs/published-guides/learning/hooks/index.html from the markdown.
 *
 * The markdown is canonical. Run this after editing it:
 *   node docs/published-guides/learning/hooks/tools/build.mjs
 *
 * Why generate rather than hand-author: the page carries the WHOLE guide (so that
 * no cross-reference is a dead `.md` link in a browser), and hand-copying that much
 * prose creates two sources of truth that diverge on the first edit.
 *
 * Paths resolve against import.meta.url and go UP one level — this file lives in
 * tools/, the markdown does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIGURES } from './figures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'index.html');

/** Reading order. `slug` is the anchor namespace and the figure key prefix. */
const DOCS = [
  { slug: 'README', file: 'README.md', title: 'Overview' },
  { slug: 'lifecycle', file: 'guide/lifecycle.md', title: 'The lifecycle and execution order' },
  { slug: 'answer-channel', file: 'guide/answer-channel.md', title: 'The answer channel: deny + reason' },
  { slug: 'held-socket', file: 'guide/held-socket.md', title: 'The held socket' },
  { slug: 'stop-loop', file: 'guide/stop-loop.md', title: 'The Stop-hook chat loop' },
  { slug: 'fail-open', file: 'guide/fail-open.md', title: 'Fail-open, hook by hook' },
  { slug: 'config', file: 'guide/config.md', title: 'Timeouts, gates, and config precedence' }
];

/* ------------------------------------------------------------------ helpers */

/**
 * Code-span placeholder delimiter. A " N " (space-digit-space) placeholder would
 * also match ordinary numbers in prose, and the restore pass would then turn them
 * into code spans — hence NUL, which cannot occur in the markdown.
 *
 * Kept as an ESCAPE SEQUENCE, never a literal NUL byte. A literal makes git
 * classify this file as binary, so it never produces a reviewable diff, and grep
 * skips it silently — which already caused one path-rewrite sweep to miss this
 * file. Same runtime value either way; only the file's encoding differs.
 */
const NUL = '\u0000';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * GitHub's heading-slug rules: lowercase, strip punctuation, and turn EACH space
 * into its own hyphen (runs are not collapsed — which is why an em dash
 * surrounded by spaces yields `--`).
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

function anchor(docSlug, headingText) {
  return `${docSlug}--${slugify(headingText)}`;
}

/**
 * Inline markdown → HTML. Order matters, and each step below exists because the
 * naive version corrupted real lines in this guide.
 */
function inline(text, docSlug, linkMap) {
  const spans = [];

  // 1. Code spans, LONGEST backtick run first: ``x`` must win over `x`, or a
  //    /`([^`]+)`/ pattern mispairs across it and scrambles the rest of the line.
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?)\1/g, (_m, ticks, body) => {
    spans.push(`<code>${esc(body.trim())}</code>`);
    // NUL-delimited: a bare " N " placeholder also matches ordinary numbers in
    // prose, and the restore pass would then turn them into code spans.
    return `${NUL}${spans.length - 1}${NUL}`;
  });

  s = esc(s);

  // 2. Links. Rewrite in-guide .md targets to in-page anchors; mark external ↗.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    if (/^https?:/.test(href)) {
      return `<a href="${href}" rel="noreferrer">${label} ↗</a>`;
    }
    const hashAt = href.indexOf('#');
    const bare = hashAt === -1 ? href : href.slice(0, hashAt);
    const frag = hashAt === -1 ? '' : href.slice(hashAt + 1);
    if (bare.endsWith('.md')) {
      // Derive the doc slug from the BASENAME, not the path as written: the same
      // target arrives as ./guide/x.md from the hub, ./x.md between chapters, and
      // ../README.md going back. Matching literal strings would leave two of the
      // three spellings as dead .md links.
      const base = path.basename(bare, '.md');
      const target = linkMap.get(base);
      if (target) return `<a href="#${frag ? `${target}--${frag}` : target}">${label}</a>`;
      return label; // unknown .md — drop the link rather than emit a dead one
    }
    // A source-file link. Chapters sit one level deeper than the page, so strip
    // exactly one ../ from links harvested out of guide/*.md.
    const fixed = docSlug === 'README' ? href : href.replace(/^\.\.\//, '');
    return `<a href="${fixed}">${label}</a>`;
  });

  // 3. Bold before italic, and bold must be able to span inner asterisks:
  //    **"… *not* …"** is common here, and [^*]+ cannot cross them.
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // 4. Restore code spans.
  s = s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_m, i) => spans[Number(i)]);
  return s;
}

/* ------------------------------------------------------------ block renderer */

function renderDoc(doc, linkMap) {
  const raw = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  const lines = raw.split('\n');
  const out = [];
  const headings = [];
  let fenceIdx = 0;
  let i = 0;

  const flushParagraph = buf => {
    if (!buf.length) return;
    // Join before parsing inline syntax: a [label\ntext](href) link split across
    // a line break is valid markdown and never matches otherwise.
    out.push(`<p>${inline(buf.join(' '), doc.slug, linkMap)}</p>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // HTML comments (the provenance stamp) are metadata, not content.
    if (line.trim().startsWith('<!--')) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }

    // Fenced code / mermaid.
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      if (lang === 'mermaid') {
        const key = `${doc.slug}:${fenceIdx++}`;
        const fig = FIGURES[key];
        if (!fig) throw new Error(`missing figure for ${key} — add it to tools/figures.mjs`);
        out.push(
          `<div class="diagram">${fig.svg}</div>`
          + `<p class="caption">${inline(fig.caption, doc.slug, linkMap)}</p>`
        );
      } else {
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      }
      continue;
    }

    // Headings. The page's own <h2> is the per-document title, so demote by one.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      const text = h[2].trim();
      if (depth === 1) { i++; continue; } // each file's H1 is replaced by the doc title
      const id = anchor(doc.slug, text);
      if (depth === 2) headings.push({ id, text });
      out.push(`<h${depth + 1} id="${id}">${inline(text, doc.slug, linkMap)}</h${depth + 1}>`);
      i++;
      continue;
    }

    // Tables.
    if (line.includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(cells(lines[i++]));
      const th = head.map(c => `<th>${inline(c, doc.slug, linkMap)}</th>`).join('');
      const tr = body
        .map(r => `<tr>${r.map(c => `<td>${inline(c, doc.slug, linkMap)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }

    // Blockquotes.
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      // Skip the page's own self-reference: on the page it tells the reader to
      // open the page they are already reading.
      if (buf.join(' ').includes('./index.html')) continue;
      out.push(`<blockquote><p>${inline(buf.join(' '), doc.slug, linkMap)}</p></blockquote>`);
      continue;
    }

    // Lists. A continuation line indented under a bullet belongs to that bullet.
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) { items.push([m[3]]); i++; continue; }
        if (/^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}>${items.map(p => `<li>${inline(p.join(' '), doc.slug, linkMap)}</li>`).join('')}</${tag}>`
      );
      continue;
    }

    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (!line.trim()) { i++; continue; }

    // Paragraph.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*]|\d+\.)\s|---+\s*$)/.test(lines[i])) {
      if (lines[i].includes('|') && lines[i + 1] && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) break;
      buf.push(lines[i++].trim());
    }
    flushParagraph(buf);
  }

  return { html: out.join('\n'), headings };
}

/* -------------------------------------------------------------------- assemble */

const linkMap = new Map(DOCS.map(d => [path.basename(d.file, '.md'), d.slug]));
const rendered = DOCS.map(d => ({ ...d, ...renderDoc(d, linkMap) }));

const toc = rendered
  .map(
    d => `<li><a href="#${d.slug}">${esc(d.title)}</a>`
      + (d.headings.length
        ? `<ul>${d.headings.map(h => `<li><a href="#${h.id}">${inline(h.text, d.slug, linkMap)}</a></li>`).join('')}</ul>`
        : '')
      + '</li>'
  )
  .join('');

const body = rendered
  .map(d => `<section><h2 id="${d.slug}">${esc(d.title)}</h2>\n${d.html}\n`
    + `<p class="backtop"><a href="#top">↑ back to contents</a></p></section>`)
  .join('\n');

const CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #5c6370; --line: #b8bec9;
  --panel: #f5f6f8; --accent: #2563eb; --good: #15803d; --bad: #b91c1c;
  --code-bg: #f2f3f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --fg: #e6e8ea; --muted: #9aa2ad; --line: #4a515c;
    --panel: #1d2027; --accent: #7aa2f7; --good: #6ccf8e; --bad: #f2777a;
    --code-bg: #1a1d23;
  }
}
* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--fg); margin: 0;
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
}
/* Desktop is the base: sidebar + gap + a 60rem prose measure = a 78rem shell. */
.shell {
  display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 1rem;
  max-width: 78rem; margin: 0 auto; padding: 1.5rem 1.25rem;
}
.side { position: sticky; top: 0; max-height: 100vh; overflow-y: auto; padding-top: .5rem; }
nav.toc { font-size: .875rem; }
nav.toc ul { list-style: none; margin: 0; padding-left: .75rem; }
nav.toc > ul { padding-left: 0; }
nav.toc li { margin: .15rem 0; }
nav.toc a { color: var(--muted); text-decoration: none; display: block; padding: .1rem .35rem; border-radius: 4px; }
nav.toc a:hover { color: var(--fg); background: var(--panel); }
nav.toc a.active { color: var(--accent); background: var(--panel); font-weight: 600; }
nav.toc > ul > li > a { color: var(--fg); font-weight: 600; margin-top: .5rem; }
main { min-width: 0; }
h1 { font-size: 1.75rem; line-height: 1.25; margin: .25rem 0 .5rem; }
h2 { font-size: 1.4rem; margin: 2.5rem 0 .75rem; padding-top: .5rem; border-top: 2px solid var(--line); }
h3 { font-size: 1.15rem; margin: 1.75rem 0 .5rem; }
h4 { font-size: 1rem; margin: 1.25rem 0 .4rem; }
p, li { overflow-wrap: break-word; }
.lede { color: var(--muted); }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--code-bg); padding: .1em .3em; border-radius: 3px; font-size: .875em;
       overflow-wrap: anywhere; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px;
      padding: .85rem 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: .8125rem; overflow-wrap: normal; }
blockquote { margin: 1.25rem 0; padding: .1rem 1rem; border-left: 3px solid var(--accent);
             background: var(--panel); border-radius: 0 6px 6px 0; }
.tablewrap { overflow-x: auto; margin: 1.25rem 0; }
table { border-collapse: collapse; font-size: .9rem; min-width: 100%; }
th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--panel); }
.diagram { overflow-x: auto; margin: 1.5rem 0 .35rem; }
.diagram svg { display: block; min-width: 34rem; width: 100%; }
.caption { color: var(--muted); font-size: .85rem; margin: 0 0 1.5rem; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
/* With a permanent sidebar these are noise; the narrow fallback restores them. */
.backtop { display: none; }
#navtoggle, .navlabel { display: none; }
@media (max-width: 63.99rem) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; max-height: none; }
  .navlabel { display: inline-block; cursor: pointer; color: var(--accent);
              border: 1px solid var(--line); border-radius: 6px; padding: .35rem .7rem;
              font-size: .875rem; }
  nav.toc { display: none; margin-top: .75rem; }
  /* The ID selector outranks nav.toc{display:none} regardless of source order. */
  #navtoggle:checked ~ .shell nav.toc { display: block; }
  .backtop { display: block; font-size: .875rem; }
}
`;

const JS = `
(function () {
  var links = [].slice.call(document.querySelectorAll('nav.toc a[href^="#"]'));
  var targets = links.map(function (a) { return document.getElementById(a.hash.slice(1)); });
  var side = document.querySelector('.side');
  var nav = document.querySelector('nav.toc');
  function scroller() {
    if (side && side.scrollHeight > side.clientHeight) return side;
    if (nav && nav.scrollHeight > nav.clientHeight) return nav;
    return null;
  }
  function onScroll() {
    var best = -1;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (t && t.getBoundingClientRect().top <= 120) best = i;
    }
    for (var j = 0; j < links.length; j++) links[j].classList.toggle('active', j === best);
    var box = scroller();
    if (box && best >= 0) {
      // offsetTop is relative to the offsetParent, not the scroll container, so
      // compare rects instead.
      var lr = links[best].getBoundingClientRect(), br = box.getBoundingClientRect();
      if (lr.top < br.top) box.scrollTop -= (br.top - lr.top) + 20;
      else if (lr.bottom > br.bottom) box.scrollTop += (lr.bottom - br.bottom) + 20;
    }
  }
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code hooks — the learning guide</title>
<style>${CSS}</style>
</head>
<body>
<input type="checkbox" id="navtoggle">
<div class="shell">
  <div class="side">
    <label class="navlabel" for="navtoggle">☰ Contents</label>
    <nav class="toc"><ul>${toc}</ul></nav>
  </div>
  <main id="top">
    <h1>Claude Code hooks in this project — the learning guide</h1>
    <p class="lede">Why the five hook scripts in <code>scripts/</code> are shaped the way they
    are. Generated from the markdown in <code>docs/published-guides/learning/hooks/README.md</code> +
    <code>docs/published-guides/learning/hooks/guide/</code> by <code>docs/published-guides/learning/hooks/tools/build.mjs</code>
    — edit the markdown, not this file.</p>
${body}
  </main>
</div>
<script>${JS}</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${kb} KB, ${DOCS.length} docs, ${Object.keys(FIGURES).length} figures)`);
