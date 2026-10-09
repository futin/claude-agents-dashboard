/**
 * Client domain logic of Management › Projects (`client/src/lib/projectsView.ts`): the layout switcher's list and guard, the pinned / offered split with its one
 * shared filter, the `~`-shortened parent dir and the copy strings. All pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { PinRow, PinsResponse, ProjectRef } from '../shared/types.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';
import {
  DEFAULT_PROJECTS_LAYOUT, LIST_SUB_OFFERS, LIST_SUB_PINNED, PROJECTS_BAND_SUB, PROJECTS_LAYOUTS, PROJECTS_MISSING,
  isProjectsLayout, noOffersText, noPinsText, projectDir, splitProjects,
} from '../client/src/lib/projectsView.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ref = (name: string, path = `/Users/u/Projects/${name}`): ProjectRef => ({ dirName: name, name, path, lastActiveMs: 1 });
const pin = (name: string, path: string | null = `/Users/u/Projects/${name}`): PinRow => ({ dirName: name, name, path, lastActiveMs: 1, listed: true });
const pins = (over: Partial<PinsResponse>): PinsResponse => ({ pinned: [], recent: [], older: [], home: '/Users/u', ...over } as PinsResponse);

export function run(): number {
  let p = 0, f = 0;
  console.log('\nprojects view logic');

  if (test('PROJECTS_LAYOUTS lists Tiles, Columns, Lists in that order; tiles is the default', () => {
    assert.deepStrictEqual(PROJECTS_LAYOUTS, [
      { key: 'tiles', label: 'Tiles' }, { key: 'columns', label: 'Columns' }, { key: 'lists', label: 'Lists' },
    ]);
    assert.strictEqual(DEFAULT_PROJECTS_LAYOUT, 'tiles');
  })) p++; else f++;

  if (test('isProjectsLayout: the three keys pass; anything else fails', () => {
    for (const k of ['tiles', 'columns', 'lists']) assert.strictEqual(isProjectsLayout(k), true);
    assert.strictEqual(isProjectsLayout('cards'), false);
    assert.strictEqual(isProjectsLayout(undefined), false);
    assert.strictEqual(isProjectsLayout(null), false);
  })) p++; else f++;

  if (test('OWNED_KEYS includes management.projectsLayout so Reset sweeps it', () => {
    assert.ok(OWNED_KEYS.includes('management.projectsLayout'));
  })) p++; else f++;

  if (test('splitProjects: offers is recent then older in order; a blank query shows everything', () => {
    const r = splitProjects(pins({ pinned: [pin('p1')], recent: [ref('r1'), ref('r2')], older: [ref('o1')] }), '');
    assert.deepStrictEqual(r.offers.map(o => o.name), ['r1', 'r2', 'o1']);
    assert.deepStrictEqual(r.offersShown.map(o => o.name), ['r1', 'r2', 'o1']);
    assert.deepStrictEqual(r.pinnedShown.map(o => o.name), ['p1']);
    assert.strictEqual(r.pinned.length, 1);
  })) p++; else f++;

  if (test('splitProjects: one query filters both groups by name or path; the unfiltered lists keep the totals', () => {
    const r = splitProjects(pins({
      pinned: [pin('alpha'), pin('beta'), pin('dead', null)],
      recent: [ref('alpine'), ref('zed')],
      older: [ref('gamma', '/Users/u/alp/gamma'), ref('delta')],
    }), ' ALP ');
    assert.deepStrictEqual(r.pinnedShown.map(x => x.name), ['alpha']);
    assert.deepStrictEqual(r.offersShown.map(x => x.name), ['alpine', 'gamma']);
    assert.strictEqual(r.pinned.length, 3);
    assert.strictEqual(r.offers.length, 4);
    assert.deepStrictEqual(splitProjects(pins({ pinned: [pin('dead', null)] }), 'dead').pinnedShown.map(x => x.name), ['dead']);
  })) p++; else f++;

  if (test('projectDir: ~-shortened parent with a trailing slash; outside home absolute; no parent → empty', () => {
    assert.strictEqual(projectDir('/Users/u/Projects/x', '/Users/u'), '~/Projects/');
    assert.strictEqual(projectDir('/Users/u/x', '/Users/u'), '~/');
    assert.strictEqual(projectDir('/opt/x/y', '/Users/u'), '/opt/x/');
    assert.strictEqual(projectDir('/opt/x/y', ''), '/opt/x/');
    assert.strictEqual(projectDir('~', '/Users/u'), '');
    assert.strictEqual(projectDir('/Users/u', '/Users/u'), '');
    assert.strictEqual(projectDir('x', '/Users/u'), '');
    assert.strictEqual(projectDir('/x', '/Users/u'), '');
  })) p++; else f++;

  if (test('noPinsText / noOffersText: empty total vs an unmatched filter', () => {
    assert.strictEqual(noPinsText(0), 'No projects are pinned.');
    assert.strictEqual(noPinsText(3), 'No pinned project matches.');
    assert.strictEqual(noOffersText(0), 'Every project active in the last 30 days is already pinned.');
    assert.strictEqual(noOffersText(5), 'No project matches.');
  })) p++; else f++;

  if (test('copy constants are verbatim', () => {
    assert.strictEqual(PROJECTS_BAND_SUB, 'Every project with a session in the last 30 days. Pin one to keep it in the launch sheet whatever the lookback; pins are stored by the dashboard server, so they show up on every device.');
    assert.strictEqual(PROJECTS_MISSING, 'Folder no longer exists. Hidden from every list until unpinned.');
    assert.strictEqual(LIST_SUB_OFFERS, 'a session in the last 30 days, gone from the launch sheet once it ages out');
    assert.strictEqual(LIST_SUB_PINNED, 'kept in the launch sheet whatever the lookback');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
