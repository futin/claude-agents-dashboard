/** The one list of what `pnpm test` runs, and the loop that runs it: every `test/**\/*.test.ts` under a root, found on disk rather than spelled by hand, so a suite is registered by
 * existing. `test/run-all.ts` runs it and `scripts/ci-scope.ts` selects from it. `test/visual/` is Playwright's and is left out by folder, not by suffix, so
 * a future `*.test.ts` there never lands in the node-assert run. */
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['visual']);

/** Repo-relative paths with `/` separators, sorted by plain string compare. Node built-ins only: a recursive readdir, no glob. */
export function listSuites(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, top: boolean): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!(top && SKIP_DIRS.has(entry.name))) walk(child, false);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        out.push(child);
      }
    }
  };
  walk('test', true);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A module a suite file evaluated to; only its `run` export is read. */
export interface SuiteModule { run?: unknown }

/**
 * Run each module's `run()` in order and return the total failure count. A missing `run` export counts one failure, and so does a `run()` whose (awaited)
 * result is not a non-negative integer: with the hand-written imports gone, nothing typechecks that return any more, and one `undefined` added to the total
 * would turn it NaN, which `NaN > 0` reads as a pass for the whole run.
 */
export async function runSuites(suites: readonly { file: string; mod: SuiteModule }[]): Promise<number> {
  let failed = 0;
  for (const { file, mod } of suites) {
    if (typeof mod.run !== 'function') {
      console.log(`\n  ✗ ${file} exports no run()`);
      failed += 1;
      continue;
    }
    const n: unknown = await (mod.run as () => unknown)();
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
      failed += n;
    } else {
      console.log(`\n  ✗ ${file} run() returned ${typeof n === 'number' ? n : typeof n}, not a failure count`);
      failed += 1;
    }
  }
  return failed;
}
