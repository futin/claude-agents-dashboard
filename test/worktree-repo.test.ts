import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearRepoNameMemo, repoNameFor } from '../server/lib/worktree-repo.js';

function test(name: string, fn: () => void): boolean {
  try { clearRepoNameMemo(); fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A tmp folder holding `<repo>/.git/` and a worktree dir elsewhere whose `.git` file says `gitdir: <gitdir>`. */
function layout(gitdirFor: (repoGit: string, wt: string) => string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wtrepo-'));
  const repoGit = path.join(base, 'my-repo', '.git');
  fs.mkdirSync(path.join(repoGit, 'worktrees', 'zen'), { recursive: true });
  const wt = path.join(base, 'elsewhere', 'zen');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdirFor(repoGit, wt)}\n`);
  return wt;
}

export function run(): number {
  console.log('\n=== worktree-repo.ts ===\n');
  let p = 0, f = 0;

  if (test('a .git file with an absolute gitdir names the main checkout', () => {
    const wt = layout(repoGit => path.join(repoGit, 'worktrees', 'zen'));
    assert.strictEqual(repoNameFor(wt), 'my-repo');
  })) p++; else f++;

  if (test('a .git file with a relative gitdir resolves against the worktree', () => {
    const wt = layout((repoGit, w) => path.relative(w, path.join(repoGit, 'worktrees', 'zen')));
    assert.strictEqual(repoNameFor(wt), 'my-repo');
  })) p++; else f++;

  if (test('the .git file wins over the path shape', () => {
    // A worktree that lives under a .claude/worktrees folder of a *different* repo still names its own.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wtrepo-'));
    const repoGit = path.join(base, 'real-repo', '.git');
    fs.mkdirSync(path.join(repoGit, 'worktrees', 'x'), { recursive: true });
    const wt = path.join(base, 'decoy', '.claude', 'worktrees', 'x');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repoGit, 'worktrees', 'x')}\n`);
    assert.strictEqual(repoNameFor(wt), 'real-repo');
  })) p++; else f++;

  if (test('a main checkout (.git is a directory) is null', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wtrepo-'));
    fs.mkdirSync(path.join(base, 'main-repo', '.git'), { recursive: true });
    assert.strictEqual(repoNameFor(path.join(base, 'main-repo')), null);
  })) p++; else f++;

  if (test('a submodule gitdir is not a worktree', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wtrepo-'));
    const sub = path.join(base, 'parent', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.strictEqual(repoNameFor(sub), null);
  })) p++; else f++;

  if (test('a deleted .claude/worktrees/<name> falls back to the path shape', () => {
    assert.strictEqual(repoNameFor('/nowhere/backlog-manager/.claude/worktrees/zen-joliot-19719c'), 'backlog-manager');
  })) p++; else f++;

  if (test('a deleted .worktrees/<n> falls back to the path shape', () => {
    assert.strictEqual(repoNameFor('/nowhere/backlog-manager/.worktrees/18'), 'backlog-manager');
  })) p++; else f++;

  if (test('a path that only passes through a worktrees folder is not one', () => {
    assert.strictEqual(repoNameFor('/nowhere/repo/.claude/worktrees/x/packages/api'), null);
  })) p++; else f++;

  if (test('a plain folder outside git, and no path, are null', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-wtrepo-'));
    assert.strictEqual(repoNameFor(base), null);
    assert.strictEqual(repoNameFor(null), null);
  })) p++; else f++;

  console.log(`\nworktree-repo: ${p} passed, ${f} failed`);
  return f;
}
