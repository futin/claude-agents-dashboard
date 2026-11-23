/** Run only the named test modules (`tsx test/run-some.ts test/a.test.ts …`) and exit nonzero if any fail — `scripts/ci-scope.ts`'s docs-only run. */
// Must stay the first import, as in run-all.ts: it repoints os.tmpdir() before any test module evaluates (tmp-root.ts).
import './tmp-root.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runSuites, type SuiteModule } from './suites.js';

// runSuites, not a bare `failed += await mod.run()`: a run() returning no count would turn the total NaN, and `NaN > 0` reads as ALL PASS.
const suites: { file: string; mod: SuiteModule }[] = [];
for (const file of process.argv.slice(2)) suites.push({ file, mod: await import(pathToFileURL(path.resolve(file)).href) as SuiteModule });

const failed = await runSuites(suites);

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
