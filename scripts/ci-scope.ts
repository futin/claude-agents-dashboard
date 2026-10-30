/**
 * ci-scope.ts — CI's one check command (`.github/workflows/ci.yml`, docs/workflows/ci.md §Scoped checks).
 *
 *   pnpm exec tsx scripts/ci-scope.ts [--dry-run] [--files <paths…>]
 *
 * Reads which files the PR changes and runs only what those files can break: a docs-only PR runs the few suites whose code names a changed doc, anything
 * else runs `pnpm typecheck`, `pnpm build` and `pnpm test` exactly as before. Ported from backlog-manager's `scripts/ci-scope.mjs` (its #359), minus the
 * skills scope — the git-sync suite already has its own path-gated `ci / skills` job here.
 *
 * The decision is taken INSIDE the `checks` job, never by skipping it: release-kit's ci-node.yml says a skipped job reports success for the same head sha,
 * so a title edit after a red run would turn the PR green. The scope is a function of the PR's diff alone, so the `edited` re-run reaches the same verdict.
 *
 * Every doubt resolves to the full run: a push to main (the post-merge backstop), a missing or odd merge commit, a failed fetch, an empty diff, and any path
 * that is not a doc. Drift in this file therefore costs CI time, never a false green. Local `pnpm test` is untouched. `--dry-run` prints the plan without
 * running it and `--files` replaces the PR diff: `pnpm exec tsx scripts/ci-scope.ts --dry-run --files docs/overview.md`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Scope = 'docs' | 'full';
export interface Suite { file: string; source: string }
export interface Step { label: string; cmd: string; args: string[] }

// Checked first, and they win over the extension: these change how the suites run (run-all.ts, run-some.ts, this file, the workflow), so no subset of the
// suites can vouch for them. `.github/pull_request_template.md` is a .md file and still lands here.
const FULL_PREFIXES = ['scripts/', 'test/', '.github/'];

export function classify(file: string): Scope {
  if (FULL_PREFIXES.some(p => file.startsWith(p))) return 'full';
  return file.startsWith('docs/') || file.endsWith('.md') ? 'docs' : 'full';
}

/** The widest scope of the change's files. No list (not a PR, or the diff could not be read) and an empty one are both `full` — an empty diff is a sign
 * the diff was read wrong, not a reason to run nothing. */
export function scopeOf(files: string[] | null): Scope {
  if (!files || files.length === 0) return 'full';
  return files.some(f => classify(f) === 'full') ? 'full' : 'docs';
}

/** The names a suite could reach a changed file by: `rooted` paths from the repo root — the top-level directory (`docs`, what `docs-links.test.ts` walks
 * from), the parent directory and the file itself — the basename, and the parent directory's own name (what a `path.join(root, 'plugin', 'skills')` spells).
 * backlog-manager leaves the top-level directory out because there `docs` selected one huge suite; here `docs-links` is the guard a docs PR most needs. */
export function pathTokens(file: string): { rooted: string[]; base: string; parent: string | null } {
  const parts = file.split('/');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return {
    rooted: [...new Set([prefixes[0], ...prefixes.slice(-2)])],
    base: parts[parts.length - 1],
    parent: parts.length > 1 ? parts[parts.length - 2] : null,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a suite's source names a changed file as a path piece. A rooted token must START at a quote or `../` and the parent name at a quote; the
 * basename may also follow a slash, as in `'../../SKILL.md'`. All must END at a quote or a slash, so `mydocs` and `docsy` do not count. Comment lines are
 * dropped first, so a header citing a doc reads nothing. A heuristic, deliberately generous: a suite picked wrongly costs seconds, and one missed — a suite
 * that reaches a doc through a helper or a computed path — is caught by the push run on main. */
export function mentions(source: string, files: string[]): boolean {
  const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const end = '(?=[\'"`/])';
  return files.some(file => {
    const { rooted, base, parent } = pathTokens(file);
    return rooted.some(t => new RegExp(`(['"\`]|\\.\\./)${escape(t)}${end}`).test(code))
      || new RegExp(`['"\`/]${escape(base)}${end}`).test(code)
      || (parent !== null && new RegExp(`['"\`]${escape(parent)}${end}`).test(code));
  });
}

export function selectSuites(changed: string[], suites: Suite[]): string[] {
  return suites.filter(s => mentions(s.source, changed)).map(s => s.file);
}

/** The commands to run. `full` is the three checks the workflow used to list; `docs` runs the selected `run-all.ts` modules through `test/run-some.ts`
 * and the selected kaizen suites through `node --test`, and possibly nothing at all. */
export function makePlan(files: string[] | null, suites: { tsx: Suite[]; node: Suite[] }): { scope: Scope; steps: Step[] } {
  const scope = scopeOf(files);
  if (scope === 'full') {
    return { scope, steps: ['typecheck', 'build', 'test'].map(s => ({ label: `pnpm ${s}`, cmd: 'pnpm', args: [s] })) };
  }
  const steps: Step[] = [];
  const tsxFiles = selectSuites(files!, suites.tsx);
  if (tsxFiles.length > 0) steps.push({ label: `run-some (${tsxFiles.length} suites)`, cmd: 'pnpm', args: ['exec', 'tsx', 'test/run-some.ts', ...tsxFiles] });
  const nodeFiles = selectSuites(files!, suites.node);
  if (nodeFiles.length > 0) steps.push({ label: `node --test (${nodeFiles.length} suites)`, cmd: 'node', args: ['--test', ...nodeFiles] });
  return { scope, steps };
}

/** The modules `test/run-all.ts` imports — the one list of what `pnpm test` runs, read rather than spelled again here, so a suite added there is
 * selectable at once and a helper like `api-harness.ts` never is. */
export function tsxSuitePaths(root = REPO_ROOT): string[] {
  const src = fs.readFileSync(path.join(root, 'test', 'run-all.ts'), 'utf8');
  return [...src.matchAll(/^import \{ run as \w+ \} from '\.\/([\w./-]+)\.js';/gm)].map(m => `test/${m[1]}.ts`).sort();
}

/** The `node --test` suites `pnpm test` runs, expanded from its own glob in package.json. Only `*` segments occur in it, so a readdir per segment is the
 * whole glob. */
export function nodeSuitePaths(root = REPO_ROOT): string[] {
  const script: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
  // A match, not a split on whitespace: the glob is followed by `;` in that script.
  const patterns = script.match(/[^\s;]+\.test\.mjs/g) ?? [];
  const expand = (dir: string, segments: string[]): string[] => {
    if (segments.length === 0) return [dir];
    const [head, ...rest] = segments;
    if (!head.includes('*')) return expand(dir ? `${dir}/${head}` : head, rest);
    const re = new RegExp(`^${head.split('*').map(escape).join('.*')}$`);
    let names: string[];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { return []; }
    return names.filter(n => re.test(n)).flatMap(n => expand(dir ? `${dir}/${n}` : n, rest));
  };
  return patterns.flatMap(p => expand('', p.split('/'))).sort();
}

export function readSuites(root = REPO_ROOT): { tsx: Suite[]; node: Suite[] } {
  const read = (file: string): Suite => ({ file, source: fs.readFileSync(path.join(root, file), 'utf8') });
  return { tsx: tsxSuitePaths(root).map(read), node: nodeSuitePaths(root).map(read) };
}

type Git = (args: string[]) => string;
const realGit: Git = args => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The PR's changed files, or `files: null` for every case that must run in full. A pull_request checkout is the merge ref at depth 1, so HEAD is the merge
 * commit and its first parent is the base tip it was merged onto: diffing the two is exactly what the merge would change on main. The shallow clone hides
 * parents from rev-list, but the raw commit object still names them, and fetching that one parent is all the diff needs. `--no-renames` matters: with rename
 * detection a file moved from server/ to docs/ would list only its new, docs-looking path. */
export function prFiles(git: Git = realGit, event = process.env.GITHUB_EVENT_NAME): { files: string[] | null; why: string } {
  if (event !== 'pull_request') return { files: null, why: 'not a pull request — the full suite always runs' };
  try {
    const parents = git(['cat-file', '-p', 'HEAD']).split('\n').filter(l => l.startsWith('parent ')).map(l => l.slice('parent '.length).trim());
    if (parents.length !== 2) return { files: null, why: `HEAD has ${parents.length} parent(s), not a PR merge commit` };
    git(['fetch', '--no-tags', '--depth=1', 'origin', parents[0]]);
    const files = git(['diff', '--name-only', '--no-renames', parents[0], 'HEAD']).split('\n').map(l => l.trim()).filter(Boolean);
    return { files, why: `${files.length} changed file(s)` };
  } catch (error) {
    return { files: null, why: `could not read the PR diff (${String((error as Error).message).split('\n')[0]})` };
  }
}

function main(argv: string[]): number {
  const dryRun = argv.includes('--dry-run');
  const at = argv.indexOf('--files');
  const { files, why } = at >= 0 ? { files: argv.slice(at + 1), why: 'files given by hand' } : prFiles();
  const { scope, steps } = makePlan(files, readSuites());

  const summary = scope === 'full'
    ? `full — ${why}`
    : `docs-only — ${why}; running ${steps.map(s => s.label).join(' + ') || 'nothing (no suite reads these files)'}; typecheck and build skipped`;
  console.log(`ci-scope: ${summary}`);
  if (files && scope !== 'full') for (const f of files) console.log(`  ${f}`);
  // An annotation, so the scope is on the run's summary page and nobody has to open the log to learn a PR was not given the full suite.
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=ci scope::${summary}`);

  if (dryRun) {
    for (const s of steps) console.log(`would run: ${s.cmd} ${s.args.join(' ')}`);
    return 0;
  }
  for (const s of steps) {
    console.log(`\n▶ ${s.label}`);
    const run = spawnSync(s.cmd, s.args, { cwd: REPO_ROOT, stdio: 'inherit' });
    if (run.error || run.status !== 0) {
      console.log(`::error::check failed: ${s.label}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
