import assert from 'node:assert';

import {
  DENY_MESSAGE_BYTES, TRIM_POINTER_BYTES, bashKind, extractResults, simulate, trimmedSize, type ResultRow
} from '../server/lib/tool-output-replay.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const jsonl = (records: unknown[]): string => records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n');

/** One assistant record of turn `id` firing the given tool_use blocks. */
function use(id: string, blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant', ...extra,
    message: {
      role: 'assistant', id,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: blocks.map(b => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }))
    }
  };
}
/** A plain assistant turn (text only) — one more replay of everything before it. */
function say(id: string, extra: Record<string, unknown> = {}) {
  return { type: 'assistant', ...extra, message: { role: 'assistant', id, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] } };
}
/** One user record carrying a tool_result. */
function result(toolUseId: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } };
}
const boundary = { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } };

function row(partial: Partial<ResultRow>): ResultRow {
  return { tool: 'Bash', kind: '', bytes: 0, ranged: false, isError: false, turnsAfter: 0, trimmedBytes: 0, scope: 'main', ...partial };
}

export function run(): number {
  console.log('\ntool-output-replay');
  let p = 0, f = 0;

  if (test('pairs tool_use with tool_result and sizes the result in UTF-8 bytes', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      result('t1', 'é'.repeat(10)),
      say('m2')
    ]), { scope: 'main' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].tool, 'Bash');
    assert.strictEqual(rows[0].bytes, 20);
  })) p++; else f++;

  if (test('block-array content is joined text; an image block adds no bytes', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 't1', name: 'mcp__x__y' }]),
      result('t1', [{ type: 'text', text: 'abc' }, { type: 'image', source: { data: 'AAAA' } }, { type: 'text', text: 'de' }])
    ]), { scope: 'main' });
    assert.strictEqual(rows[0].bytes, 5);
  })) p++; else f++;

  if (test('a Read with offset or limit is ranged; a bare Read is not', () => {
    const rows = extractResults(jsonl([
      use('m1', [
        { id: 'a', name: 'Read', input: { file_path: '/x' } },
        { id: 'b', name: 'Read', input: { file_path: '/x', offset: 10 } },
        { id: 'c', name: 'Read', input: { file_path: '/x', limit: 50 } }
      ]),
      result('a', 'x'), result('b', 'x'), result('c', 'x')
    ]), { scope: 'main' });
    assert.deepStrictEqual(rows.map(r => r.ranged), [false, true, true]);
  })) p++; else f++;

  if (test('is_error and <tool_use_error> both mark a row as an error', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 'a', name: 'Bash' }, { id: 'b', name: 'Read' }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true }] } },
      result('b', '<tool_use_error>File does not exist.</tool_use_error>')
    ]), { scope: 'main' });
    assert.deepStrictEqual(rows.map(r => r.isError), [true, true]);
  })) p++; else f++;

  if (test('a tool_result replayed after compaction is counted once', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 't1', name: 'Bash' }]),
      result('t1', 'hello'),
      boundary,
      use('m1', [{ id: 't1', name: 'Bash' }]),
      result('t1', 'hello')
    ]), { scope: 'main' });
    assert.strictEqual(rows.length, 1);
  })) p++; else f++;

  if (test('turnsAfter counts distinct assistant turns after the result, up to the next compact boundary', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 'a', name: 'Bash' }]),
      result('a', 'x'),
      say('m2'), say('m2'),            // one turn split over two records
      say('m3'),
      use('m4', [{ id: 'b', name: 'Bash' }]),
      result('b', 'y'),
      say('m5'),
      boundary,
      say('m6'), say('m7')
    ]), { scope: 'main' });
    assert.strictEqual(rows[0].turnsAfter, 4, 'a is replayed by m2, m3, m4, m5');
    assert.strictEqual(rows[1].turnsAfter, 1, 'b is replayed by m5 only; m6 and m7 come after the boundary');
  })) p++; else f++;

  if (test('main scope skips sidechain records; subagent scope keeps them', () => {
    const text = jsonl([
      use('m1', [{ id: 't1', name: 'Bash' }], { isSidechain: true }),
      result('t1', 'hello', { isSidechain: true }),
      say('m2', { isSidechain: true })
    ]);
    assert.strictEqual(extractResults(text, { scope: 'main' }).length, 0);
    const sub = extractResults(text, { scope: 'subagent' });
    assert.strictEqual(sub.length, 1);
    assert.strictEqual(sub[0].scope, 'subagent');
    assert.strictEqual(sub[0].turnsAfter, 1);
  })) p++; else f++;

  if (test('malformed lines and results without a matching tool_use are skipped', () => {
    const rows = extractResults(jsonl(['{not json', result('ghost', 'x'), use('m1', [{ id: 't1', name: 'Grep' }]), result('t1', 'ok')]), { scope: 'main' });
    assert.deepStrictEqual(rows.map(r => r.tool), ['Grep']);
  })) p++; else f++;

  if (test('trimmedSize leaves short output whole', () => {
    const text = Array.from({ length: 80 }, (_, i) => 'line ' + i).join('\n');
    assert.strictEqual(trimmedSize(text), Buffer.byteLength(text));
  })) p++; else f++;

  if (test('trimmedSize keeps 40 head + 40 tail lines plus the pointer line', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => 'line-' + String(i).padStart(4, '0'));
    const text = lines.join('\n');
    const expected = Buffer.byteLength(lines.slice(0, 40).join('\n')) + Buffer.byteLength(lines.slice(-40).join('\n')) + TRIM_POINTER_BYTES;
    assert.strictEqual(trimmedSize(text), expected);
  })) p++; else f++;

  if (test('trimmedSize caps a single huge line at 2 KB a side', () => {
    const text = 'x'.repeat(50_000);
    assert.strictEqual(trimmedSize(text), 2048 + 2048 + TRIM_POINTER_BYTES);
  })) p++; else f++;

  if (test('extractResults fills trimmedBytes from the result text', () => {
    const big = Array.from({ length: 500 }, (_, i) => 'row ' + i).join('\n');
    const rows = extractResults(jsonl([use('m1', [{ id: 't1', name: 'Bash' }]), result('t1', big)]), { scope: 'main' });
    assert.strictEqual(rows[0].trimmedBytes, trimmedSize(big));
  })) p++; else f++;

  if (test('simulate: read-guard denies only bare Reads over the threshold, net of a ranged re-read', () => {
    const rows = [
      row({ tool: 'Read', bytes: 10_000, turnsAfter: 5 }),
      row({ tool: 'Read', bytes: 20_000, ranged: true, turnsAfter: 5 }),
      row({ tool: 'Read', bytes: 3_000, turnsAfter: 5 }),
      row({ tool: 'Read', bytes: 30_000, isError: true, turnsAfter: 5 })
    ];
    const s = simulate(rows, [4096, 16384]);
    const at4 = s.readGuard.find(r => r.threshold === 4096)!;
    assert.strictEqual(at4.calls, 1);
    assert.strictEqual(at4.savedBytes, 10_000 - DENY_MESSAGE_BYTES);
    assert.strictEqual(at4.savedBytesNet, 10_000 - DENY_MESSAGE_BYTES - 4096);
    assert.strictEqual(at4.savedByteTurns, (10_000 - DENY_MESSAGE_BYTES - 4096) * 5);
    const at16 = s.readGuard.find(r => r.threshold === 16384)!;
    assert.strictEqual(at16.calls, 0);
    assert.strictEqual(at16.savedBytes, 0);
  })) p++; else f++;

  if (test('simulate: bash-trim saves bytes minus the trimmed size, weighted by turnsAfter', () => {
    const rows = [
      row({ tool: 'Bash', bytes: 10_000, trimmedBytes: 1_500, turnsAfter: 2 }),
      row({ tool: 'Bash', bytes: 2_000, trimmedBytes: 2_000, turnsAfter: 9 }),
      row({ tool: 'Grep', bytes: 50_000, trimmedBytes: 1_000, turnsAfter: 9 })
    ];
    const at4 = simulate(rows, [4096]).bashTrim[0];
    assert.deepStrictEqual(at4, { threshold: 4096, calls: 1, savedBytes: 8_500, savedByteTurns: 17_000 });
  })) p++; else f++;

  if (test('simulate: byTool totals and per-threshold over-counts, sorted by byte-turns', () => {
    const rows = [
      row({ tool: 'Bash', bytes: 5_000, turnsAfter: 1 }),
      row({ tool: 'Read', bytes: 20_000, turnsAfter: 10 }),
      row({ tool: 'Read', bytes: 1_000, turnsAfter: 10 })
    ];
    const s = simulate(rows, [4096, 16384]);
    assert.deepStrictEqual(s.totals, { calls: 3, bytes: 26_000, byteTurns: 5_000 + 210_000 });
    assert.deepStrictEqual(s.byTool.map(t => t.tool), ['Read', 'Bash']);
    const read = s.byTool[0];
    assert.strictEqual(read.calls, 2);
    assert.strictEqual(read.bytes, 21_000);
    assert.strictEqual(read.byteTurns, 210_000);
    assert.deepStrictEqual(read.over, { 4096: { calls: 1, bytes: 20_000 }, 16384: { calls: 1, bytes: 20_000 } });
    assert.deepStrictEqual(s.byTool[1].over, { 4096: { calls: 1, bytes: 5_000 }, 16384: { calls: 0, bytes: 0 } });
  })) p++; else f++;

  if (test('bashKind sorts deliberate file reads first, then by what the command ran', () => {
    assert.strictEqual(bashKind("cd /repo && sed -n '10,80p' server/lib/scan.ts"), 'read: range (sed -n, awk NR)');
    assert.strictEqual(bashKind("grep -n foo x.ts; sed -n '1,9p' x.ts"), 'read: range (sed -n, awk NR)', 'a chained read counts as a read');
    assert.strictEqual(bashKind('head -n 40 docs/overview.md'), 'read: head/tail');
    assert.strictEqual(bashKind('cat client/src/App.tsx'), 'read: cat');
    assert.strictEqual(bashKind("cat <<'EOF' > out.md\nhi\nEOF"), 'other', 'a heredoc write is not a read');
    assert.strictEqual(bashKind('git diff main...HEAD'), 'git diff/show');
    assert.strictEqual(bashKind('pnpm test'), 'tests');
    assert.strictEqual(bashKind('pnpm typecheck'), 'build/typecheck/lint');
    assert.strictEqual(bashKind('make'), 'other');
  })) p++; else f++;

  if (test('extractResults tags Bash rows with their kind and leaves other tools blank', () => {
    const rows = extractResults(jsonl([
      use('m1', [{ id: 'a', name: 'Bash', input: { command: 'pnpm test' } }, { id: 'b', name: 'Read', input: { file_path: '/x' } }]),
      result('a', 'ok'), result('b', 'x')
    ]), { scope: 'main' });
    assert.deepStrictEqual(rows.map(r => r.kind), ['tests', '']);
  })) p++; else f++;

  if (test('simulate: bashByKind sums Bash rows per kind with bash-trim savings per threshold, sorted by byte-turns', () => {
    const rows = [
      row({ kind: 'tests', bytes: 1_000, trimmedBytes: 1_000, turnsAfter: 1 }),
      row({ kind: 'read: cat', bytes: 10_000, trimmedBytes: 1_500, turnsAfter: 2 }),
      row({ kind: 'read: cat', bytes: 3_000, trimmedBytes: 3_000, turnsAfter: 2 }),
      row({ tool: 'Read', bytes: 50_000, turnsAfter: 9 })
    ];
    const s = simulate(rows, [4096, 16384]);
    assert.deepStrictEqual(s.bashByKind, [
      { kind: 'read: cat', calls: 2, bytes: 13_000, byteTurns: 26_000, trimSavedByteTurns: { 4096: 17_000, 16384: 0 } },
      { kind: 'tests', calls: 1, bytes: 1_000, byteTurns: 1_000, trimSavedByteTurns: { 4096: 0, 16384: 0 } }
    ]);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
