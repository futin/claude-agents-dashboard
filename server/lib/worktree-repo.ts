/**
 * worktree-repo.ts — the repo a linked git worktree belongs to, for the Sessions table's Project column.
 *
 * A session launched inside a worktree has the worktree folder as its `project` (`zen-joliot-19719c`), which names nothing a reader recognises. Measured
 * 2026-10-19: 111 of the 181 dirs under `~/.claude/projects` are worktree sessions.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `<repo>/.claude/worktrees/<name>` (Claude Code) and `<repo>/.worktrees/<name>` (backlog-orchestrate). */
const WORKTREE_PATH_RE = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/[^/]+\/?$/;

const memo = new Map<string, string | null>();

/**
 * Basename of the main checkout when `projectPath` is a linked worktree, else null (a main checkout, a plain folder, or no path).
 *
 * The worktree's own `.git` file is authoritative: `gitdir: <common>/.git/worktrees/<name>`, absolute or relative to the worktree. Once the worktree is
 * removed that file is gone with it, and the path shape is the only evidence left — so a deleted worktree still shows its repo. Memoised per path: a
 * live session's launch dir does not change repo, and the scan asks every poll.
 */
export function repoNameFor(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const hit = memo.get(projectPath);
  if (hit !== undefined) return hit;
  const name = fromGitFile(projectPath) ?? fromPathShape(projectPath);
  memo.set(projectPath, name);
  return name;
}

function fromGitFile(dir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
  } catch {
    return null; // missing, or a directory (a main checkout — EISDIR)
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const gitdir = path.resolve(dir, m[1].trim());
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const at = gitdir.lastIndexOf(marker);
  if (at < 0) return null; // a submodule's `gitdir: ../.git/modules/x` — not a worktree
  return path.basename(gitdir.slice(0, at)) || null;
}

function fromPathShape(p: string): string | null {
  const m = WORKTREE_PATH_RE.exec(p);
  return m ? path.basename(m[1]) || null : null;
}

/** Tests only: forget every memoised answer. */
export function clearRepoNameMemo(): void {
  memo.clear();
}
