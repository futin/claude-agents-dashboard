import assert from 'node:assert';
import type { IncomingHttpHeaders } from 'node:http';

import { classifyAddress, classifyOrigin, normalizeAddress, resolvePeer } from '../server/lib/origin.js';
import type { ConnectionOrigin } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Assert a whole table of address → origin in one case. */
function expectAll(table: [string | undefined, ConnectionOrigin][]): void {
  for (const [addr, want] of table) {
    assert.strictEqual(classifyAddress(addr), want, `${String(addr)} → ${want}`);
  }
}

function xff(value: string | string[]): IncomingHttpHeaders {
  return { 'x-forwarded-for': value };
}

export function run(): number {
  console.log('\n=== origin.ts ===\n');
  let p = 0, f = 0;

  if (test('loopback, in every spelling Node might report', () => {
    expectAll([
      ['127.0.0.1', 'local'],
      ['127.5.5.5', 'local'],
      ['::1', 'local'],
      ['0:0:0:0:0:0:0:1', 'local'],
      ['::ffff:127.0.0.1', 'local']
    ]);
  })) p++; else f++;

  if (test('tailnet: the CGNAT range 100.64.0.0/10', () => {
    expectAll([
      ['100.64.0.1', 'tailnet'],
      ['100.100.5.9', 'tailnet'],
      ['100.127.255.255', 'tailnet'],
      ['::ffff:100.90.1.2', 'tailnet']
    ]);
  })) p++; else f++;

  if (test('tailnet: fd7a:115c:a1e0::/48 wins over the generic ULA check', () => {
    // The ordering guard. Tailscale's v6 range is inside fc00::/7, so a
    // LAN-first classifier would call all of these `lan`.
    expectAll([
      ['fd7a:115c:a1e0::1', 'tailnet'],
      ['fd7a:115c:a1e0:ab12::4', 'tailnet'],
      ['fd7a:115c:a1e0:b1a:cafe:beef:1:2', 'tailnet'],
      ['[fd7a:115c:a1e0::9]', 'tailnet']
    ]);
  })) p++; else f++;

  if (test('the CGNAT range stops where it should', () => {
    expectAll([
      ['100.63.0.1', 'unknown'],
      ['100.128.0.1', 'unknown'],
      ['100.255.0.1', 'unknown']
    ]);
  })) p++; else f++;

  if (test('private + link-local ranges are lan', () => {
    expectAll([
      ['10.0.0.4', 'lan'],
      ['172.16.0.1', 'lan'],
      ['172.31.255.254', 'lan'],
      ['192.168.1.7', 'lan'],
      ['169.254.1.1', 'lan'],
      ['fe80::1', 'lan'],
      ['fe80::1%en0', 'lan'],
      ['[fe80::1]', 'lan'],
      ['fd00::1', 'lan'],
      ['fdff::5', 'lan']
    ]);
  })) p++; else f++;

  if (test('the 172.16/12 boundary is exact', () => {
    expectAll([
      ['172.15.0.1', 'unknown'],
      ['172.32.0.1', 'unknown']
    ]);
  })) p++; else f++;

  if (test('public addresses are unknown', () => {
    expectAll([
      ['8.8.8.8', 'unknown'],
      ['203.0.113.9', 'unknown'],
      ['2606:4700::1111', 'unknown']
    ]);
  })) p++; else f++;

  if (test('garbage in never throws', () => {
    expectAll([
      [undefined, 'unknown'],
      ['', 'unknown'],
      ['   ', 'unknown'],
      ['garbage', 'unknown'],
      ['::ffff:', 'unknown'],
      ['999.1.1.1', 'unknown'],
      ['1.2.3', 'unknown'],
      ['fd7a:115c:a1e0:::1', 'unknown']
    ]);
    assert.strictEqual(classifyAddress(42 as unknown as string), 'unknown');
  })) p++; else f++;

  if (test('normalizeAddress unwraps brackets, zones and IPv4-mapped forms', () => {
    assert.strictEqual(normalizeAddress('::FFFF:192.168.1.9'), '192.168.1.9');
    assert.strictEqual(normalizeAddress('[fe80::1]'), 'fe80::1');
    assert.strictEqual(normalizeAddress('fe80::1%utun3'), 'fe80::1');
    assert.strictEqual(normalizeAddress('  127.0.0.1  '), '127.0.0.1');
    assert.strictEqual(normalizeAddress(undefined), '');
  })) p++; else f++;

  if (test('a loopback socket defers to X-Forwarded-For (the pnpm tunnel path)', () => {
    assert.strictEqual(classifyOrigin('127.0.0.1', xff('100.90.1.2')), 'tailnet');
    assert.strictEqual(classifyOrigin('::1', xff('192.168.1.9')), 'lan');
    assert.strictEqual(classifyOrigin('127.0.0.1', xff('8.8.8.8')), 'unknown');
  })) p++; else f++;

  if (test('the right-most non-loopback hop wins, in string or array form', () => {
    // Each loopback proxy appends the address it accepted, so only the right end is written by something on this machine.
    assert.strictEqual(classifyOrigin('127.0.0.1', xff('100.90.1.2, 127.0.0.1')), 'tailnet');
    assert.strictEqual(classifyOrigin('127.0.0.1', xff(['192.168.1.9'])), 'lan');
    assert.strictEqual(classifyOrigin('127.0.0.1', xff(['100.90.1.2, 10.0.0.1'])), 'lan');
  })) p++; else f++;

  if (test('an absent forwarded header is local; an unusable one is unknown', () => {
    assert.strictEqual(classifyOrigin('127.0.0.1', xff('not-an-ip')), 'unknown');
    assert.strictEqual(classifyOrigin('127.0.0.1', xff('')), 'unknown');
    assert.strictEqual(classifyOrigin('127.0.0.1', {}), 'local');
    assert.strictEqual(classifyOrigin('127.0.0.1', undefined), 'local');
    assert.strictEqual(classifyOrigin('127.0.0.1'), 'local');
  })) p++; else f++;

  if (test('resolvePeer: every proxy chain the write gate meets', () => {
    const table: [string | undefined, string | string[] | null, ConnectionOrigin][] = [
      ['127.0.0.1', null, 'local'],
      ['::1', null, 'local'],
      ['::ffff:127.0.0.1', '127.0.0.1', 'local'],
      ['127.0.0.1', '100.101.102.103,127.0.0.1', 'tailnet'],
      ['127.0.0.1', '100.101.102.103, 127.0.0.1', 'tailnet'],
      ['127.0.0.1', '100.101.102.103', 'tailnet'],
      ['127.0.0.1', 'fd7a:115c:a1e0::5', 'tailnet'],
      // A LAN client forging a tailnet or loopback entry through Vite: Vite appends the real address on the right.
      ['127.0.0.1', '100.64.0.1,192.168.1.5', 'lan'],
      ['127.0.0.1', '127.0.0.1,192.168.1.5', 'lan'],
      ['127.0.0.1', '::ffff:192.168.1.5', 'lan'],
      ['127.0.0.1', '100.90.1.2, 10.0.0.1', 'lan'],
      ['127.0.0.1', 'not-an-ip', 'unknown'],
      ['127.0.0.1', '', 'unknown'],
      ['127.0.0.1', '100.101.102.103, ,127.0.0.1', 'unknown'],
      ['127.0.0.1', '  ', 'unknown'],
      ['127.0.0.1', ['100.101.102.103', '127.0.0.1'], 'tailnet'],
      ['127.0.0.1', '8.8.8.8', 'unknown'],
      ['192.168.1.5', '100.101.102.103', 'lan'],
      ['100.101.102.103', '127.0.0.1', 'tailnet'],
      [undefined, '100.101.102.103', 'unknown']
    ];
    for (const [socket, header, want] of table) {
      const headers = header === null ? {} : xff(header);
      assert.strictEqual(resolvePeer(socket, headers), want, `${String(socket)} + ${JSON.stringify(header)} → ${want}`);
    }
  })) p++; else f++;

  if (test('classifyOrigin and resolvePeer agree, so the badge never disagrees with the gate', () => {
    for (const [socket, header] of [['127.0.0.1', '100.64.0.1,192.168.1.5'], ['127.0.0.1', 'garbage'], ['192.168.1.5', '100.101.102.103']]) {
      assert.strictEqual(classifyOrigin(socket, xff(header)), resolvePeer(socket, xff(header)));
    }
  })) p++; else f++;

  if (test('X-Forwarded-For is ignored when the socket is NOT loopback', () => {
    // Only something already on the machine can steer the badge.
    assert.strictEqual(classifyOrigin('192.168.1.9', xff('100.90.1.2')), 'lan');
    assert.strictEqual(classifyOrigin('100.90.1.2', xff('192.168.1.9')), 'tailnet');
    assert.strictEqual(classifyOrigin('8.8.8.8', xff('127.0.0.1')), 'unknown');
  })) p++; else f++;

  if (test('an unclassifiable socket stays unknown regardless of headers', () => {
    assert.strictEqual(classifyOrigin(undefined, xff('100.90.1.2')), 'unknown');
    assert.strictEqual(classifyOrigin('', xff('192.168.1.9')), 'unknown');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
