/**
 * `scripts/tailnet.ts` — the tailnet publisher, and the one place the served
 * port is decided.
 *
 * The bug this file exists to prevent: `pnpm tunnel` used to be the literal
 * one-liner `tailscale serve --bg 5174`, while the port the dashboard actually
 * holds comes out of `.env` as `WEB_PORT`, through `loadConfig`. A
 * `tailscale serve` registration stores a *copy* of that number inside
 * tailscaled — outside this repo, outside git, surviving reboots — so the moment
 * `.env` moved, the copy kept pointing at the old port and the phone got a bare
 * 502 from Tailscale, which reads as a Tailscale fault rather than a stale
 * mapping. This machine's `.env` already sits on a non-default `WEB_PORT`, so it
 * was not hypothetical; `docs/subsystems/remote-access.md` carried a standing
 * "keep them in sync" warning as the only defence.
 *
 * So the assertions below are less about a CLI's output format than about two
 * properties: every port in the emitted command came from `loadConfig`, and the
 * script contains no port literal of its own for one to drift away from.
 *
 * Two halves. The pure helpers are imported and called directly. The command
 * dispatch runs as a real CLI under `--dry-run`, because that is where the argv
 * parsing and the exit codes live — and a test that reconfigured this machine's
 * network to prove a string would be a worse test than no test.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../server/lib/config.js';
import {
  offArgs,
  parseArgs,
  resolvePort,
  serveArgs,
  serveFailureRemedies,
  serveUrl
} from '../scripts/tailnet.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const SCRIPT = path.join(REPO, 'scripts', 'tailnet.ts');

/** A port no real config here uses, so a leak from `.env` cannot fake a pass. */
const WEB_PORT = '5199';

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with `WEB_PORT` pinned: the repo's own `.env` holds a real value
 * for it, and a developer who also exports one must not decide this suite.
 * `process.env` beats the file inside `loadConfig`, so setting it here fixes the
 * port these cases assert on.
 */
function tailnet(args: string[], extraEnv: Record<string, string> = {}): Result {
  const env = { ...process.env, WEB_PORT, ...extraEnv };
  const r = spawnSync(TSX, [SCRIPT, ...args, '--dry-run'], { encoding: 'utf8', env });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== tailnet.ts (publishing the dashboard to the tailnet) ===\n');
  let p = 0, f = 0;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tailnet-'));
  const envFile = (body: string): string => {
    const file = path.join(dir, `env-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, body);
    return file;
  };
  const source = fs.readFileSync(SCRIPT, 'utf8');
  /** The script minus its comments — where a stray literal would actually bite. */
  const code = source
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  const r = (ok: boolean): void => { ok ? p++ : f++; };

  // --- the emitted commands -------------------------------------------------

  r(test('defaults to HTTPS on 443 fronting WEB_PORT, with no port in the URL', () => {
    const { status, stdout } = tailnet([]);
    assert.strictEqual(status, 0, stdout);
    // 443 is the listener and WEB_PORT is the target: unlike the http mode the
    // two numbers are deliberately different, because --https takes only 443,
    // 8443 and 10000 and so can never mirror an arbitrary dev port.
    assert.strictEqual(
      stdout.trim().split(' ').slice(1).join(' '),
      `serve --bg --https=443 http://127.0.0.1:${WEB_PORT}`
    );
  }));

  r(test('--http mirrors the local port onto the tailnet side', () => {
    const { status, stdout } = tailnet(['--http']);
    assert.strictEqual(status, 0, stdout);
    // One number, both sides: tailscaled answers this machine's tailnet address
    // and the dev server answers 127.0.0.1, so they never contend for a socket.
    assert.match(stdout, new RegExp(`serve --bg --http=${WEB_PORT} http://127\\.0\\.0\\.1:${WEB_PORT}`));
  }));

  r(test('never fronts prod PORT — WEB_PORT is the only target there is', () => {
    // Deliberately no second target: a choice of ports would put a second
    // number back into the script, and prod static-serves the built client so
    // nothing appears there until `pnpm build` plus a restart.
    const { status, stderr } = tailnet(['prod'], { PORT: '4399' });
    assert.notStrictEqual(status, 0);
    assert.match(stderr, /prod/);
    assert.strictEqual(tailnet([], { PORT: '4399' }).stdout.includes('4399'), false);
  }));

  r(test('down removes the listener it created, in either mode', () => {
    // `off` takes the *listener's* port, not the target's — a mismatch here
    // would leave a serve registered that `pnpm tailnet down` could never undo.
    assert.match(tailnet(['down']).stdout, /serve --https=443 off/);
    assert.match(tailnet(['down', '--http']).stdout, new RegExp(`serve --http=${WEB_PORT} off`));
  }));

  r(test('status asks tailscaled rather than guessing', () => {
    const { status, stdout } = tailnet(['status']);
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, /serve status/);
  }));

  // --- argv parsing ---------------------------------------------------------

  r(test('drops the bare -- that pnpm forwards, rather than reading it as a command', () => {
    // `pnpm tailnet -- --http` is how a flag reaches the script through pnpm,
    // and the separator arrives as its own argv entry. Reading it as the
    // subcommand made the documented invocation exit 2 in the ported original.
    const { status, stdout } = tailnet(['--', '--http']);
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, new RegExp(`serve --bg --http=${WEB_PORT}`));
  }));

  r(test('rejects an unknown argument by name instead of guessing', () => {
    const { status, stderr } = tailnet(['sideways']);
    assert.notStrictEqual(status, 0);
    assert.match(stderr, /sideways/);
    assert.match(stderr, /usage:/);
  }));

  r(test('refuses --http and --https together', () => {
    const { status, stderr } = tailnet(['--http', '--https']);
    assert.notStrictEqual(status, 0);
    assert.match(stderr, /--http/);
  }));

  r(test('parseArgs defaults, and every part optional', () => {
    assert.deepStrictEqual(parseArgs([]), { command: 'up', mode: 'https', dryRun: false });
    assert.deepStrictEqual(parseArgs(['down', '--http', '--dry-run']),
      { command: 'down', mode: 'http', dryRun: true });
    // Order is not significant: the flag and the command interleave freely.
    assert.deepStrictEqual(parseArgs(['--http', 'status']),
      { command: 'status', mode: 'http', dryRun: false });
    assert.deepStrictEqual(parseArgs(['--https', '--https']),
      { command: 'up', mode: 'https', dryRun: false });
    assert.ok('error' in parseArgs(['up', 'down']), 'two commands is not a thing');
  }));

  // --- the port comes from .env, through loadConfig -------------------------

  r(test('reads the port out of .env, so nothing has to be kept in sync', () => {
    // The property the whole script exists for. Not a second parser: the same
    // loadConfig the server and vite.config.ts use, so there is one reader.
    const file = envFile('# comment\nWEB_PORT=5211\nPORT=4211\n');
    assert.strictEqual(resolvePort(loadConfig({ envPath: file })), 5211);
  }));

  r(test('an exported variable beats the file, as it does for the server itself', () => {
    const file = envFile('WEB_PORT=5211\n');
    const before = process.env.WEB_PORT;
    process.env.WEB_PORT = '5222';
    try {
      assert.strictEqual(resolvePort(loadConfig({ envPath: file })), 5222);
    } finally {
      if (before === undefined) delete process.env.WEB_PORT; else process.env.WEB_PORT = before;
    }
  }));

  r(test('a missing .env is not an error — the defaults are the answer', () => {
    // The ordinary case on a fresh checkout: .env is gitignored, and that is
    // precisely when the compiled-in defaults have to apply.
    const before = process.env.WEB_PORT;
    delete process.env.WEB_PORT;
    try {
      const config = loadConfig({ envPath: path.join(dir, 'absent', '.env') });
      assert.strictEqual(resolvePort(config), config.webPort);
      assert.ok(resolvePort(config) > 0);
    } finally {
      if (before !== undefined) process.env.WEB_PORT = before;
    }
  }));

  r(test('refuses a port that is not a port, naming the key', () => {
    // A caller passing a hand-built config, or a future loader that stops
    // sanitising: better a named error here than a tailscale complaint about
    // flags.
    const config = loadConfig({ envPath: envFile('') });
    for (const bad of [0, -1, 70000, Number.NaN, 5184.5]) {
      assert.throws(() => resolvePort({ ...config, webPort: bad }), /WEB_PORT/);
    }
  }));

  // --- invariants over the source ------------------------------------------

  r(test('hardcodes no dashboard port of its own', () => {
    // The one invariant worth asserting against the source text: any dashboard
    // port literal in here is a second place the number lives, which is exactly
    // the drift that produced the 502.
    for (const port of ['5173', '5174', '5184', '4173', WEB_PORT]) {
      assert.strictEqual(code.match(new RegExp(`\\b${port}\\b`)), null,
        `port ${port} is hardcoded in scripts/tailnet.ts`);
    }
    // 443 is allowed, and only as the named constant: it is a Tailscale
    // listener number, not a dashboard port, and --https accepts nothing else
    // that omits the port from the URL.
    assert.match(code, /HTTPS_LISTEN_PORT = 443/);
  }));

  r(test('the serve URL carries a port only when it needs one', () => {
    const host = 'box.example.ts.net';
    // 443 is implicit in https://, and the certificate is issued for the DNS
    // name — printing :443 would invite someone to type it into the http form.
    assert.strictEqual(serveUrl('https', host, 5211), `https://${host}`);
    assert.strictEqual(serveUrl('http', host, 5211), `http://${host}:5211`);
  }));

  r(test('both args builders agree on the listener, per mode', () => {
    assert.deepStrictEqual(serveArgs('https', 5211), ['serve', '--bg', '--https=443', 'http://127.0.0.1:5211']);
    assert.deepStrictEqual(offArgs('https', 5211), ['serve', '--https=443', 'off']);
    assert.deepStrictEqual(serveArgs('http', 5211), ['serve', '--bg', '--http=5211', 'http://127.0.0.1:5211']);
    assert.deepStrictEqual(offArgs('http', 5211), ['serve', '--http=5211', 'off']);
  }));

  r(test('names the logged-out cause and the certificate cause, not just the operator one', () => {
    // The failure a fresh WSL node actually hits: `tailscale serve` prints the
    // single word `Logged out.` and nothing else, and a message offering only
    // --operator sends you after a permission problem you do not have. The
    // certificate remedy is the https-mode equivalent — a tailnet that never
    // enabled HTTPS refuses 443 and the fix is a one-time admin-console switch,
    // not anything on this machine.
    assert.match(source, /Logged out\./);
    for (const remedy of serveFailureRemedies()) {
      assert.ok(source.includes(remedy), `failure message lost its ${remedy} remedy`);
    }
  }));

  r(test('never suggests Funnel', () => {
    // Deliberate: every read endpoint here is unauthenticated and /api/spawn
    // starts a real Claude Code session on this machine. The tailnet is the
    // perimeter, and `tailscale funnel` is exactly the command that removes it.
    assert.strictEqual(code.match(/funnel/i), null);
  }));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
