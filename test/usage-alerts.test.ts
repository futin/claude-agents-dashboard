/**
 * usage-alerts.ts — the 5-hour limit detector. The pure decision (`decideUsageAlert`) and the push copy are exercised here with hand-built readings;
 * one window per account, stamps jittered the way the real endpoint jitters them.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UsageLimits } from '../shared/types.js';
import { clearAccountCache } from '../server/lib/account.js';
import type { Config } from '../server/lib/config.js';
import { resetEnvBaseline } from '../server/lib/config.js';
import { resetNotify, setLabelResolver, setSender } from '../server/lib/notify.js';
import type { NotifyPayload } from '../server/lib/notify.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';
import {
  RESET_STALE_MS, armUsageAlerts, decideUsageAlert, onUsageReading, resetUsageAlertsMemory, setUsageAlertsFile, setUsageAlertsHome, usageAlertCopy
} from '../server/lib/usage-alerts.js';
import type { UsageAlertKind, UsageAlertLedger, UsageReading } from '../server/lib/usage-alerts.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const S = '2026-10-20T15:00:00.123Z';
const S_MS = Date.parse(S);
const shift = (ms: number): string => new Date(S_MS + ms).toISOString();
const ACC = 'a@x';
const ALL: Record<UsageAlertKind, boolean> = { reached: true, reset: true };

interface Step {
  utilization?: number | null;
  resetsAt?: string | null;
  t?: number;
  account?: string;
  ok?: boolean;
  can?: Record<UsageAlertKind, boolean>;
}

/**
 * Feeds the steps in order. A step without `t` lands one minute after the one before; the first defaults to `S − 4 h`, so an untimed sequence stays inside
 * the window and well clear of `RESET_STALE_MS`.
 */
function feed(steps: Step[], start: UsageAlertLedger = { windows: {} }): { pushes: (UsageAlertKind | null)[]; ledger: UsageAlertLedger } {
  let ledger = start;
  let t = S_MS - 4 * HOUR - MIN;
  const pushes: (UsageAlertKind | null)[] = [];
  for (const s of steps) {
    t = s.t ?? t + MIN;
    const reading: UsageReading = {
      t,
      account: s.account ?? ACC,
      utilization: s.utilization === undefined ? 100 : s.utilization,
      resetsAt: s.resetsAt === undefined ? S : s.resetsAt,
      ok: s.ok ?? true
    };
    const out = decideUsageAlert(ledger, reading, s.can ?? ALL);
    pushes.push(out.push);
    ledger = out.ledger;
  }
  return { pushes, ledger };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as object)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function conf(over: Partial<Config> = {}): Config {
  return { showUsage: true, ntfyTopic: 'test-topic', ntfyServer: 'https://ntfy.example', publicUrl: 'https://dash.example', ...over } as Config;
}

const limits = (utilization: number, resetsAt: string | null = S): UsageLimits =>
  ({ fiveHour: { utilization, resetsAt }, sevenDay: { utilization: 10, resetsAt: null } }) as UsageLimits;

function writeProfile(home: string, account: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'A', ...account } }));
  clearAccountCache();
}

interface Shell { sent: NotifyPayload[]; dir: string; home: string; file: string }

/**
 * The I/O shell with every outside thing pointed into a tmpdir: settings (cwd-relative), the account profile (a fixture home), the ledger file, and the
 * ntfy transport (a recorder). Armed, recording on, both checkboxes ticked; a case changes what it is about.
 */
function shell(name: string, fn: (s: Shell) => void): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-usage-alerts-'));
  const prev = process.cwd();
  const home = path.join(dir, 'home');
  const file = path.join(dir, 'state', 'usage-alerts.json');
  const sent: NotifyPayload[] = [];
  try {
    process.chdir(dir);
    fs.mkdirSync(home);
    resetSettings();
    resetNotify();
    resetEnvBaseline();
    setSender(payload => { sent.push(payload); });
    setLabelResolver(() => 'demo-project');
    writeProfile(home, { emailAddress: ACC, hasExtraUsageEnabled: false });
    setUsageAlertsHome(home);
    setUsageAlertsFile(file);
    resetUsageAlertsMemory();
    setSettings({ recordUsageHistory: true, notify: { enabled: true, events: { 'usage-limit': true, 'usage-reset': true } } });
    armUsageAlerts(conf());
    return test(name, () => fn({ sent, dir, home, file }));
  } finally {
    process.chdir(prev);
    armUsageAlerts(null);
    setUsageAlertsFile(null);
    setUsageAlertsHome(null);
    resetUsageAlertsMemory();
    clearAccountCache();
    resetNotify();
    resetSettings();
  }
}

const T = S_MS - 4 * HOUR;

export function run(): number {
  let p = 0, f = 0;
  console.log('\nusage-alerts');

  if (test('99% never alerts', () => {
    const { pushes, ledger } = feed([{ utilization: 99 }, { utilization: 99.9 }]);
    assert.deepStrictEqual(pushes, [null, null]);
    assert.deepStrictEqual(ledger, { windows: {} });
  })) p++; else f++;

  if (test('first 100 pushes reached', () => {
    const { pushes, ledger } = feed([{ utilization: 100 }]);
    assert.deepStrictEqual(pushes, ['reached']);
    assert.strictEqual(ledger.windows[ACC].stamp, S);
    assert.strictEqual(ledger.windows[ACC].pushed, true);
    assert.strictEqual(ledger.windows[ACC].resetSent, false);
  })) p++; else f++;

  if (test('over 100 counts as a hit', () => {
    assert.deepStrictEqual(feed([{ utilization: 104 }]).pushes, ['reached']);
  })) p++; else f++;

  if (test('the input ledger is never mutated', () => {
    const first = feed([{ utilization: 100 }]).ledger;
    const before = JSON.stringify(first);
    deepFreeze(first);
    feed([{ utilization: 20, t: S_MS + MIN }], first);
    feed([{ utilization: 100, resetsAt: shift(5 * HOUR), t: S_MS + MIN }], first);
    feed([{ utilization: 20, account: 'b@x' }], first);
    assert.strictEqual(JSON.stringify(first), before);
  })) p++; else f++;

  if (test('jitter keeps one window', () => {
    const { pushes } = feed([{ resetsAt: S }, { resetsAt: shift(400) }, { resetsAt: shift(-850) }]);
    assert.deepStrictEqual(pushes, ['reached', null, null]);
  })) p++; else f++;

  if (test('reset by new window', () => {
    const { pushes } = feed([
      { utilization: 100 },
      { utilization: 60, resetsAt: shift(5 * HOUR), t: S_MS + MIN },
      { utilization: 70, resetsAt: shift(5 * HOUR), t: S_MS + 2 * MIN }
    ]);
    assert.deepStrictEqual(pushes, ['reached', 'reset', null]);
  })) p++; else f++;

  if (test('reset by time', () => {
    const { pushes, ledger } = feed([{ utilization: 100 }, { utilization: 40, resetsAt: S, t: S_MS + MIN }]);
    assert.deepStrictEqual(pushes, ['reached', 'reset']);
    assert.strictEqual(ledger.windows[ACC].resetSent, true);
  })) p++; else f++;

  if (test('drop before the stamp is not a reset', () => {
    const { pushes } = feed([{ utilization: 100 }, { utilization: 95, resetsAt: S, t: S_MS - MIN }]);
    assert.deepStrictEqual(pushes, ['reached', null]);
  })) p++; else f++;

  if (test('changed stamp at 100 is a new hit, not a reset', () => {
    const later = shift(5 * HOUR);
    const { pushes, ledger } = feed([
      { utilization: 100 },
      { utilization: 100, resetsAt: later, t: S_MS + MIN },
      { utilization: 50, resetsAt: later, t: S_MS + 2 * MIN }
    ]);
    assert.deepStrictEqual(pushes, ['reached', 'reached', null]);
    assert.strictEqual(ledger.windows[ACC].stamp, later);
    assert.strictEqual(ledger.windows[ACC].resetSent, false);
  })) p++; else f++;

  if (test('unscoped hit then unscoped drop resets', () => {
    const { pushes } = feed([{ utilization: 100, resetsAt: null }, { utilization: 30, resetsAt: null }]);
    assert.deepStrictEqual(pushes, ['reached', 'reset']);
  })) p++; else f++;

  if (test('unscoped hit then scoped 100 is a new hit', () => {
    const { pushes } = feed([{ utilization: 100, resetsAt: null }, { utilization: 100, resetsAt: S }]);
    assert.deepStrictEqual(pushes, ['reached', 'reached']);
  })) p++; else f++;

  if (test('no-reading in between changes nothing', () => {
    const { pushes } = feed([
      { utilization: 100 },
      { utilization: 0, ok: false },
      { utilization: null },
      { utilization: 0, account: '' },
      { utilization: 100 }
    ]);
    assert.deepStrictEqual(pushes, ['reached', null, null, null, null]);
  })) p++; else f++;

  if (test('a failed read never deletes the record (no account switch)', () => {
    const { ledger } = feed([{ utilization: 100 }, { utilization: 0, ok: false, account: 'b@x' }]);
    assert.ok(ledger.windows[ACC]);
  })) p++; else f++;

  if (test('hit seen while off is recorded, not pushed', () => {
    const off = { reached: false, reset: true };
    const { pushes, ledger } = feed([
      { utilization: 100, can: off },
      { utilization: 100 },
      { utilization: 20, resetsAt: S, t: S_MS + MIN }
    ]);
    assert.deepStrictEqual(pushes, [null, null, null]);
    assert.strictEqual(ledger.windows[ACC].pushed, false);
    assert.strictEqual(ledger.windows[ACC].resetSent, true);
  })) p++; else f++;

  if (test('reset push needs the reset checkbox', () => {
    const { pushes, ledger } = feed([
      { utilization: 100 },
      { utilization: 20, resetsAt: S, t: S_MS + MIN, can: { reached: true, reset: false } }
    ]);
    assert.deepStrictEqual(pushes, ['reached', null]);
    assert.strictEqual(ledger.windows[ACC].resetSent, true);
  })) p++; else f++;

  if (test('account switch deletes the pending record', () => {
    const { pushes, ledger } = feed([
      { utilization: 100 },
      { utilization: 10, account: 'b@x', resetsAt: shift(5 * HOUR), t: S_MS + MIN },
      { utilization: 10, resetsAt: shift(5 * HOUR), t: S_MS + 2 * MIN }
    ]);
    assert.deepStrictEqual(pushes, ['reached', null, null]);
    assert.strictEqual(ledger.windows[ACC], undefined);
  })) p++; else f++;

  if (test('stale reset is retired silently', () => {
    const { pushes, ledger } = feed([{ utilization: 100 }, { utilization: 10, resetsAt: S, t: S_MS + 61 * MIN }]);
    assert.deepStrictEqual(pushes, ['reached', null]);
    assert.strictEqual(ledger.windows[ACC].resetSent, true);
  })) p++; else f++;

  if (test('unscoped reset seen after a long gap is retired silently', () => {
    const t0 = S_MS - 4 * HOUR;
    const { pushes, ledger } = feed([{ utilization: 100, resetsAt: null, t: t0 }, { utilization: 10, resetsAt: null, t: t0 + 61 * MIN }]);
    assert.deepStrictEqual(pushes, ['reached', null]);
    assert.strictEqual(ledger.windows[ACC].resetSent, true);
  })) p++; else f++;

  if (test('a reset just inside the cut-off still pushes', () => {
    const { pushes } = feed([{ utilization: 100 }, { utilization: 10, resetsAt: S, t: S_MS + RESET_STALE_MS }]);
    assert.deepStrictEqual(pushes, ['reached', 'reset']);
  })) p++; else f++;

  if (test('late reading is ignored', () => {
    const t0 = S_MS - 4 * HOUR;
    const { pushes } = feed([
      { utilization: 100, t: t0 + 10 * MIN },
      { utilization: 20, resetsAt: shift(5 * HOUR), t: t0 + 5 * MIN },
      { utilization: 20, resetsAt: shift(5 * HOUR), t: S_MS + MIN }
    ]);
    assert.deepStrictEqual(pushes, ['reached', null, 'reset']);
  })) p++; else f++;

  if (test('copy: reached and reset, every variant', () => {
    const now = new Date(2026, 9, 20, 10).getTime();
    const today = new Date(2026, 9, 20, 14, 30).toISOString();
    const tomorrow = new Date(2026, 9, 21, 9, 10).toISOString();
    const reached = (resetsAt: string | null, extraUsage = false) => usageAlertCopy('reached', { resetsAt, extraUsage, now });
    assert.deepStrictEqual(reached(today), { title: '5-hour limit reached', body: 'Resets at 14:30.' });
    assert.strictEqual(reached(tomorrow).body, 'Resets Wed at 09:10.');
    assert.strictEqual(reached(null).body, 'No reset time reported.');
    assert.strictEqual(reached(today, true).body, 'Resets at 14:30. Extra usage is on: you are now billed.');
    assert.strictEqual(reached(null, true).body, 'No reset time reported. Extra usage is on: you are now billed.');
    assert.deepStrictEqual(usageAlertCopy('reset', { resetsAt: null, extraUsage: false, now }),
      { title: '5-hour limit reset', body: 'Usage is available again.' });
    assert.strictEqual(usageAlertCopy('reset', { resetsAt: today, extraUsage: true, now }).body, 'Back on plan usage: extra-usage billing stops.');
  })) p++; else f++;

  if (shell('shell: unarmed sends nothing', ({ sent }) => {
    armUsageAlerts(null);
    onUsageReading(limits(100), T);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  if (shell('shell: recording off sends nothing', ({ sent }) => {
    setSettings({ recordUsageHistory: false });
    onUsageReading(limits(100), T);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  if (shell('shell: showUsage off sends nothing', ({ sent }) => {
    armUsageAlerts(conf({ showUsage: false }));
    onUsageReading(limits(100), T);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  if (shell('shell: no account email sends nothing', ({ sent, home }) => {
    writeProfile(home, { emailAddress: '' });
    onUsageReading(limits(100), T);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  if (shell('shell: readings below 100 never create the ledger file', ({ sent, file }) => {
    onUsageReading(limits(40), T);
    onUsageReading(null, T + MIN);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(fs.existsSync(file), false);
  })) p++; else f++;

  if (shell('shell: hit sends one reached push to the phone with ?view=usage', ({ sent, file }) => {
    onUsageReading(limits(100), T);
    onUsageReading(limits(100), T + MIN);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].title, '5-hour limit reached');
    assert.strictEqual(sent[0].tags, 'no_entry');
    assert.strictEqual(sent[0].topic, 'test-topic');
    assert.ok(sent[0].click.endsWith('/?view=usage'), sent[0].click);
    assert.match(sent[0].body, /^Resets (\w{3} )?at \d\d:\d\d\.$/);
    assert.ok(fs.existsSync(file), 'the claim is on disk');
  })) p++; else f++;

  if (shell('shell: extra usage on adds the billing line', ({ sent, home }) => {
    writeProfile(home, { emailAddress: ACC, hasExtraUsageEnabled: true });
    onUsageReading(limits(100), T);
    onUsageReading(limits(10), S_MS + MIN);
    assert.ok(sent[0].body.endsWith(' Extra usage is on: you are now billed.'), sent[0].body);
    assert.strictEqual(sent[1].body, 'Back on plan usage: extra-usage billing stops.');
  })) p++; else f++;

  if (shell('shell: reset follows a pushed hit', ({ sent }) => {
    onUsageReading(limits(100), T);
    onUsageReading(limits(10), S_MS + MIN);
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual({ title: sent[1].title, body: sent[1].body, tags: sent[1].tags },
      { title: '5-hour limit reset', body: 'Usage is available again.', tags: 'arrows_counterclockwise' });
  })) p++; else f++;

  if (shell('shell: restart at 100% sends nothing', ({ sent }) => {
    onUsageReading(limits(100), T);
    resetUsageAlertsMemory();
    armUsageAlerts(conf());
    onUsageReading(limits(100), T + MIN);
    assert.strictEqual(sent.length, 1);
  })) p++; else f++;

  if (shell('shell: with the ledger file gone, a restart at 100% pushes again (the file is what stops it)', ({ sent, file }) => {
    onUsageReading(limits(100), T);
    fs.rmSync(file);
    resetUsageAlertsMemory();
    onUsageReading(limits(100), T + MIN);
    assert.strictEqual(sent.length, 2);
  })) p++; else f++;

  if (shell('shell: a null fetch changes nothing', ({ sent }) => {
    onUsageReading(limits(100), T);
    onUsageReading(null, T + MIN);
    onUsageReading(limits(100), T + 2 * MIN);
    assert.strictEqual(sent.length, 1);
  })) p++; else f++;

  if (shell('shell: a write failure still sends, and memory stops the repeat', ({ sent, dir }) => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    setUsageAlertsFile(path.join(blocker, 'usage-alerts.json'));
    assert.doesNotThrow(() => onUsageReading(limits(100), T));
    onUsageReading(limits(100), T + MIN);
    assert.strictEqual(sent.length, 1);
  })) p++; else f++;

  if (shell('shell: checkbox off at the hit, on later — nothing at the hit, nothing at the drop', ({ sent }) => {
    setSettings({ notify: { events: { 'usage-limit': false } } });
    onUsageReading(limits(100), T);
    setSettings({ notify: { events: { 'usage-limit': true } } });
    onUsageReading(limits(100), T + MIN);
    onUsageReading(limits(10), S_MS + MIN);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  if (shell('shell: no NTFY_TOPIC at the hit records it unpushed', ({ sent }) => {
    armUsageAlerts(conf({ ntfyTopic: '' }));
    onUsageReading(limits(100), T);
    armUsageAlerts(conf());
    onUsageReading(limits(100), T + MIN);
    onUsageReading(limits(10), S_MS + MIN);
    assert.strictEqual(sent.length, 0);
  })) p++; else f++;

  console.log(`  ${p} passed, ${f} failed`);
  return f;
}
