/**
 * The deep-link contract, end to end: every link the server builds (`server/lib/notify.ts`, `server/lib/hub-widgets.ts`) parsed by the client's own
 * parsers (`client/src/lib/deepLink.ts`). The view names are typed on both sides through `DeepLinkView` in `shared/types.ts`; this suite catches what a
 * type cannot — a param name, the encoding, a view the client parses but lands somewhere else (#580).
 */
import assert from 'node:assert';

import { readRunParam, readSessionParam, readViewParam, sectionForView, startSection } from '../../client/src/lib/deepLink.js';
import type { Config } from '../../server/lib/config.js';
import { gitPendingRows } from '../../server/lib/hub-widgets.js';
import { clickUrl, routineClickUrl, tickCappedClickUrl, usageClickUrl } from '../../server/lib/notify.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const BASE = 'https://host.example';
const cfg = (over: Partial<Config> = {}): Config => ({ publicUrl: BASE, backlogBoardUrl: '', ...over }) as Config;

/** The query string the page would see after following `url`. */
function searchOf(url: string): string {
  return new URL(url, BASE).search;
}

const landing = (search: string) =>
  startSection({ session: readSessionParam(search) !== null, view: readViewParam(search), stored: 'analytics', landing: 'last' });

export function run(): number {
  console.log('\n=== deep-link contract (server builders → client parsers) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('clickUrl: the session id round-trips and the page opens on Sessions', () => {
    const id = 'abc12345-0000-4000-8000-000000000001';
    const s = searchOf(clickUrl(cfg(), id));
    assert.strictEqual(readSessionParam(s), id);
    assert.strictEqual(readViewParam(s), null);
    assert.strictEqual(landing(s), 'sessions');
  });

  t('clickUrl: an id the client would not accept is escaped by the server and refused by the client, never read as another param', () => {
    const s = searchOf(clickUrl(cfg(), 'a b/c&view=usage'));
    assert.strictEqual(new URLSearchParams(s).get('session'), 'a b/c&view=usage', 'the escape survives the trip');
    assert.strictEqual(readSessionParam(s), null, 'not a session id shape');
    assert.strictEqual(readViewParam(s), null, 'the embedded &view= stayed inside the value');
  });

  t('routineClickUrl: routines view with the run id', () => {
    const s = searchOf(routineClickUrl(cfg(), 'run-9'));
    assert.strictEqual(readViewParam(s), 'routines');
    assert.strictEqual(readRunParam(s), 'run-9');
    assert.strictEqual(landing(s), 'routines');
  });

  t('routineClickUrl: a refusal run id with dots and dashes round-trips', () => {
    const id = 'refused-mac.local-nightly-1800000000';
    assert.strictEqual(readRunParam(searchOf(routineClickUrl(cfg(), id))), id);
  });

  t('usageClickUrl: usage view, landing on the Usage section', () => {
    const s = searchOf(usageClickUrl(cfg()));
    assert.strictEqual(readViewParam(s), 'usage');
    assert.strictEqual(sectionForView('usage'), 'usage');
    assert.strictEqual(landing(s), 'usage');
  });

  t('tickCappedClickUrl: routines view without a board URL; the board URL, untouched, with one', () => {
    const s = searchOf(tickCappedClickUrl(cfg()));
    assert.strictEqual(readViewParam(s), 'routines');
    assert.strictEqual(readRunParam(s), null);
    assert.strictEqual(tickCappedClickUrl(cfg({ backlogBoardUrl: 'https://board.example' })), 'https://board.example/');
  });

  t('hub-widgets: the git row link opens the git view, landing on Management', () => {
    const [row] = gitPendingRows([{ dirName: 'm', name: 'm', path: null, state: 'missing' }]);
    const s = searchOf(row.open);
    assert.strictEqual(readViewParam(s), 'git');
    assert.strictEqual(landing(s), 'management');
  });

  t('every builder returns "" without a public URL', () => {
    const none = cfg({ publicUrl: '' });
    assert.deepStrictEqual(
      [clickUrl(none, 'abc12345'), routineClickUrl(none, 'r'), usageClickUrl(none), tickCappedClickUrl(none)],
      ['', '', '', '']
    );
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
