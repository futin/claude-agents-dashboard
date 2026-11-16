/**
 * The async process probe (`probeProcesses`, `scan.ts`) and the cache every `/api/sessions` reader shares (`sharedProcProbe`, `scan-snapshot.ts`).
 * Every case but the real-children one stubs the exec, so none depends on what happens to be running on the machine.
 */

import assert from 'node:assert';

import { testAsync } from '../api-harness.js';
import { probeProcesses, runProbeChild, setProbeExec, type ProbeExec, type ProbeResult } from '../../server/lib/scan.js';
import { resetProcProbeCache, sharedProcProbe } from '../../server/lib/scan-snapshot.js';
import type { Config } from '../../server/lib/config.js';

const COMM = '12 claude\n34 /usr/local/bin/claude\n56 claude-helper\n78 node\n';
const ARGS = '  111 /usr/local/bin/claude -p --resume abc-1\n';
const ok = (stdout: string): ProbeResult => ({ code: 0, signal: null, stdout });

/** A stub exec answering per command (`comm`, `args`, `lsof`), counting each call. */
function stub(answers: { comm?: () => ProbeResult; args?: () => ProbeResult; lsof?: () => ProbeResult }) {
  const calls = { comm: 0, args: 0, lsof: 0 };
  const exec: ProbeExec = async (bin, args) => {
    const kind = bin === 'lsof' ? 'lsof' : args.includes('pid=,comm=') ? 'comm' : 'args';
    calls[kind]++;
    const answer = answers[kind];
    if (!answer) throw new Error(`unexpected ${kind}`);
    return answer();
  };
  return { exec, calls };
}

const cfg = (skipProcScan = false) => ({ skipProcScan }) as Config;

export async function run(): Promise<number> {
  console.log('\n=== process probe (probeProcesses, sharedProcProbe) ===\n');
  let ok_ = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };

  check(await testAsync('probe composes count, cwds and ids the way the sync probes did', async () => {
    const s = stub({ comm: () => ok(COMM), lsof: () => ok('p12\nn/a/lv\n'), args: () => ok(ARGS) });
    const probe = await probeProcesses({ exec: s.exec });
    assert.deepStrictEqual(probe, { runningClaudeProcs: 2, liveCwds: new Set(['/a/lv']), liveSessionIds: new Set(['abc-1']) });
    assert.deepStrictEqual(s.calls, { comm: 1, args: 1, lsof: 1 });
  }));

  check(await testAsync('ps comm failing nulls count and cwds, skips lsof, and still parses args', async () => {
    for (const comm of [() => { throw new Error('ps: command not found'); }, () => ({ code: 127, signal: null, stdout: '' })]) {
      const s = stub({ comm, lsof: () => ok('p12\nn/a/lv\n'), args: () => ok(ARGS) });
      const probe = await probeProcesses({ exec: s.exec });
      assert.strictEqual(probe.runningClaudeProcs, null);
      assert.strictEqual(probe.liveCwds, null);
      assert.strictEqual(s.calls.lsof, 0);
      assert.deepStrictEqual(probe.liveSessionIds, new Set(['abc-1']));
    }
  }));

  check(await testAsync('no claude pid: count 0, cwds null, lsof never run', async () => {
    const s = stub({ comm: () => ok('78 node\n'), args: () => ok('') });
    const probe = await probeProcesses({ exec: s.exec });
    assert.strictEqual(probe.runningClaudeProcs, 0);
    assert.strictEqual(probe.liveCwds, null);
    assert.strictEqual(s.calls.lsof, 0);
  }));

  check(await testAsync('lsof: a clean exit 1 is a usable partial set, a signal kill is null; ps args failing nulls the ids', async () => {
    const partial = stub({ comm: () => ok(COMM), lsof: () => ({ code: 1, signal: null, stdout: 'p12\nn/a/lv\n' }), args: () => ok(ARGS) });
    assert.deepStrictEqual((await probeProcesses({ exec: partial.exec })).liveCwds, new Set(['/a/lv']));
    const killed = stub({ comm: () => ok(COMM), lsof: () => ({ code: null, signal: 'SIGTERM', stdout: 'p12\nn/a/lv\n' }), args: () => ok(ARGS) });
    assert.strictEqual((await probeProcesses({ exec: killed.exec })).liveCwds, null);
    const noArgs = stub({ comm: () => ok(COMM), lsof: () => ok('p12\nn/a/lv\n'), args: () => ({ code: 1, signal: null, stdout: '' }) });
    assert.strictEqual((await probeProcesses({ exec: noArgs.exec })).liveSessionIds, null);
  }));

  check(await testAsync('a hung child is killed by its own timer and never blocks the event loop (real children)', async () => {
    // `sleep 5` stands in for a hung lsof; the ps reads are stubs so the case does not depend on what is running.
    const s = stub({ comm: () => ok(COMM), args: () => ok('') });
    const exec: ProbeExec = (bin, args, opts) => (bin === 'lsof' ? runProbeChild('sleep', ['5'], opts) : s.exec(bin, args, opts));
    let ticked = false;
    setTimeout(() => { ticked = true; }, 10);
    const t0 = Date.now();
    const probe = await probeProcesses({ exec, timeoutMs: 100 });
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.strictEqual(probe.liveCwds, null);
    assert.strictEqual(probe.runningClaudeProcs, 2);
    assert.strictEqual(ticked, true, 'a 10 ms timer armed before the probe had not fired when it resolved');
  }));

  check(await testAsync('runProbeChild resolves a missing binary instead of rejecting', async () => {
    const r = await runProbeChild('/nonexistent/cad-probe-bin', [], { timeoutMs: 1000 });
    assert.strictEqual(r.code, null);
  }));

  check(await testAsync('sharedProcProbe: two calls in one tick share one probe and one result', async () => {
    const s = stub({ comm: () => ok(COMM), lsof: () => ok('p12\nn/a/lv\n'), args: () => ok(ARGS) });
    resetProcProbeCache();
    setProbeExec(s.exec);
    try {
      const [a, b] = await Promise.all([sharedProcProbe(cfg()), sharedProcProbe(cfg())]);
      assert.strictEqual(a, b);
      assert.deepStrictEqual(s.calls, { comm: 1, args: 1, lsof: 1 });
    } finally { setProbeExec(null); resetProcProbeCache(); }
  }));

  check(await testAsync('sharedProcProbe: reused for 999 ms after completion, re-run at 1001 ms', async () => {
    const s = stub({ comm: () => ok(COMM), lsof: () => ok('p12\nn/a/lv\n'), args: () => ok(ARGS) });
    let now = 50_000;
    resetProcProbeCache(() => now);
    setProbeExec(s.exec);
    try {
      const first = await sharedProcProbe(cfg());
      now += 999;
      assert.strictEqual(await sharedProcProbe(cfg()), first);
      assert.deepStrictEqual(s.calls, { comm: 1, args: 1, lsof: 1 });
      now += 2;
      assert.notStrictEqual(await sharedProcProbe(cfg()), first);
      assert.deepStrictEqual(s.calls, { comm: 2, args: 2, lsof: 2 });
    } finally { setProbeExec(null); resetProcProbeCache(); }
  }));

  check(await testAsync('sharedProcProbe: skipProcScan resolves null and runs nothing', async () => {
    const s = stub({});
    resetProcProbeCache();
    setProbeExec(s.exec);
    try {
      assert.strictEqual(await sharedProcProbe(cfg(true)), null);
      assert.deepStrictEqual(s.calls, { comm: 0, args: 0, lsof: 0 });
    } finally { setProbeExec(null); resetProcProbeCache(); }
  }));

  console.log(`\nprocess probe: ${ok_}/${total} passed`);
  return total - ok_;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await run() > 0 ? 1 : 0);
