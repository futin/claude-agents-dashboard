/**
 * Pins the backend's outbound network surface to what the docs say it is.
 *
 * The defect this file exists to prevent: README, `.claude/CLAUDE.md` and three reference docs all said the server makes "exactly one outbound call — the ntfy
 * push" long after `lib/usage.ts` started reading account limits from `api.anthropic.com` with the CLI's OAuth token. Nothing tied the sentence to the code,
 * so the call that carries a credential to a third party was the one a reader auditing the network surface from the docs would not find. The live half below
 * fails the moment a new network module or `fetch(` lands in `server/`; the doc half fails if the singular claim comes back.
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

const NET_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram']);

/** Blanks `/* … *\/` and `// …` comments; `://` inside a URL string is left alone. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** True when an import clause brings in no runtime binding: `type X`, `type { … }`, or `{ type A, type B }`. */
function typeOnly(clause: string): boolean {
  const c = clause.trim();
  if (/^type\s/.test(c)) return true;
  const named = c.match(/^\{([\s\S]*)\}$/);
  if (!named) return false;
  const specs = named[1].split(',').map((s) => s.trim()).filter(Boolean);
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s));
}

/**
 * Per file, the network modules it pulls in at runtime (bare specifiers normalised to `node:`) plus `fetch` for a call to the global. Files with none are
 * absent, so a deep-equal against an allowlist names only the files that talk to the network.
 */
export function scanOutbound(files: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rel, text] of Object.entries(files)) {
    const src = stripComments(text);
    const found = new Set<string>();
    const note = (spec: string) => {
      const bare = spec.replace(/^node:/, '');
      if (NET_MODULES.has(bare)) found.add('node:' + bare);
    };
    for (const m of src.matchAll(/\bimport\s+([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) {
      if (!typeOnly(m[1])) note(m[2]);
    }
    for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) note(m[1]);
    for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) note(m[1]);
    if (/(?<![\w$])fetch\s*\(/.test(src)) found.add('fetch');
    if (found.size > 0) out[rel] = [...found].sort();
  }
  return out;
}

/**
 * Every entry here is a network surface the docs must name. Adding one means updating README.md (intro + Dictation bullet), `.claude/CLAUDE.md` (the
 * zero-deps rule), `docs/overview.md` (the `lib/` map), `docs/subsystems/dictation.md` and `docs/subsystems/session-surfaces.md` in the same change.
 */
const ALLOWED: Record<string, string[]> = {
  'server/index.ts': ['node:http'], // the inbound listener, not an outbound call
  'server/lib/notify.ts': ['node:https'], // the ntfy push
  'server/lib/usage.ts': ['node:http', 'node:https'], // account limits from api.anthropic.com; http only for the test-only CLAUDE_USAGE_BASE_URL
};

const SINGULAR_CLAIM = /exactly one (kind of )?outbound|only outbound call|the one outbound call/i;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(abs, out);
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

export function run(): number {
  console.log('\n=== outbound surface ===\n');
  let p = 0, f = 0;
  const root = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const cases: [string, string, Record<string, string[]>][] = [
    ['default import of node:https counts', `import https from 'node:https';`, { 'a.ts': ['node:https'] }],
    ['bare specifier is normalised to node:', `import * as net from 'net';`, { 'a.ts': ['node:net'] }],
    ['import type does not count', `import type { IncomingMessage } from 'node:http';`, {}],
    ['inline type-only named imports do not count', `import { type IncomingHttpHeaders } from 'node:http';`, {}],
    ['a runtime binding beside an inline type does count', `import { request, type RequestOptions } from 'node:https';`, { 'a.ts': ['node:https'] }],
    ['a call to the global fetch counts', `const r = await fetch(url);`, { 'a.ts': ['fetch'] }],
    ['prefetch( and a commented fetch( do not count', `prefetch(x);\n// fetch( later\n/* fetch(y) */`, {}],
    ['fetch with a URL string survives comment stripping', `await fetch('https://example.com');`, { 'a.ts': ['fetch'] }],
    ['dynamic import and require count', `await import('node:tls');\nconst d = require('dgram');`, { 'a.ts': ['node:dgram', 'node:tls'] }],
    ['http and https together are both reported, sorted', `import https from 'node:https';\nimport http from 'node:http';`, { 'a.ts': ['node:http', 'node:https'] }],
    ['a file with no network module is absent, not empty', `import fs from 'node:fs';`, {}],
  ];
  for (const [name, src, want] of cases) {
    if (test(`scanner: ${name}`, () => {
      assert.deepStrictEqual(scanOutbound({ 'a.ts': src }), want);
    })) p++; else f++;
  }

  if (test('server/**/*.ts talks to the network only where ALLOWED says', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) {
      files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    }
    assert.deepStrictEqual(scanOutbound(files), ALLOWED, 'server/ network surface changed — update ALLOWED and every doc its comment names');
  })) p++; else f++;

  if (test('no reference doc claims the server makes a single outbound call', () => {
    const docs = ['README.md', '.claude/CLAUDE.md', 'docs/overview.md'];
    const subsystems = path.join(root, 'docs', 'subsystems');
    for (const name of fs.readdirSync(subsystems)) if (name.endsWith('.md')) docs.push(`docs/subsystems/${name}`);
    const hits = docs.filter((rel) => SINGULAR_CLAIM.test(fs.readFileSync(path.join(root, rel), 'utf8').replace(/\s+/g, ' ')));
    assert.deepStrictEqual(hits, [], `singular outbound claim still in: ${hits.join(', ')}`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
