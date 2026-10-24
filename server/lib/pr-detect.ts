/**
 * pr-detect.ts — the newest pull request a session created, folded out of its transcript for the chat modal's PR card.
 *
 * Two signals, newest in transcript order wins:
 *   1. Claude Code's own `toolUseResult.gitOperation.pr` on a Bash result, `action: "created"`. Undocumented, so it can change between versions; when a
 *      result carries one, it alone decides that call.
 *   2. Fallback: a Bash call whose command contains `gh pr create`, did not fail, and whose result text holds a github.com PR URL (the last one).
 * Never the top-level `pr-link` record: Claude Code writes it for any PR URL seen in output, and on this machine (2026-10-24) it marked 11 PRs that
 * sessions did not create. Subagent files are not read — only the parent transcript the caller hands in.
 *
 * Same incremental fold as `tasks.ts`: the file is read once, the offset reached is remembered, and later polls read only what was appended.
 * Unlike `readSessionTasks`, an I/O error other than a missing file throws, because the one caller is the `/pr` endpoint and it answers 500.
 *
 * Design: docs/superpowers/specs/2026-10-24-chat-pr-card-design.md §How a PR is found.
 */

import fs from 'node:fs';

import { CHUNK_BYTES } from './tasks.js';

const MAX_ENTRIES = 64;
const CREATE_CMD = 'gh pr create';
const GIT_OP = '"gitOperation"';
const MARKERS = [Buffer.from(CREATE_CMD), Buffer.from(GIT_OP)];

/** A github.com PR URL; the lookahead keeps `…/pull/new/<branch>` (git push's hint) and `…/pull/12abc` out. */
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)(?![\w/])/g;

/** `--title` / `-t`, then `=` or spaces, then a double-quoted, single-quoted or bare value. */
const TITLE_RE = /(?:^|\s)(?:--title|-t)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']\S*))/;

export interface DetectedPr {
  url: string;
  number: number;
  title: string | null;
  /** The shell cwd Claude Code stamped on the call's record; null when absent. */
  cwd: string | null;
}

interface PendingCreate {
  command: string;
  cwd: string | null;
}

interface Entry {
  offset: number;
  size: number;
  /** `gh pr create` calls whose result has not been seen yet, by tool_use id. */
  pending: Map<string, PendingCreate>;
  newest: DetectedPr | null;
}

const cache = new Map<string, Entry>();

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The PR title a `gh pr create` command line carries; null when it has none or it comes from a heredoc / command substitution. */
export function parsePrTitle(command: string): string | null {
  const m = TITLE_RE.exec(command);
  if (!m) return null;
  const value = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]);
  if (value === undefined || value === '' || value.startsWith('$(')) return null;
  return value;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function settle(entry: Entry, block: Record<string, any>, rec: Record<string, any>): void {
  const call = entry.pending.get(block.tool_use_id);
  if (call) entry.pending.delete(block.tool_use_id);
  const cwd = call ? call.cwd : nonEmpty(rec.cwd);
  const title = call ? parsePrTitle(call.command) : null;

  const op = isObject(rec.toolUseResult) && isObject(rec.toolUseResult.gitOperation) ? rec.toolUseResult.gitOperation.pr : undefined;
  if (isObject(op)) {
    if (op.action === 'created' && typeof op.number === 'number' && typeof op.url === 'string') {
      entry.newest = { url: op.url, number: op.number, title, cwd };
    }
    return;
  }
  if (!call || block.is_error === true) return;
  const urls = [...resultText(block.content).matchAll(PR_URL_RE)];
  const last = urls[urls.length - 1];
  if (last) entry.newest = { url: last[0], number: Number(last[1]), title, cwd };
}

function foldLine(entry: Entry, line: Buffer): void {
  // Most lines are neither a create nor its answer; skip them without decoding.
  let hit = MARKERS.some((m) => line.includes(m));
  if (!hit && entry.pending.size > 0) for (const id of entry.pending.keys()) if (line.includes(id)) { hit = true; break; }
  if (!hit) return;

  let rec: any;
  try { rec = JSON.parse(line.toString('utf8')); } catch { return; }
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return;

  // The substring hit is not trusted: the words also turn up in prose, so only the exact block shape counts.
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'tool_use' && block.name === 'Bash' && typeof block.id === 'string') {
      const command = isObject(block.input) && typeof block.input.command === 'string' ? block.input.command : '';
      if (command.includes(CREATE_CMD)) entry.pending.set(block.id, { command, cwd: nonEmpty(rec.cwd) });
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      settle(entry, block, rec);
    }
  }
}

/** Fold `[entry.offset, size)`; `entry.offset` advances past whole lines only, so an unterminated last line waits for the next call. */
function foldFrom(fd: number, entry: Entry, size: number): void {
  let pos = entry.offset;
  let carry: Buffer | null = null;
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - pos));
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    pos += n;

    const buf: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      foldLine(entry, buf.subarray(start, nl));
      start = nl + 1;
    }
    entry.offset += start;
    carry = start < buf.length ? buf.subarray(start) : null;
  }
}

/** The newest PR the session created; null when none or the file is gone. Throws on any other I/O error, keeping what was folded. */
export function readSessionPr(filePath: string): DetectedPr | null {
  let entry = cache.get(filePath);

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return null; }
    throw e;
  }

  if (entry && size < entry.size) { cache.delete(filePath); entry = undefined; }
  if (entry && size === entry.offset) return entry.newest;

  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(filePath); return null; }
    throw e;
  }

  if (!entry) {
    entry = { offset: 0, size: 0, pending: new Map(), newest: null };
    cache.set(filePath, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  try {
    foldFrom(fd, entry, size);
    entry.size = size;
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing left to do */ }
  }
  return entry.newest;
}

/** Test seam: forget every file. */
export function resetPrDetectCache(): void {
  cache.clear();
}
