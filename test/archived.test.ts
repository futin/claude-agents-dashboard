/**
 * archived.test.ts — the desktop app's archived ("deleted") sessions, and the
 * two call sites that hide them: `scanSessions` and `listRecentProjects`.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archivedSessionIds, appSessionsRoot } from '../server/lib/archived.js';
import * as scan from '../server/lib/scan.js';
import * as mgmt from '../server/lib/management.js';
import { listReports } from '../server/lib/analytics.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

interface Record_ {
  /** Directory pair under the store root: install id / account id. */
  install?: string;
  account?: string;
  /** The app's own id — the `local_<uuid>.json` filename. */
  local: string;
  isArchived?: boolean;
  cliSessionId?: string | null;
  /** Raw body, for the malformed-JSON case. Overrides the fields above. */
  raw?: string;
  mtimeMs?: number;
}

/** Absolute path of one record inside a store root. */
function recordPath(root: string, r: Record_): string {
  return path.join(root, r.install || 'install-1', r.account || 'account-1', `local_${r.local}.json`);
}

/** Build a fake claude-code-sessions store. */
function makeStore(records: Record_[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-store-'));
  for (const r of records) writeRecord(root, r);
  return root;
}

/** Write (or rewrite) one record. */
function writeRecord(root: string, r: Record_): string {
  const full = recordPath(root, r);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body = r.raw !== undefined ? r.raw : JSON.stringify({
    sessionId: `local_${r.local}`,
    ...(r.cliSessionId === null ? {} : { cliSessionId: r.cliSessionId ?? r.local }),
    isArchived: r.isArchived === true,
    name: 'a session'
  });
  fs.writeFileSync(full, body);
  if (r.mtimeMs) {
    const t = r.mtimeMs / 1000;
    fs.utimesSync(full, t, t);
  }
  return full;
}

/** Fake ~/.claude/projects root: one transcript per spec, each with a message. */
function makeProjectsRoot(specs: { dirName: string; id: string; cwd?: string; mtimeMs: number }[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-aroot-'));
  for (const s of specs) {
    const dir = path.join(root, s.dirName);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, s.id + '.jsonl');
    fs.writeFileSync(file, [
      { cwd: s.cwd || '/tmp/demo', gitBranch: 'main', version: '2.1.0', timestamp: '2026-08-01T09:00:00Z', type: 'user' },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000 } } }
    ].map(r => JSON.stringify(r)).join('\n'));
    const t = s.mtimeMs / 1000;
    fs.utimesSync(file, t, t);
  }
  return root;
}

const CFG = { maxSessions: 5, activeWindowMin: 5, lookbackHours: 24 };
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

export function run(): number {
  console.log('archived.test.ts');
  let ok = 0, n = 0;
  const t = (name: string, fn: () => void) => { n++; if (test(name, fn)) ok++; };

  /* ------------------------------------------------------- archivedSessionIds */

  t('archived record → its cliSessionId is in the set', () => {
    const root = makeStore([{ local: 'u1', cliSessionId: 'sess-arch', isArchived: true }]);
    const ids = archivedSessionIds({ root });
    assert.deepEqual([...ids], ['sess-arch']);
  });

  t('unarchived record → not in the set', () => {
    const root = makeStore([
      { local: 'u1', cliSessionId: 'sess-live', isArchived: false },
      { local: 'u2', cliSessionId: 'sess-arch', isArchived: true }
    ]);
    const ids = archivedSessionIds({ root });
    assert.equal(ids.has('sess-live'), false);
    assert.equal(ids.has('sess-arch'), true);
  });

  t('archived record with no cliSessionId → ignored, no crash', () => {
    const root = makeStore([
      { local: 'u1', cliSessionId: null, isArchived: true },
      { local: 'u2', cliSessionId: 'sess-arch', isArchived: true }
    ]);
    assert.deepEqual([...archivedSessionIds({ root })], ['sess-arch']);
  });

  t('store root absent → empty set (fail open, hide nothing)', () => {
    const root = path.join(os.tmpdir(), 'cad-store-does-not-exist-' + Date.now());
    assert.deepEqual([...archivedSessionIds({ root })], []);
  });

  t('two account dirs under one install → records from both are read', () => {
    const root = makeStore([
      { install: 'i1', account: 'a1', local: 'u1', cliSessionId: 'sess-a', isArchived: true },
      { install: 'i1', account: 'a2', local: 'u2', cliSessionId: 'sess-b', isArchived: true }
    ]);
    assert.deepEqual([...archivedSessionIds({ root })].sort(), ['sess-a', 'sess-b']);
  });

  t('malformed record → skipped, the readable ones still returned', () => {
    const root = makeStore([
      { local: 'u1', raw: '{"isArchived": true, "cliSessionId": "sess-bad"' },
      { local: 'u2', cliSessionId: 'sess-arch', isArchived: true }
    ]);
    assert.deepEqual([...archivedSessionIds({ root })], ['sess-arch']);
  });

  t('non-record files in the store are ignored', () => {
    const root = makeStore([{ local: 'u1', cliSessionId: 'sess-arch', isArchived: true }]);
    fs.writeFileSync(path.join(root, 'install-1', 'account-1', 'other.json'), '{"isArchived":true,"cliSessionId":"nope"}');
    assert.deepEqual([...archivedSessionIds({ root })], ['sess-arch']);
  });

  t('archive flipped on with a bumped mtime → in the set on the next call', () => {
    const root = makeStore([{ local: 'u1', cliSessionId: 'sess-x', isArchived: false, mtimeMs: 1_000_000_000_000 }]);
    assert.deepEqual([...archivedSessionIds({ root })], []);
    writeRecord(root, { local: 'u1', cliSessionId: 'sess-x', isArchived: true, mtimeMs: 1_000_000_060_000 });
    assert.deepEqual([...archivedSessionIds({ root })], ['sess-x']);
  });

  t('unchanged mtime → record is not re-read (the cache is what makes the 3s poll affordable)', () => {
    const root = makeStore([{ local: 'u1', cliSessionId: 'sess-y', isArchived: false, mtimeMs: 1_000_000_000_000 }]);
    assert.deepEqual([...archivedSessionIds({ root })], []);
    // Same mtime, archived content: a re-read would find it, the cache must not.
    writeRecord(root, { local: 'u1', cliSessionId: 'sess-y', isArchived: true, mtimeMs: 1_000_000_000_000 });
    assert.deepEqual([...archivedSessionIds({ root })], [], 'cached verdict reused');
  });

  t('record deleted from the store → dropped from the set', () => {
    const root = makeStore([
      { local: 'u1', cliSessionId: 'sess-gone', isArchived: true },
      { local: 'u2', cliSessionId: 'sess-stay', isArchived: true }
    ]);
    assert.deepEqual([...archivedSessionIds({ root })].sort(), ['sess-gone', 'sess-stay']);
    fs.rmSync(recordPath(root, { local: 'u1' }));
    assert.deepEqual([...archivedSessionIds({ root })], ['sess-stay']);
  });

  t('appSessionsRoot: under the given home, macOS Application Support layout', () => {
    assert.equal(
      appSessionsRoot('/home/x'),
      path.join('/home/x', 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
    );
  });

  /* --------------------------------------------------------------- scanSessions */

  t('scanSessions: archived id is excluded from the session list', () => {
    const root = makeProjectsRoot([
      { dirName: '-tmp-one', id: 'sess-arch', mtimeMs: NOW - 60_000 },
      { dirName: '-tmp-two', id: 'sess-live', mtimeMs: NOW - 120_000 }
    ]);
    const out = scan.scanSessions(CFG, { root, now: NOW, liveCwds: null, archivedIds: new Set(['sess-arch']) });
    assert.deepEqual(out.sessions.map(s => s.id), ['sess-live']);
    assert.equal(out.totals.shown, 1);
  });

  t('scanSessions: no archivedIds (or null) → nothing is hidden', () => {
    const specs = [
      { dirName: '-tmp-one', id: 'sess-arch', mtimeMs: NOW - 60_000 },
      { dirName: '-tmp-two', id: 'sess-live', mtimeMs: NOW - 120_000 }
    ];
    const bare = scan.scanSessions(CFG, { root: makeProjectsRoot(specs), now: NOW, liveCwds: null });
    assert.deepEqual(bare.sessions.map(s => s.id), ['sess-arch', 'sess-live']);
    const nulled = scan.scanSessions(CFG, { root: makeProjectsRoot(specs), now: NOW, liveCwds: null, archivedIds: null });
    assert.deepEqual(nulled.sessions.map(s => s.id), ['sess-arch', 'sess-live']);
  });

  t('scanSessions: an archived transcript does not consume a maxSessions slot', () => {
    const root = makeProjectsRoot([
      { dirName: '-tmp-a', id: 'sess-arch', mtimeMs: NOW - 10_000 },
      { dirName: '-tmp-b', id: 'sess-b', mtimeMs: NOW - 20_000 },
      { dirName: '-tmp-c', id: 'sess-c', mtimeMs: NOW - 30_000 }
    ]);
    const out = scan.scanSessions({ ...CFG, maxSessions: 2 }, { root, now: NOW, liveCwds: null, archivedIds: new Set(['sess-arch']) });
    assert.deepEqual(out.sessions.map(s => s.id), ['sess-b', 'sess-c']);
  });

  /* ---------------------------------------------------------- recent projects */

  t('listRecentProjects: a project whose only recent session is archived drops out', () => {
    const root = makeProjectsRoot([
      { dirName: '-tmp-one', id: 'sess-arch', cwd: '/tmp/one', mtimeMs: NOW - 60_000 },
      { dirName: '-tmp-two', id: 'sess-live', cwd: '/tmp/two', mtimeMs: NOW - 120_000 }
    ]);
    const refs = mgmt.listRecentProjects(CFG, { root, now: NOW, archivedIds: new Set(['sess-arch']) });
    assert.deepEqual(refs.map(r => r.dirName), ['-tmp-two']);
  });

  t('listRecentProjects: a project keeps its unarchived session as the newest', () => {
    const root = makeProjectsRoot([
      { dirName: '-tmp-one', id: 'sess-arch', cwd: '/tmp/one', mtimeMs: NOW - 60_000 },
      { dirName: '-tmp-one', id: 'sess-live', cwd: '/tmp/one', mtimeMs: NOW - 600_000 }
    ]);
    const refs = mgmt.listRecentProjects(CFG, { root, now: NOW, archivedIds: new Set(['sess-arch']) });
    assert.deepEqual(refs.map(r => r.dirName), ['-tmp-one']);
    assert.equal(refs[0].lastActiveMs, NOW - 600_000, 'the archived one no longer dates the project');
  });

  t('listRecentProjects: no archivedIds → unchanged behaviour', () => {
    const root = makeProjectsRoot([
      { dirName: '-tmp-one', id: 'sess-arch', cwd: '/tmp/one', mtimeMs: NOW - 60_000 },
      { dirName: '-tmp-two', id: 'sess-live', cwd: '/tmp/two', mtimeMs: NOW - 120_000 }
    ]);
    const refs = mgmt.listRecentProjects(CFG, { root, now: NOW });
    assert.deepEqual(refs.map(r => r.dirName).sort(), ['-tmp-one', '-tmp-two']);
  });

  /* ------------------------------------------------------------------ reports */

  t('listReports still resolves a transcript whose session is archived', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ahome-'));
    const projDir = path.join(home, '.claude', 'projects', '-tmp-demo');
    fs.mkdirSync(projDir, { recursive: true });
    const id = 'abc12345-0000-1111-2222-333344445555';
    fs.writeFileSync(path.join(projDir, `${id}.jsonl`), JSON.stringify({
      cwd: '/tmp/demo',
      timestamp: '2026-07-12T10:00:00.000Z',
      message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100 }, content: [{ type: 'text', text: 'hi' }] }
    }));
    fs.writeFileSync(
      path.join(home, '.claude', 'session-analytics-log.md'),
      `- 2026-07-12 [demo] abc12345: 100 billable (1.00k ctx), top cost Read. Lesson: archived is not forgotten.`
    );
    // The store says this session is archived; analytics must not care.
    archivedSessionIds({ root: makeStore([{ local: 'u1', cliSessionId: id, isArchived: true }]) });
    const reports = listReports(5, { homeDir: home });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].sessionId, id);
    assert.ok(reports[0].analysis, 'analysis still computed for an archived session');
  });

  console.log(`  ${ok}/${n} passed`);
  return n - ok;
}
