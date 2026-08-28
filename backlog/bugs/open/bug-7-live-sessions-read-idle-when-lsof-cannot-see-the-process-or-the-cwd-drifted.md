---
id: bug-7
title: Live sessions read IDLE when lsof cannot see the process or the cwd drifted
created: 2026-08-28
tags: sessions, scan, spawn
---

## Symptom

A session that is demonstrably running — a Bash tool call rendered in its activity line,
last message 1s old — renders gray **IDLE** instead of green **WORKING**.

Observed on a dashboard-spawned session (`surface: dashboard`, row title
`bl claude-agents-dashboard bug-2`, project `claude-agents-dashboard`, branch `main`,
40.1k tokens, `IDLE · Bash Show bug-2 · 1s ago`) launched from a dashboard sitting in
`../backlog-manager`, while two ordinary `backlog-manager` rows in the same snapshot
correctly showed WORKING.

Not spawn-specific. Cause A below mislabels **any** session started from the native
installer's `claude`; the spawned session merely hits it first, because `CLAUDE_BIN`
points at exactly that shim.

## Repro

Cause A (probe blind to the binary):

```bash
ps -o pid=,ucomm= -p <pid of a native-install claude session>   # -> 2.1.250, not "claude"
lsof -c claude -a -d cwd -Fn                                    # that pid is absent
lsof -p <pid> -a -d cwd -Fn                                     # but its cwd resolves fine
```

Measured 2026-08-28 with three desktop-app sessions and one native-install session live:
the aggregate probe returned 3 of the 4 pids. Missing pid `93162`
(`~/.local/bin/claude -p --session-id … --remote-control`), cwd
`/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard`.

Cause B (cwd drift):

1. Start any session, let it run `cd <subdir> && …` in one Bash tool call.
2. Every transcript record from that point carries `cwd: <repo>/<subdir>`.
3. The row flips to IDLE and stays there while the session keeps working.

Confirmed in `~/.claude/projects/-Users-…-claude-agents-dashboard/f9388f02-….jsonl`:
record 97 is `Bash {"command": "cd backlog/bugs/open && sed -i '' …"}`; records 98-100
carry `cwd: …/claude-agents-dashboard/backlog/bugs/open` while `lsof` still reported the
process cwd as the repo root. `GET /api/sessions` reported that session's `projectPath`
as `…/claude-agents-dashboard/backlog/bugs/open`.

## Affects

- `server/lib/scan.ts:191` — `liveCwds()` runs `lsof -c claude -a -d cwd -Fn`
- `server/lib/scan.ts:283` — the `dead` gate: `live !== null && projectPath !== null && !live.has(normCwd(projectPath))`
- `server/lib/scan.ts:305` — `else if (dead) status = 'idle'`
- `server/lib/spawn.ts:442` — spawns with `cwd: ref.path`, so a spawned session's *process* cwd is right; only the probe and the transcript reading are wrong
- `docs/subsystems/sessions.md` — documents per-cwd granularity as the only stated limit of the liveness probe; neither cause below is mentioned

## Cause

Two independent causes, either one sufficient on its own. Both verified live, 2026-08-28.

**A — `lsof -c claude` matches the kernel process name, and the native installer's binary
isn't called `claude`.** `~/.local/bin/claude` is a symlink to
`~/.local/share/claude/versions/2.1.250`, a Mach-O executable whose *filename is the
version string*. `ucomm` (p_comm) is therefore `2.1.250`, and `lsof -c claude` — a prefix
match on that name — never sees it. The desktop app's binary
(`…/claude-code/2.1.247/claude.app/Contents/MacOS/claude`) is literally named `claude`, so
those sessions pass; that is why the two `backlog-manager` rows were correct in the same
snapshot. Every native-install session's cwd is silently absent from the live set, the
`dead` gate fires, and `status` is forced to `idle` regardless of what the transcript says.
The probe's fail-open contract does not help: it fails open only when `lsof` *errors*, and
here it exits 0 with a confidently incomplete set.

**B — the transcript's `cwd` follows `cd`, the process's does not.** Claude Code stamps
`cwd` on every record, and a `cd` inside a Bash tool call moves it for the rest of the
session. `dead` compares that string for exact equality against a set of *process* cwds,
so the moment a session cd's into a subdirectory its `projectPath` can no longer match any
live entry — even with cause A fixed, even for a plain terminal session. This also
mislabels `project`, the row's project pill, and the Settings project filter.

Why it surfaced now rather than earlier: at the moment of the screenshot no other session
held the repo root as its cwd. Per-cwd granularity (the documented limit) normally *masks*
both causes — a second session sitting in the same directory makes a mislabelled one read
live by accident.

## Fix

Not settled — needs grooming. Candidate directions, each verified as feasible but not
chosen:

- **A.** Stop matching on the command name. Either resolve `config.claudeBin` to its real
  filename and pass that to `-c` as well, or drop `-c` and filter `lsof -d cwd` output by
  argv/binary path, or replace the probe with `ps -Ao pid,args` + `lsof -p <pids>` so the
  match is on the executable path rather than p_comm. Cost matters: the probe runs on
  every 3s poll with a 2s timeout.
- **A′.** Track spawned children directly — `server/lib/spawn.ts` already holds the child
  pid, so a dashboard-spawned session could contribute its own liveness without any probe.
  Fixes the reported case only; terminal sessions on the native install stay broken.
- **B.** Compare cwds by containment, not equality (a live cwd at or under the recorded
  `projectPath`, or vice versa), or pin `projectPath` to the *first* record's cwd rather
  than the newest so `cd` cannot move it.

Both must be fixed for the reported row to go green; each alone leaves the other's repro
failing.
