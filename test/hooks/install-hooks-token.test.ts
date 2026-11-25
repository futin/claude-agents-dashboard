/**
 * The `token` block of `scripts/install-hooks.sh` — the one production caller of
 * `scripts/env-value.ts`.
 *
 * `test/settings/env-value.test.ts` proves the reader answers correctly. That is only half
 * of backlog bug-6: the half that actually bit was the *caller*, which had its own
 * parser, believed it, and reported success. So this file drives the real script,
 * always against a throwaway `CLAUDE_CONFIG_DIR` and, but for the real-write cases (#569), with `--dry-run`, and
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
 * makes anyway. The real-write cases (#569) drop `--dry-run` to see a written file's
 * bytes, mode and inode, each in a scratch of its own. Elsewhere the token file each
 * case starts with is asserted byte-identical afterwards.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  /** Extra flags after `--dry-run` (or alone, with `write`). */
  flags?: string[];
  /** Run for real, without `--dry-run`: the only way to see a written token file's bytes and mode. */
  write?: boolean;
  /** Mode the starting token file is chmodded to (with `token`). */
  tokenMode?: number;
  /** Make the token file a symlink to this path instead (`token` is then ignored). */
  tokenLink?: string;
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
  /** The token file's permission bits afterwards (`mode & 0o777`), or null if there is none. */
  mode: number | null;
  /** The installer's exit status. */
  status: number | null;
  /** The token file's inode before the run and after it, or null where there is none — a replaced file has a new one, a truncated one does not. */
  inoBefore: number | null;
  ino: number | null;
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
  if (options.tokenLink !== undefined) fs.symlinkSync(options.tokenLink, s.tokenFile);
  else if (options.token !== undefined) {
    fs.writeFileSync(s.tokenFile, options.token);
    if (options.tokenMode !== undefined) fs.chmodSync(s.tokenFile, options.tokenMode);
  }

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

  const inoBefore = fs.existsSync(s.tokenFile) ? fs.statSync(s.tokenFile).ino : null;
  // Under umask 022, the usual default: a file created by a plain `>` redirect is then 0644, which is the exposure the real-write cases look for.
  const args = [...(options.write ? [] : ['--dry-run']), ...(options.flags ?? [])];
  const r = spawnSync('bash', ['-c', 'umask 022; exec bash "$0" "$@"', path.join(s.repo, 'scripts', 'install-hooks.sh'), ...args],
    { encoding: 'utf8', env: env as NodeJS.ProcessEnv });
  const stdout = `${r.stdout}${r.stderr}`;
  const exists = fs.existsSync(s.tokenFile);
  return {
    token: tokenSection(stdout),
    all: stdout,
    after: exists ? fs.readFileSync(s.tokenFile, 'utf8') : null,
    mode: exists ? fs.statSync(s.tokenFile).mode & 0o777 : null,
    status: r.status,
    inoBefore,
    ino: exists ? fs.statSync(s.tokenFile).ino : null
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

    if (test('genuinely no token anywhere needs no token file: the hooks reach the dashboard on loopback', () => {
      const r = runInstaller(s);
      assert.ok(r.token.includes(
        'ok       no token file needed — hooks reach the dashboard on loopback (set ANSWER_TOKEN only for a container or a non-loopback CLAUDE_DASHBOARD_URL)'
      ), `got:\n${r.token}`);
      assert.ok(!/TODO {5}no ANSWER_TOKEN/.test(r.token), `the old TODO is gone, got:\n${r.token}`);
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

    // ------------------------------------------------------- the real writes (#569)
    // Every case above is --dry-run, so none of them ever executed a token write. These do, each in a fresh scratch (a real run also links the hooks
    // and writes settings.json into it), under umask 022.
    if (test('first install writes the token file 0600 with the exact bytes', () => {
      const scratch = makeScratch();
      try {
        const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', write: true });
        assert.strictEqual(r.status, 0, `got:\n${r.all}`);
        assert.strictEqual(r.after, 'abc', 'no trailing newline: the server compares the header exactly');
        assert.strictEqual(r.mode, 0o600, `mode was ${r.mode?.toString(8)}`);
      } finally { scratch.cleanup(); }
    })) p++; else f++;

    if (test('--force over an existing 0644 file replaces it with a 0600 one', () => {
      const scratch = makeScratch();
      try {
        const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', token: 'stale-token', tokenMode: 0o644, flags: ['--force'], write: true });
        assert.strictEqual(r.status, 0, `got:\n${r.all}`);
        assert.strictEqual(r.after, 'abc');
        assert.strictEqual(r.mode, 0o600, `mode was ${r.mode?.toString(8)}`);
        // The end state alone cannot tell the fix from the bug: the old one-liner's chmod also ended at 0600. What differs is the inode. The old
        // `>` truncated the existing 0644 inode, so the new token sat in it readable until the chmod ran (and stayed there if the chmod failed). A
        // rename writes into a temp file that is 0600 from birth and never touches the 0644 inode at all.
        assert.notStrictEqual(r.ino, r.inoBefore, 'the 0644 inode must be replaced, never truncated and refilled');
        const left = fs.readdirSync(path.dirname(scratch.tokenFile)).filter(n => n.startsWith('.dashboard-token.'));
        assert.deepStrictEqual(left, [], 'no temp file is left behind');
      } finally { scratch.cleanup(); }
    })) p++; else f++;

    if (test('a write that cannot happen fails loudly and leaves no token or temp file', () => {
      const scratch = makeScratch();
      const hooks = path.dirname(scratch.tokenFile);
      try {
        fs.chmodSync(hooks, 0o555);
        const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', write: true });
        assert.notStrictEqual(r.status, 0, `a failed token write must not read as success, got:\n${r.all}`);
        assert.match(r.all, /FAILED {3}could not write \S+dashboard-token privately/, `got:\n${r.all}`);
        assert.strictEqual(r.after, null);
        assert.deepStrictEqual(fs.readdirSync(hooks).filter(n => n.startsWith('.dashboard-token.')), []);
      } finally { fs.chmodSync(hooks, 0o755); scratch.cleanup(); }
    })) p++; else f++;

    if (test('--force leaves a symlinked token file alone', () => {
      const scratch = makeScratch();
      const target = path.join(scratch.claude, '..', 'mounted-secret');
      try {
        fs.writeFileSync(target, 'mounted-token');
        const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', tokenLink: target, flags: ['--force'], write: true });
        assert.strictEqual(r.status, 0, `got:\n${r.all}`);
        assert.ok(fs.lstatSync(scratch.tokenFile).isSymbolicLink(), 'the link is still a link');
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'mounted-token', 'its target is untouched');
        assert.match(r.token, /warn {5}\S+dashboard-token is a symlink/, `got:\n${r.token}`);
      } finally { scratch.cleanup(); }
    })) p++; else f++;

    for (const flags of [[], ['--force']]) {
      if (test(`a dangling symlinked token file is left alone${flags.length ? ' under --force' : ''}`, () => {
        const scratch = makeScratch();
        const target = path.join(scratch.claude, '..', 'not-mounted-yet');
        try {
          const r = runInstaller(scratch, { env: 'ANSWER_TOKEN=abc\n', tokenLink: target, flags, write: true });
          assert.strictEqual(r.status, 0, `got:\n${r.all}`);
          assert.ok(fs.lstatSync(scratch.tokenFile).isSymbolicLink(), 'the link is still a link');
          assert.ok(!fs.existsSync(target), 'nothing was written through it either');
          assert.match(r.token, /warn {5}\S+dashboard-token is a symlink to a missing file/, `got:\n${r.token}`);
        } finally { scratch.cleanup(); }
      })) p++; else f++;
    }

    if (test('the manual remedy in the warn line never writes before narrowing the mode', () => {
      const r = runInstaller(s, { env: 'ANSWER_TOKEN=abc\n', token: 'stale-token' });
      assert.ok(!/> \S+ && chmod 600/.test(r.token), `the write-then-chmod one-liner is the bug, got:\n${r.token}`);
      assert.match(r.token, /umask 077/, `got:\n${r.token}`);
    })) p++; else f++;

    // ------------------------------------------------------------- no leakage
    if (test('no branch ever prints the token value', () => {
      const secret = 'zz-not-in-any-output-zz';
      const other = 'yy-also-not-printed-yy';
      for (const options of [
        { env: `ANSWER_TOKEN=${secret}\n` },
        { env: `ANSWER_TOKEN=${secret}\n`, token: other },
        { env: `ANSWER_TOKEN=${secret}\n`, token: other, flags: ['--force'] },
        { env: `ANSWER_TOKEN=${secret}\n`, token: other, flags: ['--force'], write: true },
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
