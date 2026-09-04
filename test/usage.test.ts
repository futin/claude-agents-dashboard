import assert from 'node:assert';

import * as usage from '../server/lib/usage.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== usage.ts ===\n');
  let p = 0, f = 0;

  if (test('mapUsage maps top-level five_hour + seven_day (live shape)', () => {
    const u = usage.mapUsage({
      five_hour: { utilization: 17, resets_at: '2026-07-01T17:20:00Z' },
      seven_day: { utilization: 28, resets_at: '2026-07-06T08:00:00Z' },
      seven_day_opus: null
    })!;
    assert.strictEqual(u.fiveHour.utilization, 17);
    assert.strictEqual(u.fiveHour.resetsAt, '2026-07-01T17:20:00Z');
    assert.strictEqual(u.sevenDay.utilization, 28);
    assert.strictEqual(u.sevenDay.resetsAt, '2026-07-06T08:00:00Z');
  })) p++; else f++;

  if (test('mapUsage also accepts a rate_limits wrapper', () => {
    const u = usage.mapUsage({
      rate_limits: { five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: 68, resets_at: null } }
    })!;
    assert.strictEqual(u.fiveHour.utilization, 42);
    assert.strictEqual(u.sevenDay.utilization, 68);
  })) p++; else f++;

  if (test('mapUsage returns null when both windows absent', () => {
    assert.strictEqual(usage.mapUsage({}), null);
    assert.strictEqual(usage.mapUsage({ rate_limits: null }), null);
    assert.strictEqual(usage.mapUsage(null), null);
    assert.strictEqual(usage.mapUsage({ seven_day_opus: null }), null);
  })) p++; else f++;

  if (test('mapUsage coerces missing/invalid window fields to null', () => {
    const u = usage.mapUsage({ five_hour: {}, seven_day: { utilization: 'x' } })!;
    assert.strictEqual(u.fiveHour.utilization, null);
    assert.strictEqual(u.fiveHour.resetsAt, null);
    assert.strictEqual(u.sevenDay.utilization, null);
  })) p++; else f++;

  const NOW = 1_700_000_000_000;

  if (test('tokenFromCredsBlob: valid token → ok', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW + 60_000 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'ok', token: 'tok-1' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: past expiresAt → expired', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW - 1 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'expired' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: no expiresAt → ok (never skipped)', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1' } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'ok', token: 'tok-1' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: garbage / missing token → missing', () => {
    assert.deepStrictEqual(usage.tokenFromCredsBlob('not json', NOW), { state: 'missing' });
    assert.deepStrictEqual(usage.tokenFromCredsBlob('{}', NOW), { state: 'missing' });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(JSON.stringify({ claudeAiOauth: {} }), NOW), { state: 'missing' });
    // The complement of the signed-out split below: a non-string accessToken is
    // a malformed store, not a logout, and must not inherit the sign-in hint.
    assert.deepStrictEqual(usage.tokenFromCredsBlob(JSON.stringify({ claudeAiOauth: { accessToken: 42 } }), NOW), { state: 'missing' });
  })) p++; else f++;

  // ── signed-out: credentials present but blank ──
  // `claude auth logout` leaves the blob in place with every field emptied. That
  // is the one absent-bars cause the user can fix in one command, so it gets its
  // own state rather than sharing `missing`'s silence.

  if (test('tokenFromCredsBlob: blank token with expiresAt 0 → signed-out, not expired', () => {
    // The exact blob observed after `claude auth logout`. Classifying it expiry-first
    // would say `expired` (0 <= NOW) and fire a renewal at a credential with no
    // refresh token to renew — so the blank test must precede the expiry test.
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 0 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'signed-out' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: blank token with a future expiresAt → signed-out', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: NOW + 60_000 } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'signed-out' });
  })) p++; else f++;

  if (test('tokenFromCredsBlob: whitespace-only token → signed-out', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: '   ' } });
    assert.deepStrictEqual(usage.tokenFromCredsBlob(blob, NOW), { state: 'signed-out' });
  })) p++; else f++;

  if (test('pickTokenState: signed-out outranks missing, either order', () => {
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'missing' }, { state: 'signed-out' }]), { state: 'signed-out' });
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'signed-out' }, { state: 'missing' }]), { state: 'signed-out' });
  })) p++; else f++;

  if (test('pickTokenState: expired outranks signed-out, either order', () => {
    // An expired token in *any* store is renewable with no user action; a blank
    // blob in another store must not suppress that self-healing path.
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'signed-out' }, { state: 'expired' }]), { state: 'expired' });
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'expired' }, { state: 'signed-out' }]), { state: 'expired' });
  })) p++; else f++;

  if (test('pickTokenState: ok wins over everything; empty → missing', () => {
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'signed-out' }, { state: 'ok', token: 'tok-1' }]), { state: 'ok', token: 'tok-1' });
    assert.deepStrictEqual(usage.pickTokenState([{ state: 'missing' }]), { state: 'missing' });
    assert.deepStrictEqual(usage.pickTokenState([]), { state: 'missing' });
  })) p++; else f++;

  if (test('statusForToken: every TokenState maps to its own status', () => {
    assert.strictEqual(usage.statusForToken('ok'), 'ok');
    assert.strictEqual(usage.statusForToken('expired'), 'token-expired');
    // Folding signed-out back into token-expired would re-arm autoRenew on a
    // credential that cannot be renewed. This assertion is that guard.
    assert.strictEqual(usage.statusForToken('signed-out'), 'signed-out');
    assert.strictEqual(usage.statusForToken('missing'), 'unavailable');
  })) p++; else f++;

  if (test('requestHeaders: carries the token + a claude-code User-Agent', () => {
    const h = usage.requestHeaders('tok-9');
    assert.strictEqual(h.Authorization, 'Bearer tok-9');
    assert.ok(/^claude-code\//.test(h['User-Agent']), 'User-Agent must start with claude-code/ (endpoint 429s otherwise)');
    assert.strictEqual(h['anthropic-beta'], 'oauth-2025-04-20');
  })) p++; else f++;

  // ── shouldRefresh: the gate that decides when a new fetch cycle may start ──
  // A refresh promise that never settles used to pin the single-flight guard
  // forever, freezing usageStatus at whatever the last completed cycle saw.

  const GATE = { inFlight: false, startedAt: 0, cachedAt: NOW };

  if (test('shouldRefresh: nothing in flight and the cache is stale → true', () => {
    assert.strictEqual(usage.shouldRefresh({ ...GATE }, NOW + 61_000), true);
  })) p++; else f++;

  if (test('shouldRefresh: nothing in flight and the cache is fresh → false', () => {
    assert.strictEqual(usage.shouldRefresh({ ...GATE }, NOW + 5_000), false);
  })) p++; else f++;

  if (test('shouldRefresh: never fetched (cachedAt 0) → true', () => {
    assert.strictEqual(usage.shouldRefresh({ inFlight: false, startedAt: 0, cachedAt: 0 }, NOW), true);
  })) p++; else f++;

  if (test('shouldRefresh: a young in-flight cycle holds the single flight → false', () => {
    const gate = { inFlight: true, startedAt: NOW, cachedAt: NOW - 120_000 };
    assert.strictEqual(usage.shouldRefresh(gate, NOW + 5_000), false);
  })) p++; else f++;

  if (test('shouldRefresh: an in-flight cycle past the stall deadline is abandoned → true', () => {
    const gate = { inFlight: true, startedAt: NOW, cachedAt: NOW - 120_000 };
    assert.strictEqual(usage.shouldRefresh(gate, NOW + 60_000), true);
  })) p++; else f++;

  if (test('shouldRefresh: force ignores the cache TTL', () => {
    assert.strictEqual(usage.shouldRefresh({ ...GATE }, NOW + 5_000, true), true);
  })) p++; else f++;

  if (test('shouldRefresh: force still yields to a young in-flight cycle', () => {
    const gate = { inFlight: true, startedAt: NOW, cachedAt: NOW };
    assert.strictEqual(usage.shouldRefresh(gate, NOW + 5_000, true), false);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
