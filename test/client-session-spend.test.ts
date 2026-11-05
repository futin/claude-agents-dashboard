import assert from 'node:assert';

import { acceptSpend, spendCard } from '../client/src/lib/sessionSpend.js';
import type { SessionSpend } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function spend(over: Partial<SessionSpend> = {}): SessionSpend {
  return { id: 'x', main: 1_220_000, subagents: 3_390_000, total: 4_610_000, compactions: 0, uncountedSubagents: 0, ...over };
}

export function run(): number {
  console.log('\n=== session spend card (client logic) ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('an exact total has no prefix and reads as itself', () => {
    const c = spendCard(spend());
    assert.equal(c.total, '4.61M');
    assert.equal(c.ariaLabel, '4.61M tokens spent');
    assert.equal(c.split, 'main 1.22M · subagents 3.39M');
  });

  t('a compaction marks the total as a minimum', () => {
    const c = spendCard(spend({ compactions: 2 }));
    assert.equal(c.total, '≥ 4.61M');
    assert.equal(c.ariaLabel, 'at least 4.61M tokens spent');
  });

  t('an uncounted subagent marks the total as a minimum', () => {
    const c = spendCard(spend({ uncountedSubagents: 1 }));
    assert.equal(c.total, '≥ 4.61M');
    assert.equal(c.ariaLabel, 'at least 4.61M tokens spent');
  });

  t('no subagents at all hides the split, because the total is the main figure', () => {
    assert.equal(spendCard(spend({ subagents: 0, total: 1_220_000 })).split, null);
  });

  t('an uncounted subagent keeps the split even at zero subagent tokens', () => {
    assert.equal(spendCard(spend({ subagents: 0, total: 1_220_000, uncountedSubagents: 1 })).split, 'main 1.22M · subagents 0');
  });

  t('main at zero with subagents keeps the split', () => {
    assert.equal(spendCard(spend({ main: 0, total: 3_390_000 })).split, 'main 0 · subagents 3.39M');
  });

  t('a good response replaces the snapshot', () => {
    const next = spend({ total: 5 });
    assert.equal(acceptSpend(spend(), next), next);
  });

  t('an error response after a good snapshot keeps that snapshot', () => {
    const prev = spend();
    assert.equal(acceptSpend(prev, spend({ total: 0, error: true })), prev);
  });

  t('an error as the first response leaves no snapshot, so no card', () => {
    assert.equal(acceptSpend(null, spend({ error: true })), null);
  });

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} passed`);
  return results.length - ok;
}
