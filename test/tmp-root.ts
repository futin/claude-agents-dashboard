/**
 * One temp root per test run, removed when the process ends.
 *
 * Every fixture in `test/` is a `mkdtemp` under `os.tmpdir()`, and most never removed theirs: orchestrator runs execute the suite many times a day, and on
 * 2026-10-03 the leftovers filled `/tmp`'s inode table and every `Bash` call on the machine failed with ENOSPC (backlog #177). Rather than chase cleanup
 * through 45 files' worth of fixtures and their failure paths, `run-all.ts` imports this module FIRST — before any test module evaluates — and it points
 * `TMPDIR` at a fresh `cad-test-run-*` dir. `os.tmpdir()` reads `TMPDIR` on every call and child processes inherit it, so every fixture the run makes,
 * its subprocesses' included, lands under that one dir, and the `exit` hook removes it whether the run passed, failed or threw.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-test-run-'));
process.env.TMPDIR = TEST_TMP_ROOT;
// The guard in tmp-root.test.ts reads this without importing the module, so it proves run-all.ts did.
process.env.CAD_TEST_TMP_ROOT = TEST_TMP_ROOT;

function cleanup(): void {
  try { fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort at exit */ }
}

process.on('exit', cleanup);
// A signal skips the `exit` event unless something handles it; Ctrl-C mid-run is the common case.
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(sig, () => { cleanup(); process.exit(code); });
}
