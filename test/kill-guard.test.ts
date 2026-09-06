/**
 * `scripts/kill-guard-hook.sh` — the PreToolUse/Bash guard that refuses
 * `pkill` and `killall`.
 *
 * The bug it exists for is a specific command, so the specific command is the
 * first case here verbatim: an unattended session tore down its own preview
 * servers with `pkill -f "nest start --watch"; pkill -f "vite"` and took this
 * repo's `pnpm dev` down with them for 6.5 hours, along with the POST /api/spawn
 * that backlog-manager's watchdog needed to resume the run that had done it.
 *
 * Two properties are asserted, and the second is the one that decides whether
 * the guard survives contact with real work:
 *
 *   - **Broad kills are refused.** With or without `-f`, behind `sudo`, after a
 *     `&&`, and — the case a cwd-prefix check gets wrong if it merely looks for
 *     a leading `/` — with an absolute pattern pointing somewhere else entirely.
 *   - **Narrow kills are not.** `kill <pid>` is the idiom the guard is steering
 *     toward and must never touch it; `pkill -f "$PWD/…"` is the escape hatch
 *     the refusal message advertises, and an advertised escape hatch that does
 *     not work makes the guard something to route around rather than obey. A
 *     `pkill` appearing as an ARGUMENT (grep's pattern, echo's string) is not a
 *     kill and must pass, or every attempt to document this hook trips it.
 *
 * The hook is driven as the CLI drives it: one PreToolUse payload on stdin,
 * `CLAUDECODE=1` in the environment, decision read back off stdout. Nothing here
 * signals a process — the guard's whole job is to answer before anything does.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'scripts', 'kill-guard-hook.sh');

/** The cwd every case is judged against — what `$PWD` would expand to. */
const CWD = '/Users/someone/projects/app';

type Decision = 'deny' | 'allow';

/** One PreToolUse/Bash call, answered the way the CLI would read it. */
function decide(command: string): { decision: Decision; reason: string } {
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: CWD,
    permission_mode: 'auto'
  });
  const r = spawnSync('bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1', CLAUDE_KILL_GUARD: 'on' }
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(out);
  const hook = parsed.hookSpecificOutput ?? {};
  assert.equal(hook.hookEventName, 'PreToolUse', `wrong event name in ${out}`);
  return {
    decision: hook.permissionDecision === 'deny' ? 'deny' : 'allow',
    reason: hook.permissionDecisionReason ?? ''
  };
}

const DENIED: string[] = [
  // The command from the 2026-09-06 incident, verbatim.
  'pkill -f "nest start --watch" 2>/dev/null; pkill -f "vite" 2>/dev/null',
  'pkill -f "vite"',
  'pkill -f vite',
  // No -f at all: matches by process NAME, which is broader still.
  'pkill node',
  'killall node',
  'killall -9 Google\\ Chrome',
  'sudo pkill -9 node',
  // Not the first command in the line.
  'pnpm build && pkill -f vite',
  'cd /tmp; pkill -f esbuild',
  // Absolute, and therefore anchored-looking, but not to THIS session's cwd.
  'pkill -f "/Users/someone-else/projects/other/node_modules/.bin/vite"',
  // The parent of the cwd is not the cwd: this would match siblings too.
  'pkill -f "/Users/someone/projects/"',
  // A glob in the pattern must be judged as itself, not expanded against the
  // hook's own cwd — where it could resolve to paths that read as anchored.
  'pkill -f *',
  'pkill -f "*.js"'
];

const ALLOWED: string[] = [
  // The idiom the refusal message steers toward.
  'kill 78682',
  'kill -9 1234; echo done',
  'lsof -nP -iTCP:5174 -sTCP:LISTEN -t | xargs kill',
  // The advertised escape hatch, both spellings.
  'pkill -f "$PWD/node_modules/.bin/vite"',
  'pkill -f "${PWD}/node_modules/.bin/vite"',
  `pkill -f "${CWD}/node_modules/.bin/vite"`,
  // `pkill` as an argument is not a kill.
  'grep -rn pkill scripts/ | head',
  'echo "never pkill by pattern"',
  // Prose that names the tool. Backtick opens a command substitution and is
  // therefore a segment separator, so inline code in markdown reaches the guard
  // looking like a bare command — which is harmless, since neither tool does
  // anything without a pattern. This exact shape refused this hook's own docs.
  'python3 -c "s = s.replace(\'refuses `pkill` and `killall`\', x)"',
  'pkill',
  'killall',
  // Flags without an operand are the same nothing: `pkill -f` prints usage.
  // This exact shape — a line of prose wrapping after `pkill -f` — refused this
  // change's own commit message.
  'pkill -f',
  'killall -9',
  // Ordinary work, which must not pay for any of this.
  'pnpm dev',
  'git status --porcelain'
];

function ok(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== kill-guard-hook.sh: broad pkill/killall is refused ===\n');
  let p = 0, f = 0;

  if (spawnSync('jq', ['--version']).status !== 0) {
    console.log('  ⚠ SKIPPED — jq is not installed, and the hook exits before deciding');
    console.log('    without it. These cases did not run.');
    return 0;
  }

  for (const cmd of DENIED) {
    if (ok(`denies: ${cmd}`, () => {
      const { decision } = decide(cmd);
      assert.equal(decision, 'deny', `expected deny for: ${cmd}`);
    })) p++; else f++;
  }

  for (const cmd of ALLOWED) {
    if (ok(`allows: ${cmd}`, () => {
      const { decision } = decide(cmd);
      assert.equal(decision, 'allow', `expected allow for: ${cmd}`);
    })) p++; else f++;
  }

  // A refusal that does not say what to do instead is a refusal the next
  // session works around. Both halves of the alternative must be in the text.
  if (ok('the refusal names the pid idiom and the anchored escape hatch', () => {
    const { reason } = decide('pkill -f vite');
    assert.ok(/kill "\$MYPID"/.test(reason), `no pid idiom in reason:\n${reason}`);
    assert.ok(/pkill -f "\$PWD\//.test(reason), `no anchored form in reason:\n${reason}`);
    assert.ok(reason.includes('pkill -f vite'), `reason does not quote the command:\n${reason}`);
  })) p++; else f++;

  // The off switch is an env var so that turning it off is something a human
  // did to a session, not something a session arranged for itself.
  if (ok('CLAUDE_KILL_GUARD=off disables it', () => {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pkill -f vite' }, cwd: CWD }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDECODE: '1', CLAUDE_KILL_GUARD: 'off' }
    });
    assert.equal(r.status, 0);
    assert.equal((r.stdout || '').trim(), '', 'expected no output when disabled');
  })) p++; else f++;

  // Outside Claude Code the payload shape is not guaranteed, and every sibling
  // hook in ~/.claude/settings.json makes the same check first.
  if (ok('stays silent outside Claude Code', () => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pkill -f vite' }, cwd: CWD }),
      encoding: 'utf8',
      env
    });
    assert.equal(r.status, 0);
    assert.equal((r.stdout || '').trim(), '', 'expected no output outside the CLI');
  })) p++; else f++;

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
