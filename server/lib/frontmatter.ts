/**
 * frontmatter.ts — tolerant YAML-frontmatter subset parser (zero deps).
 *
 * Handles exactly what SKILL.md / agent .md files use in practice: top-level
 * `key: value` pairs, quoted values, and folded (`>`, `>-`) / literal (`|`,
 * `|-`) block scalars. Nested structures are skipped silently. Fails open:
 * anything malformed yields `{ data: {}, body: <whole text> }` — never throws.
 */

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

const KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/** Strip one pair of matching single/double quotes. */
function unquote(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseFrontmatter(text: string): Frontmatter {
  const src = String(text ?? '').replace(/^﻿/, '');
  const none: Frontmatter = { data: {}, body: src };

  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') return none;

  const end = lines.indexOf('---', 1);
  if (end === -1) return none;

  const data: Record<string, string> = {};
  let i = 1;
  while (i < end) {
    const m = lines[i].match(KEY_RE);
    if (!m) { i++; continue; }
    const key = m[1];
    const raw = m[2].trim();
    if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
      // Block scalar: consume following indented (or blank) lines.
      const parts: string[] = [];
      let j = i + 1;
      while (j < end && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
        parts.push(lines[j].trim());
        j++;
      }
      data[key] = parts.filter(Boolean).join(raw.startsWith('>') ? ' ' : '\n').trim();
      i = j;
    } else if (raw === '') {
      // Nested map/list follows — skip its indented block.
      let j = i + 1;
      while (j < end && (lines[j].trim() === '' || /^\s/.test(lines[j]))) j++;
      i = j;
    } else {
      data[key] = unquote(raw);
      i++;
    }
  }

  return { data, body: lines.slice(end + 1).join('\n') };
}
