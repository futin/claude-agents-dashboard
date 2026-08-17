#!/usr/bin/env node
/**
 * build.mjs — render the dictation guide's markdown into one offline HTML page.
 *
 *   node docs/learning/dictation/tools/build.mjs
 *
 * The markdown is canonical. This script is the ONLY way index.html changes;
 * never hand-edit the page. Paths resolve against import.meta.url, and the
 * markdown now sits one level UP from this file (tools/ → guide root).
 *
 * Two rules govern the output:
 *   1. No link a browser cannot follow. Every cross-reference between guide
 *      documents becomes an in-page anchor, because the page holds the whole
 *      guide. Links that genuinely leave the page are marked with a visible ↗.
 *   2. Generated, never hand-authored — a hand-copied page is a second source
 *      of truth that diverges on the first edit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { figureFor } from './figures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'index.html');

/** Reading order. The slug is also the anchor prefix for that file's headings. */
const DOCS = [
  { slug: 'readme', file: 'README.md' },
  { slug: 'why-local-whisper', file: 'guide/why-local-whisper.md' },
  { slug: 'render-gate', file: 'guide/render-gate.md' },
  { slug: 'recorder-lifecycle', file: 'guide/recorder-lifecycle.md' }
];
const IN_GUIDE = new Set(DOCS.map(d => d.slug));

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** GitHub's slug rules: lowercase, drop punctuation, EACH space its own hyphen. */
function slugify(s) {
  return s.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
}

/** README.md → readme; why-local-whisper.md → why-local-whisper. */
function docSlugFromHref(href) {
  const base = path.basename(href.split('#')[0], '.md');
  return base.toLowerCase() === 'readme' ? 'readme' : base;
}

/**
 * A chapter sits one level deeper than the page, so every relative link taken
 * from guide/*.md loses exactly one `../` on its way in. Strip one segment;
 * never rewrite the markdown to match, because the link must stay correct
 * where it is written too.
 */
function fixDepth(href, fromGuide) {
  if (!fromGuide) return href;
  if (href.startsWith('../')) return href.slice(3);
  return href;
}

const NUL = '\u0000';

/**
 * Inline markdown → HTML.
 *
 * Order matters and every step here is a bug that actually bit:
 *  - code spans first, matching the LONGEST backtick run, so ``` `x` ``` works;
 *  - the placeholder is NUL-delimited, because a bare digit placeholder also
 *    matches ordinary numbers in prose and gets clobbered on restore;
 *  - bold before italic, and bold matches lazily ACROSS asterisks so
 *    `**"… *not* …"**` does not leak raw `**`.
 */
function inline(md, ctx) {
  const spans = [];
  let s = md.replace(/(`+)([\s\S]+?)\1/g, (_, ticks, code) => {
    spans.push(code.trim());
    return `${NUL}${spans.length - 1}${NUL}`;
  });

  s = esc(s);

  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (/\.md($|#)/.test(href)) {
      const slug = docSlugFromHref(href);
      if (IN_GUIDE.has(slug)) {
        const frag = href.includes('#') ? href.split('#')[1] : '';
        const target = frag ? `#${slug}--${frag}` : `#${slug}`;
        return `<a href="${target}">${label}</a>`;
      }
    }
    if (/^https?:/.test(href)) {
      return `<a href="${href}" target="_blank" rel="noreferrer">${label} <span class="ext">↗</span></a>`;
    }
    return `<a href="${fixDepth(href, ctx.fromGuide)}">${label} <span class="ext">↗</span></a>`;
  });

  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_, i) => `<code>${esc(spans[+i])}</code>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// block parser
// ─────────────────────────────────────────────────────────────────────────────

function renderDoc(doc, md) {
  const ctx = { fromGuide: doc.file.startsWith('guide/') };
  const lines = md.split('\n');
  const out = [];
  const headings = [];
  let title = doc.slug;
  let fenceOrdinal = 0;
  let i = 0;

  const isBlockStart = l =>
    /^(#{1,6} |```|> |- |\d+\. |\|)/.test(l) || l.trim() === '' || l.trim() === '---';

  while (i < lines.length) {
    const line = lines[i];

    // metadata, not content
    if (/^\s*<!--/.test(line)) { i++; continue; }
    if (line.trim() === '') { i++; continue; }

    // ── fences ───────────────────────────────────────────────────────────────
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      if (lang === 'mermaid') {
        const fig = figureFor(doc.slug, fenceOrdinal++);
        if (!fig) throw new Error(`no figure for ${doc.slug}:${fenceOrdinal - 1}`);
        out.push(`<div class="diagram">${fig.svg}</div>`);
        out.push(`<p class="caption">${inline(fig.caption, ctx)}</p>`);
      } else {
        out.push(`<div class="codewrap"><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
      }
      continue;
    }

    // ── headings ─────────────────────────────────────────────────────────────
    const h = line.match(/^(#{1,6}) (.+)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) { title = text; i++; continue; }   // page supplies the <h2>
      const id = `${doc.slug}--${slugify(text)}`;
      if (level === 2) headings.push({ id, text });
      out.push(`<h${level + 1} id="${id}">${inline(text, ctx)}</h${level + 1}>`);
      i++;
      continue;
    }

    if (line.trim() === '---') { out.push('<hr>'); i++; continue; }

    // ── blockquote ───────────────────────────────────────────────────────────
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const joined = buf.join(' ').trim();
      // The markdown's "read it in a browser" pointer would, on the page, tell
      // the reader to open the page they are already reading.
      if (joined.includes('](./index.html)')) continue;
      out.push(`<blockquote><p>${inline(joined, ctx)}</p></blockquote>`);
      continue;
    }

    // ── table ────────────────────────────────────────────────────────────────
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const cells = l => l.split('|').slice(1, -1).map(c => c.trim());
      const head = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const th = head.map(c => `<th>${inline(c, ctx)}</th>`).join('');
      const tb = rows
        .map(r => `<tr>${r.map(c => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`)
        .join('\n');
      out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>\n${tb}\n</tbody></table></div>`);
      continue;
    }

    // ── list (a continuation line indented under a bullet belongs to it) ─────
    const bullet = line.match(/^(-|\d+\.) (.*)$/);
    if (bullet) {
      const ordered = /^\d+\./.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(-|\d+\.) (.*)$/);
        if (m) { items.push(m[2]); i++; continue; }
        if (/^\s+\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map(t => `<li>${inline(t, ctx)}</li>`).join('\n')}\n</${tag}>`);
      continue;
    }

    // ── paragraph (joined before inline parsing, so wrapped links match) ─────
    const para = [];
    while (i < lines.length && !isBlockStart(lines[i]) && !/^\s*<!--/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    const text = para.join(' ').trim();
    if (!text) continue;
    const cls = text.startsWith('[←') ? ' class="backlink"' : '';
    out.push(`<p${cls}>${inline(text, ctx)}</p>`);
  }

  return { html: out.join('\n'), headings, title };
}

// ─────────────────────────────────────────────────────────────────────────────
// page
// ─────────────────────────────────────────────────────────────────────────────

const rendered = DOCS.map(doc => {
  const md = fs.readFileSync(path.join(ROOT, doc.file), 'utf8');
  return { doc, ...renderDoc(doc, md) };
});

const nav = rendered
  .map(r => {
    const subs = r.headings
      .map(h => `<li><a href="#${h.id}">${inline(h.text, { fromGuide: false })}</a></li>`)
      .join('\n');
    return `<li><a class="doc" href="#${r.doc.slug}">${esc(r.title)}</a>\n<ul>\n${subs}\n</ul></li>`;
  })
  .join('\n');

const body = rendered
  .map(r => `<section>\n<h2 id="${r.doc.slug}">${esc(r.title)}</h2>\n${r.html}\n<p class="totop"><a href="#top">↑ back to contents</a></p>\n</section>`)
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dictation — the learning guide</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #5c6370; --line: #b8bec9;
  --panel: #f5f6f8; --accent: #2563eb; --good: #15803d; --bad: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --fg: #e6e8ea; --muted: #9aa2ad; --line: #4a515c;
    --panel: #1d2027; --accent: #7aa2f7; --good: #6ccf8e; --bad: #f2777a;
  }
}
* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--fg); margin: 0;
  font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
}
/* sidebar + prose measure: 17 + 1 + 60 = 78rem */
.shell {
  display: grid; grid-template-columns: 17rem minmax(0, 1fr); gap: 1rem;
  max-width: 78rem; margin: 0 auto; padding: 1.5rem 1.25rem;
}
.side { position: sticky; top: 0; max-height: 100vh; overflow-y: auto; padding: .5rem 0; }
nav.toc { font-size: .875rem; }
nav.toc ul { list-style: none; margin: 0; padding: 0 0 0 .5rem; }
nav.toc > ul { padding-left: 0; }
nav.toc li { margin: .15rem 0; }
nav.toc a { display: block; padding: .2rem .45rem; border-radius: 4px;
            color: var(--muted); text-decoration: none; }
nav.toc a.doc { color: var(--fg); font-weight: 600; margin-top: .6rem; }
nav.toc a:hover { background: var(--panel); }
nav.toc a.active { background: var(--panel); color: var(--accent); }
.main { min-width: 0; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 .5rem; }
h2 { font-size: 1.4rem; margin: 2.5rem 0 .75rem; padding-top: .5rem;
     border-top: 1px solid var(--line); }
h3 { font-size: 1.12rem; margin: 1.9rem 0 .5rem; }
h4 { font-size: 1rem; margin: 1.4rem 0 .4rem; color: var(--muted); }
p, li { overflow-wrap: break-word; }
a { color: var(--accent); }
.ext { font-size: .8em; opacity: .7; }
.lede { color: var(--muted); margin: 0 0 1.5rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font-size: .875em; overflow-wrap: anywhere;
       background: var(--panel); padding: .1em .3em; border-radius: 3px; }
pre code { overflow-wrap: normal; background: none; padding: 0; font-size: .82rem; }
.codewrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line);
            border-radius: 6px; margin: 1rem 0; }
.codewrap pre { margin: 0; padding: .85rem 1rem; }
blockquote { margin: 1.25rem 0; padding: .1rem 1rem; border-left: 3px solid var(--accent);
             background: var(--panel); border-radius: 0 6px 6px 0; }
.diagram { overflow-x: auto; margin: 1.5rem 0; }
.diagram svg { display: block; min-width: 34rem; }
.diagram .boxlabel { fill: var(--fg); font-size: 12px; text-anchor: middle;
                     font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                     stroke: none; }
.caption { color: var(--muted); font-size: .875rem; margin: -.75rem 0 1.5rem; }
.tablewrap { overflow-x: auto; margin: 1.25rem 0; }
table { border-collapse: collapse; font-size: .9rem; }
th, td { border: 1px solid var(--line); padding: .45rem .7rem; text-align: left;
         vertical-align: top; }
th { background: var(--panel); }
hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
/* the sidebar is permanently on screen, so per-document jump links are noise */
.backlink, .totop { display: none; }
#navtoggle, .navlabel { display: none; }

@media (max-width: 63.99rem) {
  .shell { grid-template-columns: 1fr; }
  .side { position: sticky; top: 0; z-index: 5; background: var(--bg);
          border-bottom: 1px solid var(--line); max-height: 70vh; }
  .navlabel { display: inline-block; cursor: pointer; padding: .4rem .6rem;
              border: 1px solid var(--line); border-radius: 6px; font-size: .875rem; }
  nav.toc { display: none; padding-top: .5rem; }
  #navtoggle:checked ~ .shell nav.toc { display: block; }
  .backlink, .totop { display: block; font-size: .875rem; }
}
</style>
</head>
<body>
<input type="checkbox" id="navtoggle">
<div class="shell" id="top">
  <div class="side">
    <label class="navlabel" for="navtoggle">☰ contents</label>
    <nav class="toc">
      <ul>
${nav}
      </ul>
    </nav>
  </div>
  <div class="main">
    <h1>Dictation — the learning guide</h1>
    <p class="lede">Why the mic button in the reply composer is shaped the way it is.
      Generated from the markdown in <code>docs/learning/dictation/README.md</code> and
      <code>docs/learning/dictation/guide/</code> by
      <code>docs/learning/dictation/tools/build.mjs</code> — edit the markdown, not this file.</p>
${body}
  </div>
</div>
<script>
(function () {
  var links = [].slice.call(document.querySelectorAll('nav.toc a'));
  var targets = links
    .map(function (a) { return { a: a, el: document.getElementById(a.hash.slice(1)) }; })
    .filter(function (t) { return t.el; });
  if (!targets.length) return;
  var side = document.querySelector('.side');
  var toc = document.querySelector('nav.toc');
  var active = null;

  function scroller() {
    // desktop scrolls .side, the narrow fallback scrolls nav.toc — ask which
    if (toc.scrollHeight > toc.clientHeight + 4) return toc;
    if (side.scrollHeight > side.clientHeight + 4) return side;
    return null;
  }

  function sync() {
    var best = targets[0];
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].el.getBoundingClientRect().top <= 120) best = targets[i];
    }
    if (best.a === active) return;
    if (active) active.classList.remove('active');
    active = best.a;
    active.classList.add('active');
    var box = scroller();
    if (!box) return;
    // offsetTop is relative to the offsetParent, not the scroll box — compare rects
    var ar = active.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (ar.top < br.top) box.scrollTop -= br.top - ar.top + 12;
    else if (ar.bottom > br.bottom) box.scrollTop += ar.bottom - br.bottom + 12;
  }

  var queued = false;
  addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; sync(); });
  }, { passive: true });
  sync();
})();
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(html.length / 1024).toFixed(1)} KB, ${DOCS.length} documents)`);
