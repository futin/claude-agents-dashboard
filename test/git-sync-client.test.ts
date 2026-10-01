/**
 * Client domain logic of the Git Sync button (`client/src/lib/gitSync.ts`, git-stats spec §9): who gets a button, the spawn request it posts, the phase
 * of a remembered run, the stored-runs parser and every string the button and its note show. All pure, so no React and no DOM.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LaunchingSession, RepoGitStats, Session, SessionsResponse } from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../client/src/lib/settings.js';
import { EFFORTS, MODELS, NAME_CAP, NAME_RE } from '../client/src/lib/spawnOptions.js';
import {
  GIT_SYNC_PROMPT, SYNC_NEEDS_TOKEN, SYNC_RUNS_KEY, SYNC_UNSEEN_TTL_MS,
  canSync, parseSyncRuns, runFor, syncButtonText, syncFailedText, syncLaunchErrorText, syncPhase, syncRequest, syncSessionName,
  type SyncPhase, type SyncRun,
} from '../client/src/lib/gitSync.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

function okRepo(name: string, over: Partial<Ok> = {}): Ok {
  return {
    dirName: name, name, path: `/p/${name}`, state: 'ok', toplevel: `/p/${name}`,
    branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
    trunk: 'main', hasOrigin: true, trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true },
    fetchedAtMs: null, branches: [], unmergedTotal: 0, mergedCount: 0,
    ...over,
  };
}

/** Only the fields `syncPhase` reads are meaningful; the rest satisfy the type. */
function session(id: string, status: Session['status']): Session {
  return { id, status } as Session;
}

function payload(sessions: Session[], launching?: LaunchingSession[]): SessionsResponse {
  return { sessions, launching } as SessionsResponse;
}

function launchingEntry(sessionId: string, state: LaunchingSession['state'], error?: string): LaunchingSession {
  const l: LaunchingSession = { sessionId, projectName: 'repo', projectPath: '/p/repo', prompt: GIT_SYNC_PROMPT, startedAtMs: 0, state };
  if (error !== undefined) l.error = error;
  return l;
}

const RUN: SyncRun = { sessionId: 's1', dirName: 'd1', name: 'repo', launchedAtMs: 1_000_000 };
const HOUR = 60 * 60 * 1000;
const SYNC_DEFAULTS = {
  syncModel: DEFAULT_SETTINGS.syncModel, syncEffort: DEFAULT_SETTINGS.syncEffort,
  syncPermissionMode: DEFAULT_SETTINGS.syncPermissionMode, syncRemoteControl: DEFAULT_SETTINGS.syncRemoteControl,
};

export function run(): number {
  console.log('\n=== client/lib/gitSync.ts ===\n');
  let p = 0;
  let f = 0;

  if (test('only an ok repo with an origin can sync', () => {
    assert.strictEqual(canSync(okRepo('a')), true);
    assert.strictEqual(canSync(okRepo('a', { hasOrigin: false })), false);
    assert.strictEqual(canSync({ dirName: 'a', name: 'a', path: null, state: 'missing' }), false);
    assert.strictEqual(canSync({ dirName: 'a', name: 'a', path: '/p/a', state: 'not-git' }), false);
    assert.strictEqual(canSync({ dirName: 'a', name: 'a', path: '/p/a', state: 'error', message: 'git status timed out after 5s' }), false);
  })) p++; else f++;

  if (test('defaults post the pin, the prompt, the name, auto and remote control, and no model or effort key', () => {
    assert.deepStrictEqual(syncRequest(okRepo('repo', { dirName: 'd1' }), SYNC_DEFAULTS, 'auto'), {
      project: 'd1', prompt: GIT_SYNC_PROMPT, name: 'git-sync repo', permissionMode: 'auto', remoteControl: true,
    });
  })) p++; else f++;

  if (test('session name keeps a plain repo name and dashes every character the server rejects', () => {
    assert.strictEqual(syncSessionName('claude-agents-dashboard'), 'git-sync claude-agents-dashboard');
    assert.strictEqual(syncSessionName('café+ü'), 'git-sync caf---');
  })) p++; else f++;

  if (test('a 70-character repo name is cut to the 60-character cap', () => {
    const name = syncSessionName('x'.repeat(70));
    assert.strictEqual(name.length, 60);
    assert.strictEqual(NAME_CAP, 60);
    assert.ok(name.startsWith('git-sync '));
  })) p++; else f++;

  if (test('every session name passes NAME_RE, and NAME_RE matches the server literal', () => {
    for (const n of ['claude-agents-dashboard', 'café+ü', 'x'.repeat(70)]) assert.ok(NAME_RE.test(syncSessionName(n)), n);
    const src = readFileSync(resolve(ROOT, 'server/lib/spawn.ts'), 'utf8');
    const m = src.match(/^const NAME_RE = \/(.+)\/;$/m);
    assert.ok(m, 'found the server NAME_RE line');
    assert.strictEqual(NAME_RE.source, m[1]);
  })) p++; else f++;

  if (test('a picked model and effort are both sent', () => {
    const req = syncRequest(okRepo('repo'), { ...SYNC_DEFAULTS, syncModel: MODELS[0], syncEffort: EFFORTS[0] }, 'auto');
    assert.strictEqual(req.model, MODELS[0]);
    assert.strictEqual(req.effort, EFFORTS[0]);
  })) p++; else f++;

  if (test('remote control off is sent as false', () => {
    assert.strictEqual(syncRequest(okRepo('repo'), { ...SYNC_DEFAULTS, syncRemoteControl: false }, 'auto').remoteControl, false);
  })) p++; else f++;

  if (test('a mode above the ceiling is sent as the ceiling', () => {
    assert.strictEqual(syncRequest(okRepo('repo'), { ...SYNC_DEFAULTS, syncPermissionMode: 'bypassPermissions' }, 'plan').permissionMode, 'plan');
  })) p++; else f++;

  if (test('an unknown ceiling clamps to auto', () => {
    assert.strictEqual(syncRequest(okRepo('repo'), { ...SYNC_DEFAULTS, syncPermissionMode: 'bypassPermissions' }, undefined).permissionMode, 'auto');
  })) p++; else f++;

  if (test('a mode below the ceiling is never raised', () => {
    assert.strictEqual(
      syncRequest(okRepo('repo'), { ...SYNC_DEFAULTS, syncPermissionMode: 'acceptEdits' }, 'bypassPermissions').permissionMode, 'acceptEdits'
    );
  })) p++; else f++;

  if (test('no payload yet reads unseen, never ended', () => {
    assert.deepStrictEqual(syncPhase(RUN, null, RUN.launchedAtMs + 48 * HOUR), { kind: 'unseen' });
  })) p++; else f++;

  if (test('a launching entry reads launching', () => {
    assert.deepStrictEqual(syncPhase(RUN, payload([], [launchingEntry('s1', 'launching')]), RUN.launchedAtMs), { kind: 'launching' });
  })) p++; else f++;

  if (test('a failed launch reads failed with its error, or null without one', () => {
    assert.deepStrictEqual(syncPhase(RUN, payload([], [launchingEntry('s1', 'failed', 'boom')]), RUN.launchedAtMs), { kind: 'failed', error: 'boom' });
    assert.deepStrictEqual(syncPhase(RUN, payload([], [launchingEntry('s1', 'failed')]), RUN.launchedAtMs), { kind: 'failed', error: null });
  })) p++; else f++;

  if (test('a working or question row reads running and carries the row', () => {
    const working = session('s1', 'working');
    assert.deepStrictEqual(syncPhase(RUN, payload([working]), RUN.launchedAtMs), { kind: 'running', session: working });
    assert.strictEqual(syncPhase(RUN, payload([session('s1', 'question')]), RUN.launchedAtMs).kind, 'running');
  })) p++; else f++;

  if (test('a run missing from the payload an hour in reads unseen', () => {
    assert.deepStrictEqual(syncPhase(RUN, payload([]), RUN.launchedAtMs + HOUR), { kind: 'unseen' });
  })) p++; else f++;

  if (test('unseen holds until exactly 24h, then ends', () => {
    assert.strictEqual(SYNC_UNSEEN_TTL_MS, 24 * HOUR);
    assert.deepStrictEqual(syncPhase(RUN, payload([]), RUN.launchedAtMs + 24 * HOUR - 1), { kind: 'unseen' });
    assert.deepStrictEqual(syncPhase(RUN, payload([]), RUN.launchedAtMs + 24 * HOUR), { kind: 'ended' });
  })) p++; else f++;

  if (test('an idle or incomplete row reads ended', () => {
    assert.deepStrictEqual(syncPhase(RUN, payload([session('s1', 'idle')]), RUN.launchedAtMs), { kind: 'ended' });
    assert.deepStrictEqual(syncPhase(RUN, payload([session('s1', 'incomplete')]), RUN.launchedAtMs), { kind: 'ended' });
  })) p++; else f++;

  if (test("another session's row does not decide this run", () => {
    assert.deepStrictEqual(syncPhase(RUN, payload([session('s2', 'idle')]), RUN.launchedAtMs + HOUR), { kind: 'unseen' });
  })) p++; else f++;

  if (test('a launching entry beats a row for the same id', () => {
    assert.deepStrictEqual(
      syncPhase(RUN, payload([session('s1', 'idle')], [launchingEntry('s1', 'launching')]), RUN.launchedAtMs), { kind: 'launching' }
    );
  })) p++; else f++;

  if (test('two pins on one toplevel share one run; a non-ok repo has none', () => {
    const runs = { '/p/root': RUN };
    const a = okRepo('a', { dirName: 'da', toplevel: '/p/root' });
    const b = okRepo('b', { dirName: 'db', toplevel: '/p/root' });
    assert.strictEqual(runFor(runs, a), RUN);
    assert.strictEqual(runFor(runs, b), RUN);
    assert.strictEqual(runFor(runs, { dirName: 'da', name: 'a', path: null, state: 'missing' }), null);
  })) p++; else f++;

  if (test('a stored blob that is not a plain object parses to {}', () => {
    for (const raw of [null, 'x', [], 42]) assert.deepStrictEqual(parseSyncRuns(raw), {}, JSON.stringify(raw));
  })) p++; else f++;

  if (test('a valid two-entry blob parses unchanged', () => {
    const raw = { '/p/a': RUN, '/p/b': { ...RUN, sessionId: 's2', dirName: 'd2' } };
    assert.deepStrictEqual(parseSyncRuns(raw), raw);
  })) p++; else f++;

  if (test('an entry with a non-number launchedAtMs is dropped, its sibling kept', () => {
    assert.deepStrictEqual(parseSyncRuns({ '/p/a': RUN, '/p/b': { ...RUN, launchedAtMs: 'soon' } }), { '/p/a': RUN });
  })) p++; else f++;

  if (test('an entry missing name is dropped', () => {
    const { name: _drop, ...noName } = RUN;
    assert.deepStrictEqual(parseSyncRuns({ '/p/a': noName }), {});
  })) p++; else f++;

  if (test('an entry under the empty key is dropped', () => {
    assert.deepStrictEqual(parseSyncRuns({ '': RUN }), {});
  })) p++; else f++;

  if (test('button text for every phase', () => {
    const running: SyncPhase = { kind: 'running', session: session('s1', 'working') };
    assert.strictEqual(syncButtonText(null, false), 'Sync');
    assert.strictEqual(syncButtonText(null, true), 'Starting…');
    assert.strictEqual(syncButtonText(running, false), 'Syncing · open');
    assert.strictEqual(syncButtonText({ kind: 'launching' }, false), 'Syncing…');
    assert.strictEqual(syncButtonText({ kind: 'unseen' }, false), 'Syncing…');
    assert.strictEqual(syncButtonText({ kind: 'ended' }, false), 'Sync');
    assert.strictEqual(syncButtonText({ kind: 'failed', error: null }, false), 'Sync');
  })) p++; else f++;

  if (test('failed-launch note, with and without an error', () => {
    assert.strictEqual(syncFailedText('repo', 'boom'), 'git-sync in repo failed to start: boom');
    assert.strictEqual(syncFailedText('repo', null), 'git-sync in repo failed to start.');
  })) p++; else f++;

  if (test('launch-error note', () => {
    assert.strictEqual(syncLaunchErrorText('repo', 'unknown project'), "Sync in repo couldn't start: unknown project");
  })) p++; else f++;

  if (test('the 403 note names where the token is set', () => {
    assert.strictEqual(SYNC_NEEDS_TOKEN, 'Sync needs the Answer token — set it under Settings › Local › Connection.');
  })) p++; else f++;

  if (test('the runs key is management.syncRuns', () => {
    assert.strictEqual(SYNC_RUNS_KEY, 'management.syncRuns');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
