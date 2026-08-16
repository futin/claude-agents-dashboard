import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHAT_WINDOW_BYTES, NO_CAPS, TEXT_CAP, TOOL_BODY_CAP,
  parseChatRecord, readChatAfter, readChatBefore, readChatTail
} from '../server/lib/chat.js';
// The real producer of the remote-message wrapper: importing it here is what
// makes the unwrap tests fail if `composeReason`'s prose ever drifts.
import { composeReason } from '../server/lib/messages.js';
import type { ChatMessage } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-chat-'));
  return path.join(dir, 'x.jsonl');
}

function userRec(uuid: string, text: unknown, extra: Record<string, unknown> = {}) {
  return { uuid, type: 'user', timestamp: '2026-07-01T10:00:00Z', ...extra, message: { role: 'user', content: text } };
}
function asstRec(uuid: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { uuid, type: 'assistant', timestamp: '2026-07-01T10:00:01Z', ...extra, message: { role: 'assistant', content } };
}

/** Write records as JSONL and return the file path. */
function writeJsonl(records: unknown[], trailingNewline = true): string {
  const file = tmpFile();
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

export function run(): number {
  console.log('\n=== chat.ts ===\n');
  let p = 0, f = 0;

  /* ---------------------------------------------- parseChatRecord (pure) */

  if (test('user record with string content', () => {
    const m = parseChatRecord(userRec('u1', 'hello there'))!;
    assert.strictEqual(m.role, 'user');
    assert.strictEqual(m.text, 'hello there');
    assert.strictEqual(m.uuid, 'u1');
    assert.strictEqual(m.ts, '2026-07-01T10:00:00Z');
    assert.deepStrictEqual(m.tools, []);
    assert.strictEqual(m.textTruncated, false);
  })) p++; else f++;

  if (test('user record with text blocks', () => {
    const m = parseChatRecord(userRec('u1', [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))!;
    assert.strictEqual(m.text, 'one\ntwo');
  })) p++; else f++;

  if (test('tool_result-only user record dropped', () => {
    const rec = userRec('u1', [{ type: 'tool_result', tool_use_id: 't1', content: 'a 40KB blob' }]);
    assert.strictEqual(parseChatRecord(rec), null);
  })) p++; else f++;

  if (test('assistant text + thinking + tool_use → text and tool list', () => {
    const m = parseChatRecord(asstRec('a1', [
      { type: 'thinking', thinking: 'internal musings' },
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'Explore', description: 'find X' } }
    ]))!;
    assert.strictEqual(m.text, 'Reading the file.'); // thinking is not text
    assert.deepStrictEqual(m.tools, [
      { name: 'Read', detail: '/tmp/a.ts' },
      { name: 'Task', detail: 'Explore: find X' }
    ]);
  })) p++; else f++;

  if (test('thinking-only assistant record dropped', () => {
    assert.strictEqual(parseChatRecord(asstRec('a1', [{ type: 'thinking', thinking: 'hmm' }])), null);
  })) p++; else f++;

  if (test('sidechain and meta records dropped', () => {
    assert.strictEqual(parseChatRecord(userRec('u1', 'sub', { isSidechain: true })), null);
    assert.strictEqual(parseChatRecord(userRec('u2', 'meta', { isMeta: true })), null);
  })) p++; else f++;

  if (test('remote follow-up unwrapped to plain user text', () => {
    const rec = userRec('u1', 'Stop hook feedback:\n' + composeReason('Hello from the browser'), { isMeta: true });
    const m = parseChatRecord(rec)!;
    assert.strictEqual(m.role, 'user');
    assert.strictEqual(m.text, 'Hello from the browser');
    assert.deepStrictEqual(m.tools, []);
  })) p++; else f++;

  if (test('remote follow-up keeps its own line breaks', () => {
    const typed = 'first line\n\nthird line';
    const rec = userRec('u1', 'Stop hook feedback:\n' + composeReason(typed), { isMeta: true });
    assert.strictEqual(parseChatRecord(rec)!.text, typed);
  })) p++; else f++;

  if (test('meta records that are not remote follow-ups stay dropped', () => {
    for (const content of [
      'Stop hook feedback:\nsome other hook blocked the stop',
      'The user is away from the terminal and sent this follow-up from the dashboard; treat it as their next message:\ntruncated',
      composeReason('trailing text was appended') + '\nextra'
    ]) {
      assert.strictEqual(parseChatRecord(userRec('u1', content, { isMeta: true })), null, content.slice(0, 40));
    }
  })) p++; else f++;

  if (test('non-conversational records dropped', () => {
    for (const rec of [
      { type: 'last-prompt', lastPrompt: 'x' },
      { type: 'custom-title', customTitle: 'My session' },
      { type: 'queue-operation', operation: 'add' },
      { type: 'attachment', attachment: {} },
      { type: 'system', subtype: 'hook', content: 'hook ran' },
      null, 'nope', 42
    ]) {
      assert.strictEqual(parseChatRecord(rec), null, JSON.stringify(rec));
    }
  })) p++; else f++;

  if (test('system-reminder spans stripped; reminder-only record dropped', () => {
    const m = parseChatRecord(userRec('u1', 'real ask\n<system-reminder>\nnoise\n</system-reminder>'))!;
    assert.strictEqual(m.text, 'real ask');
    assert.strictEqual(parseChatRecord(userRec('u2', '<system-reminder>only noise</system-reminder>')), null);
  })) p++; else f++;

  if (test('over-cap text truncated with flag', () => {
    const m = parseChatRecord(userRec('u1', 'x'.repeat(TEXT_CAP + 500)))!;
    assert.strictEqual(m.text.length, TEXT_CAP);
    assert.strictEqual(m.textTruncated, true);
  })) p++; else f++;

  if (test('NO_CAPS keeps the whole message text', () => {
    const long = 'x'.repeat(TEXT_CAP + 500);
    const m = parseChatRecord(userRec('u1', long), NO_CAPS)!;
    assert.strictEqual(m.text, long);
    assert.strictEqual(m.textTruncated, false);
  })) p++; else f++;

  if (test('NO_CAPS keeps the whole tool body', () => {
    const plan = 'p'.repeat(TOOL_BODY_CAP + 5);
    const m = parseChatRecord(asstRec('a1', [
      { type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan } }
    ]), NO_CAPS)!;
    assert.strictEqual(m.tools[0].body, plan);
    assert.strictEqual('bodyTruncated' in m.tools[0], false);
  })) p++; else f++;

  if (test('tool-only assistant record kept (no text)', () => {
    const m = parseChatRecord(asstRec('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'run tests' } }]))!;
    assert.strictEqual(m.text, '');
    assert.deepStrictEqual(m.tools, [{ name: 'Bash', detail: 'run tests' }]);
  })) p++; else f++;

  if (test('ExitPlanMode carries the full plan as body', () => {
    const plan = '# Plan\n\n- step one\n- step two';
    const m = parseChatRecord(asstRec('a1', [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan } }]))!;
    assert.deepStrictEqual(m.tools, [{ name: 'ExitPlanMode', detail: plan.slice(0, 80), body: plan }]);
  })) p++; else f++;

  if (test('over-cap plan body truncated with flag', () => {
    const m = parseChatRecord(asstRec('a1', [
      { type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan: 'p'.repeat(TOOL_BODY_CAP + 5) } }
    ]))!;
    assert.strictEqual(m.tools[0].body!.length, TOOL_BODY_CAP);
    assert.strictEqual(m.tools[0].bodyTruncated, true);
  })) p++; else f++;

  if (test('ExitPlanMode without a usable plan falls back to a plain tool line', () => {
    for (const input of [undefined, {}, { plan: 42 }, { plan: '   ' }]) {
      const m = parseChatRecord(asstRec('a1', [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input }]))!;
      assert.strictEqual('body' in m.tools[0], false, JSON.stringify(input));
    }
  })) p++; else f++;

  if (test('AskUserQuestion composes questions + options as body', () => {
    const m = parseChatRecord(asstRec('a1', [{
      type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {
        questions: [
          {
            question: 'Which auth method?', header: 'Auth', multiSelect: false,
            options: [{ label: 'OAuth', description: 'redirect flow' }, { label: 'JWT' }]
          },
          { question: 'Deploy now?' }
        ]
      }
    }]))!;
    assert.strictEqual(m.tools[0].name, 'AskUserQuestion');
    assert.strictEqual(
      m.tools[0].body,
      '**Auth** — Which auth method?\n- **OAuth** — redirect flow\n- **JWT**\n\nDeploy now?'
    );
  })) p++; else f++;

  if (test('AskUserQuestion with malformed questions falls back to a plain tool line', () => {
    for (const input of [{}, { questions: 'x' }, { questions: [] }, { questions: [{ header: 'H' }] }]) {
      const m = parseChatRecord(asstRec('a1', [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input }]))!;
      assert.strictEqual('body' in m.tools[0], false, JSON.stringify(input));
    }
  })) p++; else f++;

  if (test('missing uuid falls back to a unique offset key', () => {
    const file = writeJsonl([{ type: 'user', message: { role: 'user', content: 'a' } }, { type: 'user', message: { role: 'user', content: 'b' } }]);
    const ids = readChatTail(file)!.messages.map(m => m.uuid);
    assert.deepStrictEqual(ids, ['off:0', 'off:' + (JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }).length + 1)]);
  })) p++; else f++;

  if (test('every reader threads the caps through to the records', () => {
    const long = 'y'.repeat(TEXT_CAP + 500);
    const file = writeJsonl([userRec('u0', 'short'), userRec('u1', long)]);

    for (const [what, page] of [
      ['tail', readChatTail(file, 100, NO_CAPS)!],
      ['after', readChatAfter(file, 0, NO_CAPS)!],
      ['before', readChatBefore(file, fs.statSync(file).size, 100, NO_CAPS)!]
    ] as const) {
      const m = page.messages.find(x => x.uuid === 'u1')!;
      assert.strictEqual(m.text, long, what);
      assert.strictEqual(m.textTruncated, false, what);
    }
    // Default (no caps argument) still truncates — the toggle is opt-in.
    const capped = readChatTail(file)!.messages.find(x => x.uuid === 'u1')!;
    assert.strictEqual(capped.text.length, TEXT_CAP);
    assert.strictEqual(capped.textTruncated, true);
  })) p++; else f++;

  /* ---------------------------------------------- paging / offset math */

  if (test('tail returns the newest `limit` messages, oldest-first', () => {
    const file = writeJsonl(Array.from({ length: 25 }, (_, i) => userRec('u' + i, 'msg ' + i)));
    const page = readChatTail(file, 10)!;
    assert.strictEqual(page.messages.length, 10);
    assert.deepStrictEqual(page.messages.map(m => m.text), Array.from({ length: 10 }, (_, i) => 'msg ' + (15 + i)));
    assert.strictEqual(page.hasMore, true);
    assert.strictEqual(page.cursor, fs.statSync(file).size);
  })) p++; else f++;

  if (test('before-page joins the tail with no gap and no duplicate', () => {
    const file = writeJsonl(Array.from({ length: 25 }, (_, i) => userRec('u' + i, 'msg ' + i)));
    const tail = readChatTail(file, 10)!;
    const older = readChatBefore(file, tail.headOffset, 10)!;
    assert.deepStrictEqual(older.messages.map(m => m.text), Array.from({ length: 10 }, (_, i) => 'msg ' + (5 + i)));
    assert.strictEqual(older.cursor, 0); // backward pages never move the live cursor
    const first = readChatBefore(file, older.headOffset, 10)!;
    assert.deepStrictEqual(first.messages.map(m => m.text), ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
    assert.strictEqual(first.headOffset, 0);
    assert.strictEqual(first.hasMore, false);
    assert.deepStrictEqual(readChatBefore(file, 0, 10)!.messages, []);
  })) p++; else f++;

  if (test('walking back over a file larger than one window loses nothing', () => {
    // ~1.2 KB per record → comfortably more than one CHAT_WINDOW_BYTES window.
    const pad = 'x'.repeat(1200);
    const count = 700;
    const file = writeJsonl(Array.from({ length: count }, (_, i) => userRec('u' + i, i + ' ' + pad)));
    assert.ok(fs.statSync(file).size > CHAT_WINDOW_BYTES, 'fixture must exceed one window');

    const collected: ChatMessage[] = [];
    let page = readChatTail(file, 100)!;
    collected.unshift(...page.messages);
    let guard = 0;
    while (page.hasMore) {
      if (++guard > 100) throw new Error('paging did not terminate');
      page = readChatBefore(file, page.headOffset, 100)!;
      collected.unshift(...page.messages);
    }
    assert.strictEqual(collected.length, count);
    assert.deepStrictEqual(collected.map(m => m.uuid), Array.from({ length: count }, (_, i) => 'u' + i));
  })) p++; else f++;

  if (test('after-appends equal the whole-file parse (odd chunks, multibyte)', () => {
    const records = [
      userRec('u1', 'emoji 🚀🔥 描述'),
      asstRec('a1', [{ type: 'text', text: 'ok 🚀' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'foo' } }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'noise' }]),
      userRec('u3', 'next question 描述')
    ];
    const oracleFile = writeJsonl(records);
    const oracle = readChatTail(oracleFile, 1000)!.messages;

    const file = tmpFile();
    fs.writeFileSync(file, '');
    const buf = Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const seen: ChatMessage[] = [];
    let cursor = 0;
    for (let off = 0; off < buf.length; off += 7) {
      fs.appendFileSync(file, buf.subarray(off, Math.min(off + 7, buf.length)));
      const page = readChatAfter(file, cursor)!;
      seen.push(...page.messages);
      cursor = page.cursor;
    }
    assert.deepStrictEqual(seen, oracle);
    assert.strictEqual(cursor, fs.statSync(file).size);
    assert.deepStrictEqual(readChatAfter(file, cursor)!.messages, []); // idle poll is empty
  })) p++; else f++;

  if (test('final record without trailing newline is included', () => {
    const file = writeJsonl([userRec('u1', 'a'), userRec('u2', 'b')], false);
    assert.deepStrictEqual(readChatTail(file)!.messages.map(m => m.text), ['a', 'b']);
    assert.strictEqual(readChatTail(file)!.cursor, fs.statSync(file).size);
  })) p++; else f++;

  if (test('half a line is not consumed until it completes', () => {
    const file = tmpFile();
    const line = JSON.stringify(userRec('u1', 'partial')) + '\n';
    fs.writeFileSync(file, line.slice(0, 20));
    const first = readChatAfter(file, 0)!;
    assert.deepStrictEqual(first.messages, []);
    assert.strictEqual(first.cursor, 0); // nothing consumed
    fs.appendFileSync(file, line.slice(20));
    const second = readChatAfter(file, first.cursor)!;
    assert.deepStrictEqual(second.messages.map(m => m.text), ['partial']);
  })) p++; else f++;

  if (test('unparseable lines are skipped but still consumed', () => {
    const file = tmpFile();
    fs.writeFileSync(file, 'not json\n' + JSON.stringify(userRec('u1', 'a')) + '\n');
    const page = readChatTail(file)!;
    assert.deepStrictEqual(page.messages.map(m => m.text), ['a']);
    assert.strictEqual(page.cursor, fs.statSync(file).size);
  })) p++; else f++;

  if (test('cursor past EOF signals reset; cursor at EOF is a no-op', () => {
    const file = writeJsonl([userRec('u1', 'a')]);
    const size = fs.statSync(file).size;
    const past = readChatAfter(file, size + 500)!;
    assert.strictEqual(past.reset, true);
    assert.deepStrictEqual(past.messages, []);
    const atEof = readChatAfter(file, size)!;
    assert.strictEqual(atEof.reset, undefined);
    assert.strictEqual(atEof.cursor, size);
  })) p++; else f++;

  if (test('missing file returns null everywhere', () => {
    const gone = path.join(os.tmpdir(), 'cad-chat-missing', 'nope.jsonl');
    assert.strictEqual(readChatTail(gone), null);
    assert.strictEqual(readChatBefore(gone, 100), null);
    assert.strictEqual(readChatAfter(gone, 0), null);
  })) p++; else f++;

  if (test('empty transcript yields an empty page', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '');
    const page = readChatTail(file)!;
    assert.deepStrictEqual(page.messages, []);
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.cursor, 0);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
