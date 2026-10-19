/**
 * The dashboard may map ui-kit's `--uk-*` tokens onto its own palette and do nothing else to the chip or the drawer: sizes, geometry, the phone shape and
 * the notes' typography are ui-kit's, so the three apps that ship it look identical. `ui-kit/guard`'s `checkHostCss` is the one definition of "nothing
 * else" — it reports any rule on a `.uk-*` class that is not a token mapping, and any `--uk-*` property that is not a public token. Run here over every
 * sheet the client ships, so an override cannot come back unnoticed (it came back once already, as `.uk-releases-notes .md` and `--uk-font-size-lg`).
 */
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkHostCss } from 'ui-kit/guard';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const CLIENT = fileURLToPath(new URL('../client/src', import.meta.url));

/** Every sheet the client ships, listed on purpose: a new `.css` file has to be added here, which is the moment to ask whether it overrides ui-kit. */
const SHEETS = ['styles.css'];

const css = (rel: string): string => readFileSync(join(CLIENT, rel), 'utf8');

/** Every `.css` under `client/src`, relative to it, in a stable order. */
function sheetsOnDisk(dir = CLIENT): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? sheetsOnDisk(join(dir, e.name)) : e.name.endsWith('.css') ? [relative(CLIENT, join(dir, e.name))] : []))
    .sort();
}

export function run(): number {
  console.log('\n=== ui-kit guard (host stylesheets) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('the listed sheets are every .css under client/src', () => {
    assert.deepStrictEqual(sheetsOnDisk(), [...SHEETS].sort(), 'a stylesheet was added or removed: list it in SHEETS so ui-kit/guard checks it');
  });

  for (const sheet of SHEETS) {
    t(`${sheet} sets only ui-kit's public tokens and no .uk-* rule of its own`, () => {
      assert.deepStrictEqual(checkHostCss(css(sheet)), [], `${sheet} overrides ui-kit`);
    });
  }

  // The guard sees what a sheet sets wrongly, never what it forgot to set. An unmapped chip fill leaves the light default well on a dark rail; an unmapped
  // zoom leaves the drawer sized against the unscaled viewport, so at a font scale other than 1 it overhangs the screen.
  t('the mapping sets --uk-chip-bg and --uk-zoom', () => {
    const sheet = css('styles.css');
    assert.match(sheet, /--uk-chip-bg\s*:\s*var\(--steel\)/, '--uk-chip-bg is not mapped');
    assert.match(sheet, /--uk-zoom\s*:\s*var\(--font-scale\s*,\s*1\)/, '--uk-zoom is not mapped to the shell zoom');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
