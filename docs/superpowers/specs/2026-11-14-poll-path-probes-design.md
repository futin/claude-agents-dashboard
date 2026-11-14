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
2026-11-14). At ~27 runs/day, the 181-day retention below is ~4,900 runs; rotation (20 MiB) would first fire after roughly seven months. D6/D7 are slow-growing, not urgent —
which is why they get the cheap, non-destructive fix below rather than a log format change.

## Decisions

**A1 — Idle reads go async; the gates that must stay synchronous never read idle.** `readIdleSecs` becomes an async read (`execFile`, same 1000 ms timeout,
same `HIDIdleTime` parse, same null on any failure). The predicate splits in two:

- a synchronous **gate** — `enabled`, the event checkbox, `requireRemoteAnswer`, `requireAutoMode` — the four free clauses in today's order;
- the asynchronous **`shouldNotify`** — the gate, then the `requireAfk` clause awaiting the idle thunk only when every free clause has passed.

`unattendedOpen` (usage, tick-capped and routine pushes) forces `requireAfk: false` today, so it never read idle: it switches to the synchronous gate, and
`usageCanSend`, `tickCanSend` and the `boolean` returns of `sendUsageEvent` / `sendTickCappedEvent` / `sendRoutineEvent` stay synchronous with unchanged
meaning. Only their desk/phone routing (`routeTo`) awaits idle, and it runs in the fire-and-forget continuation that already carries `deliver`.

**Synchronous fast path.** A send that needs no idle reading — the policy lacks `requireAfk` (or the gate already failed) and no desk topic is set — runs
exactly as today, start to `deliver`, in the caller's tick. Only a send that needs the reading defers: `maybeSend` keeps its signature (`void`, returns
immediately, never throws, never rejects unhandled) and moves the AFK clause, routing and `deliver` into a caught async continuation; the unattended
senders do the same for routing and `deliver` only. Suites without a desk topic (`usage-alerts`, `routine-notify`, `tick-caps`) therefore keep asserting
`sent.length` synchronously. The memoised thunk keeps both properties `notify.test.ts` pins — at most one reading per send, and none at all when no clause
needs it. `sendTest` is already async and simply awaits the route.

**Test seams.** `setIdleSource` and `setIdleReader` accept a reader returning `number | null` or a promise of it, so existing synchronous fakes keep
working. A new `notifySettled(): Promise<void>` resolves once every deferred send started so far has delivered or given up; a test of a deferred path awaits
it before asserting `sent`.

`backAtDesk` becomes async. The reaper tick (`reapIdle`) collects releasable entries, returns 0 with no read when there are none, otherwise awaits one
reading and then settles **the entries of that first collection that are still held** — an entry answered during the await is already settled (`settle` is
idempotent, so it keeps its answer) and one added during the await is not in the collection, so it is left for the next tick. Ticks never overlap: the guard
lives in `reapIdle` itself, so a call made while an earlier one is still awaiting resolves 0 without reading. Each store's `sweepIdle()` and
the three module exports (`plans.ts`, `messages.ts`, `pending.ts`) return `Promise<number>`. Fail directions are unchanged (unreadable → stay held;
`idleSecs === 0` → false before any read).

Why not a cached sampler that keeps the sync API: a sample taken on demand is stale exactly when it matters (the first push after a quiet spell), and one
kept fresh by a timer spawns `ioreg` forever on an idle server, which `remote-answer.md` rules out.

**A2 — The token read goes async.** `readToken` keeps its store order (env blob → keychain → `.credentials.json`) and `pickTokenState`, but reads the
keychain with async `execFile` (same 5 s timeout; stdin closed explicitly with `child.stdin?.end()`, as `token-refresh.ts` does for its spawn, since
`execFile` leaves stdin an open pipe; stderr ignored) and returns `Promise<TokenState>`. `UsageCycleDeps.readToken`, `RefreshOptions.probe` and
`AutoRenewOptions.probe` widen to accept a promise, and every call site in `token-refresh.ts` (`spawnWatching`'s loop, the `already-ok`, `auth-status` and
`spawn-turn` re-checks) awaits it. No caching: the CLI rewrites the keychain item whenever it renews, and a cached token would delay seeing that.

**A3 — `spawnToEnd` gets a run timeout and an output cap.** `CODEGRAPH_RUN_TIMEOUT_MS = 30 min`, overridable through the runner factory for tests. On expiry
the child gets SIGTERM, then SIGKILL after a 5 s grace, and the promise rejects with the same `ETIMEDOUT` error `execWithTimer` uses — **on the child's
`close` after the timer fired, or when the kill grace ends, whichever comes first**, never at the moment of expiry, so the `runs` entry is not freed while
the killed child may still hold the graph (`codegraph-store.ts:268`), and a descendant that keeps the pipe open cannot keep the promise pending. `launch`'s
existing catch records `{ ok: false, message }` and deletes the `runs` entry, so the repo stops answering `busy`. Each stream is capped at the existing
`MAX_BUFFER` (8 MiB) by keeping the **tail** — `lastLine` and the lock-loss check read the end of the output, and a lock loss happens before indexing writes
anything bulky. No separate stop endpoint: the timeout is the stop path the audit asked for; `resetCodegraph` already detaches the store from a late result.

**A4 — Wrapper liveness is memoised per run and bounded.** `createProbe().command` gets a 2 s `timeout`. `createLogReader` memoises the liveness verdict per
run id: `false` is **sticky** (a dead wrapper never comes back, and a recycled pid — the case the audit names — is exactly the one that kept paying);
`true` and `null` are reused for `LIVENESS_TTL_MS = 10 s` (caching `null` too bounds a hung `ps`: the probe stays synchronous, so its worst case is 2 s of
blocked loop per unfinished live-pid run per 10 s, not per poll). A run that gains an `end` record drops its memo.

**A5 — `GET /api/routines` reads a coalesced, short-lived plan.** A new `planReconcileCached(config)`: concurrent callers share one in-flight `plan`, and a
result younger than `PLAN_TTL_MS = 5 s` is served as is. `applyOnce` seeds the cache with its post-apply plan — or with the bare report its early return
produces when `plan` answers one (`routine-reconcile.ts:432`) — and the reconcile watchers' trigger drops it at trigger time, before the debounce. A
**generation counter** guards the race: every seed and drop bumps it, and an in-flight plan stores its result only if the generation is unchanged since it
started (its own callers still get it). A rejected plan is never cached.
`POST /api/routines/reconcile` (dry run and apply) keeps calling the uncached `planReconcile` — an explicit user action reads the OS fresh. Inside `plan`,
the per-plist `launchctl print` calls run concurrently (`Promise.all`), keeping `installed` keyed and ordered as today.

**A6 — Rotated archives older than the retention window are not read.** `RUN_RETAIN_DAYS = 181`: the widest stats window (`ROUTINE_WINDOWS`, 90 days)
also totals the window before it (`computeStats`'s `prev`, from `dayStart(-(2 * days - 1))`, `server/lib/routine-log.ts:292`), so 2 × 90 days, plus one so a
window that starts at local midnight is never short. The **cutoff** is local midnight `RUN_RETAIN_DAYS` days before today:
`new Date(y, m, d - RUN_RETAIN_DAYS)` on the reader's `now()`, the same day arithmetic `computeStats` uses. `sync` skips a `<machine>.<yyyymmdd>[.<n>].jsonl`
archive when its stamp, compared as a string, is strictly less than `ymd(cutoff)` — rotation renames a live file, so every record in it predates its stamp.
The skip applies only to a name `sync` is **not already tracking**: a tracked file that ages past the cutoff stays tracked (its offset sits at EOF, so it
costs one `stat`), which keeps `sync`'s "a tracked file vanished → full rebuild" rule (`routine-log.ts:155-170`) from firing on an age-out. The live
`<machine>.jsonl` and unparseable names are always read. Archives are **never deleted** — the log is the only record of runs, and disk is not the problem.

**A7 — The run fold is pruned and the built list is reused.** After each `sync`, folds and refusals whose `startedAt` is before the cutoff instant (A6) are
dropped, with one exception: per job, the run `serveRoutines` would show as `last` — the newest run whose state is not `running`, of any state (`ok`,
`failed`, `lost`, `refused`; `server/api.ts:1808`) — is kept whatever its age, so pruning never changes a job's `last` row. Unfinished runs before the
cutoff are dropped like any other (they read `lost` by then). `read()`
keeps the built `RoutineRun` of every finished run (immutable once its `end` record is folded) and rebuilds only unfinished ones; the sorted list is rebuilt
only when a fold was added, changed or pruned, or an unfinished run's state changed. `read()` still returns a fresh array each call, so no caller can mutate
the cache.

## Accepted edge cases

- A job whose newest run sits only in an archive older than the cutoff loses its `last` row after a restart. It needs a job idle for > 181 days across a
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
