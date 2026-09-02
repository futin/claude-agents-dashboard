import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tr from '../server/lib/transcript.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function fixture(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tr-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, records.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return file;
}

export function run(): number {
  console.log('\n=== transcript.ts ===\n');
  let p = 0, f = 0;

  if (test('usageTokens sums input + cache read + cache create', () => {
    assert.strictEqual(tr.usageTokens({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } }), 105);
    assert.strictEqual(tr.usageTokens({ message: {} }), 0);
    assert.strictEqual(tr.usageTokens({}), 0);
  })) p++; else f++;

  if (test('resolveWindow: default 200k, sonnet/opus 1M, [1m] marker, env override, overflow', () => {
    assert.strictEqual(tr.resolveWindow(1000, 'claude-haiku-4-5-20251001', {}), 200000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-opus-4-8', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-sonnet-5', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-sonnet-5[1m]', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'x', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }), 400000);
    assert.strictEqual(tr.resolveWindow(250000, 'x', {}), 1000000);
  })) p++; else f++;

  if (test('windowLabel formats k / M', () => {
    assert.strictEqual(tr.windowLabel(200000), '200k');
    assert.strictEqual(tr.windowLabel(1000000), '1M');
  })) p++; else f++;

  if (test('describeTool per tool type', () => {
    assert.strictEqual(tr.describeTool({ name: 'Task', input: { subagent_type: 'Explore', description: 'find' } }), 'Explore: find');
    assert.strictEqual(tr.describeTool({ name: 'Bash', input: { description: 'run', command: 'x' } }), 'run');
    assert.strictEqual(tr.describeTool({ name: 'Edit', input: { file_path: '/a.js' } }), '/a.js');
    assert.strictEqual(tr.describeTool({ name: 'Grep', input: { pattern: 'foo' } }), 'foo');
  })) p++; else f++;

  if (test('readTranscript extracts tokens, model, activity, meta', () => {
    const file = fixture([
      { cwd: '/Users/me/proj', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user' },
      { message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, cache_read_input_tokens: 900 } } },
      { message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.js' } }] } }
    ]);
    const s = tr.readTranscript(file)!;
    assert.strictEqual(s.tokens, 1000);
    assert.strictEqual(s.model, 'claude-opus-4-8');
    assert.strictEqual(s.contextWindow, 1000000);
    assert.strictEqual(s.contextPct, 0.1);
    assert.strictEqual(s.activity!.tool, 'Edit');
    assert.strictEqual(s.activity!.detail, '/a/b.js');
    assert.strictEqual(s.cwd, '/Users/me/proj');
    assert.strictEqual(s.gitBranch, 'main');
    assert.strictEqual(s.version, '2.1.0');
    assert.strictEqual(s.sessionName, null);
    assert.strictEqual(s.entrypoint, null);   // no record carried one
  })) p++; else f++;

  if (test('readTranscript reports entrypoint off the newest record carrying one', () => {
    // Real transcripts stamp `entrypoint` on every user/assistant record, and
    // newest wins. That is not a tie-break detail: one transcript on this
    // machine runs `sdk-cli` → `claude-desktop` (a headless session later picked
    // up in the desktop app), and that session IS in the app's sidebar now — so
    // reading the oldest value would label a visible session invisible.
    const headless = tr.readTranscript(fixture([
      { cwd: '/p', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user', entrypoint: 'sdk-cli' },
      { type: 'assistant', entrypoint: 'sdk-cli', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100 } } }
    ]))!;
    assert.strictEqual(headless.entrypoint, 'sdk-cli');

    const resumed = tr.readTranscript(fixture([
      { type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: 'go' } },
      { cwd: '/p', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user', entrypoint: 'cli' },
      { type: 'assistant', entrypoint: 'cli', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100 } } }
    ]))!;
    assert.strictEqual(resumed.entrypoint, 'cli');

    // A non-string value is ignored rather than passed through.
    const bogus = tr.readTranscript(fixture([
      { type: 'user', entrypoint: 7, message: { role: 'user', content: 'go' } }
    ]))!;
    assert.strictEqual(bogus.entrypoint, null);
  })) p++; else f++;

  if (test('readTranscript extracts custom-title as sessionName', () => {
    const s = tr.readTranscript(fixture([
      { message: { role: 'user', content: 'hi' }, timestamp: '2026-07-01T09:00:00Z' },
      { type: 'custom-title', customTitle: 'My work', sessionId: 'x' }
    ]))!;
    assert.strictEqual(s.sessionName, 'My work');
  })) p++; else f++;

  if (test('readTranscript finds custom-title buried under later records', () => {
    // Claude Code re-appends custom-title on session select, then work piles on
    // top of it. The newest-first scan must not stop before reaching it just
    // because tokens/activity/cwd/version/message are already satisfied.
    const s = tr.readTranscript(fixture([
      { message: { role: 'user', content: 'hi' }, timestamp: '2026-07-01T09:00:00Z' },
      { type: 'custom-title', customTitle: 'My work', sessionId: 'x' },
      { cwd: '/Users/me/proj', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:01:00Z', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 100 }, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.js' } }] } },
      { cwd: '/Users/me/proj', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:02:00Z', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 200 }, content: [{ type: 'tool_use', name: 'Bash', input: { description: 'ls' } }] } }
    ]))!;
    assert.strictEqual(s.sessionName, 'My work');
    assert.strictEqual(s.tokens, 200);           // still the newest usage, not the older one
    assert.strictEqual(s.activity!.tool, 'Bash'); // still the newest activity
  })) p++; else f++;

  if (test('readTranscript treats "New session" placeholder as unnamed', () => {
    const s = tr.readTranscript(fixture([
      { message: { role: 'user', content: 'hi' }, timestamp: '2026-07-01T09:00:00Z' },
      { type: 'custom-title', customTitle: 'New session', sessionId: 'x' }
    ]))!;
    assert.strictEqual(s.sessionName, null);
  })) p++; else f++;

  if (test('readTranscript returns null for missing file', () => {
    assert.strictEqual(tr.readTranscript('/no/such.jsonl'), null);
  })) p++; else f++;

  if (test('turnComplete/waitingOnQuestion (question + plan) from newest message record', () => {
    const done = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
    ]))!;
    assert.strictEqual(done.turnComplete, true);
    assert.strictEqual(done.waitingOnQuestion, false);

    const pending = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
    ]))!;
    assert.strictEqual(pending.turnComplete, false);
    assert.strictEqual(pending.waitingOnQuestion, false);

    const asking = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } }] } }
    ]))!;
    assert.strictEqual(asking.waitingOnQuestion, true);

    // A proposed plan is the same shape of wait: the card is unanswered until a
    // tool_result lands, so the trailing ExitPlanMode is the signal.
    const planning = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: '## Steps\n1. do it' } }] } }
    ]))!;
    assert.strictEqual(planning.waitingOnQuestion, true);

    const planAccepted = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'x' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'User has approved your plan.' }] } }
    ]))!;
    assert.strictEqual(planAccepted.waitingOnQuestion, false);

    // Newest record is the user's tool_result → question answered, turn still open.
    const answered = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }
    ]))!;
    assert.strictEqual(answered.waitingOnQuestion, false);
    assert.strictEqual(answered.turnComplete, false);
  })) p++; else f++;

  if (test('commandOnly: only local slash-command records, and the cases that are not', () => {
    // A `/login` in a fresh terminal writes three user records and stops: no
    // assistant turn, no usage. Real on-disk shape (content is a plain string).
    const loginOnly = tr.readTranscript(fixture([
      { type: 'user', isMeta: true, timestamp: '2026-08-24T17:24:30.831Z', message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>' } },
      { type: 'user', timestamp: '2026-08-24T17:24:30.831Z', message: { role: 'user', content: '<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>' } },
      { type: 'user', timestamp: '2026-08-24T17:24:30.831Z', message: { role: 'user', content: '<local-command-stdout>Login successful</local-command-stdout>' } }
    ]))!;
    assert.strictEqual(loginOnly.commandOnly, true);
    assert.strictEqual(loginOnly.hasMessages, true);  // the older guard cannot catch it: these ARE message records

    // A bang command is the same class of local plumbing.
    const bangOnly = tr.readTranscript(fixture([
      { type: 'user', message: { role: 'user', content: '<bash-input>ls</bash-input>' } },
      { type: 'user', message: { role: 'user', content: '<bash-stdout>a.txt</bash-stdout>' } }
    ]))!;
    assert.strictEqual(bangOnly.commandOnly, true);

    // Same command run at the END of a session that did real work: usage sits on
    // an older assistant record, so this is a real session and must stay visible.
    const afterWork = tr.readTranscript(fixture([
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 5000 }, content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', message: { role: 'user', content: '<command-name>/login</command-name>' } }
    ]))!;
    assert.strictEqual(afterWork.commandOnly, false);

    // Fresh session, real prompt typed, assistant has not answered yet: 0 tokens
    // but a real conversation — the green "working" row, must stay visible.
    const firstPrompt = tr.readTranscript(fixture([
      { type: 'user', message: { role: 'user', content: 'fix the login bug' } }
    ]))!;
    assert.strictEqual(firstPrompt.commandOnly, false);

    // Block-array content that is not plumbing, still zero tokens.
    const blockPrompt = tr.readTranscript(fixture([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix the login bug' }] } }
    ]))!;
    assert.strictEqual(blockPrompt.commandOnly, false);

    // No conversational record at all: hasMessages already drops it, so
    // commandOnly must not claim it too (the two guards stay distinct).
    const empty = tr.readTranscript(fixture([
      { type: 'queue-operation', timestamp: '2026-08-24T17:24:30.831Z' }
    ]))!;
    assert.strictEqual(empty.hasMessages, false);
    assert.strictEqual(empty.commandOnly, false);
  })) p++; else f++;

  // ---- bug-7: originCwd, the launch cwd -------------------------------------

  // A record big enough to pad a fixture past a window boundary, carrying no cwd.
  const pad = (i: number) => ({ type: 'progress', note: 'p' + i + '-' + 'x'.repeat(280) });

  if (test('originCwd is the oldest cwd, cwd the newest, when the tail is truncated', () => {
    tr.resetOriginCache();
    const file = fixture([
      { type: 'attachment', cwd: '/a/repo', timestamp: '2026-09-01T10:00:00Z' },
      ...Array.from({ length: 8 }, (_, i) => pad(i)),
      { type: 'user', cwd: '/a/repo/sub', message: { role: 'user', content: 'x' }, timestamp: '2026-09-01T10:05:00Z' }
    ]);
    const p = tr.readTranscript(file, { tailBytes: 400 })!;
    assert.strictEqual(p.originCwd, '/a/repo');
    assert.strictEqual(p.cwd, '/a/repo/sub');
  })) p++; else f++;

  if (test('originCwd equals cwd when the session never drifted', () => {
    tr.resetOriginCache();
    const file = fixture([
      { type: 'attachment', cwd: '/a/repo', timestamp: '2026-09-01T10:00:00Z' },
      ...Array.from({ length: 8 }, (_, i) => pad(i)),
      { type: 'user', cwd: '/a/repo', message: { role: 'user', content: 'x' }, timestamp: '2026-09-01T10:05:00Z' }
    ]);
    const p = tr.readTranscript(file, { tailBytes: 400 })!;
    assert.strictEqual(p.originCwd, '/a/repo');
    assert.strictEqual(p.cwd, '/a/repo');
  })) p++; else f++;

  if (test('originCwd is null (fail open) when no cwd sits in the head window', () => {
    tr.resetOriginCache();
    // 60 * ~300B = ~18 KB of cwd-less records ahead of the first cwd, so the
    // 16 KB head window genuinely misses. No guess is made.
    const file = fixture([
      ...Array.from({ length: 60 }, (_, i) => pad(i)),
      { type: 'user', cwd: '/a/repo/sub', message: { role: 'user', content: 'x' }, timestamp: '2026-09-01T10:05:00Z' }
    ]);
    const p = tr.readTranscript(file, { tailBytes: 400 })!;
    assert.strictEqual(p.originCwd, null);
    assert.strictEqual(p.cwd, '/a/repo/sub');
  })) p++; else f++;

  if (test('originCwd is memoized per path; only a shrunk file re-reads the head', () => {
    tr.resetOriginCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-oc-'));
    const file = path.join(dir, 's.jsonl');
    const line = (r: unknown) => JSON.stringify(r) + '\n';
    const head = line({ type: 'attachment', cwd: '/a/repo', timestamp: '2026-09-01T10:00:00Z' });
    const body = (n: number) => Array.from({ length: n }, (_, i) => line(pad(i))).join('');
    const newest = line({ type: 'user', cwd: '/a/repo/sub', message: { role: 'user', content: 'x' }, timestamp: '2026-09-01T10:05:00Z' });

    fs.writeFileSync(file, head + body(20) + newest);
    assert.strictEqual(tr.readTranscript(file, { tailBytes: 400 })!.originCwd, '/a/repo');
    assert.strictEqual(tr.readTranscript(file, { tailBytes: 400 })!.originCwd, '/a/repo');
    assert.strictEqual(tr.originCacheStats().headReads, 1, 'second read served from the memo');

    // Appends leave the launch cwd untouched, so no second head read.
    fs.appendFileSync(file, newest);
    assert.strictEqual(tr.readTranscript(file, { tailBytes: 400 })!.originCwd, '/a/repo');
    assert.strictEqual(tr.originCacheStats().headReads, 1, 'an append does not invalidate');

    // Smaller than before but still past the tail window: rotation/truncation,
    // so nothing remembered describes this file any more.
    fs.writeFileSync(file, head + body(10) + newest);
    assert.strictEqual(tr.readTranscript(file, { tailBytes: 400 })!.originCwd, '/a/repo');
    assert.strictEqual(tr.originCacheStats().headReads, 2, 'a shrunk file re-reads the head');
  })) p++; else f++;

  if (test('originCwd costs no head read when the whole file is inside the tail window', () => {
    tr.resetOriginCache();
    const file = fixture([
      { type: 'attachment', cwd: '/a/repo', timestamp: '2026-09-01T10:00:00Z' },
      { type: 'user', cwd: '/a/repo/sub', message: { role: 'user', content: 'x' }, timestamp: '2026-09-01T10:05:00Z' }
    ]);
    const p = tr.readTranscript(file)!;
    assert.strictEqual(p.originCwd, '/a/repo');
    assert.strictEqual(p.cwd, '/a/repo/sub');
    assert.strictEqual(tr.originCacheStats().headReads, 0);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
