/**
 * Pins WCAG AA (4.5:1) for the daylight theme's text tokens, computed straight off the `[data-theme="daylight"]` block in `client/src/styles.css`.
 *
 * The visual suite catches the same violations in a real browser, but it is macOS only and accepts whatever `contrast-known.json` lists; this runs
 * everywhere and accepts nothing. Two kinds of pair: a text token on the surfaces it is drawn on, and an accent drawn as text on its own
 * `color-mix(in srgb,var(--X) N%,transparent)` tint. The tint pairs are read out of the stylesheet rather than listed here, because the tint moves with
 * the token — a new pill at a heavier tint is a new pair, and a hand list would not see it.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/src/styles.css'), 'utf8');
const AA = 4.5;

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Every `--name:#hex` declared in the daylight block. */
function daylightTokens(css: string): Record<string, string> {
  const block = /\[data-theme="daylight"\]\{([^}]*)\}/.exec(css);
  if (!block) throw new Error('no [data-theme="daylight"] block in styles.css');
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
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

interface TintPair { line: number; selector: string; token: string; pct: number }

/** Rules that set `color:var(--X)` and `background:color-mix(in srgb,var(--X) N%,transparent)` with the same X — text on its own tint. */
function tintPairs(css: string): TintPair[] {
  const out: TintPair[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const color = /(?<![-\w])color:var\(--([\w-]+)\)/.exec(m[2]);
    const bg = /background:color-mix\(in srgb,var\(--([\w-]+)\) *(\d+)%,transparent\)/.exec(m[2]);
    if (!color || !bg || color[1] !== bg[1]) continue;
    out.push({
      line: css.slice(0, m.index).split('\n').length,
      selector: m[1].trim().split('\n').pop()!.trim(),
      token: color[1],
      pct: Number(bg[2])
    });
  }
  return out;
}

export function run(): number {
  console.log('\n=== daylight contrast (WCAG AA) ===\n');
  let p = 0, f = 0;
  const t = daylightTokens(CSS);
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
      green: ['strip'], amber: ['strip'], mustard: ['strip'], cyan: ['strip'], red: ['strip'], magenta: ['strip']
    };
    for (const [fg, bgs] of Object.entries(surfaces)) for (const bg of bgs) check(fg, `--${bg} ${t[bg]}`, at(bg), fails);
    assert.deepStrictEqual(fails, []);
  })) p++; else f++;

  // A tint is translucent, so its pill reads against whatever surface it sits on — measured in the browser on `--strip-hi` rows and section heads
  // (2026-10-10), not only on white cards. Each pair is checked over every surface a pill is drawn on.
  if (test('every accent drawn as text on its own tint clears 4.5:1 over --strip, --strip-hi and --board', () => {
    const pairs = tintPairs(CSS);
    // Guards the parser, not the palette: if the regex stops matching, the loop below would pass on nothing.
    for (const sel of ['.spill.working', '.spill.question', '.git-chip.mustard', '.pb-badge']) {
      assert.ok(pairs.some((x) => x.selector === sel), `tint-pair scan no longer finds ${sel}`);
    }
    const fails: string[] = [];
    for (const x of pairs) for (const under of ['strip', 'strip-hi', 'board']) {
      check(x.token, `its ${x.pct}% tint over --${under} (${x.selector}, styles.css:${x.line})`, tint(at(x.token), x.pct, at(under)), fails);
    }
    assert.deepStrictEqual(fails, []);
  })) p++; else f++;

  if (test('--ink2 stays darker than --ink3, so the secondary/tertiary order holds', () => {
    assert.ok(luminance(at('ink2')) < luminance(at('ink3')), `--ink2 ${t.ink2} is not darker than --ink3 ${t.ink3}`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed\n`);
  return f;
}
