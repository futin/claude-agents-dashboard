/**
 * gen-plugin-lib.ts — write plugin/lib/*.mjs from the TypeScript sources in LIB_MODULES.
 *
 *   pnpm plugin:gen
 *
 * The routine wrapper and `/kaizen` run outside the server and the client, under plain `node` from the installed plugin, which has no package.json: a `.js`
 * would load as CommonJS on the Node 20 this repo allows and die before its first log line, hence `.mjs` and the specifier rewrite. The output is only what
 * `transpileModule` prints; `test/guards/plugin-manifest.test.ts` repeats the transpile over this same list and compares, so a source edit without a regen
 * fails CI. A source may import only `node:` builtins, types, and other sources in the list — the guard checks that too, because a sibling the list does not
 * generate would be a missing file on a user's machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** One generated module: `source` is repo-relative TypeScript, `out` the file name under plugin/lib/. */
export interface LibModule { source: string; out: string }

export const LIB_MODULES: readonly LibModule[] = [
  { source: 'shared/cron.ts', out: 'cron.mjs' },
  { source: 'shared/frontmatter.ts', out: 'frontmatter.mjs' },
  { source: 'shared/routine-file.ts', out: 'routine-file.mjs' },
  { source: 'server/lib/agents.ts', out: 'agents.mjs' },
  { source: 'server/lib/subagent-usage.ts', out: 'subagent-usage.mjs' },
  { source: 'server/lib/usage-line.ts', out: 'usage-line.mjs' }
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What `pnpm plugin:gen` writes for one TypeScript source: the transpile, with every `./x.js` sibling specifier rewritten to `./x.mjs`. */
export function generate(sourceText: string): string {
  const { outputText } = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return outputText.replace(/(from\s+['"]\.\/[\w-]+)\.js(['"])/g, '$1.mjs$2');
}

export function main(): void {
  const outDir = path.join(REPO_ROOT, 'plugin', 'lib');
  fs.mkdirSync(outDir, { recursive: true });
  for (const m of LIB_MODULES) {
    fs.writeFileSync(path.join(outDir, m.out), generate(fs.readFileSync(path.join(REPO_ROOT, m.source), 'utf8')));
    console.log(`plugin/lib/${m.out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
