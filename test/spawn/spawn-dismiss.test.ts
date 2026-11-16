/**
 * Guards the launch panel's keep-open rule (#434): the scrim, Escape and Back refuse while a launch is pending OR a typed prompt would be lost; ✕ refuses
 * only mid-launch, the request's own guard (`docs/subsystems/spawn.md`). Source assertions, because this suite has no DOM.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Nearest ancestor of `from` that holds a `package.json`. */
function findRepoRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${from}`);
    dir = parent;
  }
}

const SRC = fs.readFileSync(path.join(findRepoRoot(path.dirname(fileURLToPath(import.meta.url))), 'client', 'src', 'components', 'SpawnPanel.tsx'), 'utf8');

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('the stray exits refuse on a pending launch or a typed prompt', () => {
    assert.match(SRC, /const keepOpen = pending \|\| prompt\.trim\(\) !== '';/);
    assert.match(SRC, /function strayClose\(\): void \{\s*if \(!keepOpen\) onClose\(\);\s*\}/);
    assert.match(SRC, /<div className="spawn-back" onClick=\{strayClose\}>/);
    assert.match(SRC, /e\.key === 'Escape' && !keepOpen\) onClose\(\)/);
  });

  t('a refused Back re-arms, since it spent the history entry', () => {
    assert.match(SRC, /useBackClose\(\(\) => \{ if \(keepOpen\) setBackGen\(g => g \+ 1\); else onClose\(\); \}, backGen\)/);
    assert.ok(!/useBackClose\(close\)/.test(SRC), 'Back goes through close(), which never re-arms');
  });

  t('✕ still refuses only mid-launch', () => {
    assert.match(SRC, /function close\(\): void \{\s*if \(!pending\) onClose\(\);\s*\}/);
    assert.match(SRC, /className="chat-x" onClick=\{close\} disabled=\{pending\}/);
  });

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
