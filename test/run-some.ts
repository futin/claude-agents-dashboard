/** Run only the named test modules (`tsx test/run-some.ts test/a.test.ts …`) and exit nonzero if any fail — `scripts/ci-scope.ts`'s docs-only run. */
// Must stay the first import, as in run-all.ts: it repoints os.tmpdir() before any test module evaluates (tmp-root.ts).
import './tmp-root.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
for (const file of process.argv.slice(2)) {
  const mod = await import(pathToFileURL(path.resolve(file)).href) as { run: () => number | Promise<number> };
  failed += await mod.run();
}

console.log(failed > 0 ? `FAILED (${failed})` : 'ALL PASS');
process.exit(failed > 0 ? 1 : 0);
