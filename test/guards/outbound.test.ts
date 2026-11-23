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

/** The files that import `node:child_process` (or bare `child_process`) at runtime, sorted — the launchers `.claude/CLAUDE.md` must name. */
export function scanLaunchers(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const src = stripComments(text);
    const isCp = (spec: string) => spec.replace(/^node:/, '') === 'child_process';
    let hit = false;
    for (const m of src.matchAll(/\bimport\s+([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) if (!typeOnly(m[1]) && isCp(m[2])) hit = true;
    for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) if (isCp(m[1])) hit = true;
    if (hit) out.push(rel);
  }
  return out.sort();
}

/** The callees whose first argument is a program to launch: child_process's own, and the runner seams server/ wraps them in. */
const LAUNCH_CALLEES = ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync', 'fork', 'nodeSpawn', 'run', 'runner', 'spawner', 'runProbeChild', 'spawnProcess'];
const LAUNCH_CALL = new RegExp(`(?<![\\w$.])(?:${LAUNCH_CALLEES.join('|')})\\s*\\(\\s*(['"\`])([\\w./-]+)\\1`, 'g');
/** `bin: 'gh'`, `bin = 'codegraph'` (a default), `const bin = opts.bin ?? 'git'`: a runner told which program to launch. */
const BIN_LITERAL = /\bbin\s*(?::|=(?!=))\s*(?:[\w$.]+\s*\?\?\s*)?(['"])([\w./-]+)\1/g;

/**
 * Per file, the programs it names to launch: a string literal as the first argument of a launch call (`LAUNCH_CALLEES`) or as a runner's `bin`. A program
 * named only through config (`config.claudeBin`, the whisper and ffmpeg bins) is not a literal and is not seen. Files naming none are absent.
 */
export function scanCommands(files: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rel, text] of Object.entries(files)) {
    const src = stripComments(text);
    const found = new Set<string>();
    for (const m of src.matchAll(LAUNCH_CALL)) found.add(m[2]);
    for (const m of src.matchAll(BIN_LITERAL)) found.add(m[2]);
    if (found.size > 0) out[rel] = [...found].sort();
  }
  return out;
}

/**
 * The programs each `server/` file launches by name. Adding one means naming it in `.claude/CLAUDE.md`'s zero-deps rule in the same change — the test
 * below checks every name here appears there in backticks.
 */
const COMMANDS: Record<string, string[]> = {
  'server/index.ts': ['cmd', 'open', 'xdg-open'], // opens the browser on `pnpm start`
  'server/lib/codegraph.ts': ['codegraph'],
  'server/lib/desktop.ts': ['open'], // a claude:// URL
  'server/lib/git-fetch.ts': ['git'], // `makeFetchRunner`'s default; git-quick.ts launches through it
  'server/lib/git-stats.ts': ['git'],
  'server/lib/idle.ts': ['ioreg'],
  'server/lib/open-folder.ts': ['open'],
  'server/lib/pr-status.ts': ['gh'], // through git-fetch.ts's `makeFetchRunner`
  'server/lib/routine-reconcile.ts': ['crontab', 'launchctl', 'pgrep'],
  'server/lib/routine-store.ts': ['ps', 'sysctl'],
  'server/lib/scan.ts': ['lsof', 'ps'],
  'server/lib/token-refresh.ts': ['claude'],
  'server/lib/usage.ts': ['security'],
};

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

  const launcherCases: [string, string, string[]][] = [
    ['a runtime import of node:child_process counts', `import { execFileSync } from 'node:child_process';`, ['a.ts']],
    ['bare child_process counts', `import { spawn } from 'child_process';`, ['a.ts']],
    ['a type-only import does not count', `import type { ChildProcess } from 'node:child_process';`, []],
    ['a commented import does not count', `// import { spawn } from 'node:child_process';`, []],
    ['a dynamic import counts', `const cp = await import('node:child_process');`, ['a.ts']],
  ];
  for (const [name, src, want] of launcherCases) {
    if (test(`launcher scanner: ${name}`, () => {
      assert.deepStrictEqual(scanLaunchers({ 'a.ts': src }), want);
    })) p++; else f++;
  }

  const commandCases: [string, string, Record<string, string[]>][] = [
    ['a literal program in execFile counts', `execFile('ioreg', ['-c', 'IOHIDSystem'], cb);`, { 'a.ts': ['ioreg'] }],
    ['a literal on the next line counts', `const c = execFile(\n  'security',\n  ['-w'],\n);`, { 'a.ts': ['security'] }],
    ['a runner seam counts', `await runner('launchctl', ['print']); run('ps', ['-A']);`, { 'a.ts': ['launchctl', 'ps'] }],
    ['a bin property, default and ?? fallback count', `makeFetchRunner({ bin: 'gh' });\nfunction r(bin = 'codegraph') {}\nconst bin = opts.bin ?? 'git';`, { 'a.ts': ['codegraph', 'gh', 'git'] }],
    ['a program from a variable is not seen', `execFile(cmd, args); spawn(config.claudeBin, []);`, {}],
    ['a regex .exec( does not count', `const m = /x/.exec('ps');`, {}],
    ['a run( whose first argument is not a literal does not count', `await run(toplevel, ['push', 'origin']);`, {}],
    ['a commented launch does not count', `// execFile('curl', [url])`, {}],
  ];
  for (const [name, src, want] of commandCases) {
    if (test(`command scanner: ${name}`, () => {
      assert.deepStrictEqual(scanCommands({ 'a.ts': src }), want);
    })) p++; else f++;
  }

  if (test('server/**/*.ts launches only the programs COMMANDS names, file by file', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) {
      files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    }
    assert.deepStrictEqual(scanCommands(files), COMMANDS, 'server/ launches a program COMMANDS does not name — add it there and to .claude/CLAUDE.md\'s zero-deps rule');
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names every program COMMANDS lists', () => {
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    const head = rule.slice(0, rule.indexOf('`client/dist/`'));
    const names = [...new Set(Object.values(COMMANDS).flat())].sort();
    const missing = names.filter((name) => !new RegExp('`' + name.replace(/[.-]/g, '\\$&') + '[ `]').test(head));
    assert.deepStrictEqual(missing, [], `programs missing from .claude/CLAUDE.md's zero-deps rule: ${missing.join(', ')}`);
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names every server/ file that imports node:child_process', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) {
      files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    }
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    const head = rule.slice(0, rule.indexOf('`client/dist/`'));
    const missing = scanLaunchers(files).filter((rel) => !head.includes('`' + rel + '`') && !head.includes('`' + rel.replace(/^server\//, '') + '`'));
    assert.deepStrictEqual(missing, [], `launchers missing from .claude/CLAUDE.md's zero-deps rule: ${missing.join(', ')}`);
  })) p++; else f++;

  if (test('server/**/*.ts talks to the network only where ALLOWED says', () => {
    const files: Record<string, string> = {};
    for (const abs of tsFiles(path.join(root, 'server'))) {
      files[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    }
    assert.deepStrictEqual(scanOutbound(files), ALLOWED, 'server/ network surface changed — update ALLOWED and every doc its comment names');
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names lib/git-fetch.ts, which launches the fetch', () => {
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    assert.match(rule.slice(0, rule.indexOf('`client/dist/`')), /lib\/git-fetch\.ts/);
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names lib/git-quick.ts, which launches fetch, merge --ff-only and push', () => {
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    assert.match(rule.slice(0, rule.indexOf('`client/dist/`')), /lib\/git-quick\.ts/);
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names lib/pr-status.ts, which launches gh pr view', () => {
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    const head = rule.slice(0, rule.indexOf('`client/dist/`'));
    for (const name of ['lib/pr-status.ts', '`gh pr view`']) assert.ok(head.includes(name), name);
  })) p++; else f++;

  if (test('.claude/CLAUDE.md zero-deps rule names lib/routine-reconcile.ts and lib/routine-store.ts, which launch launchctl, crontab, pgrep, ps, sysctl', () => {
    const md = fs.readFileSync(path.join(root, '.claude/CLAUDE.md'), 'utf8').replace(/\s+/g, ' ');
    const rule = md.slice(md.indexOf('Keep new deps out of'));
    const head = rule.slice(0, rule.indexOf('`client/dist/`'));
    for (const name of ['lib/routine-reconcile.ts', 'lib/routine-store.ts', '`launchctl`', '`crontab`', '`pgrep`', '`ps`', '`sysctl`']) assert.ok(head.includes(name), name);
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

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
