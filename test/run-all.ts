/** Run every test module and exit nonzero if any fail. The modules are found on disk (`listSuites`, `test/suites.ts`): a `*.test.ts` in a feature folder is
 * a suite by existing, with no line to add here. */
// Must stay the first import: it repoints os.tmpdir() before any test module evaluates, and removes every fixture at exit (tmp-root.ts).
import './tmp-root.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listSuites } from './suites.js';

type Suite = { run?: unknown };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = listSuites(ROOT);

// Every module is imported before the first run(), as the static imports this list replaced did: a suite's top level never sees another suite's run.
const mods: Suite[] = [];
for (const file of files) mods.push(await import(pathToFileURL(path.join(ROOT, file)).href) as Suite);

let failed = 0;
for (const [i, mod] of mods.entries()) {
  if (typeof mod.run !== 'function') {
    console.log(`\n  ✗ ${files[i]} exports no run()`);
    failed += 1;
    continue;
  }
  failed += await (mod.run as () => number | Promise<number>)();
}

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
