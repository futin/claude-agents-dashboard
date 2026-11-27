/** `readSessionRegistry` and `parentLiveOf` (#588 D3): whether a session's parent `claude` process is alive. */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProcProbe } from '../../server/lib/scan.js';
import { parentLiveOf, readSessionRegistry } from '../../server/lib/session-registry.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const probe = (liveSessionIds: string[] | null, claudePids: string[] | null): ProcProbe => ({
  runningClaudeProcs: claudePids ? claudePids.length : null,
  liveCwds: null,
  liveSessionIds: liveSessionIds ? new Set(liveSessionIds) : null,
  claudePids: claudePids ? new Set(claudePids) : null
});

export function run(): number {
  console.log('\n=== session-registry.ts ===\n');
  let p = 0, f = 0;

  if (test('15: registry reads valid entries only; a missing sessions/ dir is null', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-registry-'));
    assert.strictEqual(readSessionRegistry(home), null);
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/a', kind: 'interactive' }));
    fs.writeFileSync(path.join(dir, '2.json'), '{malformed');
    fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ pid: 3 }));
    fs.writeFileSync(path.join(dir, '4.abc.key'), JSON.stringify({ pid: 4, sessionId: 'K' }));
    assert.deepStrictEqual(readSessionRegistry(home), new Map([['S', ['1']]]));
  })) p++; else f++;

  if (test('16: parentLiveOf — true on either proof, false only when every source answered, else null', () => {
    const reg = new Map([['S', ['42']]]);
    const cases: [string, ProcProbe | null, Map<string, string[]> | null, boolean | null][] = [
      ['argv names it', probe(['S'], ['7']), new Map(), true],
      ['registry pid is live (terminal session)', probe([], ['42']), reg, true],
      ['registry pid is dead', probe([], ['7']), reg, false],
      ['no registry entry', probe([], ['7']), new Map(), false],
      ['probe null', null, reg, null],
      ['liveSessionIds null', probe(null, ['7']), reg, null],
      ['claudePids null', probe([], null), reg, null],
      ['registry null, argv empty', probe([], ['7']), null, null],
      ['registry null, argv names it', probe(['S'], ['7']), null, true]
    ];
    for (const [label, pr, registry, want] of cases) assert.strictEqual(parentLiveOf('S', pr, registry), want, label);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
