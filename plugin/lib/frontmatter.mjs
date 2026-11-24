/**
 * frontmatter.ts — tolerant YAML-frontmatter subset parser (zero deps).
 *
 * Handles exactly what SKILL.md / agent .md files use in practice: top-level
 * `key: value` pairs, quoted values, and folded (`>`, `>-`) / literal (`|`,
 * `|-`) block scalars. Nested structures are skipped silently. Fails open:
 * anything malformed yields `{ data: {}, body: <whole text> }` — never throws.
 */
const KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
/** Strip one pair of matching single/double quotes. */
function unquote(v) {
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        return v.slice(1, -1);
    }
    return v;
}
export function parseFrontmatter(text) {
    const src = String(text ?? '').replace(/^﻿/, '');
    const none = { data: {}, body: src };
    const lines = src.split(/\r?\n/);
    if (lines[0] !== '---')
        return none;
    const end = lines.indexOf('---', 1);
    if (end === -1)
        return none;
    const data = {};
    let i = 1;
    while (i < end) {
        const m = lines[i].match(KEY_RE);
        if (!m) {
            i++;
            continue;
        }
        const key = m[1];
        const raw = m[2].trim();
        if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
            // Block scalar: consume following indented (or blank) lines.
            const parts = [];
            let j = i + 1;
            while (j < end && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
                parts.push(lines[j].trim());
                j++;
            }
            data[key] = parts.filter(Boolean).join(raw.startsWith('>') ? ' ' : '\n').trim();
            i = j;
        }
        else if (raw === '') {
            // Nested map/list follows — skip its indented block.
            let j = i + 1;
            while (j < end && (lines[j].trim() === '' || /^\s/.test(lines[j])))
                j++;
            i = j;
        }
        else {
            data[key] = unquote(raw);
            i++;
        }
    }
    return { data, body: lines.slice(end + 1).join('\n') };
}
/**
 * Length of the value in `s` (the text after `key:` with its leading blanks dropped): a quoted value runs to its closing quote, an unquoted one stops
 * before a ` #` comment, and trailing blanks are never part of it. Shared by `writeFrontmatterLine` and the routine-file parser so both read one
 * value the same way; `parseFrontmatter` above does not strip comments and is unchanged.
 */
export function scalarEnd(s) {
    const q = s[0];
    if (q === '"' || q === "'") {
        const close = s.indexOf(q, 1);
        if (close !== -1 && (/^\s*(#.*)?$/.test(s.slice(close + 1))))
            return close + 1;
    }
    let end = s.length;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
            end = i;
            break;
        }
    }
    return s.slice(0, end).trimEnd().length;
}
const stripCr = (l) => l.replace(/\r$/, '');
/** The frontmatter fence of `text`: null unless line 0, less one leading BOM and a trailing `\r`, is exactly `---`. */
export function frontmatterFence(text) {
    const lines = text.split('\n');
    if (stripCr(lines[0]).replace(/^\uFEFF/, '') !== '---')
        return null;
    const close = lines.findIndex((l, i) => i >= 1 && stripCr(l) === '---');
    return { lines, close, nl: lines[0].endsWith('\r') ? '\r\n' : '\n' };
}
/**
 * Index of the first top-level `key:` line inside the fence — no leading whitespace, no space before the colon, which is how the routine parser reads a
 * key — or -1 when there is none or the fence never closes.
 */
export function frontmatterKeyIndex(fence, key) {
    const prefix = `${key}:`;
    for (let i = 1; i < fence.close; i++)
        if (fence.lines[i].startsWith(prefix))
            return i;
    return -1;
}
/**
 * Set `key: value` in the frontmatter, touching nothing else: an existing top-level line has only its value replaced (spacing and a trailing comment
 * stay), an absent key is inserted after `afterKey`'s line or, failing that, just before the closing fence. Text without a closed frontmatter block is
 * returned unchanged. The edited line keeps the file's own line ending.
 */
export function writeFrontmatterLine(text, key, value, afterKey) {
    const fence = frontmatterFence(text);
    if (!fence || fence.close === -1)
        return text;
    const { lines } = fence;
    const at = frontmatterKeyIndex(fence, key);
    if (at !== -1) {
        const cr = lines[at].endsWith('\r') ? '\r' : '';
        const line = lines[at].slice(0, lines[at].length - cr.length);
        const head = line.slice(0, key.length + 1);
        const rest = line.slice(head.length);
        const body = rest.trimStart();
        const pad = rest.slice(0, rest.length - body.length);
        const end = scalarEnd(body);
        // An empty value may still be followed by a comment; keep it a space away from the new value.
        lines[at] = end === 0
            ? `${head}${pad || ' '}${value}${body ? ' ' + body : ''}${cr}`
            : `${head}${pad}${value}${body.slice(end)}${cr}`;
        return lines.join('\n');
    }
    const cr = fence.nl === '\r\n' ? '\r' : '';
    const after = afterKey === undefined ? -1 : frontmatterKeyIndex(fence, afterKey);
    lines.splice(after === -1 ? fence.close : after + 1, 0, `${key}: ${value}${cr}`);
    return lines.join('\n');
}
