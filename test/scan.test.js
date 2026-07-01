'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scan = require('../lib/scan');
const { parseEnv, toPosInt, loadConfig } = require('../lib/config');

function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + e.message); return false; }
}

// Build a fake ~/.claude/projects root with project dirs + transcripts.
function makeRoot(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-root-'));
  specs.forEach(spec => {
    const dir = path.join(root, spec.dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, spec.id + '.jsonl');
    fs.writeFileSync(file, spec.records.map(r => JSON.stringify(r)).join('\n'));
    if (spec.mtimeMs) {
      const t = spec.mtimeMs / 1000;
      fs.utimesSync(file, t, t);
    }
  });
  return root;
}

function usageRec(tokens) {
  return { message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } } };
}
function toolRec(name, input) {
  return { message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, input }] } };
}
function metaRec(cwd, branch) {
  return { cwd, gitBranch: branch, version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user' };
}

function run() {
  console.log('\n=== config.js ===\n');
  let p = 0, f = 0;

  if (test('parseEnv handles comments, quotes, blanks', () => {
    const e = parseEnv('# c\nPORT=4000\nMAX_SESSIONS="7"\n\nBAD\nACTIVE_WINDOW_MIN=3');
    assert.strictEqual(e.PORT, '4000');
    assert.strictEqual(e.MAX_SESSIONS, '7');
    assert.strictEqual(e.ACTIVE_WINDOW_MIN, '3');
    assert.strictEqual(e.BAD, undefined);
  })) p++; else f++;

  if (test('toPosInt coerces / falls back', () => {
    assert.strictEqual(toPosInt('5', 1), 5);
    assert.strictEqual(toPosInt('0', 9), 9);
    assert.strictEqual(toPosInt('x', 9), 9);
    assert.strictEqual(toPosInt(undefined, 9), 9);
  })) p++; else f++;

  if (test('loadConfig applies defaults when no .env', () => {
    const c = loadConfig({ envPath: '/no/such/.env' });
    assert.strictEqual(c.port, 4173);
    assert.strictEqual(c.maxSessions, 5);
  })) p++; else f++;

  console.log('\n=== scan.js ===\n');

  if (test('decodeProjectName fallback basename', () => {
    assert.strictEqual(scan.decodeProjectName('-Users-me-Documents-ECC'), 'ECC');
  })) p++; else f++;

  if (test('scanSessions ranks by recency, caps at maxSessions', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-old', id: 'old', mtimeMs: now - 60 * 60 * 1000, records: [metaRec('/a/old', 'main'), usageRec(1000)] },
      { dirName: '-a-mid', id: 'mid', mtimeMs: now - 10 * 60 * 1000, records: [metaRec('/a/mid', 'dev'), usageRec(2000)] },
      { dirName: '-a-new', id: 'new', mtimeMs: now - 60 * 1000, records: [metaRec('/a/new', 'main'), toolRec('Bash', { description: 'go' }), usageRec(3000)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 2, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions.length, 2);
    assert.strictEqual(out.sessions[0].project, 'new');   // newest first
    assert.strictEqual(out.sessions[1].project, 'mid');
    assert.strictEqual(out.maxSessions, 2);
  })) p++; else f++;

  if (test('working vs idle by activeWindowMin', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-hot', id: 'hot', mtimeMs: now - 60 * 1000, records: [metaRec('/a/hot', 'main'), usageRec(1000)] },
      { dirName: '-a-cold', id: 'cold', mtimeMs: now - 30 * 60 * 1000, records: [metaRec('/a/cold', 'main'), usageRec(1000)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    const hot = out.sessions.find(s => s.project === 'hot');
    const cold = out.sessions.find(s => s.project === 'cold');
    assert.strictEqual(hot.status, 'working');
    assert.strictEqual(cold.status, 'idle');
    assert.strictEqual(out.totals.active, 1);
  })) p++; else f++;

  if (test('lookbackHours excludes stale transcripts', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-stale', id: 'stale', mtimeMs: now - 48 * 60 * 60 * 1000, records: [metaRec('/a/stale', 'main'), usageRec(1000)] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions.length, 0);
  })) p++; else f++;

  if (test('activity captured from newest tool_use', () => {
    const now = 1_700_000_000_000;
    const root = makeRoot([
      { dirName: '-a-act', id: 'act', mtimeMs: now - 60 * 1000, records: [metaRec('/a/act', 'main'), usageRec(1000), toolRec('Task', { subagent_type: 'Explore', description: 'map' })] }
    ]);
    const out = scan.scanSessions({ maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 }, { root, now, skipProcScan: true });
    assert.strictEqual(out.sessions[0].activity.tool, 'Task');
    assert.strictEqual(out.sessions[0].activity.detail, 'Explore: map');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (require.main === module) process.exit(run() > 0 ? 1 : 0);
module.exports = { run };
