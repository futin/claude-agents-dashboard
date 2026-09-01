---
id: bug-12
title: Native-installer sessions always read idle: lsof -c claude misses them
created: 2026-09-01
tags: server, scan, status
updated: 2026-09-01T19:09:57Z
groom-elapsed: 95
started: 2026-09-01T18:59:34Z
execute-elapsed: 623
---

## Symptom

Sessions that are actively churning render as gray **IDLE**. Observed with 5 sessions
working in parallel: only 2 cards showed WORKING (`bug-13` / ixray, `idea-11` /
claude-agents-dashboard); `task-5`, `bug-4` and `bug-14` showed IDLE while their own cards
displayed live tool activity 6–12s old (`Bash Confirm new settings-view test ran`, etc).

The activity row, last-activity age, token count and context % are all correct on the
mislabelled cards — only the status badge is wrong. So it is not a staleness problem: the
liveness gate is firing.

## Repro

1. Have at least one session started via the **native installer** binary on `PATH`
   (`~/.local/bin/claude`), e.g. any `claude -p …` headless run, or a terminal session
   started with `claude` after the native install.
2. Have another started from the desktop app (`Claude.app` → `claude-code/<ver>/claude.app`).
3. Load the Sessions board while both are mid-turn.

The desktop-app one shows WORKING; the native-installer one shows IDLE, permanently.

Direct proof of the gate's input, captured live while pid 35791 was mid-turn:

```
$ lsof -c claude -a -d cwd -Fn     # what liveCwds() runs
n/Users/andrejajevtic/Documents/custom-projects/backlog-manager
n/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
n/Users/andrejajevtic/Documents/custom-projects/ixray
n/Users/andrejajevtic/Documents/timify-projects/microservice
# ← the task-5 worktree cwd is absent

$ ps -o pid,comm,args -p 35791
35791 claude   claude -p /backlog-execute task-5 --output-format stream-json …

$ lsof -p 35791 -a -d cwd -Fcn
p35791
c2.1.250                                              # ← lsof's command name
fcwd
n/Users/andrejajevtic/.../backlog-manager/.worktrees/task-5
```

## Affects

- `server/lib/scan.ts:193` — `liveCwds()`, the `lsof -c claude` probe.
- `server/lib/scan.ts:280` — `const dead = live !== null && projectPath !== null && !live.has(normCwd(projectPath))`.
- `server/lib/scan.ts:305` — `else if (dead) status = 'idle'` sits above every activity
  branch, so a false `dead` overrides `recent && !turnComplete`.
- `server/lib/scan.ts:186-190` — the doc comment claims the only case-sensitivity
  consequence is excluding `Claude.app`; the native installer inverts that.
- `server/lib/config.ts:174` — the same claim in prose.

Downstream of the wrong status: the `active` count in `scanSessions` (`scan.ts:343`),
status filtering in `client/src/components/Toolbar.tsx:14`, session ranking, and any
notification path gated on `working`.

## Cause

`lsof -c claude` matches on the **executable's basename**, not on `argv[0]` or the kernel's
`p_comm`.

The native installer ships each version as a single file named after the version and
symlinks the launcher at it:

```
/Users/andrejajevtic/.local/bin/claude -> /Users/andrejajevtic/.local/share/claude/versions/2.1.250
```

The process is exec'd through that symlink, so its `p_comm` is `claude` and `ps` reports
`claude` — but lsof resolves the vnode to the real file and reports the command name as
`2.1.250`. `-c claude` therefore never matches it, its cwd never enters the live set, and
`dead` is true for every session running under it.

Desktop-app sessions exec `…/claude-code/2.1.247/claude.app/Contents/MacOS/claude`, whose
basename *is* `claude` — hence the split: desktop-app sessions read live, native-installer
sessions read dead. Measured on this machine: 8 claude CLI processes, `lsof -c claude`
returned 7; the missing one was the native-installer child.

The bug grows with version churn — the name lsof sees changes on every upgrade — so no
static `-c` pattern can fix it.

Note the repo already contains a matcher that gets this right: `countClaudeProcesses()`
(`scan.ts:166`) tests `ps -Ao comm=` lines against `/(^|\/)claude$/`, which matches both
install flavours. That function and `liveCwds()` disagree by exactly the number of
native-installer sessions running — the two have simply never been reconciled.

## Fix

Stop identifying processes by the binary's filename. Get the pids from `ps`, then ask lsof
for those pids' cwds.

**Shape** (`server/lib/scan.ts`, all of it):

1. Split the probe into three pieces so the logic is testable without spawning anything.
   Two pure exported parsers plus a pure composer; `liveCwds()` becomes the thin shell that
   runs the two commands and hands their stdout to the composer.
   - a parser over `ps -Ao pid=,comm=` stdout returning the pids whose comm matches
     `/(^|\/)claude$/` — the matcher `countClaudeProcesses()` already uses, so the two
     agree by construction from here on. Comm is the last column and macOS prints a full
     path that **can contain spaces** (`/Users/…/Application Support/Claude/…`), so split
     each line once at the first whitespace run: pid, then the rest verbatim.
   - a parser over `lsof … -Fn` stdout returning a `Set` of `normCwd`'d paths — the loop
     already in `liveCwds()`, lifted out unchanged.
   - a composer taking both stdouts (either may be `null` for "the command failed") and
     returning `Set<string> | null`.
2. `liveCwds()` runs `ps -Ao pid=,comm=`, then `lsof -p <comma-separated pids> -a -d cwd
   -Fn`. Both keep the existing `timeout: 2000` and `encoding: 'utf8'`. Both stay on
   `execFileSync` — `ps` and `lsof` are both already used here, so this adds no dependency
   and no new kind of outbound call.
3. **Preserve the fail-open contract, and extend it to the new failure modes.** The
   composer returns `null` — gate skipped, nothing marked dead — when:
   - `ps` failed;
   - `ps` succeeded but matched **zero** pids. Deliberate, and a behaviour change worth
     stating: an empty set would mean "every session is dead", which is precisely this
     bug's failure mode re-created the moment the matcher stops recognising a future
     launcher. Fail open instead. Cost is small: with nothing actually running, sessions
     land on `idle` via `turnComplete && !recent` anyway; only a stale mid-turn session
     reads `incomplete` (yellow) rather than gray.
   - `lsof` failed with no usable stdout.

   One refinement over today's `catch { return null }`: when `lsof` exits non-zero but
   *did* write cwd lines (it warns and exits 1 on processes it cannot inspect), use
   `err.stdout` rather than discarding the whole probe. A partial live set is strictly
   better than no gate, and this is the common case on a machine with other users'
   processes around.
4. Fix the two prose claims that assert the opposite of reality — `scan.ts:186-190` ("it
   matches only the lowercase CLI binary") and `config.ts:174`. Both now describe a
   pid-based probe.

**Deliberately not done:** no version-shape whitelist (`-c /^\d+\.\d+\.\d+$/`) and no
install-root allowlist. Both were considered and rejected — the first matches a name shape
rather than an identity, the second breaks whenever an install root moves.

**Untouched:** the status chain at `scan.ts:302-310`, its ordering, and the per-cwd
granularity caveat (two sessions in one directory still cannot be told apart). The gate's
*input* is wrong, not its logic.

### Test cases

Backend tests in `test/scan.test.ts`. The parsers are pure, so all of these are string in,
value out — no process spawning.

pid parser, over one fixture block of `ps -Ao pid=,comm=` output holding all of these lines:

| Line | Expected |
|---|---|
| `  26947 /Users/x/Library/Application Support/Claude/claude-code/2.1.247/claude.app/Contents/MacOS/claude` | pid `26947` included — path contains spaces |
| `  70839 claude` | pid `70839` included — bare native-installer launcher |
| `  75935 /Applications/Claude.app/Contents/MacOS/Claude` | excluded — capital `C` desktop shell stays excluded |
| `  26946 /Applications/Claude.app/Contents/Helpers/disclaimer` | excluded |
| `  99999 /usr/local/bin/claude-wrapper` | excluded — `claude` must be the whole basename |
| `  88888 /opt/notclaude` | excluded — the `(^\|/)` anchor, not a bare suffix match |
| `` (empty line) | skipped, no throw |
| `  12345` (pid, no comm) | skipped, no throw |

Expected result for that whole block: exactly `['26947', '70839']`, in that order.

lsof parser:

- `p123\nfcwd\nn/a/b\np456\nfcwd\nn/c/d/\n` → `Set { '/a/b', '/c/d' }` — trailing slash
  stripped by `normCwd`.
- a bare `n` line (length 1) → not added; the existing `line.length > 1` guard must survive.
- `f`/`p` lines → ignored.
- empty string → empty set (**not** `null`; deciding null is the composer's job, not the
  parser's).

composer, four cases:

- ps stdout `null` → `null`.
- ps stdout with no matching pid → `null` (the fail-open case from step 3).
- pids found, lsof stdout `null` → `null`.
- pids found, lsof stdout with two cwds → a `Set` of exactly those two.

Status-chain regression, through `scanSessions` with an injected set (the existing tests at
`test/scan.test.ts:277-298` already cover this path; add the worktree-shaped case):

- session cwd `/a/repo/.worktrees/bug-4`, last message 10s ago, turn not complete,
  `liveCwds: new Set(['/a/repo/.worktrees/bug-4'])` → status `working`.
- same session, `liveCwds: new Set(['/a/repo'])` → status `idle`. The parent repo being live
  must **not** rescue a worktree session; per-cwd exact match is the intended granularity,
  and after this fix the worktree's own process supplies its own cwd.

### Done when

- `pnpm test` and `pnpm typecheck` both pass, with the output pasted.
- On this machine, with a headless `claude -p` session running in a worktree: `liveCwds()`
  contains that worktree path. Before the fix it does not — capture both. Run it from the
  scratchpad, not the repo root (`server/lib` writes are cwd-relative).
- `liveCwds()!.size` no longer disagrees with `countClaudeProcesses()` by the number of
  native-installer sessions.
- The board shows WORKING for a native-installer session that is mid-turn — the symptom
  above, gone.
- Not verified by any of the above, needs a human: behaviour on a machine where `lsof`
  refuses the pid list outright (locked-down / non-macOS), and behaviour under a future
  launcher whose `ps` comm is not `claude` — that case is designed to fail open, not proven
  to.

## Outcome

2026-09-01 — Fixed. `liveCwds()` no longer identifies processes by the binary's filename:
it takes pids from `ps -Ao pid=,comm=` (comm matched against `/(^|\/)claude$/`, the matcher
`countClaudeProcesses()` already used) and asks `lsof -p <pids> -a -d cwd -Fn` for their cwds.
Split into three pure exported units — `parsePsClaudePids`, `parseLsofCwds`,
`composeLiveCwds` — so the logic is testable without spawning; `liveCwds()` is now the thin
shell that runs the two commands.

Cause re-confirmed live before any change (pid 73008 = this session, native installer):

```
$ ps -Ao comm= | grep -E '(^|/)claude$' | sort | uniq -c
   1 /Users/andrejajevtic/.local/bin/claude
   2 /Users/andrejajevtic/Library/Application Support/Claude/claude-code/2.1.247/claude.app/Contents/MacOS/claude
   1 claude
$ lsof -p 73008 -a -d cwd -Fcn
p73008
c2.1.250                                    # ← lsof's command name, not "claude"
fcwd
n/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
```

Probe before vs after, run from a scratchpad against the live machine:

```
OLD (lsof -c claude) size=2
  old  /Users/andrejajevtic/Documents/custom-projects/backlog-manager
  old  /Users/andrejajevtic/Documents/custom-projects/backlog-manager/.worktrees/runs-archive
NEW (ps + lsof -p) size=4
  new  /Users/andrejajevtic/Documents/custom-projects/backlog-manager
  new  /Users/andrejajevtic/Documents/custom-projects/backlog-manager/.worktrees/runs-archive
  new  /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
  new  /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard/.worktrees/bug-12
countClaudeProcesses() = 4
```

The two native-installer cwds that were missing are now present. (The set is deduplicated by
cwd, so its size is not expected to equal `countClaudeProcesses()` in general — several
sessions can share one directory; the two matched here only because each process sat in its
own.)

Symptom gone, measured through the real `scanSessions` on live transcripts — the
native-installer session running in this worktree, mid-turn:

```
working     bug-12  /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard/.worktrees/bug-12
incomplete  claude-agents-dashboard  /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
idle        claude-agents-dashboard  /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
active=1
```

Red-green proof that the fix is what moved it: the same session re-scanned with the *pre-fix*
live set injected reads idle again.

```
OLD-INPUT idle        /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard/.worktrees/bug-12
OLD-INPUT idle        /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
OLD-INPUT idle        /Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard
```

`pnpm test` (the three parser/composer tests failed with `scan.parsePsClaudePids is not a
function` before the implementation existed):

```
  13 passed, 0 failed
  ✓ parsePsClaudePids: keeps every launcher whose basename is claude
  ✓ parseLsofCwds: collects n-lines, normalizes trailing slash, ignores the rest
  ✓ composeLiveCwds: fails open on ps failure, zero pids, or lsof failure
  ✓ liveness: a worktree session is live on its own cwd, not its parent repo
  …
  18/18 passed
ALL PASS
```

`pnpm typecheck` → `tsc --noEmit`, exit 0, no output.

Two deviations from the plan, both deliberate:

- **One extra fail-open case.** The composer also returns `null` when `ps` matched pids but
  `lsof` named **no** cwd — pids exist, so an empty answer means the probe told us nothing,
  and an empty set would condemn every session. Covered by a case in the composer test.
- **`config.ts:174` left as written.** The plan expected it to repeat the case-sensitivity
  claim; it does not — it already says the gate "shells out to `lsof`/`ps`", which the
  pid-based probe makes more accurate, not less. `scan.ts`'s doc comment was rewritten, and
  `docs/subsystems/sessions.md` (§Process-liveness gate + §Docker) now describes the two-step
  probe and its fail-open cases.

Files changed: `server/lib/scan.ts`, `test/scan.test.ts`, `docs/subsystems/sessions.md`.
Not staged or committed — that is the user's call.

**Not verified, needs a human:** behaviour where `lsof` refuses the pid list outright
(locked-down or non-macOS host), and behaviour under a future launcher whose `ps` comm is not
`claude` — that path is designed to fail open and unit-tested at the composer, but never
exercised against a real such launcher. Also unverified in the browser: only the `scanSessions`
output was inspected, not the rendered board.


## Outcome — review follow-up (2026-09-01)

Code review raised one Important issue against the first pass: the `lsof` catch reused
`e.stdout` on *any* throw, including the `timeout: 2000` expiry. A timed-out child is killed
mid-stream, so its stdout is a **truncated** cwd list — and a short live set is exactly what
marks live sessions dead. `## Fix` step 3 authorised reusing stdout only for a non-zero
*exit*, and the branch had no test.

Fixed by extracting the decision into a pure exported `usableLsofStdout(err)`
(`server/lib/scan.ts`), which returns the stdout only when the error carries a numeric
non-zero `status` **and** no `signal` — lsof warning and exiting 1 on processes it may not
inspect, having printed the rest. Anything else — killed by timeout, killed by signal, never
ran (`ENOENT`), or an empty stdout — returns `null` and the gate is skipped. `liveCwds()`'s
catch is now one line: `lsofOut = usableLsofStdout(e)`.

Two tests cover it. The second one does not fabricate an error object: it runs
`sh -c 'echo n/a/b; sleep 5'` under a 200ms timeout, asserts the killed child really did write
stdout first, and then asserts that stdout is discarded — so the error shape is proved against
node itself.

```
  ✓ usableLsofStdout: a non-zero exit keeps its stdout, a timeout kill discards it
  ✓ usableLsofStdout: a real execFileSync timeout is discarded, output and all
```

Both guards mutation-proved, not just asserted:

- restoring the reviewed bug (deleting both guard lines, reusing stdout on any throw) fails
  both tests — `'n/a/b\n' !== null`;
- deleting only `if (e.signal) return null` fails the first test, after adding the case that
  makes that line load-bearing: `{ status: 1, signal: 'SIGKILL', stdout: 'n/a/b\n' }` → `null`,
  since a kill reported alongside a status is still a truncation.

Re-verified after the change: `pnpm test` → `18/18 passed` / `ALL PASS`; `pnpm typecheck` →
`tsc --noEmit`, exit 0, no output; the live probe still recovers the native-installer cwds
(`OLD size=2` → `NEW size=4`, including this worktree) and this session still reads `working`
through the real `scanSessions`.

Still not verified, needs a human: a real `lsof` that refuses the pid list on a locked-down or
non-macOS host (the `ENOENT`/no-status path is unit-tested, never exercised against such a
host), a real `lsof` slow enough to actually hit the 2s timeout, a future launcher whose `ps`
comm is not `claude`, and the rendered board in a browser.

Not staged or committed — the orchestrator commits.
