/**
 * markdown.ts — a tiny markdown subset parser for chat-drawer message text.
 *
 * Transcript text is markdown, so rendering it raw shows table pipes and
 * asterisks. This parses the subset Claude Code output actually uses — headings,
 * bold, italic, inline code, fenced code, GFM tables, bullet/numbered lists,
 * blockquotes, rules, links — into a small block/inline tree the renderer turns
 * into React elements. Anything it doesn't recognise stays literal text, so the
 * worst case is what we had before.
 *
 * Pure and unit-tested (`test/markdown.test.ts`). Zero deps, and no HTML string
 * ever reaches the DOM (no `dangerouslySetInnerHTML`), so transcript content
 * can't inject markup.
 *
 * Deliberate omissions: `_underscore_` emphasis (transcripts are full of
 * snake_case and `__init__`, where it would fire on identifiers), nested
 * blockquotes, reference links, inline HTML, footnotes.
 */

export type Align = 'l' | 'c' | 'r';

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; kids: Inline[] }
  | { t: 'em'; kids: Inline[] }
  | { t: 'link'; kids: Inline[]; href: string }
  /** `[label](repo/relative/path)` — nothing the dashboard can navigate to, so
   *  it renders as the label with the target on hover instead of a dead link. */
  | { t: 'path'; kids: Inline[]; target: string };

export interface ListItem {
  /** Nesting level, 2 spaces per level. */
  depth: number;
  spans: Inline[];
}

export type Block =
  | { t: 'p'; spans: Inline[] }
  | { t: 'h'; level: number; spans: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; spans: Inline[] }
  | { t: 'table'; head: Inline[][]; align: (Align | null)[]; rows: Inline[][][] }
  | { t: 'hr' };

/* ------------------------------------------------------------ inline */

// Order matters: code spans win over emphasis, `**` over `*`. Emphasis runs may
// not start or end on whitespace (CommonMark flanking), so arithmetic like
// `2 * 3 * 4` stays literal.
const INLINE_RE = /(`+)([\s\S]*?)\1|\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*|\*([^\s*](?:[^*\n]*[^\s*])?)\*|\[([^\]\n]*)\]\(([^)\s]+)\)/;

/** Only linkify schemes that can't execute script. */
function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:|#)/i.test(href) ? href : null;
}

/** Parse emphasis / code / links out of one run of text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;

  const push = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };

  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) break;
    push(rest.slice(0, m.index));
    const [full, , codeBody, strong, em, linkText, linkHref] = m;

    if (codeBody !== undefined) {
      // Per CommonMark, one leading/trailing space inside a code span is padding.
      out.push({ t: 'code', v: codeBody.replace(/^ (.*) $/, '$1') });
    } else if (strong !== undefined) {
      out.push({ t: 'strong', kids: parseInline(strong) });
    } else if (em !== undefined) {
      out.push({ t: 'em', kids: parseInline(em) });
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (!linkText.trim()) push(full); // no label to show → leave it literal
      else if (href) out.push({ t: 'link', kids: parseInline(linkText), href });
      else out.push({ t: 'path', kids: parseInline(linkText), target: linkHref });
    }
    rest = rest.slice(m.index + full.length);
  }
  push(rest);
  return out;
}

/* ------------------------------------------------------------ blocks */

const FENCE_RE = /^\s*(```+|~~~+)\s*([^\s`]*)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** Split a table row on unescaped pipes, dropping the leading/trailing ones. */
function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map(c => c.trim());
}

function alignOf(spec: string): Align | null {
  const s = spec.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'c';
  if (right) return 'r';
  if (left) return 'l';
  return null;
}

/** Markdown source → blocks. Never throws; unknown syntax stays literal text. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ t: 'p', spans: parseInline(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code — takes precedence over everything, including blank lines
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1][0].repeat(3);
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith(marker)) break;
        body.push(lines[i]);
      }
      blocks.push({ t: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }

    if (!line.trim()) { flushPara(); continue; }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ t: 'h', level: heading[1].length, spans: parseInline(heading[2].trim()) });
      continue;
    }

    if (HR_RE.test(line)) { flushPara(); blocks.push({ t: 'hr' }); continue; }

    // table: a pipe row immediately followed by a delimiter row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line).map(parseInline);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        rows.push(splitRow(lines[i]).map(parseInline));
      }
      i--; // the loop above stopped on a non-row line
      blocks.push({ t: 'table', head, align, rows });
      continue;
    }

    const item = ITEM_RE.exec(line);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[2]);
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        const it = ITEM_RE.exec(lines[i]);
        if (!it || /\d/.test(it[2]) !== ordered) break;
        items.push({ depth: Math.floor(it[1].length / 2), spans: parseInline(it[3]) });
      }
      i--;
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushPara();
      const body: string[] = [];
      for (; i < lines.length; i++) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
      }
      i--;
      blocks.push({ t: 'quote', spans: parseInline(body.join('\n')) });
      continue;
    }

    para.push(line);
  }

  flushPara();
  return blocks;
}
