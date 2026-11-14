# Poll-path probes: async child processes and a bounded routine run log — design

Backlog: [#427](https://github.com/futin/claude-agents-dashboard/issues/427) (from the 2026-11-12 deep audit, 6 × Minor runtime + 1 × Minor bugs). Status: approved
for planning by the groom of 2026-11-14; the plan lives in the task promoted from #427.

## Problem

Seven places on request, poll or timer paths either block the event loop on a synchronous child process, fork more than they need to, or hold state that
grows without bound. Each one stalls every other client of the one-process server while it runs.

| # | Site | What it costs today |
| - | ---- | ------------------- |
| D1 | `server/lib/notify.ts` `readIdleSecs` — `execFileSync('ioreg')`, 1000 ms timeout | ~30–40 ms of blocked loop per read (3 timed runs, 2026-11-14); read by `maybeSend` on hook POSTs and by the 5 s wait-store reaper while a hold is releasable |
| D2 | `server/lib/usage.ts` `readToken` — `execFileSync('security')`, 5 s timeout | blocks every usage cycle (forced every 60 s by the recorder), and the renewal probe calls it again on every poll of `spawnWatching`; a slow or prompting keychain blocks for the full 5 s |
| D3 | `server/lib/codegraph.ts` `spawnToEnd` — no timeout, unbounded `stdout`/`stderr` strings | a hung `codegraph sync`/`index` keeps its `runs` entry (`codegraph-store.ts`) forever, so that repo answers `busy` until restart; output is held whole in memory |
| D4 | `server/lib/routine-store.ts` `createProbe().command` — `execFileSync('ps')`, no timeout | one `ps` per unfinished run whose pid is alive, on every `read()` of the run log, i.e. every `/api/routines` and `/api/routines/runs` poll |
| D5 | `server/lib/routine-reconcile.ts` `plan` — one `launchctl print` per installed plist, sequential | 5 forks per `GET /api/routines` on this machine (5 routine plists, 2026-11-14), per visible tab, uncached and uncoalesced |
| D6 | `server/lib/routine-log.ts` `sync` — rotated archives still match `.jsonl` | every archive is read from offset 0 at startup and never dropped; nothing deletes them |
| D7 | `server/lib/routine-log.ts` `read` — every fold kept, every run rebuilt and sorted per call | memory and per-poll cost grow with all history ever recorded |

Scale today: `~/.claude/routines/runs/mac.jsonl` is 2,176,507 bytes, 11,355 lines, 684 runs since 2026-10-20, none unfinished, no rotation yet (all measured
2026-11-14). At ~27 runs/day, 90 days is ~2,500 runs; rotation (20 MiB) would first fire after roughly seven months. D6/D7 are slow-growing, not urgent —
which is why they get the cheap, non-destructive fix below rather than a log format change.

## Decisions

**A1 — Idle reads go async; the gates that must stay synchronous never read idle.** `readIdleSecs` becomes an async read (`execFile`, same 1000 ms timeout,
same `HIDIdleTime` parse, same null on any failure). The predicate splits in two:

- a synchronous **gate** — `enabled`, the event checkbox, `requireRemoteAnswer`, `requireAutoMode` — the four free clauses in today's order;
- the asynchronous **`shouldNotify`** — the gate, then the `requireAfk` clause awaiting the idle thunk only when every free clause has passed.

`unattendedOpen` (usage, tick-capped and routine pushes) forces `requireAfk: false` today, so it never read idle: it switches to the synchronous gate, and
`usageCanSend`, `tickCanSend` and the `boolean` returns of `sendUsageEvent` / `sendTickCappedEvent` / `sendRoutineEvent` stay synchronous with unchanged
meaning. Only their desk/phone routing (`routeTo`) awaits idle, and it runs in the fire-and-forget continuation that already carries `deliver`.

`maybeSend` keeps its signature (`void`, returns immediately, never throws, never rejects unhandled): its body moves into an async continuation. The memoised
thunk keeps both properties `notify.test.ts` pins — at most one reading per send, and none at all when the policy lacks `requireAfk` and no desk topic is
set. `sendTest` is already async and simply awaits the route.

`backAtDesk` becomes async. The reaper tick (`reapIdle`) collects releasable entries, returns 0 with no read when there are none, otherwise awaits one
reading and then **re-collects** releasable entries before settling — an entry answered during the await is already settled (`settle` is idempotent) and
one added during it is left for the next tick. Ticks never overlap: a tick that finds the previous one still awaiting skips. Each store's `sweepIdle()` and
the three module exports (`plans.ts`, `messages.ts`, `pending.ts`) return `Promise<number>`. Fail directions are unchanged (unreadable → stay held;
`idleSecs === 0` → false before any read).

Why not a cached sampler that keeps the sync API: a sample taken on demand is stale exactly when it matters (the first push after a quiet spell), and one
kept fresh by a timer spawns `ioreg` forever on an idle server, which `remote-answer.md` rules out.

**A2 — The token read goes async.** `readToken` keeps its store order (env blob → keychain → `.credentials.json`) and `pickTokenState`, but reads the
keychain with async `execFile` (same 5 s timeout, same stdio) and returns `Promise<TokenState>`. `UsageCycleDeps.readToken`, `RefreshOptions.probe` and
`AutoRenewOptions.probe` widen to accept a promise, and every call site in `token-refresh.ts` (`spawnWatching`'s loop, the `already-ok`, `auth-status` and
`spawn-turn` re-checks) awaits it. No caching: the CLI rewrites the keychain item whenever it renews, and a cached token would delay seeing that.

**A3 — `spawnToEnd` gets a run timeout and an output cap.** `CODEGRAPH_RUN_TIMEOUT_MS = 30 min`, overridable through the runner factory for tests. On expiry
the child gets SIGTERM, then SIGKILL after a 5 s grace, and the promise rejects with the same `ETIMEDOUT` error `execWithTimer` uses; `launch`'s existing
catch records `{ ok: false, message }` and deletes the `runs` entry, so the repo stops answering `busy`. Each stream is capped at the existing
`MAX_BUFFER` (8 MiB) by keeping the **tail** — `lastLine` and the lock-loss check read the end of the output, and a lock loss happens before indexing writes
anything bulky. No separate stop endpoint: the timeout is the stop path the audit asked for; `resetCodegraph` already detaches the store from a late result.

**A4 — Wrapper liveness is memoised per run and bounded.** `createProbe().command` gets a 2 s `timeout`. `createLogReader` memoises the liveness verdict per
run id: `false` is **sticky** (a dead wrapper never comes back, and a recycled pid — the case the audit names — is exactly the one that kept paying), `true`
is reused for `LIVENESS_TTL_MS = 10 s`, `null` is never cached. A run that gains an `end` record drops its memo.

**A5 — `GET /api/routines` reads a coalesced, short-lived plan.** A new `planReconcileCached(config)`: concurrent callers share one in-flight `plan`, and a
result younger than `PLAN_TTL_MS = 5 s` is served as is. `applyOnce` seeds the cache with its post-apply plan, and the reconcile watchers' trigger drops it.
`POST /api/routines/reconcile` (dry run and apply) keeps calling the uncached `planReconcile` — an explicit user action reads the OS fresh. Inside `plan`,
the per-plist `launchctl print` calls run concurrently (`Promise.all`), keeping `installed` keyed and ordered as today.

**A6 — Rotated archives older than the retention window are not read.** `RUN_RETAIN_DAYS = 91`: the widest stats window (`ROUTINE_WINDOWS`, 90 days) plus
one so a window that starts at local midnight is never short. `sync` skips a `<machine>.<yyyymmdd>[.<n>].jsonl` archive whose stamp is older than the cutoff:
rotation renames a live file, so every record in it predates its stamp. The live `<machine>.jsonl` and unparseable names are always read. Archives are
**never deleted** — the log is the only record of runs, and disk is not the problem.

**A7 — The run fold is pruned and the built list is reused.** After each `sync`, folds whose run started before the cutoff are dropped, with one exception:
each job's newest finished run is kept whatever its age, because `serveRoutines` shows it as the job's `last` row. Refusals get the same cutoff. `read()`
keeps the built `RoutineRun` of every finished run (immutable once its `end` record is folded) and rebuilds only unfinished ones; the sorted list is rebuilt
only when a fold was added, changed or pruned, or an unfinished run's state changed. `read()` still returns a fresh array each call, so no caller can mutate
the cache.

## Accepted edge cases

- A job whose newest run sits only in an archive older than the cutoff loses its `last` row after a restart. It needs a job idle for > 91 days across a
  20 MiB rotation, and the row returns on the job's next run.
- A desk/phone route decided after an `await` reflects idle up to ~40 ms later than today. Immaterial against a threshold in seconds.
- A 30 min run timeout can kill a real first `index` of a very large repo. The run reports `timed out`, and the user can re-run; raise the constant if that
  shows up.

## Out of scope

`bootId()`'s synchronous `sysctl` (startup and owner claim only), `wrapperAlive` on the reconcile `lockHeld` path (per change, not per poll, and it gets
A4's timeout through the shared probe), and any change to the run-log line format or the rotation size.

## Docs that change with it

`docs/subsystems/remote-answer.md` and `push-notify.md` (async idle, the sync gate / async predicate split), `usage-limits.md` (async token read),
`codegraph.md` (run timeout, output cap), `routines.md` (liveness memo, cached plan, archive cutoff and retention), and `docs/overview.md` §Map if any line
there names a changed behaviour.
