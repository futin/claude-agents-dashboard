/**
 * The `token` block of `scripts/install-hooks.sh` — the one production caller of
 * `scripts/env-value.ts`.
 *
 * `test/env-value.test.ts` proves the reader answers correctly. That is only half
 * of backlog bug-6: the half that actually bit was the *caller*, which had its own
 * parser, believed it, and reported success. So this file drives the real script,
 * always with `--dry-run` and always against a throwaway `CLAUDE_CONFIG_DIR`, and
 * asserts the two properties a wrong caller cannot have:
 *
 *   - **It names the source the value really came from.** `env-value` mirrors
 *     `loadConfig`, so an exported `ANSWER_TOKEN` beats the file. A caller that
 *     hardcodes ".env" then writes the shell's token while claiming it copied the
 *     checkout's, and its `warn` line sends you to edit a `.env` that may already
 *     match the token file byte for byte.
 *   - **A reader that fails is never reported as "no token".** node exits 1 for an
 *     uncaught error and `env-value` exits 1 for "unset", so the exit code alone
 *     cannot separate them — only the `unset` marker on stderr can. Get this wrong
 *     and a half-installed `node_modules` prints
 *     `TODO no ANSWER_TOKEN in .env` for a token that is plainly there, which is
 *     the sentence this bug is named after.
 *
 * Nothing here touches the real `~/.claude`: `CLAUDE_CONFIG_DIR` and `HOME` are
 * both redirected into tmpdirs, and `--dry-run` suppresses every write the script
 * makes anyway. The token file each case starts with is asserted byte-identical
 * afterwards.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A scratch checkout: real `scripts/`, everything else symlinked back. */
interface Scratch {
  /** The fake repo root — what the script resolves `$REPO` to. */
  repo: string;
  /** The fake `~/.claude`, passed as `CLAUDE_CONFIG_DIR`. */
  claude: string;
  /** `<claude>/hooks/dashboard-token`. */
  tokenFile: string;
  cleanup(): void;
}

function makeScratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-installer-'));
  const repo = path.join(dir, 'repo');
  const claude = path.join(dir, 'claude');
  // `scripts/` must be real files, not a symlink: the script resolves its own
  // root with `cd "$(dirname "$0")/.." && pwd`, and `cd` through a symlinked
  // directory would land back in the real checkout.
  fs.cpSync(path.join(REPO, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
  for (const entry of ['node_modules', 'server', 'shared', 'package.json']) {
    fs.symlinkSync(path.join(REPO, entry), path.join(repo, entry));
  }
  fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true });
  return {
    repo, claude,
    tokenFile: path.join(claude, 'hooks', 'dashboard-token'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

interface RunOptions {
  /** Body of the scratch `.env`. Omitted = no `.env` at all. */
  env?: string;
  /** Contents of the token file. Omitted = no token file. */
  token?: string;
  /** Overlaid on the environment; `ANSWER_TOKEN` is cleared unless named here. */
  shell?: Record<string, string>;
  /** Extra flags after the mandatory `--dry-run`. */
  flags?: string[];
  /** Replace the scratch copy of `env-value.ts` with this source, to break it. */
  reader?: string;
}

interface RunResult {
  /** Just the `token` section of the output — the block this file is about. */
  token: string;
  /** The whole stdout, for the rare assertion that spans sections. */
  all: string;
  /** The token file's exact bytes afterwards, or null if there is none. */
  after: string | null;
}

/** Pull the `token` section: from the `token` heading to the next blank line. */
function tokenSection(stdout: string): string {
  const lines = stdout.split('\n');
  const start = lines.indexOf('token');
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.trim() === '');
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function runInstaller(s: Scratch, options: RunOptions = {}): RunResult {
  const envFile = path.join(s.repo, '.env');
  fs.rmSync(envFile, { force: true });
  if (options.env !== undefined) fs.writeFileSync(envFile, options.env);

  fs.rmSync(s.tokenFile, { force: true });
  if (options.token !== undefined) fs.writeFileSync(s.tokenFile, options.token);

  if (options.reader !== undefined) {
    fs.writeFileSync(path.join(s.repo, 'scripts', 'env-value.ts'), options.reader);
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: s.claude,
    HOME: path.join(s.repo, '..'),
    ...(options.shell ?? {})
  };
  if (!options.shell || !('ANSWER_TOKEN' in options.shell)) delete env.ANSWER_TOKEN;

  const r = spawnSync('bash', [path.join(s.repo, 'scripts', 'install-hooks.sh'), '--dry-run', ...(options.flags ?? [])],
    { encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  const stdout = `${r.stdout}${r.stderr}`;
  return {
    token: tokenSection(stdout),
    all: stdout,
    after: fs.existsSync(s.tokenFile) ? fs.readFileSync(s.tokenFile, 'utf8') : null
  };
}

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== install-hooks.sh: the token block (env-value.ts call site) ===\n');

  // The script hard-requires jq for the settings merge and exits before the
  // token block without it. Report that loudly rather than passing vacuously.
  if (spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.log('  ⚠ SKIPPED — jq is not installed, and install-hooks.sh exits before');
    console.log('    the token block without it. These cases did not run.');
    return 0;
  }

  let p = 0, f = 0;
  const s = makeScratch();

  try {
    // ---------------------------------------------------------------- part 1
    // The three rows of the divergence table, now through the real caller.
    for (const [label, body] of [
      ['a leading space', ' ANSWER_TOKEN=abc\n'],
      ['a quoted inner space', 'ANSWER_TOKEN="a b"\n'],
      ['a duplicated key', 'ANSWER_TOKEN=one\nANSWER_TOKEN=two\n']
    ] as const) {
      if (test(`${label} in .env reaches the write branch, not the TODO branch`, () => {
        const r = runInstaller(s, { env: body });
        assert.match(r.token, /^ {2}write {4}\S+dashboard-token from this checkout's \.env ANSWER_TOKEN$/m,
          `expected a write step, got:\n${r.token}`);
        assert.ok(!/no ANSWER_TOKEN/.test(r.token), 'the TODO branch is the bug');
      })) p++; else f++;
    }

    // ------------------------------------------------- part 1, the source name
    if (test('an exported ANSWER_TOKEN is named as the shell, never as .env', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=from-file\n', shell: { ANSWER_TOKEN: 'from-shell' } });
      assert.match(r.token, /write {4}\S+dashboard-token from the ANSWER_TOKEN exported in this shell/,
        `the write line must name the shell, got:\n${r.token}`);
      assert.ok(!/\.env ANSWER_TOKEN/.test(r.token),
        `writing the shell's value while crediting .env is the finding, got:\n${r.token}`);
    })) p++; else f++;

    if (test('the warn line names the shell too, so its advice is actionable', () => {
      // The token file matches .env exactly and differs only from the export.
      // Told to "edit .env", the user would change nothing.
      const r = runInstaller(s, {
        env: 'ANSWER_TOKEN=from-file\n', token: 'from-file', shell: { ANSWER_TOKEN: 'from-shell' }
      });
      assert.match(r.token, /warn {5}\S+dashboard-token differs from the ANSWER_TOKEN exported in this shell\./,
        `got:\n${r.token}`);
      assert.ok(!/differs from this checkout's \.env/.test(r.token),
        'the file matches .env byte for byte — saying it differs from .env is false');
      assert.strictEqual(r.after, 'from-file', 'the file is left alone');
    })) p++; else f++;

    if (test('with no export, the source named is .env', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=abc\n', token: 'abc' });
      assert.match(r.token, /ok {7}\S+dashboard-token already exists and matches this checkout's \.env ANSWER_TOKEN/,
        `got:\n${r.token}`);
    })) p++; else f++;

    // ---------------------------------------------------------------- part 2
    if (test('a token file that differs is warned about and left alone', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=abc\n', token: 'stale-token' });
      assert.match(r.token, /warn {5}\S+dashboard-token differs from this checkout's \.env ANSWER_TOKEN\./, `got:\n${r.token}`);
      assert.strictEqual(r.after, 'stale-token');
    })) p++; else f++;

    if (test('a trailing newline is a real difference, not a match', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=abc\n', token: 'abc\n' });
      assert.match(r.token, /warn {5}/, `the server compares the header exactly, got:\n${r.token}`);
      assert.strictEqual(r.after, 'abc\n');
    })) p++; else f++;

    if (test('--force takes the write branch on a differing file', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=abc\n', token: 'stale-token', flags: ['--force'] });
      assert.match(r.token, /write {4}\S+dashboard-token replaced from this checkout's \.env ANSWER_TOKEN \(--force\)/, `got:\n${r.token}`);
      assert.strictEqual(r.after, 'stale-token', '--dry-run still writes nothing');
    })) p++; else f++;

    if (test('a token file with nothing in .env to compare is left alone', () => {
      const r = runInstaller(s, { env: 'NTFY_TOPIC=x\n', token: 'whatever' });
      assert.match(r.token, /ok {7}\S+dashboard-token already exists \(left alone\)/, `got:\n${r.token}`);
      assert.strictEqual(r.after, 'whatever');
    })) p++; else f++;

    if (test('genuinely no token anywhere is the TODO branch', () => {
      const r = runInstaller(s);
      assert.match(r.token, /TODO {5}no ANSWER_TOKEN in \.env/, `got:\n${r.token}`);
    })) p++; else f++;

    // ------------------------------------------- the reader that fails to run
    // Each of these replaces the scratch copy of env-value.ts, so the scratch is
    // rebuilt afterwards. The assertion that matters in all of them is the same:
    // NOT the "no ANSWER_TOKEN in .env" sentence, because nothing is known.
    const broken: Array<[string, string]> = [
      ['throws at import (node exits 1, the same code as "unset")', "throw new Error('boom');\n"],
      ['exits nonzero without a marker', 'process.exit(3);\n'],
      ['exits 0 but prints nothing at all', 'process.exit(0);\n'],
      ['prints a value but no source line', "process.stdout.write('a-token');\n"]
    ];
    for (const [label, source] of broken) {
      if (test(`a reader that ${label} is a distinct failure, not "no ANSWER_TOKEN"`, () => {
        const scratch = makeScratch();
        try {
          const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', reader: source });
          assert.ok(!/no ANSWER_TOKEN in \.env/.test(r.token),
            `reporting "no token" for a token that exists is the entire bug, got:\n${r.token}`);
          assert.match(r.token, /TODO {5}could not read ANSWER_TOKEN/, `got:\n${r.token}`);
          assert.match(r.token, /NOT "no token set"/, `got:\n${r.token}`);
        } finally { scratch.cleanup(); }
      })) p++; else f++;
    }

    if (test('a failing reader leaves an existing token file untouched and unjudged', () => {
      const scratch = makeScratch();
      try {
        const r = runInstaller(scratch, {
          env: 'ANSWER_TOKEN=abc\n', token: 'live-token', reader: "throw new Error('boom');\n"
        });
        assert.match(r.token, /TODO {5}could not read ANSWER_TOKEN/, `got:\n${r.token}`);
        // Neither "matches", "differs" nor "left alone": all three are claims
        // about a comparison that could not be made.
        assert.ok(!/matches|differs|left alone/.test(r.token), `got:\n${r.token}`);
        assert.strictEqual(r.after, 'live-token');
      } finally { scratch.cleanup(); }
    })) p++; else f++;

    // The missing-binary branch, which is a different failure from a broken one.
    if (test('no node_modules at all says "run pnpm install", not "no ANSWER_TOKEN"', () => {
      const scratch = makeScratch();
      try {
        fs.rmSync(path.join(scratch.repo, 'node_modules'));
        const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n' });
        assert.match(r.token, /TODO {5}run pnpm install first/, `got:\n${r.token}`);
        assert.ok(!/no ANSWER_TOKEN in \.env/.test(r.token));
      } finally { scratch.cleanup(); }
    })) p++; else f++;

    // ------------------------------------------------------------- no leakage
    if (test('no branch ever prints the token value', () => {
      const secret = 'zz-not-in-any-output-zz';
      const other = 'yy-also-not-printed-yy';
      for (const options of [
        { env: `ANSWER_TOKEN=${secret}\n` },
        { env: `ANSWER_TOKEN=${secret}\n`, token: other },
        { env: `ANSWER_TOKEN=${secret}\n`, token: other, flags: ['--force'] },
        { env: `ANSWER_TOKEN=${secret}\n`, shell: { ANSWER_TOKEN: other } }
      ]) {
        const r = runInstaller(s, options);
        assert.ok(!r.all.includes(secret), `.env value leaked:\n${r.token}`);
        assert.ok(!r.all.includes(other), `other value leaked:\n${r.token}`);
      }
    })) p++; else f++;
  } finally {
    s.cleanup();
  }

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
