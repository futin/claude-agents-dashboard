/**
 * Accepted daylight contrast violations (`contrast-known.json`), keyed by view + text + colour pair and never by selector: the CSS Modules migration this
 * suite serves renames classes, and a selector key would report every known violation as new on each step. Pure — `layout.spec.ts` does the I/O.
 */
export interface ContrastEntry {
  view: string;
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  required: number;
  selector: string;
}

/** `view|text|fg|bg`: text trimmed with whitespace runs collapsed, colours lowercased as axe reports them (an alpha suffix is kept). */
export function contrastKey(e: ContrastEntry): string {
  return `${e.view}|${e.text.trim().replace(/\s+/g, ' ')}|${e.fg.toLowerCase()}|${e.bg.toLowerCase()}`;
}

/** `added`: found but not known. `fixed`: known but no longer found. Duplicate keys within `found` collapse to the first. */
export function diffContrast(known: ContrastEntry[], found: ContrastEntry[]): { added: ContrastEntry[]; fixed: ContrastEntry[] } {
  const knownKeys = new Set(known.map(contrastKey));
  const foundKeys = new Set<string>();
  const added: ContrastEntry[] = [];
  for (const e of found) {
    const k = contrastKey(e);
    if (foundKeys.has(k)) continue;
    foundKeys.add(k);
    if (!knownKeys.has(k)) added.push(e);
  }
  return { added, fixed: known.filter((e) => !foundKeys.has(contrastKey(e))) };
}
