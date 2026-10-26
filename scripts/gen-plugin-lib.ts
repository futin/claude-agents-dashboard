/**
 * gen-plugin-lib.ts — write plugin/lib/{cron,frontmatter,routine-file}.mjs from the shared/ TypeScript.
 *
 *   pnpm plugin:gen
 *
 * The routine wrapper runs outside the server and the client, under plain `node` from the installed plugin, which has no package.json: a `.js` would load as
 * CommonJS on the Node 20 this repo allows and die before its first log line, hence `.mjs` and the specifier rewrite. The output is only what
 * `transpileModule` prints; `test/plugin-manifest.test.ts` repeats the transpile and compares, so a shared/ edit without a regen fails CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const LIB_MODULES = ['cron', 'frontmatter', 'routine-file'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function main(): void {
  const outDir = path.join(REPO_ROOT, 'plugin', 'lib');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of LIB_MODULES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'shared', `${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    fs.writeFileSync(path.join(outDir, `${name}.mjs`), outputText.replace(/(from\s+['"]\.\/[\w-]+)\.js(['"])/g, '$1.mjs$2'));
    console.log(`plugin/lib/${name}.mjs`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
