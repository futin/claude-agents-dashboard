/**
 * Pins the split behind the docs' two write terms (`docs/subsystems/remote-access.md` §Who may write) against `server/api.ts` itself.
 *
 * Every POST handler that writes calls `refuseWrite` — the write gate. A **session write path** also checks the remote-answer switch before the gate; a
 * **gate-only write** does not. The docs count four session write paths by feature (answer, plan, message, spawn) and list the rest as gate-only, and they
 * drifted once already: the route table called pins and git fetch "write path" too, and "token-guarded" outlived #223. Moving a handler from one set to
 * the other is a security-posture change, so this test fails until the lists below — and the docs that mirror them — are updated in the same change.
 *
 * Source text, not behaviour, on purpose: the per-route behaviour is already covered by the api-* suites; what nothing else pins is which handlers sit
 * in which set.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './docs-links.test.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const GATE = 'refuseWrite(config, req, res)';

/** answer, plan, message and spawn handlers, plus `serveTranscribe` — dictation rides the switch but acts on no session, so it is not a fifth path. */
const SESSION_WRITE_PATHS = [
  'serveMessageWait', 'servePlanWait', 'serveQuestionWait', 'serveSessionAnswer', 'serveSessionMessageAnswer',
  'serveSessionPlanAnswer', 'serveSessionStop', 'serveSpawn', 'serveSpawnStop', 'serveTranscribe',
];

const GATE_ONLY_WRITES = [
  'serveCodegraphRun', 'serveGitFetch', 'serveNotifyEvent', 'serveNotifyTest', 'serveOpenFolder',
  'servePermissionNotify', 'servePinsOrder', 'servePinsWrite', 'serveRemoteAnswerToggle', 'serveSettingsWrite',
];

/** Each exported `serve*` function's text, from its `export` line up to the next top-level `export`. */
export function serveBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...src.matchAll(/^export (?:async )?function (serve\w+)/gm)];
  const exportAt = [...src.matchAll(/^export /gm)].map((m) => m.index!);
  for (const m of starts) {
    const end = exportAt.find((i) => i > m.index!) ?? src.length;
    out.set(m[1], src.slice(m.index!, end));
  }
  return out;
}

/** Splits the gated handlers by whether a `remoteAnswer)` switch check comes before the gate call. */
export function classify(src: string): { session: string[]; gateOnly: string[] } {
  const session: string[] = [];
  const gateOnly: string[] = [];
  for (const [name, body] of serveBodies(src)) {
    const gate = body.indexOf(GATE);
    if (gate < 0) continue;
    (body.slice(0, gate).includes('remoteAnswer)') ? session : gateOnly).push(name);
  }
  return { session: session.sort(), gateOnly: gateOnly.sort() };
}

export function run(): number {
  console.log('\nwrite paths (session write paths vs gate-only writes)');
  let p = 0;
  let f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  const src = fs.readFileSync(path.join(root, 'server/api.ts'), 'utf8');
  const { session, gateOnly } = classify(src);

  if (test('session write paths: exactly the handlers that check the remote-answer switch before the write gate', () => {
    assert.deepStrictEqual(session, SESSION_WRITE_PATHS);
  })) p++; else f++;

  if (test('gate-only writes: exactly the gated handlers that skip the switch', () => {
    assert.deepStrictEqual(gateOnly, GATE_ONLY_WRITES);
  })) p++; else f++;

  if (test('every gate call sits in a classified serve* handler', () => {
    const total = SESSION_WRITE_PATHS.length + GATE_ONLY_WRITES.length;
    assert.strictEqual(session.length + gateOnly.length, total);
    assert.strictEqual(src.split(GATE).length - 1, total, `${GATE} appears outside the classified handlers, or twice in one`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
