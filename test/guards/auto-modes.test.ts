/**
 * The auto-ish permission modes are written twice, on purpose: `AUTO_MODES` in `server/lib/notify.ts` decides which sessions get a push, and the default
 * `MODES` list in `scripts/remote-decision-hook.sh` decides which sessions get the REMOTE DECISION banner. One is TypeScript and one is bash, so they are
 * not shared — and nothing kept the two hand copies equal until this guard (backlog #599). A mode added to one side only would push a session the banner
 * never armed, or arm one the push never reaches.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTO_MODES } from '../../server/lib/notify.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The words of the hook's default list — the fallback in `MODES="${CLAUDE_DASHBOARD_DECISION_MODES:-…}"` — or null when that line is gone. */
export function hookDefaultModes(src: string): string[] | null {
  const m = src.match(/^MODES="\$\{CLAUDE_DASHBOARD_DECISION_MODES:-([^}"]*)\}"/m);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : null;
}

export function run(): number {
  console.log('\n=== AUTO_MODES matches the remote-decision hook default ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  r(test('the parser reads the fallback words and nothing else', () => {
    assert.deepStrictEqual(hookDefaultModes('x=1\nMODES="${CLAUDE_DASHBOARD_DECISION_MODES:-a  b c}"\n'), ['a', 'b', 'c']);
    assert.strictEqual(hookDefaultModes('MODES="$OTHER"\n'), null);
  }));

  r(test('scripts/remote-decision-hook.sh defaults to exactly AUTO_MODES', () => {
    const modes = hookDefaultModes(fs.readFileSync(path.join(ROOT, 'scripts', 'remote-decision-hook.sh'), 'utf8'));
    assert.ok(modes, 'no MODES="${CLAUDE_DASHBOARD_DECISION_MODES:-…}" line in the hook');
    assert.deepStrictEqual([...modes].sort(), [...AUTO_MODES].sort());
    assert.strictEqual(new Set(modes).size, modes.length, `duplicate mode in the hook list: ${modes.join(' ')}`);
  }));

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
