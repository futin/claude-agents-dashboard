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
 * Pure and unit-tested (`test/chat/markdown.test.ts`). Zero deps, and no HTML string
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
  /** Numbered (`1.`, `2)`) rather than a bullet. A list block holds both kinds once nested. */
  ordered: boolean;
  /** The number written on an ordered item; null for a bullet. */
  n: number | null;
}

/** One list of a nested list tree (`listTree`): an ordered list numbers on from `start` (CommonMark), a bullet list has none. */
export interface ListNode {
  ordered: boolean;
  start: number | null;
  items: { spans: Inline[]; children: ListNode[] }[];
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

/** An `ITEM_RE` match as a flat list item, its written number kept. */
function listItem(m: RegExpExecArray): ListItem {
  const ordered = /\d/.test(m[2]);
  return { depth: Math.floor(m[1].length / 2), spans: parseInline(m[3]), ordered, n: ordered ? parseInt(m[2], 10) : null };
}

/**
 * A list block's flat items as nested lists. A deeper item opens a child list under the item before it (one level down, however much deeper it is
 * indented — no empty lists in between); a shallower one closes back to its level; an item of the other kind at the same level starts a sibling list
 * there. Each ordered list starts at its first item's written number.
 */
export function listTree(items: ListItem[]): ListNode {
  const open = (it: ListItem): ListNode => ({ ordered: it.ordered, start: it.ordered ? it.n : null, items: [] });
  const root = open(items[0] ?? { depth: 0, spans: [], ordered: false, n: null });
  const stack: { list: ListNode; depth: number }[] = [{ list: root, depth: items[0]?.depth ?? 0 }];
  const top = () => stack[stack.length - 1];
  for (const it of items) {
    // Close deeper lists until this item's level — but never past a list whose parent sits shallower than the item.
    while (stack.length > 1 && it.depth < top().depth && it.depth <= stack[stack.length - 2].depth) stack.pop();
    const cur = top();
    if (it.depth > cur.depth && cur.list.items.length) {
      const child = open(it);
      cur.list.items[cur.list.items.length - 1].children.push(child);
      stack.push({ list: child, depth: it.depth });
    } else if (it.ordered !== cur.list.ordered && stack.length > 1) {
      const sibling = open(it);
      const parent = stack[stack.length - 2].list;
      parent.items[parent.items.length - 1].children.push(sibling);
      stack[stack.length - 1] = { list: sibling, depth: cur.depth };
    }
    top().list.items.push({ spans: it.spans, children: [] });
  }
  return root;
}
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** Split a table row on unescaped pipes outside code spans, dropping the leading/trailing ones. `\|` becomes a literal `|`. */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = '';
  let endedOnPipe = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    endedOnPipe = false;
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const run = '`'.repeat(n);
      // a code span closes on a run of exactly the same length; an unclosed run stays literal text
      let close = -1;
      for (let j = s.indexOf(run, i + n); j !== -1; j = s.indexOf(run, j + 1)) {
        if (s[j - 1] !== '`' && s[j + n] !== '`') { close = j; break; }
      }
      const end = close === -1 ? i + n : close + n;
      cur += s.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; endedOnPipe = true; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (s.startsWith('|')) cells.shift();
  if (endedOnPipe && cells.length) cells.pop();
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
      // Closer: the opener's character, at least its length, nothing after it but whitespace. Any indent, as FENCE_RE allows any on the opener — a fence
      // nested in a list sits 4+ spaces in, and CommonMark's 0–3 would leave it open to the end of the message.
      const closer = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (closer.test(lines[i])) break;
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
      const base = listItem(item).depth;
      // A list of the other kind at this list's own level is a separate block; nested deeper, it is a sub-list of this one (#519).
      const ends = (it: ListItem) => it.depth <= base && it.ordered !== ordered;
      const items: ListItem[] = [];
      for (; i < lines.length; i++) {
        if (!lines[i].trim()) {
          // Blank lines inside a list keep it going when an item follows them, so `1. a`, blank, `2. b` stays one list numbered 1, 2.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = j < lines.length ? ITEM_RE.exec(lines[j]) : null;
          if (!next || ends(listItem(next))) break;
          i = j - 1;
          continue;
        }
        const it = ITEM_RE.exec(lines[i]);
        if (!it) break;
        const li = listItem(it);
        if (ends(li)) break;
        items.push(li);
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
