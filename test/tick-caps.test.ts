/**
 * server/lib/tick-caps.ts — the `tick-capped` push: `decideTickCapped` over hand-built readings, the `last-decide.json` reader over a tmpdir tick home, and
 * the `foldTickCaps` shell with the owner check, the ledger file and the ntfy transport all pointed at fakes.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from '../server/lib/config.js';
import { resetEnvBaseline } from '../server/lib/config.js';
import { resetNotify, setSender } from '../server/lib/notify.js';
import type { NotifyPayload } from '../server/lib/notify.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';
import {
  decideTickCapped, foldTickCaps, readTickReadings, resetTickCapsMemory, setTickCapsFile, setTickCapsOwner, setTickHome, TICK_FRESH_MS
} from '../server/lib/tick-caps.js';
import type { TickCapLedger, TickReading } from '../server/lib/tick-caps.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const NOW = Date.parse('2026-10-28T09:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ROOT = '/Users/x/proj';
const EMPTY: TickCapLedger = { projects: {} };

const reading = (planReview: number, maxPlans = 3, over: Partial<TickReading> = {}): TickReading =>
  ({ root: ROOT, name: 'proj', at: new Date(NOW - MIN).toISOString(), planReview, maxPlans, ...over });

/** Feeds one reading set per step, each a minute after the last, and collects how many pushes each step produced. */
function feed(steps: { readings: TickReading[]; canSend?: boolean }[], start: TickCapLedger = EMPTY): { counts: number[]; ledger: TickCapLedger } {
  let ledger = start;
  const counts: number[] = [];
  steps.forEach((s, i) => {
    const out = decideTickCapped(ledger, s.readings, s.canSend ?? true, NOW + i * MIN);
    counts.push(out.pushes.length);
    ledger = out.ledger;
  });
  return { counts, ledger };
}

function conf(over: Partial<Config> = {}): Config {
  return { ntfyTopic: 'test-topic', ntfyServer: 'https://ntfy.example', publicUrl: 'https://dash.example', backlogBoardUrl: '', ...over } as Config;
}

function writeDecide(home: string, root: string, body: unknown): void {
  const dir = path.join(home, encodeURIComponent(root));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-decide.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

const decide = (planReview: unknown, maxPlans: unknown = 3, at: unknown = new Date(NOW - MIN).toISOString()) =>
  ({ at, verdict: 'idle', caps: { openPrs: 0, maxPrs: 2, planReview, maxPlans } });

interface Shell { sent: NotifyPayload[]; home: string; file: string }

/** The shell with every outside thing in a tmpdir: settings (cwd-relative), the tick home, the ledger file, the transport. Owner, checkbox on. */
function shell(name: string, fn: (s: Shell) => void): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tick-caps-'));
  const prev = process.cwd();
  const home = path.join(dir, 'tick');
  const file = path.join(dir, 'state', 'tick-capped.json');
  const sent: NotifyPayload[] = [];
  try {
    process.chdir(dir);
    fs.mkdirSync(home);
    resetSettings();
    resetNotify();
    resetEnvBaseline();
    setSender(payload => { sent.push(payload); });
    setTickHome(home);
    setTickCapsFile(file);
    setTickCapsOwner(() => true);
    resetTickCapsMemory();
    setSettings({ notify: { enabled: true, events: { 'tick-capped': true } } });
    return test(name, () => fn({ sent, home, file }));
  } finally {
    process.chdir(prev);
    setTickHome(null);
    setTickCapsFile(null);
    setTickCapsOwner(null);
    resetTickCapsMemory();
    resetNotify();
    resetSettings();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function run(): number {
  let p = 0, f = 0;
  console.log('\n=== tick-caps.ts ===\n');

  if (test('decide: 2/3 with no entry → no push, ledger unchanged', () => {
    const { counts, ledger } = feed([{ readings: [reading(2)] }]);
    assert.deepStrictEqual(counts, [0]);
    assert.deepStrictEqual(ledger, EMPTY);
  })) p++; else f++;

  if (test('decide: 3/3 fresh with canSend → one push naming the project and 3/3, entry pushed', () => {
    const out = decideTickCapped(EMPTY, [reading(3)], true, NOW);
    assert.deepStrictEqual(out.pushes, [{ root: ROOT, title: 'proj · backlog tick blocked', body: '3/3 plans awaiting review — approve one to resume grooming' }]);
    assert.strictEqual(out.ledger.projects[ROOT].pushed, true);
    assert.deepStrictEqual(EMPTY, { projects: {} }, 'the input ledger is never mutated');
  })) p++; else f++;

  if (test('decide: still capped with a later at → no second push', () => {
    const later = new Date(NOW + 10 * MIN).toISOString();
    assert.deepStrictEqual(feed([{ readings: [reading(3)] }, { readings: [reading(3, 3, { at: later })] }]).counts, [1, 0]);
  })) p++; else f++;

  if (test('decide: drop below the cap removes the entry, reaching it again pushes again', () => {
    const { counts, ledger } = feed([{ readings: [reading(3)] }, { readings: [reading(2)] }, { readings: [reading(3)] }]);
    assert.deepStrictEqual(counts, [1, 0, 1]);
    assert.strictEqual(ledger.projects[ROOT].pushed, true);
    assert.deepStrictEqual(feed([{ readings: [reading(3)] }, { readings: [reading(2)] }]).ledger, EMPTY);
  })) p++; else f++;

  if (test('decide: 4/3 counts as capped, 0/0 never does', () => {
    assert.deepStrictEqual(feed([{ readings: [reading(4)] }]).counts, [1]);
    const zero = feed([{ readings: [reading(0, 0)] }]);
    assert.deepStrictEqual(zero.counts, [0]);
    assert.deepStrictEqual(zero.ledger, EMPTY);
  })) p++; else f++;

  if (test('decide: capped with canSend false records unpushed, and turning it on mid-episode still pushes nothing', () => {
    const first = feed([{ readings: [reading(3)], canSend: false }]);
    assert.strictEqual(first.ledger.projects[ROOT].pushed, false);
    assert.deepStrictEqual(feed([{ readings: [reading(3)], canSend: false }, { readings: [reading(3)], canSend: true }]).counts, [0, 0]);
  })) p++; else f++;

  if (test('decide: a capped reading 25 h old is recorded without a push', () => {
    const old = new Date(NOW - 25 * HOUR).toISOString();
    const out = decideTickCapped(EMPTY, [reading(3, 3, { at: old })], true, NOW);
    assert.deepStrictEqual(out.pushes, []);
    assert.strictEqual(out.ledger.projects[ROOT].pushed, false);
    const edge = new Date(NOW - TICK_FRESH_MS).toISOString();
    assert.strictEqual(decideTickCapped(EMPTY, [reading(3, 3, { at: edge })], true, NOW).pushes.length, 1, 'exactly 24 h is still fresh');
  })) p++; else f++;

  if (test('decide: two projects, one capped and one not → exactly one push', () => {
    const other = reading(1, 3, { root: '/Users/x/other', name: 'other' });
    const out = decideTickCapped(EMPTY, [reading(3), other], true, NOW);
    assert.deepStrictEqual(out.pushes.map(x => x.root), [ROOT]);
    assert.deepStrictEqual(Object.keys(out.ledger.projects), [ROOT]);
  })) p++; else f++;

  if (test('decide: an entry whose project has no reading is dropped', () => {
    const start: TickCapLedger = { projects: { '/gone': { cappedAt: new Date(NOW).toISOString(), pushed: true } } };
    const out = decideTickCapped(start, [], true, NOW);
    assert.deepStrictEqual(out.ledger, EMPTY);
    assert.deepStrictEqual(out.pushes, []);
  })) p++; else f++;

  if (test('reader: the dir name decodes to the root, its basename is the name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tick-home-'));
    try {
      writeDecide(home, '/Users/x/proj', decide(2, 3, '2026-10-28T08:59:00.000Z'));
      assert.deepStrictEqual(readTickReadings(home), [
        { root: '/Users/x/proj', name: 'proj', at: '2026-10-28T08:59:00.000Z', planReview: 2, maxPlans: 3 }
      ]);
      assert.ok(fs.readdirSync(home).includes('%2FUsers%2Fx%2Fproj'));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  })) p++; else f++;

  if (test('reader: a missing home reads as no projects', () => {
    assert.deepStrictEqual(readTickReadings(path.join(os.tmpdir(), 'cad-tick-home-missing-' + process.pid)), []);
  })) p++; else f++;

  if (test('reader: malformed files are skipped while a valid sibling is read', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tick-home-'));
    try {
      writeDecide(home, '/a/array', [decide(3)]);
      writeDecide(home, '/a/nocaps', { at: new Date(NOW).toISOString(), verdict: 'idle' });
      writeDecide(home, '/a/string', decide('3'));
      writeDecide(home, '/a/negative', decide(-1));
      writeDecide(home, '/a/fraction', decide(1.5));
      writeDecide(home, '/a/badmax', decide(3, -3));
      writeDecide(home, '/a/badat', decide(3, 3, 'not a date'));
      writeDecide(home, '/a/notjson', '{not json');
      fs.mkdirSync(path.join(home, encodeURIComponent('/a/nofile')));
      fs.mkdirSync(path.join(home, '%E0%A4%A'));
      writeDecide(home, '/a/good', decide(3));
      assert.deepStrictEqual(readTickReadings(home).map(r => r.root), ['/a/good']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  })) p++; else f++;

  if (shell('shell: a capped project pushes once, with the project name and N/N', ({ sent, home }) => {
    writeDecide(home, ROOT, decide(3));
    foldTickCaps(conf(), NOW);
    foldTickCaps(conf(), NOW + MIN);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual({ title: sent[0].title, body: sent[0].body, tags: sent[0].tags, click: sent[0].click }, {
      title: 'proj · backlog tick blocked', body: '3/3 plans awaiting review — approve one to resume grooming', tags: 'hourglass',
      click: 'https://dash.example/?view=routines'
    });
  })) p++; else f++;

  if (shell('shell: a non-owner reads and sends nothing', ({ sent, home, file }) => {
    setTickCapsOwner(() => false);
    writeDecide(home, ROOT, decide(3));
    foldTickCaps(conf(), NOW);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(fs.existsSync(file), false);
  })) p++; else f++;

  if (shell('shell: two calls 10 s apart make one pass', ({ sent, home }) => {
    foldTickCaps(conf(), NOW);
    writeDecide(home, ROOT, decide(3));
    foldTickCaps(conf(), NOW + 10_000);
    assert.strictEqual(sent.length, 0, 'the second call was throttled');
    foldTickCaps(conf(), NOW + 31_000);
    assert.strictEqual(sent.length, 1);
  })) p++; else f++;

  if (shell('shell: the ledger survives a restart, so a capped episode is not re-pushed', ({ sent, home, file }) => {
    writeDecide(home, ROOT, decide(3));
    foldTickCaps(conf(), NOW);
    assert.ok(fs.existsSync(file));
    resetTickCapsMemory();
    foldTickCaps(conf(), NOW + MIN);
    assert.strictEqual(sent.length, 1);
  })) p++; else f++;

  if (shell('shell: a failed ledger write still never pushes the same episode twice, and never throws', ({ sent, home, file }) => {
    const ro = path.dirname(file);
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o555);
    try {
      writeDecide(home, ROOT, decide(3));
      foldTickCaps(conf(), NOW);
      foldTickCaps(conf(), NOW + MIN);
      foldTickCaps(conf(), NOW + 2 * MIN);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(fs.existsSync(file), false);
    } finally {
      fs.chmodSync(ro, 0o755);
    }
  })) p++; else f++;

  if (shell('shell: checkbox off records the episode unpushed', ({ sent, home }) => {
    setSettings({ notify: { events: { 'tick-capped': false } } });
    writeDecide(home, ROOT, decide(3));
    foldTickCaps(conf(), NOW);
    setSettings({ notify: { events: { 'tick-capped': true } } });
    foldTickCaps(conf(), NOW + MIN);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  console.log(`  ${p} passed, ${f} failed`);
  return f;
}
