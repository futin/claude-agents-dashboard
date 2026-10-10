/**
 * The non-image checks (spec §6), on the same fixtures and staging as the shots: no horizontal page overflow at any width, and no daylight text contrast
 * below WCAG AA that `contrast-known.json` does not already accept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { SECTIONS } from '../../client/src/lib/sections.js';

import { contrastKey, diffContrast, type ContrastEntry } from './contrast-known.js';
import { expect, test } from './harness.js';
import { stage } from './stage.js';
import { DAYLIGHT_TIERS } from './tiers.js';

const KNOWN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contrast-known.json');

/**
 * Decided once, at load: with no file, this run records what it finds and passes; with one, it compares. Deciding per case would make the first view's write
 * turn every later view into a comparison against a half-written file.
 */
const RECORDING = !fs.existsSync(KNOWN_FILE);

function readKnown(): ContrastEntry[] {
  return fs.existsSync(KNOWN_FILE) ? (JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')) as ContrastEntry[]) : [];
}

/** Replaces `view`'s entries in the file with `entries`, sorted by key, 2-space JSON. */
function recordView(view: string, entries: ContrastEntry[]): void {
  const merged = [...readKnown().filter((e) => e.view !== view), ...entries];
  merged.sort((a, b) => contrastKey(a).localeCompare(contrastKey(b)));
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * `isReady` can pass in the gap between a view's first data and a fetch it starts only once that data arrives (Usage's `table.dt` at 768 rendered after the
 * check in one full run, 2026-10-06). A screenshot waits for two identical frames on its own; these checks read once, so they wait for the same: element
 * count, document size and `.main`'s scroll width unchanged across 250ms.
 */
async function settle(page: Page): Promise<void> {
  const signature = () => page.evaluate(() => {
    const main = document.querySelector('.main');
    const d = document.documentElement;
    return `${document.querySelectorAll('*').length}|${d.scrollWidth}x${d.scrollHeight}|${main?.scrollWidth ?? -1}`;
  });
  let last = await signature();
  await expect.poll(async () => {
    await page.waitForTimeout(250);
    const next = await signature();
    const stable = next === last;
    last = next;
    return stable;
  }, { timeout: 10_000, intervals: [0] }).toBe(true);
}

function describe(e: ContrastEntry): string {
  return `${e.view} · "${e.text}" · ${e.selector} · fg ${e.fg} on bg ${e.bg} · ${e.ratio}:1, needs ${e.required}:1`;
}

for (const { id } of SECTIONS) {
  for (const { width, contentWidth } of DAYLIGHT_TIERS) {
    test(`${id} · daylight · ${width} · overflow`, async ({ page }) => {
      await stage(page, { section: id, theme: 'daylight', width, contentWidth });
      await settle(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          mainScroll: main?.scrollWidth ?? -1,
          mainClient: main?.clientWidth ?? -1
        };
      });
      expect(m.scrollWidth, `${id} at ${width}px overflows: scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(m.innerWidth);
      // `.main{overflow-x:clip}` keeps content overflow out of the document's scrollWidth — it is cut off instead, so measure the content area too.
      expect(m.mainClient, `${id} at ${width}px has no .main`).toBeGreaterThan(0);
      expect(m.mainScroll, `${id} at ${width}px clips content: .main scrollWidth ${m.mainScroll} > clientWidth ${m.mainClient}`).toBeLessThanOrEqual(m.mainClient);
    });
  }
}

for (const { id } of SECTIONS) {
  test(`${id} · daylight · 1280 · contrast`, async ({ page }) => {
    await stage(page, { section: id, theme: 'daylight', width: 1280, contentWidth: 'fixed' });
    await settle(page);
    const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();

    const found: ContrastEntry[] = [];
    for (const v of result.violations) {
      for (const node of v.nodes) {
        const data = (node.any.find((c) => c.id === 'color-contrast')?.data ?? {}) as {
          fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string;
        };
        const selector = node.target.map(String).join(' ');
        const text = (await page.locator(selector).first().innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
        found.push({
          view: id,
          text,
          fg: data.fgColor ?? '',
          bg: data.bgColor ?? '',
          ratio: data.contrastRatio ?? 0,
          required: Number.parseFloat(data.expectedContrastRatio ?? '0'),
          selector
        });
      }
    }
    console.log(`${id} · daylight · 1280 · contrast: ${result.incomplete.reduce((n, r) => n + r.nodes.length, 0)} incomplete (not judged)`);

    if (RECORDING) {
      recordView(id, found);
      return;
    }
    const { added, fixed } = diffContrast(readKnown().filter((e) => e.view === id), found);
    for (const e of fixed) console.log(`contrast fixed: ${contrastKey(e)}`);
    expect(added, `new daylight contrast violations:\n  ${added.map(describe).join('\n  ')}`).toEqual([]);
  });
}
