import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePrTitle, readSessionPr, resetPrDetectCache } from '../server/lib/pr-detect.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-pr-detect-'));
let fileSeq = 0;
let useSeq = 0;

/** A fresh transcript holding `body`, with the cache reset so every case starts cold. */
function transcript(body: string): string {
  resetPrDetectCache();
  const file = path.join(dir, `t${++fileSeq}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

const line = (rec: unknown): string => JSON.stringify(rec) + '\n';
const CWD = '/Users/me/repo';
const REPO = 'https://github.com/futin/claude-agents-dashboard';

/** An assistant record holding one tool_use, stamped with the record-level cwd Claude Code writes. */
function call(name: string, useId: string, input: Record<string, unknown>, cwd = CWD): string {
  return line({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] } });
}

/** A user record answering `useId`, shaped as a real Bash result on this machine (2026-10-25); `toolUseResult` omitted when undefined. */
function result(useId: string, text: string, opts: { gitOperation?: unknown; isError?: boolean; blocks?: boolean } = {}): string {
  const content = opts.blocks ? [{ type: 'text', text }] : text;
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: useId, content, is_error: opts.isError === true };
  const tur: Record<string, unknown> = { stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  if (opts.gitOperation !== undefined) tur.gitOperation = opts.gitOperation;
  return line({ type: 'user', cwd: CWD, message: { role: 'user', content: [block] }, toolUseResult: tur });
}

/** One Bash call plus its result. */
function bash(command: string, text: string, opts: { gitOperation?: unknown; isError?: boolean; blocks?: boolean; cwd?: string } = {}): string {
  const useId = 'toolu_bash_' + ++useSeq;
  return call('Bash', useId, { command, description: 'x' }, opts.cwd) + result(useId, text, opts);
}

/** The real push-then-create output: git's `pull/new/<branch>` hint, then the created PR's URL. */
const pushOutput = (url: string): string =>
  `remote: Create a pull request for 'fix/x' on GitHub by visiting:        \nremote:      ${REPO}/pull/new/fix/x        \nremote: \n${url}`;

const created = (n: number, url = `${REPO}/pull/${n}`) => ({ pr: { number: n, url, action: 'created' } });

export function run(): number {
  console.log('\n=== pr-detect ===\n');
  let p = 0, f = 0;

  if (test('D1. a gitOperation create is the PR, with its title and record cwd', () => {
    const file = transcript(bash(`git push -u origin fix/x && gh pr create --title "Fix: a" --body x`, pushOutput(`${REPO}/pull/57`),
      { gitOperation: created(57), cwd: '/wt/x' }));
    assert.deepStrictEqual(readSessionPr(file), { url: `${REPO}/pull/57`, number: 57, title: 'Fix: a', cwd: '/wt/x' });
  })) p++; else f++;

  if (test('D2. the newest create wins across both signals, in transcript order', () => {
    const a = transcript(bash('gh pr create --fill', `${REPO}/pull/57`, { gitOperation: created(57) }) + bash('gh pr create --fill', `${REPO}/pull/58`));
    assert.strictEqual(readSessionPr(a)?.number, 58);
    const b = transcript(bash('gh pr create --fill', `${REPO}/pull/58`) + bash('gh pr create --fill', `${REPO}/pull/59`, { gitOperation: created(59) }));
    assert.strictEqual(readSessionPr(b)?.number, 59);
  })) p++; else f++;

  if (test('D3. a call with a gitOperation record ignores the URLs in its own text', () => {
    const file = transcript(bash('gh pr create --fill', `${REPO}/pull/99`, { gitOperation: created(57) }));
    assert.strictEqual(readSessionPr(file)?.url, `${REPO}/pull/57`);
  })) p++; else f++;

  if (test('D4. the parse finds the URL in compound commands, never the pull/new hint', () => {
    const heredoc = `cat > /tmp/b <<'EOF'\nbody\nEOF\ngh pr create --title "x" --body-file /tmp/b`;
    const a = transcript(bash(heredoc, pushOutput('https://github.com/o/r/pull/12')));
    assert.deepStrictEqual(readSessionPr(a), { url: 'https://github.com/o/r/pull/12', number: 12, title: 'x', cwd: CWD });
    const b = transcript(bash('git push && gh pr create --fill | tail -3', 'Warning: 1 uncommitted change\nhttps://github.com/o/r/pull/13', { blocks: true }));
    assert.strictEqual(readSessionPr(b)?.number, 13);
    const c = transcript(bash('cd x && gh pr create -R other/repo --fill', 'https://github.com/other/repo/pull/5'));
    assert.strictEqual(readSessionPr(c)?.url, 'https://github.com/other/repo/pull/5');
    const d = transcript(bash('git push && gh pr create --fill', pushOutput('a pull request already exists')));
    assert.strictEqual(readSessionPr(d), null);
  })) p++; else f++;

  if (test('D5. two PR URLs in one result: the last one', () => {
    const file = transcript(bash('gh pr create --fill', 'see https://github.com/o/r/pull/3\nhttps://github.com/o/r/pull/4\n'));
    assert.strictEqual(readSessionPr(file)?.number, 4);
  })) p++; else f++;

  if (test('D6. a failed create contributes nothing', () => {
    const a = transcript(bash('gh pr create --fill', 'Exit code 1\nhttps://github.com/o/r/pull/4', { isError: true }));
    assert.strictEqual(readSessionPr(a), null);
    const b = transcript(bash('gh pr create --fill', 'pull request create failed: GraphQL: No commits between main and x'));
    assert.strictEqual(readSessionPr(b), null);
  })) p++; else f++;

  if (test('D7. gh pr view of another PR is not a create', () => {
    const file = transcript(bash('gh pr view 123', 'title: x\nurl: https://github.com/o/r/pull/123'));
    assert.strictEqual(readSessionPr(file), null);
  })) p++; else f++;

  if (test('D8. a pr-link record never counts', () => {
    const file = transcript(line({ type: 'pr-link', prNumber: 3, prUrl: 'https://github.com/o/r/pull/3', prRepository: 'o/r' }));
    assert.strictEqual(readSessionPr(file), null);
  })) p++; else f++;

  if (test('D9. a URL only in assistant text or a user prompt never counts', () => {
    const file = transcript(
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/8 via gh pr create' }] } }) +
      line({ type: 'user', message: { role: 'user', content: 'gh pr create gave https://github.com/o/r/pull/9' } }));
    assert.strictEqual(readSessionPr(file), null);
  })) p++; else f++;

  if (test('D10. a gitOperation pr that is not a create decides alone: nothing, and no parse', () => {
    const file = transcript(bash('gh pr create --fill', 'https://github.com/o/r/pull/10', { gitOperation: { pr: { number: 10, url: 'https://github.com/o/r/pull/10', action: 'merged' } } }));
    assert.strictEqual(readSessionPr(file), null);
  })) p++; else f++;

  if (test('D11. a gitOperation create on another host is kept as is', () => {
    const url = 'https://ghe.example.com/o/r/pull/4';
    const file = transcript(bash('gh pr create --fill', url, { gitOperation: created(4, url) }));
    assert.deepStrictEqual(readSessionPr(file), { url, number: 4, title: null, cwd: CWD });
  })) p++; else f++;

  if (test('D12. parsePrTitle reads the six in-scope forms and nothing else', () => {
    assert.strictEqual(parsePrTitle('gh pr create --title "Fix: a" --body x'), 'Fix: a');
    assert.strictEqual(parsePrTitle(`gh pr create --title 'b c'`), 'b c');
    assert.strictEqual(parsePrTitle('gh pr create --title=d --fill'), 'd');
    assert.strictEqual(parsePrTitle('gh pr create --title="e f"'), 'e f');
    assert.strictEqual(parsePrTitle('gh pr create -t "g" -b x'), 'g');
    assert.strictEqual(parsePrTitle(`gh pr create -t 'h i'`), 'h i');
    assert.strictEqual(parsePrTitle('gh pr create -t=j'), 'j');
    assert.strictEqual(parsePrTitle(`gh pr create --title "$(cat <<'EOF'\nfeat: x\nEOF\n)"`), null);
    assert.strictEqual(parsePrTitle('gh pr create --fill'), null);
  })) p++; else f++;

  if (test('D13. an append is folded without a reset; a replaced file is re-read from the start', () => {
    const file = transcript(bash('git status', 'clean'));
    assert.strictEqual(readSessionPr(file), null);
    fs.appendFileSync(file, bash('gh pr create --fill', `${REPO}/pull/60`, { gitOperation: created(60) }));
    assert.strictEqual(readSessionPr(file)?.number, 60);
    fs.writeFileSync(file, bash('gh pr create --fill', 'https://github.com/o/r/pull/2'));
    assert.strictEqual(readSessionPr(file)?.number, 2);
  })) p++; else f++;

  if (test('D14. a missing file is null; an unreadable one throws', () => {
    resetPrDetectCache();
    assert.strictEqual(readSessionPr(path.join(dir, 'nope.jsonl')), null);
    if (process.getuid?.() === 0) return; // root reads mode 000
    const file = transcript(bash('gh pr create --fill', `${REPO}/pull/61`, { gitOperation: created(61) }));
    fs.chmodSync(file, 0);
    try { assert.throws(() => readSessionPr(file)); } finally { fs.chmodSync(file, 0o644); }
  })) p++; else f++;

  if (test('D15. a last line still being written is not folded until its newline lands', () => {
    const whole = bash('gh pr create --fill', `${REPO}/pull/62`, { gitOperation: created(62) });
    const file = transcript(whole.slice(0, -1));
    assert.strictEqual(readSessionPr(file), null);
    fs.appendFileSync(file, '\n');
    assert.strictEqual(readSessionPr(file)?.number, 62);
  })) p++; else f++;

  if (test('D16. a malformed line is skipped and the create after it still counts', () => {
    const file = transcript(bash('git status', 'clean') + '{"type":"user", broken\n' + bash('gh pr create --fill', `${REPO}/pull/63`, { gitOperation: created(63) }));
    assert.strictEqual(readSessionPr(file)?.number, 63);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
