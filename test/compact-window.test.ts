import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as cw from '../server/lib/compact-window.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A tmp home and a tmp project, with no managed file unless the test writes one. */
function sandbox(): { home: string; project: string; managed: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-cw-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  cw.resetCompactWindowCache();
  const managed = path.join(root, 'managed-settings.json');
  cw.setManagedSettingsPath(managed);
  return { home, project, managed };
}

function write(file: string, value: unknown): void {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

export function run(): number {
  console.log('\n=== compact-window.ts ===\n');
  let p = 0, f = 0;

  if (test('user, project and local files layer in that order, later wins', () => {
    const s = sandbox();
    write(path.join(s.home, '.claude', 'settings.json'), { autoCompactWindow: 200000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 200000);
    write(path.join(s.project, '.claude', 'settings.json'), { autoCompactWindow: 300000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 300000);
    write(path.join(s.project, '.claude', 'settings.local.json'), { autoCompactWindow: 400000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 400000);
  })) p++; else f++;

  if (test('the managed file beats every other layer', () => {
    const s = sandbox();
    write(path.join(s.project, '.claude', 'settings.local.json'), { autoCompactWindow: 400000 });
    write(s.managed, { autoCompactWindow: 150000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 150000);
  })) p++; else f++;

  if (test('a settings env CLAUDE_CODE_AUTO_COMPACT_WINDOW wins, floored at 100k', () => {
    const s = sandbox();
    const user = path.join(s.home, '.claude', 'settings.json');
    write(user, { autoCompactWindow: 300000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' } });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 250000);
    write(path.join(s.project, '.claude', 'settings.json'), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' } });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 100000);
  })) p++; else f++;

  if (test('autoCompactEnabled false means no cap at all', () => {
    const s = sandbox();
    write(path.join(s.home, '.claude', 'settings.json'), { autoCompactWindow: 200000, autoCompactEnabled: false });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), null);
  })) p++; else f++;

  if (test('no files, malformed JSON and a null projectDir fail open', () => {
    const s = sandbox();
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), null);
    write(path.join(s.project, '.claude', 'settings.json'), '{ not json');
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), null);
    write(path.join(s.home, '.claude', 'settings.json'), { autoCompactWindow: 200000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 200000);
    write(path.join(s.project, '.claude', 'settings.local.json'), { autoCompactWindow: 400000 });
    assert.strictEqual(cw.sessionCompactWindow(null, s.home), 200000);
    write(path.join(s.home, '.claude', 'settings.json'), { autoCompactWindow: 'big' });
    assert.strictEqual(cw.sessionCompactWindow(null, s.home), null);
  })) p++; else f++;

  if (test('cache: a changed file is re-read, an unchanged one is not', () => {
    const s = sandbox();
    const user = path.join(s.home, '.claude', 'settings.json');
    write(user, { autoCompactWindow: 200000 });
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 200000);
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 200000);
    assert.strictEqual(cw.compactWindowStats().reads, 1);
    write(user, { autoCompactWindow: 300000 });
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(user, later, later);
    assert.strictEqual(cw.sessionCompactWindow(s.project, s.home), 300000);
    assert.strictEqual(cw.compactWindowStats().reads, 2);
  })) p++; else f++;

  cw.setManagedSettingsPath(null);
  cw.resetCompactWindowCache();
  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
