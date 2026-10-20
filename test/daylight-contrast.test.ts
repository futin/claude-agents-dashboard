/**
 * Pins WCAG AA (4.5:1) for the daylight theme's text tokens, computed straight off the `[data-theme="daylight"]` block in `client/src/styles.css`.
 *
 * The visual suite catches the same violations in a real browser, but it is macOS only and accepts whatever `contrast-known.json` lists; this runs
 * everywhere and accepts nothing. Two kinds of pair: a text token on the surfaces it is drawn on, and an accent drawn as text on its own
 * `color-mix(in srgb,var(--X) N%,transparent)` tint, or on a named `--X-tint` token in `--X` or `--X-ink` (the soft amber and mustard pills, whose
 * daylight fill is itself a `color-mix` of a mock hue). The tint pairs are read out of the stylesheet rather than listed here, because the tint moves with
 * the token — a new pill at a heavier tint is a new pair, and a hand list would not see it.
 * Amber is the one accent split in two: `--amber-solid` is a mark held to 3:1 (and the dark boards' `--amber` is checked as both mark and text), while
 * daylight's `--amber-text` is the ink.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/src/styles.css'), 'utf8');
const AA = 4.5;
/** WCAG 1.4.11: a non-text mark (a bar fill, a status dot, a meter) against the surface it is drawn on. */
const MARK = 3;

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function daylightBlock(css: string): string {
  const block = /\[data-theme="daylight"\]\{([^}]*)\}/.exec(css);
  if (!block) throw new Error('no [data-theme="daylight"] block in styles.css');
  return block[1];
}

/** Every `--name:#hex` declared in the daylight block. */
function daylightTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const block = daylightBlock(css);
  for (const m of block.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  // `--amber-text:var(--ink)` — a token that is another token, resolved once (the target is a hex in the same block)
  for (const m of block.matchAll(/--([\w-]+):var\(--([\w-]+)\)/g)) if (out[m[2]]) out[m[1]] = out[m[2]];
  return out;
}

/** Every `--name:#hex` a non-daylight theme block declares, by theme id. `midnight` is the `:root` block, whose selector also lists it. */
function darkThemes(css: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const m of css.matchAll(/(?:^|\n)((?::root,)?\[data-theme="(midnight|graphite|amber|nightshift)"\])\{([^}]*)\}/g)) {
    const toks: Record<string, string> = {};
    for (const d of m[3].matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})\b/g)) toks[d[1]] = d[2].toLowerCase();
    out[m[2]] = toks;
  }
  return out;
}

/** Every `--name:color-mix(in srgb,#hex N%,transparent)` declared in the daylight block — a translucent fill token, as `--amber-tint` is. */
function daylightMixTokens(css: string): Record<string, { hex: string; pct: number }> {
  const out: Record<string, { hex: string; pct: number }> = {};
  for (const m of daylightBlock(css).matchAll(/--([\w-]+):color-mix\(in srgb,(#[0-9a-fA-F]{6}) *(\d+)%,transparent\)/g)) {
    out[m[1]] = { hex: m[2].toLowerCase(), pct: Number(m[3]) };
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(c: [number, number, number]): number {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: [number, number, number], bg: [number, number, number]): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color-mix(in srgb,fg p%,transparent)` composited over `under`. */
function tint(fg: [number, number, number], pct: number, under: [number, number, number]): [number, number, number] {
  return fg.map((v, i) => Math.round(v * pct / 100 + under[i] * (1 - pct / 100))) as [number, number, number];
}

/** `bg` is the token the tint is mixed from: X itself, or a `--X-tint` token the theme sets as its own hex (pct 100) or as a `color-mix` of a hex. */
interface TintPair { line: number; selector: string; token: string; bg: string; pct: number }

/** Rules that set `color:var(--X)` over its own tint — `background:color-mix(in srgb,var(--X) N%,transparent)` or `background:var(--X-tint)` — or
 *  `color:var(--X-ink)` over `background:var(--X-tint)`. */
function tintPairs(css: string): TintPair[] {
  const out: TintPair[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const color = /(?<![-\w])color:var\(--([\w-]+)\)/.exec(m[2]);
    if (!color) continue;
    const mix = /background:color-mix\(in srgb,var\(--([\w-]+)\) *(\d+)%,transparent\)/.exec(m[2]);
    const named = /background:var\(--([\w-]+)-tint\)/.exec(m[2]);
    const pair = mix && mix[1] === color[1] ? { bg: color[1], pct: Number(mix[2]) }
      : named && (named[1] === color[1] || `${named[1]}-ink` === color[1]) ? { bg: `${named[1]}-tint`, pct: 100 } : null;
    if (!pair) continue;
    out.push({
      line: css.slice(0, m.index).split('\n').length,
      selector: m[1].trim().split('\n').pop()!.trim(),
      token: color[1],
      ...pair
    });
  }
  return out;
}

export function run(): number {
  console.log('\n=== daylight contrast (WCAG AA) ===\n');
  let p = 0, f = 0;
  const t = daylightTokens(CSS);
  const mixes = daylightMixTokens(CSS);
  const at = (name: string) => {
    assert.ok(t[name], `--${name} is not a #rrggbb token in the daylight block`);
    return rgb(t[name]);
  };
  const check = (fg: string, bgName: string, bg: [number, number, number], fails: string[]) => {
    const r = ratio(at(fg), bg);
    if (r < AA) fails.push(`--${fg} ${t[fg]} on ${bgName}: ${r.toFixed(2)}:1`);
  };

  if (test('text tokens clear 4.5:1 on every surface they are drawn on', () => {
    const fails: string[] = [];
    const surfaces: Record<string, string[]> = {
      ink2: ['hairline2', 'steel', 'strip'],
      ink3: ['strip', 'strip-hi', 'board', 'steel'],
      green: ['strip'], 'amber-text': ['strip', 'strip-hi', 'board', 'steel'], mustard: ['strip'], cyan: ['strip'], red: ['strip'], magenta: ['strip'],
      'amber-ink': ['strip'], 'mustard-ink': ['strip']
    };
    for (const [fg, bgs] of Object.entries(surfaces)) for (const bg of bgs) check(fg, `--${bg} ${t[bg]}`, at(bg), fails);
    assert.deepStrictEqual(fails, []);
  })) p++; else f++;

  // The amber *fill* is the opposite case: it is drawn as a mark (a context bar on its `--steel` track, a status dot, a meter, a border), where WCAG asks
  // 3:1, and it stays bright because a darkened amber reads as brown. The text that goes with it is the ink, pinned above.
  if (test('--amber-solid, drawn as a mark, clears 3:1 on every surface it sits on', () => {
    const fails: string[] = [];
    for (const bg of ['strip', 'strip-hi', 'steel', 'board']) {
      const r = ratio(at('amber-solid'), at(bg));
      if (r < MARK) fails.push(`--amber-solid ${t['amber-solid']} on --${bg} ${t[bg]}: ${r.toFixed(2)}:1`);
    }
    assert.deepStrictEqual(fails, []);
  })) p++; else f++;

  // A filled amber button (Schedules' New job) carries text, so its ink is held to 4.5:1 on the fill: white is 3.5:1 there, so daylight uses the ink.
  if (test('--on-amber clears 4.5:1 on the --amber-solid fill', () => {
    const r = ratio(at('on-amber'), at('amber-solid'));
    assert.ok(r >= AA, `--on-amber ${t['on-amber']} on --amber-solid ${t['amber-solid']}: ${r.toFixed(2)}:1`);
  })) p++; else f++;

  if (test('daylight amber text is the ink, and nothing but the dark boards still names bare --amber', () => {
    assert.strictEqual(t['amber-text'], t.ink, `--amber-text ${t['amber-text']} is not --ink ${t.ink}`);
    assert.strictEqual(t.amber, undefined, 'daylight sets --amber again — the darkened brown the split removed');
    const afterTokens = CSS.slice(CSS.indexOf('/* Density + text scale'));
    assert.ok(afterTokens.length > 0 && !/var\(--amber\)/.test(afterTokens), 'a rule below the token blocks reads var(--amber): use --amber-solid (marks) or --amber-text (text)');
  })) p++; else f++;

  if (test('dark boards keep amber unchanged: mark >= 3:1 and text >= 4.5:1 on every surface', () => {
    const fails: string[] = [];
    const themes = darkThemes(CSS);
    assert.deepStrictEqual(Object.keys(themes).sort(), ['amber', 'graphite', 'midnight', 'nightshift']);
    const root = themes.midnight;
    for (const [id, own] of Object.entries(themes)) {
      const tok = { ...root, ...own };
      for (const bg of ['strip', 'strip-hi', 'steel', 'board']) {
        const mark = ratio(rgb(tok.amber), rgb(tok[bg]));
        if (mark < MARK) fails.push(`${id}: --amber-solid ${tok.amber} on --${bg}: ${mark.toFixed(2)}:1`);
        const txt = ratio(rgb(tok.amber), rgb(tok[bg]));
        if (txt < AA) fails.push(`${id}: --amber-text ${tok.amber} on --${bg}: ${txt.toFixed(2)}:1`);
      }
    }
    assert.deepStrictEqual(fails, []);
    // the dark themes must not override the split, or they would stop following their own --amber
    assert.ok(/--amber-solid:var\(--amber\);--amber-text:var\(--amber\)/.test(CSS), 'the root block no longer derives --amber-solid / --amber-text from --amber');
  })) p++; else f++;

  // A tint is translucent, so its pill reads against whatever surface it sits on — measured in the browser on `--strip-hi` rows and section heads
  // (2026-10-10), not only on white cards. Each pair is checked over every surface a pill is drawn on.
  if (test('every accent drawn as text on its own tint clears 4.5:1 over --strip, --strip-hi and --board', () => {
    const pairs = tintPairs(CSS);
    // Guards the parser, not the palette: if the regex stops matching, the loop below would pass on nothing.
    for (const sel of ['.spill.working', '.spill.question', '.spill.incomplete', '.git-chip.mustard', '.pb-badge', '.git-mx .git-cell.meh,.git-mx-legend .git-cell.meh']) {
      assert.ok(pairs.some((x) => x.selector === sel), `tint-pair scan no longer finds ${sel}`);
    }
    const fails: string[] = [];
    for (const x of pairs) for (const under of ['strip', 'strip-hi', 'board']) {
      const mix = mixes[x.bg];
      const fill = mix ? tint(rgb(mix.hex), mix.pct, at(under)) : tint(at(x.bg), x.pct, at(under));
      const pct = mix ? `${mix.pct}% ${mix.hex}` : `${x.pct}% --${x.bg}`;
      check(x.token, `its ${pct} tint over --${under} (${x.selector}, styles.css:${x.line})`, fill, fails);
    }
    assert.deepStrictEqual(fails, []);
  })) p++; else f++;

  if (test('--ink2 stays darker than --ink3, so the secondary/tertiary order holds', () => {
    assert.ok(luminance(at('ink2')) < luminance(at('ink3')), `--ink2 ${t.ink2} is not darker than --ink3 ${t.ink3}`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed\n`);
  return f;
}
