/** The one list of what `pnpm test` runs: every `test/**\/*.test.ts` under a root, found on disk rather than spelled by hand, so a suite is registered by
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
