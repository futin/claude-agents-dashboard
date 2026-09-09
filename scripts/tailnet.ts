/**
 * tailnet.ts — publish the dashboard onto this machine's tailnet.
 *
 *   pnpm tailnet                  # HTTPS on 443 → the local port
 *   pnpm tailnet -- --http        # plain HTTP, tailnet port == local port
 *   pnpm tailnet:local            # the same, without the `--` dance
 *   pnpm tailnet status
 *   pnpm tailnet down             # and `pnpm tailnet:local down`
 *   pnpm tailnet -- --dry-run     # print the tailscale command, run nothing
 *
 * `pnpm tunnel` is the same script under its older name. `pnpm tailnet:local`
 * is it with `--http` already applied — `parseArgs` is order-independent, so
 * any subcommand or flag you add lands after it (`pnpm tailnet:local status`,
 * `pnpm tailnet:local down`, `pnpm tailnet:local --dry-run`).
 *
 * ## Why a script rather than the one-liner it replaces
 *
 * `pnpm tunnel` used to be literally `tailscale serve --bg 5174`. A serve
 * registration typed by hand stores a *copy* of the port inside tailscaled —
 * outside this repo, outside git, and surviving reboots. But which port the
 * dashboard actually holds comes from `.env`, as `WEB_PORT`, read through
 * `loadConfig`. This machine's `.env` already sits on a
 * non-default `WEB_PORT`, so the two had drifted apart, and
 * `docs/subsystems/remote-access.md` carried a standing "keep them in sync"
 * warning as the only defence. The symptom of losing that race is a bare 502
 * from Tailscale on the phone, which reads as a Tailscale fault rather than a
 * stale mapping.
 *
 * So the number lives in exactly one place — `.env`, read by the same
 * `loadConfig` the server and `vite.config.ts` read — and this script asks for
 * it. There is nothing left to keep in sync. `test/tailnet.test.ts` asserts
 * against this file's own source text that no dashboard port literal appears
 * in here at all.
 *
 * Ported from backlog-manager's `scripts/tailnet.mjs`, which exists for the
 * same reason one variable over.
 *
 * ## Why two modes, and why HTTPS is the default
 *
 * backlog-manager serves plain HTTP with the tailnet port and the loopback port
 * carrying the same number, which is a genuinely nicer property: one number per
 * project, identical wherever you type it. It cannot be had over HTTPS, because
 * `tailscale serve --https` accepts only 443, 8443 and 10000.
 *
 * Here that trade lands the other way round, because of one feature:
 * [dictation](../docs/subsystems/dictation.md)'s `getUserMedia` refuses to run
 * outside a secure context, so over a plain-http tailnet URL the phone can
 * never record. HTTPS on 443 is therefore the default — `https://<host>.<your
 * tailnet>.ts.net`, no port, a real browser-trusted certificate — and `--http`
 * opts into the matching-port shape for the cases HTTPS cannot serve: a tailnet
 * that has never had HTTPS certificates enabled in the admin console, or a
 * second project on this node that already holds 443.
 *
 * The two are not exclusive. The listeners are 443 and `<port>`, so both can be
 * registered at once; `down` takes the same flag as the `up` that made it.
 *
 * ## What is safe to expose this way
 *
 * Never Funnel. Every read endpoint here is open — full transcripts, chat
 * history, `/api/management/file` config bodies — and with `CLAUDE_BIN` set,
 * `/api/spawn` starts a real Claude Code session on this machine. A tailnet is
 * private WireGuard between your own devices and device identity is the auth,
 * which is why `ANSWER_TOKEN` may stay empty there and must not on anything
 * public. See `../docs/subsystems/remote-access.md`.
 *
 * The plain-HTTP mode is not a hole in that: the hop from the phone to this
 * machine is WireGuard-encrypted end to end, and the HTTP exists only inside
 * that tunnel, between tailscaled and a loopback socket. What it costs is the
 * browser's secure-context flag, and so dictation, and nothing else.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Config } from '../server/lib/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the tailscale CLI lives. Linux first, because that is what this repo
 * runs on; the Homebrew paths cover a Mac, and the fourth is the CLI embedded in
 * the GUI app, which is what you have if Tailscale came from the App Store —
 * there the binary is never on PATH, and `which tailscale` finding nothing is
 * not the same as Tailscale being absent.
 */
export const CLI_CANDIDATES = [
  '/usr/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
];

/**
 * The only port literal this file is allowed to contain, and it is not a
 * dashboard port: it is the one HTTPS listener Tailscale offers that needs no
 * port in the URL. `--https` accepts 443, 8443 and 10000 only.
 */
const HTTPS_LISTEN_PORT = 443;

export type Mode = 'https' | 'http';

/**
 * The one port this script fronts: `WEB_PORT`, the port `pnpm dev` serves the UI
 * on. Deliberately not offered a choice of prod `PORT` as well — the tailnet
 * route exists to be iterated against, prod static-serves the built
 * `client/dist` and so shows no change until `pnpm build` plus a `pnpm start`
 * restart, and a second target would put a second number back into a script
 * whose whole point is that there is only ever one.
 */
export function resolvePort(config: Config): number {
  const port = config.webPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`WEB_PORT is not a usable port: ${JSON.stringify(port)}`);
  }
  return port;
}

/**
 * In `http` mode the tailnet side and the loopback side carry the same number on
 * purpose: tailscaled answers this machine's tailnet address, the dev server
 * answers 127.0.0.1, and the two never contend for one socket.
 */
export function serveArgs(mode: Mode, port: number): string[] {
  const listen = mode === 'https' ? `--https=${HTTPS_LISTEN_PORT}` : `--http=${port}`;
  return ['serve', '--bg', listen, `http://127.0.0.1:${port}`];
}

/** Undoes the above. `off` takes the *listener's* port, not the target's. */
export function offArgs(mode: Mode, port: number): string[] {
  const listen = mode === 'https' ? `--https=${HTTPS_LISTEN_PORT}` : `--http=${port}`;
  return ['serve', listen, 'off'];
}

/** The URL to type into the phone. HTTPS on 443 needs no port; HTTP does. */
export function serveUrl(mode: Mode, host: string, port: number): string {
  return mode === 'https' ? `https://${host}` : `http://${host}:${port}`;
}

export const findCli = (candidates: string[] = CLI_CANDIDATES): string | undefined =>
  candidates.find(candidate => fs.existsSync(candidate));

/**
 * Is anything actually behind the port? `serve` registers happily against a dead
 * target and the failure surfaces on the phone as a bare 502, so it is worth one
 * connect attempt and a warning here. A refused connection is the answer, not an
 * error — hence the promise resolving either way.
 */
function listening(port: number, timeout = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * This machine's MagicDNS name, so the script can print the URL rather than
 * leaving you to reconstruct it. Best-effort: MagicDNS can be off, in which case
 * the tailnet IP is the honest answer — and note that an IP can only ever be
 * used with `--http`, since the certificate is issued for the DNS name.
 */
function tailnetHost(cli: string): string | undefined {
  const { status, stdout } = spawnSync(cli, ['status', '--json'], { encoding: 'utf8' });
  if (status !== 0) return undefined;
  try {
    const self = JSON.parse(stdout).Self ?? {};
    const dns = String(self.DNSName || '').replace(/\.$/, '');
    return dns || (self.TailscaleIPs ?? [])[0];
  } catch {
    return undefined;
  }
}

/**
 * Exported for the suite alone: the remedies are the whole value of the failure
 * path, and the wrong one costs a real debugging detour — a fresh node answers
 * `tailscale serve` with the single word `Logged out.` and the operator flag is
 * then not the fix.
 */
export const serveFailureRemedies = (): string[] => [
  'tailscale status',
  'sudo tailscale set --operator=$USER',
  'tailscale up',
  'https://login.tailscale.com/admin/dns'
];

/**
 * `serve` is an operator-only operation: it edits the node's configuration, so
 * tailscaled refuses it from a user who is neither root nor the declared
 * operator. The remedy is one command, but this script will not run it — a
 * helper that silently escalates to change your machine's network config is
 * worse than an error message. Print the fix, let the human decide.
 *
 * Four causes, because the CLI's own output does not always name the one you
 * have. The logged-out case comes first: it answers with `Logged out.` and
 * nothing else, and the operator advice is then the wrong fix — there is no
 * tailnet identity for a serve to hang off yet, so no amount of permission
 * helps. `up` needs root as well, so the two remedies are ordered: claim the
 * operator flag once, then log in without sudo forever after.
 */
function reportServeFailure(mode: Mode, port: number): void {
  const listener = mode === 'https' ? `HTTPS on ${HTTPS_LISTEN_PORT}` : `HTTP on ${port}`;
  const lines = [
    '',
    `tailscale refused to serve ${listener}.`,
    '',
    'If it said `Logged out.`, this node has no tailnet identity yet — check',
    'with `tailscale status`, then:',
    '  sudo tailscale set --operator=$USER   # once, so the rest needs no sudo',
    '  tailscale up                          # opens a browser login',
    '',
    'If it complained about access, this user is not the tailscaled operator:',
    '  sudo tailscale set --operator=$USER',
    ''
  ];
  if (mode === 'https') {
    lines.push(
      'If it complained about HTTPS or a certificate, this tailnet has never had',
      'HTTPS certificates enabled — a one-time switch on the admin DNS page:',
      '  https://login.tailscale.com/admin/dns',
      'Until then use `pnpm tailnet -- --http`, which needs no certificate (and',
      'no secure context, so dictation stays disabled on it).',
      ''
    );
  }
  lines.push(
    `If it complained about the port, something else may already hold that`,
    'listener on the tailnet side — `pnpm tailnet status` lists what is',
    'registered. This node has three HTTPS slots in total (443, 8443, 10000),',
    'shared across every project on it.',
    ''
  );
  process.stderr.write(lines.join('\n'));
}

interface Ctx {
  mode: Mode;
  /** The local port being fronted — the target of the proxy, never the listener. */
  port: number;
  cli: string | undefined;
  dryRun: boolean;
}

async function up({ mode, port, cli, dryRun }: Ctx): Promise<number> {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} ${serveArgs(mode, port).join(' ')}\n`);
    return 0;
  }

  if (!(await listening(port))) {
    // Not fatal: registering before the dashboard is up is a reasonable order to
    // work in, and the registration persists across reboots. Worth saying out
    // loud, though, because the symptom on the phone gives no hint of the cause.
    process.stdout.write(
      `warning: nothing is listening on 127.0.0.1:${port} — start it with \`pnpm dev\`\n`
    );
  }

  const { status } = spawnSync(cli as string, serveArgs(mode, port), { stdio: 'inherit' });
  if (status !== 0) {
    reportServeFailure(mode, port);
    return status ?? 1;
  }

  const host = tailnetHost(cli as string) ?? '<this-machine>.<your-tailnet>.ts.net';
  process.stdout.write(`\nserving ${serveUrl(mode, host, port)} to your tailnet\n`);
  process.stdout.write(`  → 127.0.0.1:${port}\n`);
  // This machine being awake is the actual day-to-day failure mode, and no
  // amount of correct configuration survives it.
  process.stdout.write(
    'reachable from anywhere you are logged into the tailnet, while this machine is awake\n'
  );
  if (mode === 'http') {
    process.stdout.write(
      'note: plain HTTP is not a secure context, so dictation renders disabled on this URL\n'
    );
  }
  return 0;
}

function down({ mode, port, cli, dryRun }: Ctx): number {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} ${offArgs(mode, port).join(' ')}\n`);
    return 0;
  }
  const { status } = spawnSync(cli as string, offArgs(mode, port), { stdio: 'inherit' });
  if (status !== 0) reportServeFailure(mode, port);
  return status ?? 1;
}

async function status({ port, cli, dryRun }: Ctx): Promise<number> {
  if (dryRun) {
    process.stdout.write(`${cli ?? 'tailscale'} serve status\n`);
    return 0;
  }
  spawnSync(cli as string, ['serve', 'status'], { stdio: 'inherit' });
  const alive = await listening(port);
  process.stdout.write(`\n127.0.0.1:${port}: ${alive ? 'listening' : 'nothing there'}\n`);
  return 0;
}

const COMMANDS = { up, down, status };
type Command = keyof typeof COMMANDS;

const isCommand = (value: string): value is Command => Object.hasOwn(COMMANDS, value);

export interface ParsedArgs {
  command: Command;
  mode: Mode;
  dryRun: boolean;
}

/**
 * `[up|down|status] [--http|--https] [--dry-run]`, every part optional. A bare
 * `--` is dropped rather than read as the command: `pnpm tailnet -- --http` is
 * how pnpm forwards a flag, and the separator arrives here as its own argv entry
 * — reading it as the subcommand made the documented invocation exit 2 in the
 * script this was ported from.
 */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  let command: Command = 'up';
  let mode: Mode | undefined;
  let dryRun = false;
  let sawCommand = false;

  for (const arg of argv) {
    if (arg === '--' || arg === '') continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--http' || arg === '--https') {
      const next = arg.slice(2) as Mode;
      if (mode !== undefined && mode !== next) return { error: 'pick one of --http or --https' };
      mode = next;
    } else if (!sawCommand && isCommand(arg)) {
      command = arg;
      sawCommand = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  return { command, mode: mode ?? 'https', dryRun };
}

/**
 * The one reader of the port. `.env` is resolved from the repo root rather than
 * `process.cwd()` so the script behaves the same run from a subdirectory as it
 * does through `pnpm`, which always starts at the root.
 */
function loadRepoConfig(): Config {
  return loadConfig({ envPath: path.join(REPO_ROOT, '.env') });
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write('usage: tailnet [up|down|status] [--http|--https] [--dry-run]\n');
    return 2;
  }
  const { command, mode, dryRun } = parsed;

  let port: number;
  try {
    port = resolvePort(loadRepoConfig());
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  // Resolved after the port so that --dry-run works on a machine without
  // Tailscale at all: the command it would run is a fact about this repo's
  // configuration, not about what happens to be installed.
  const cli = findCli();
  if (!cli && !dryRun) {
    process.stderr.write(
      `tailscale CLI not found. Looked in:\n${CLI_CANDIDATES.map(p => `  ${p}`).join('\n')}\n`
    );
    return 2;
  }

  return COMMANDS[command]({ mode, port, cli, dryRun });
}

// Guarded so the suite can import the helpers without registering anything as a
// side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
