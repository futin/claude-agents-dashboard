import assert from 'node:assert';

import { checkPins, parseJob, serializeEnabled } from '../../shared/routine-file.js';
import type { PinSnapshot } from '../../shared/routine-file.js';
import type { RoutineJob } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

// The spec's example file, verbatim, comments and all.
const EXAMPLE = [
  '---',
  'cron: "0 22 * * *"            # five fields, local time of the machine that runs it',
  'run: claude                   # shell | claude',
  'foreach: pinned               # absent = run once in `cwd`; pinned = every pinned repo; [a, b] = only these pins, by name',
  '# cwd: ~/Documents/x          # only without foreach; default = the routines folder\'s parent',
  'enabled: true                 # absent = true',
  'model: opus                   # claude only; absent = CLI default',
  'effort: medium                # claude only',
  'permission-mode: acceptEdits  # claude only; plan | acceptEdits | auto; default = the Sync button\'s (`SYNC_PERMISSION_MODE`, `auto`)',
  'allowed-tools: [Bash, Read]   # claude only; absent = CLI default',
  'max-turns: 60                 # claude only',
  'timeout: 30m                  # both; 30s | 30m | 2h; wrapper kills the step after this; default 60m',
  '---',
  '/git-sync',
  '',
].join('\n');

/** A minimal valid claude job with `extra` lines appended inside the frontmatter. */
function claude(...extra: string[]): string {
  return ['---', 'cron: "0 9 * * *"', 'run: claude', ...extra, '---', '/git-sync', ''].join('\n');
}

function shell(...extra: string[]): string {
  return ['---', 'cron: "0 9 * * *"', 'run: shell', ...extra, '---', 'Runs a thing.', '', '```bash', 'echo hi', 'ls', '```', ''].join('\n');
}

function must(name: string, text: string): RoutineJob {
  const r = parseJob(name, text, 'mac');
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.job);
  return r.job;
}

const errs = (name: string, text: string) => parseJob(name, text, 'mac').errors;

export function run(): number {
  console.log('\n=== routine-file.ts ===\n');
  let p = 0, f = 0;

  if (test('the spec example parses as written', () => {
    const j = must('nightly-sync', EXAMPLE);
    assert.deepStrictEqual(j, {
      name: 'nightly-sync', cron: '0 22 * * *', run: 'claude', foreach: 'pinned', cwd: null, enabled: true,
      model: 'opus', effort: 'medium', permissionMode: 'acceptEdits', allowedTools: ['Bash', 'Read'], maxTurns: 60, timeoutMs: 1_800_000,
      body: '/git-sync', script: null,
    });
  })) p++; else f++;

  if (test('absent optional keys: enabled true, timeout 60m, everything else null', () => {
    const j = must('a', claude());
    assert.strictEqual(j.enabled, true);
    assert.strictEqual(j.timeoutMs, 3_600_000);
    assert.strictEqual(j.foreach, null);
    assert.strictEqual(j.cwd, null);
    assert.strictEqual(j.model, null);
    assert.strictEqual(j.effort, null);
    assert.strictEqual(j.permissionMode, null);
    assert.strictEqual(j.allowedTools, null);
    assert.strictEqual(j.maxTurns, null);
  })) p++; else f++;

  if (test('name errors are whole-file (line 0): Runs and runs', () => {
    assert.deepStrictEqual(errs('Runs', claude()), [{ line: 0, message: 'name must match [a-z0-9-]+' }]);
    assert.deepStrictEqual(errs('runs', claude()), [{ line: 0, message: 'name is reserved' }]);
    for (const n of ['validate', 'reconcile', 'reveal']) assert.deepStrictEqual(errs(n, claude()), [{ line: 0, message: 'name is reserved' }]);
  })) p++; else f++;

  if (test('a job with errors comes back with job null', () => {
    assert.strictEqual(parseJob('a', claude('foo: 1'), 'mac').job, null);
  })) p++; else f++;

  if (test('four-field cron gives the Task 1 message at the cron line', () => {
    const text = ['---', 'cron: "0 22 * *"', 'run: claude', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 2, message: 'cron needs five fields (minute hour day month weekday); got 4' }]);
  })) p++; else f++;

  if (test('a file with machines: is an error on that line', () => {
    const inline = ['---', 'cron: "0 9 * * *"', 'machines: [mac]', 'run: claude', '---', 'x'].join('\n');
    const r = parseJob('a', inline, 'mac');
    assert.strictEqual(r.job, null);
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].line, 3);
    assert.ok(r.errors[0].message.includes('machines') && r.errors[0].message.includes('no longer used'));
    const block = ['---', 'cron: "0 9 * * *"', 'machines:', '  - mac', 'run: claude', '---', 'x'].join('\n');
    const b = parseJob('a', block, 'mac');
    assert.strictEqual(b.errors.length, 1);
    assert.strictEqual(b.errors[0].line, 3);
    assert.ok(b.errors[0].message.includes('no longer used'));
  })) p++; else f++;

  if (test('a file without machines: parses, and the job has no machines property', () => {
    const j = must('a', ['---', 'cron: "0 9 * * *"', 'run: claude', '---', '/git-sync'].join('\n'));
    assert.strictEqual('machines' in j, false);
  })) p++; else f++;

  if (test('run: python -> run must be shell or claude', () => {
    const text = ['---', 'cron: "0 9 * * *"', 'run: python', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 3, message: 'run must be shell or claude' }]);
  })) p++; else f++;

  if (test('permission-mode: bypassPermissions and dontAsk are errors, never clamped', () => {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      assert.deepStrictEqual(errs('a', claude(`permission-mode: ${mode}`)), [{ line: 4, message: 'permission-mode must be plan, acceptEdits or auto' }]);
    }
    for (const mode of ['plan', 'acceptEdits', 'auto']) assert.strictEqual(must('a', claude(`permission-mode: ${mode}`)).permissionMode, mode);
  })) p++; else f++;

  if (test('foreach with cwd is an error at the cwd line; foreach alone and cwd alone are fine', () => {
    assert.deepStrictEqual(errs('a', claude('foreach: pinned', 'cwd: ~/x')), [{ line: 5, message: 'cwd is not used with foreach' }]);
    assert.deepStrictEqual(errs('a', claude('cwd: ~/x', 'foreach: [a]')), [{ line: 4, message: 'cwd is not used with foreach' }]);
    assert.strictEqual(must('a', claude('cwd: ~/x')).cwd, '~/x');
    assert.deepStrictEqual(must('a', claude('foreach: [lookout, dir-b]')).foreach, ['lookout', 'dir-b']);
  })) p++; else f++;

  if (test('foreach: a bare word other than pinned, and an empty list, are errors', () => {
    assert.deepStrictEqual(errs('a', claude('foreach: lookout')), [{ line: 4, message: 'foreach must be pinned or a list [a, b]' }]);
    assert.deepStrictEqual(errs('a', claude('foreach: []')), [{ line: 4, message: 'foreach list is empty' }]);
  })) p++; else f++;

  if (test('run: shell without a bash fence is an error at the run line', () => {
    const text = ['---', 'cron: "0 9 * * *"', 'run: shell', '---', 'just prose', ''].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 3, message: 'shell job needs a ```bash block' }]);
  })) p++; else f++;

  if (test('run: shell body with a fence -> script is the fence inner text; body is the whole body', () => {
    const j = must('a', shell());
    assert.strictEqual(j.script, 'echo hi\nls');
    assert.strictEqual(j.body, 'Runs a thing.\n\n```bash\necho hi\nls\n```');
  })) p++; else f++;

  if (test('run: shell takes only the first bash fence, and an unclosed fence is an error at the fence line', () => {
    const two = ['---', 'cron: "0 9 * * *"', 'run: shell', '---', '```bash', 'one', '```', '```bash', 'two', '```'].join('\n');
    assert.strictEqual(must('a', two).script, 'one');
    const open = ['---', 'cron: "0 9 * * *"', 'run: shell', '---', 'x', '```bash', 'one'].join('\n');
    assert.deepStrictEqual(errs('a', open), [{ line: 6, message: 'shell job needs a ```bash block' }]);
  })) p++; else f++;

  if (test('model / effort must be one token', () => {
    assert.deepStrictEqual(errs('a', claude('model: claude opus')), [{ line: 4, message: 'model must be one token' }]);
    assert.deepStrictEqual(errs('a', claude('effort: "very high"')), [{ line: 4, message: 'effort must be one token' }]);
  })) p++; else f++;

  if (test('unknown key is rejected with the key named', () => {
    assert.deepStrictEqual(errs('a', claude('foo: 1')), [{ line: 4, message: 'unknown key foo' }]);
  })) p++; else f++;

  if (test('duplicate key is an error at the second line', () => {
    assert.deepStrictEqual(errs('a', claude('cron: "1 1 * * *"')), [{ line: 4, message: 'cron given twice' }]);
  })) p++; else f++;

  if (test('a nested block under allowed-tools -> must be an inline list', () => {
    assert.deepStrictEqual(errs('a', claude('allowed-tools:', '  - Bash')), [{ line: 4, message: 'allowed-tools must be an inline list [a, b]' }]);
  })) p++; else f++;

  if (test('a list key given a bare scalar -> must be an inline list', () => {
    assert.deepStrictEqual(errs('a', claude('allowed-tools: Bash')), [{ line: 4, message: 'allowed-tools must be an inline list [a, b]' }]);
  })) p++; else f++;

  if (test('an empty value is "<key> is empty" (cron), with and without a trailing comment', () => {
    const text = ['---', 'cron:', 'run: claude', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 2, message: 'cron is empty' }]);
    const commented = ['---', 'cron:   # todo', 'run: claude', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', commented), [{ line: 2, message: 'cron is empty' }]);
  })) p++; else f++;

  if (test('a nested block under a scalar key is an error naming the key', () => {
    assert.deepStrictEqual(errs('a', claude('model:', '  opus')), [{ line: 4, message: 'model must be a single-line value' }]);
    assert.deepStrictEqual(errs('a', claude('model: >', '  opus')), [{ line: 4, message: 'model must be a single-line value' }]);
  })) p++; else f++;

  if (test('whole-line comments (also indented) inside the frontmatter are ignored, and do not break a nested-block lookahead', () => {
    assert.strictEqual(must('a', claude('# note', '   # indented note', 'model: opus')).model, 'opus');
  })) p++; else f++;

  if (test('a " #" outside quotes starts a comment; inside quotes it does not', () => {
    assert.strictEqual(must('a', claude('model: opus   # why')).model, 'opus');
    const j = must('a', ['---', 'cron: "0 22 * * *"  # c', 'run: claude', '---', 'x'].join('\n'));
    assert.strictEqual(j.cron, '0 22 * * *');
    assert.strictEqual(must('a', claude('cwd: "~/a #b"  # c')).cwd, '~/a #b');
  })) p++; else f++;

  if (test('a "#" glued to a word is not a comment', () => {
    assert.strictEqual(must('a', claude('cwd: ~/a#b')).cwd, '~/a#b');
  })) p++; else f++;

  if (test('enabled: true | false parse; anything else is an error', () => {
    assert.strictEqual(must('a', claude('enabled: false')).enabled, false);
    assert.strictEqual(must('a', claude('enabled: true')).enabled, true);
    assert.deepStrictEqual(errs('a', claude('enabled: yes')), [{ line: 4, message: 'enabled must be true or false' }]);
  })) p++; else f++;

  if (test('timeout: 30s / 30m / 2h convert to ms; anything else is an error', () => {
    assert.strictEqual(must('a', claude('timeout: 30s')).timeoutMs, 30_000);
    assert.strictEqual(must('a', claude('timeout: 30m')).timeoutMs, 1_800_000);
    assert.strictEqual(must('a', claude('timeout: 2h')).timeoutMs, 7_200_000);
    for (const bad of ['x', '30', '0m', '1d', '1.5h']) {
      assert.deepStrictEqual(errs('a', claude(`timeout: ${bad}`)), [{ line: 4, message: 'timeout must be like 30s, 30m or 2h' }], bad);
    }
  })) p++; else f++;

  if (test('max-turns must be a positive integer', () => {
    assert.strictEqual(must('a', claude('max-turns: 7')).maxTurns, 7);
    for (const bad of ['0', '-1', 'x', '2.5']) {
      assert.deepStrictEqual(errs('a', claude(`max-turns: ${bad}`)), [{ line: 4, message: 'max-turns must be a positive integer' }], bad);
    }
  })) p++; else f++;

  if (test('missing cron / run are whole-file errors', () => {
    const text = ['---', 'model: opus', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text).map((e) => e.message), ['cron is required', 'run is required']);
    assert.ok(errs('a', text).every((e) => e.line === 0));
  })) p++; else f++;

  if (test('a claude job with an empty body is an error', () => {
    const text = ['---', 'cron: "0 9 * * *"', 'run: claude', '---', '', '  '].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 0, message: 'claude job needs a prompt' }]);
  })) p++; else f++;

  if (test('no frontmatter / unclosed frontmatter are line-0 errors', () => {
    assert.deepStrictEqual(errs('a', '# hi\nbody'), [{ line: 0, message: 'file must start with a --- frontmatter block' }]);
    assert.deepStrictEqual(errs('a', '---\ncron: "0 9 * * *"\n'), [{ line: 0, message: 'frontmatter is not closed with ---' }]);
    assert.deepStrictEqual(errs('a', ''), [{ line: 0, message: 'file must start with a --- frontmatter block' }]);
  })) p++; else f++;

  if (test('CRLF and BOM files parse, with line numbers unchanged', () => {
    const crlf = EXAMPLE.replace(/\n/g, '\r\n');
    assert.strictEqual(must('a', crlf).body, '/git-sync');
    assert.strictEqual(must('a', '﻿' + EXAMPLE).cron, '0 22 * * *');
    assert.deepStrictEqual(errs('a', claude('foo: 1').replace(/\n/g, '\r\n')), [{ line: 4, message: 'unknown key foo' }]);
  })) p++; else f++;

  if (test('a stray indented line that follows no empty key is an error', () => {
    assert.deepStrictEqual(errs('a', claude('model: opus', '  extra')), [{ line: 5, message: 'unexpected indented line' }]);
  })) p++; else f++;

  if (test('launchd rule follows the validating machine: dom + dow is an error on mac, fine on wsl; manual is fine on mac', () => {
    const text = ['---', 'cron: "0 9 1 * 1"', 'run: claude', '---', 'x'].join('\n');
    assert.deepStrictEqual(parseJob('a', text, 'mac').errors, [{ line: 2, message: 'cron: launchd cannot combine day-of-month and weekday; use one' }]);
    assert.deepStrictEqual(parseJob('a', text, 'wsl').errors, []);
    assert.deepStrictEqual(parseJob('a', text.replace('"0 9 1 * 1"', 'manual'), 'mac').errors, []);
  })) p++; else f++;

  if (test('cron: manual is valid (bare or quoted) and keeps the literal as job.cron', () => {
    const bare = shell().replace('cron: "0 9 * * *"', 'cron: manual');
    assert.deepStrictEqual(errs('a', bare), []);
    assert.strictEqual(must('a', bare).cron, 'manual');
    const quoted = shell().replace('cron: "0 9 * * *"', 'cron: "manual"');
    assert.strictEqual(must('a', quoted).cron, 'manual');
  })) p++; else f++;

  if (test('cron: manual gets no launchd error', () => {
    assert.deepStrictEqual(errs('a', claude().replace('cron: "0 9 * * *"', 'cron: manual')), []);
  })) p++; else f++;

  if (test('an absent cron line is still "cron is required", so a forgotten line does not become Manual', () => {
    const text = ['---', 'run: claude', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text), [{ line: 0, message: 'cron is required' }]);
  })) p++; else f++;

  if (test('cron: Manual is not manual: five-fields error at the cron line', () => {
    const text = claude().replace('cron: "0 9 * * *"', 'cron: Manual');
    assert.deepStrictEqual(errs('a', text), [{ line: 2, message: 'cron needs five fields (minute hour day month weekday); got 1' }]);
    assert.strictEqual(parseJob('a', text, 'mac').job, null);
  })) p++; else f++;

  if (test('several errors are all reported, in file order', () => {
    const text = ['---', 'cron: "0 22 * *"', 'machines: [linux]', 'run: python', 'zzz: 1', '---', 'x'].join('\n');
    assert.deepStrictEqual(errs('a', text).map((e) => e.line), [2, 3, 4, 5]);
  })) p++; else f++;

  const pin = (dirName: string, name: string, over: Partial<PinSnapshot> = {}): PinSnapshot => ({ dirName, name, path: `/r/${name}`, listed: true, ...over });
  const withForeach = (foreach: RoutineJob['foreach']): RoutineJob => ({ ...must('a', claude()), foreach });

  if (test('checkPins: a unique name, pinned or fan-out, has no errors', () => {
    assert.deepStrictEqual(checkPins(withForeach(['lookout']), [{ dirName: 'x', name: 'lookout', path: null, listed: true }]), []);
    assert.deepStrictEqual(checkPins(withForeach('pinned'), [pin('a', 'lookout'), pin('b', 'lookout')]), []);
    assert.deepStrictEqual(checkPins(withForeach(null), [pin('a', 'lookout'), pin('b', 'lookout')]), []);
  })) p++; else f++;

  if (test('checkPins: two pins named lookout is one ambiguity error naming both dirNames', () => {
    assert.deepStrictEqual(
      checkPins(withForeach(['lookout']), [pin('dir-a', 'lookout'), pin('dir-b', 'lookout')]),
      [{ line: 0, message: 'foreach: lookout is ambiguous here (dir-a, dir-b); use the dirName' }],
    );
  })) p++; else f++;

  if (test('checkPins: a dirName entry resolves the ambiguity; an unlisted twin does not count', () => {
    assert.deepStrictEqual(checkPins(withForeach(['dir-a']), [pin('dir-a', 'lookout'), pin('dir-b', 'lookout')]), []);
    assert.deepStrictEqual(checkPins(withForeach(['lookout']), [pin('dir-a', 'lookout'), pin('dir-b', 'lookout', { listed: false })]), []);
  })) p++; else f++;

  if (test('checkPins: an unpinned name is not an error here (the wrapper logs skipped: not pinned)', () => {
    assert.deepStrictEqual(checkPins(withForeach(['ghost']), [pin('dir-a', 'lookout')]), []);
  })) p++; else f++;

  if (test('serializeEnabled: flips true to false and every other byte stays equal', () => {
    const out = serializeEnabled(EXAMPLE, false);
    assert.strictEqual(out, EXAMPLE.replace('enabled: true ', 'enabled: false '));
    assert.strictEqual(serializeEnabled(out, true), EXAMPLE);
  })) p++; else f++;

  if (test('serializeEnabled: an absent line is inserted directly after run:', () => {
    const text = claude('model: opus');
    assert.strictEqual(
      serializeEnabled(text, false),
      ['---', 'cron: "0 9 * * *"', 'run: claude', 'enabled: false', 'model: opus', '---', '/git-sync', ''].join('\n'),
    );
    assert.strictEqual(must('a', serializeEnabled(text, false)).enabled, false);
  })) p++; else f++;

  console.log(`\nroutine-file: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
