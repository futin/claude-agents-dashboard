---
id: bug-15
title: A session whose transcript split across two project dirs renders twice, then piles up until reload
created: 2026-09-02
tags: sessions, scan
updated: 2026-09-04T21:58:19Z
started: 2026-09-04T21:41:59Z
execute-elapsed: 980
---

## Symptom

One live session renders as several rows in the sessions list. Every copy carries the
same title, project, branch, model and token total; what differs is the status word and
the relative age — one row reads `WORKING · 22s ago`, the ones under it read `PENDING`
at 5m, 6m, 6m, 6m… Reloading the page collapses them back to the real count, and they
start accumulating again from there.

The pile-up is the *visible* half. Underneath it, `GET /api/sessions` really does return
the same session twice: 20 entries, 19 unique ids, `f4f08da0-…` appearing once as
`incomplete` and once as `idle`. So the row count is wrong even on a fresh load — the
piling is what an actively-written duplicate turns that into.

## Repro

Needs a session that `cd`'d out of its launch directory mid-run — an orchestrator run
entering a per-item worktree is the reliable producer, and 11 ids on this machine are
already in that state.

```bash
# every session id that has a transcript in more than one project dir
cd ~/.claude/projects && find . -maxdepth 2 -name '*.jsonl' \
  | sed 's|.*/||' | sort | uniq -d
```

```bash
# the same id, twice, in one payload
curl -s 'http://127.0.0.1:4173/api/sessions?limit=20' \
  | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")).sessions.map(x=>x.id); console.log(s.length, new Set(s).size)'
# → 20 19
```

With the duplicated session idle, the DOM sits at exactly two rows for it and stays
there across polls — measured stable over six ticks. The pile-up needs the pair to keep
*reordering*, which is what an actively-written half does: its mtime bumps it to the top
of the sort on every poll while the stale half stays where it was.

## Affects

- `server/lib/scan.ts:110` — `listTranscripts` emits one ref per *file*
- `server/lib/scan.ts:309` — `candidates`: filter, sort by mtime, slice; no dedupe by id
- `server/lib/scan.ts:406` — `id: c.id` pushed once per candidate
- `server/lib/scan.ts:163` — `listTranscripts(root).find(t => t.id === sessionId)`
- `server/api.ts:192`, `server/api.ts:243`, `server/api.ts:486`, `server/api.ts:1165` — four more `find(t => t.id === id)`
- `client/src/components/SessionList.tsx:117` — `key={s.id}`
- `client/src/hooks/useSessions.ts:35` — replaces state wholesale, so the client is not the source

## Cause

Claude Code files a transcript record under the project dir derived from the cwd *at
the time it is written*, so a session that `cd`s into a git worktree keeps its id and
starts a second `.jsonl` in a second project dir. Its history is then split in half:

```
~/.claude/projects/-Users-…-backlog-manager/f4f08da0-….jsonl
~/.claude/projects/-Users-…-backlog-manager--worktrees-runs-view-redesign/f4f08da0-….jsonl
```

`listTranscripts` walks project dirs and pushes a `TranscriptRef` per file, keyed on
`(dirName, id)`. `scanSessions` treats that list as a list of *sessions*: it filters by
lookback, sorts by mtime, slices the pool and parses each entry, so both halves survive
as two `Session` objects with the same `id`. They read differently because each is
parsed from a different half — different mtime, so a different `recent`, and different
newest records, so a different `turnComplete` — which is why the same session shows as
`working` and `idle` at once.

The client then can't reconcile them. `SessionList` keys rows on `s.id`, and two children
with the same key is unsupported: React's keyed map holds one of them, so the other is
treated as a fresh insertion on each update instead of being matched to the node already
mounted. While the pair holds still nothing visibly breaks; as soon as the live half
keeps jumping up the sort, each poll leaves another orphaned copy behind, frozen with the
status and age it was rendered with. Nothing removes those, hence the reload.

The same wrong assumption — that an id names one file — is behind a second defect the
duplicate rows hide: five call sites resolve a session with
`listTranscripts(...).find(t => t.id === id)`, which returns whichever half `readdirSync`
happened to yield first, not the newest. A split session's chat drawer and detail pane
can therefore be served the *abandoned* half of its own transcript.

## Fix

Keep `listTranscripts` as the raw per-file enumeration — three consumers legitimately
want every file: `server/lib/usage-ledger.ts:279` (dropping a half loses its token
accounting outright), `server/lib/analytics.ts:47` and `server/lib/management.ts:419`.
Deduping in there would silently corrupt the ledger to fix a display bug.

Add the dedupe one layer up instead, as the single implementation of "which file *is*
this session now":

1. A newest-per-id reduction over the refs — same id, keep the greater `mtimeMs` — applied
   to `candidates` in `scanSessions` *before* the slice, so the pool can't spend two of
   `maxSessions * 2` slots on one session.
2. One exported `findTranscript(root, id)` built on that same reduction, replacing all
   five `find(t => t.id === id)` call sites, so a split session resolves to its live half
   everywhere rather than per-call-site chance.

`SessionList`'s `key={s.id}` stays as it is: unique ids in the payload is the invariant
being restored, and a client-side dedupe would only hide a server that broke it again.

## Test cases

In `test/scan.test.ts`, against the existing tmpdir fixture style:

- Two dirs, same session id, distinct mtimes → `scanSessions` returns **one** session for
  that id, and it is the one parsed from the newer file (assert on a field that differs
  between the halves, e.g. `updatedMs` or `status`).
- The pool arithmetic. **Corrected after review — the original bullet here was
  arithmetically impossible:** at `maxSessions: 1` there is no remaining display slot for a
  second session, so no assertion could tell a pre-slice dedupe from a post-slice one.
  Discriminating needs a split id holding *the whole pool* — at least `maxSessions * 2`
  halves. With `maxSessions: 2` (pool of 4), an id split across the four newest files plus
  an older distinct id: pre-slice dedupe yields both ids, post-slice yields only the split
  one, because the slice drops the distinct id before the dedupe can free a slot.
- `findTranscript(root, id)` returns the newer ref for a split id, and `undefined` for an
  unknown id.
- `listTranscripts` itself still returns **both** files — the guard on the ledger.

## Done when

`GET /api/sessions` has as many unique ids as entries with an 11-way split corpus on
disk, the sessions list holds a stable row count across polls while a split session is
being actively written, and the chat drawer for a split session shows its newest turns.

## Outcome

2026-09-04 — Fixed as planned. `newestPerId` (private) collapses per-file refs to one per
id, keeping the greater `mtimeMs`; `scanSessions` runs it over the filtered refs *before*
the `maxSessions * 2` slice, and the new exported `findTranscript(root, id)` is built on the
same reduction. `listTranscripts` is untouched, so the usage ledger and analytics still see
both halves. Three of the four `find(t => t.id === id)` call sites now go through
`findTranscript`: `scan.ts` `lastMessageMs`, `api.ts` `serveSessionDetail`,
`serveSessionChat`, plus `serveSpawn`'s resume lookup. `SessionList`'s `key={s.id}` stayed
as it is.

**One deviation from the plan:** `api.ts:487` `sessionExists` was left as
`listTranscripts(...).some(t => t.id === id)`. It is the fifth site the plan counted, but it
only asks *whether* an id exists, and dedupe cannot change that answer — routing it through
`findTranscript` would add a Map build for an identical result.

### Regression tests (`test/scan.test.ts`, 4 new cases)

Watched all three guard cases fail first, then pass, then fail again with the reduction
removed entirely (mutation check — plain `find`, no dedupe at all). **That mutation proved
the dedupe exists, not that it runs before the slice — see the review follow-up below.**

```
  ✗ split transcript: one session per id, parsed from the newer file
    Expected values to be strictly equal:
2 !== 1
  ✗ split transcript: the dupe does not eat another session's display slot
    Expected values to be strictly deep-equal:
+ actual - expected
  [ 'split-1', + 'split-1' - 'other-1' ]
  ✗ findTranscript resolves a split id to its newest file
    scan.findTranscript is not a function
```

After the fix, `tsx test/scan.test.ts`:

```
  ✓ split transcript: one session per id, parsed from the newer file
  ✓ split transcript: the dupe does not eat another session's display slot
  ✓ findTranscript resolves a split id to its newest file
  ✓ listTranscripts still enumerates both halves (the usage ledger depends on it)

Passed: 57  Failed: 0
```

`pnpm test` → `ALL PASS`; `pnpm typecheck` → clean (no output). Note: `api-usage-rates`
fails in a fresh worktree until `pnpm build` exists — it did here, `pnpm build` fixed it,
nothing to do with this change.

### Against the real corpus (739 transcripts, 12 split ids)

`scanSessions({ maxSessions: 40, lookbackHours: 24*365 })` over `~/.claude/projects`:

```
before: files 739 unique ids 727 split ids 12
        sessions 40 unique 39
        dup: 93319dd5-… → [['idle', 1788555743895.95], ['idle', 1788541161405.99]]

after:  files 739 unique ids 727 split ids 12
        sessions 40 unique 40
        split ids present in payload: [ '93319dd5-adad-4071-aaae-b72d63b674de' ]
```

`GET /api/sessions?limit=20` off a prod server on 4273 → `entries 20 unique 20`. The chat
endpoint for the split id served the live half: last message `2026-09-04T20:43:48.567Z`,
which is the newer file's last conversational timestamp (the abandoned half ends at
`16:59:21.092Z`).

Row-count stability across polls, staged on a fixture `HOME` with a split session whose
newer half got a fresh turn appended before every poll:

```
poll 0 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
poll 1 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
poll 2 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
poll 3 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
poll 4 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
poll 5 entries 2 unique 2 | split id count 1 | ids aaaaaaaa,bbbbbbbb
```

### Not verified, needs a human

- **The DOM half of the pile-up.** Only the payload invariant was proven, over six polls of
  an actively-written split session. The orphaned rows were a consequence of duplicate React
  keys, and the payload no longer carries any — but no browser was driven, so nobody has
  watched the list hold its row count on screen.
- **The second defect is latent on this machine, not observable.** For all 12 split ids here,
  the old `find` happened to hit the newest half anyway (`readdirSync` yields the non-worktree
  dir first, and that is the live one in every case), so the wrong-half chat drawer is proven
  only by the fixture test, not live.

## Review follow-up (2026-09-04)

An independent review of the branch returned **fix** with one Important finding, addressed
here.

### The pool-slot test did not guard the dedupe's placement

As first written, `split transcript: the dupe does not eat another session's display slot`
used three files (two halves of `split-1`, one `other-1`) and asserted at `maxSessions: 1`
and `maxSessions: 2`. Neither assertion could fail with the dedupe moved after the slice:
at `maxSessions: 1` the display cap alone excludes `other-1`, and at `maxSessions: 2` the
pool of 4 holds all three files, so slicing changes nothing. The `## Fix` step-1 requirement
— dedupe *before* the slice — was therefore unguarded, while the test's own comment and this
Outcome both claimed it was covered. Both claims are now corrected above.

Replaced with `split transcript: the dupe does not eat another session's pool slots`:
`maxSessions: 2` (pool of 4), `split-1` split across the four newest files, plus an older
distinct `other-1`. Pre-slice dedupe leaves the pool one distinct id and `other-1` reachable;
post-slice dedupe slices `other-1` out first and loses the row.

Proved by mutation on the placement itself — `newestPerId` moved to wrap the sliced list:

```
  const candidates = newestPerId(
    listTranscripts(root)
      .filter(t => !archived || !archived.has(t.id))
      .filter(t => now - t.mtimeMs <= lookbackMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxSessions * 2));
```

```
  ✗ split transcript: the dupe does not eat another session's pool slots
    Expected values to be strictly deep-equal:
+ actual - expected

  [
    'split-1',
-   'other-1'
  ]

  ✓ findTranscript resolves a split id to its newest file

Passed: 56  Failed: 1
```

Restored to the pre-slice placement (`newestPerId(...)` wrapping the *filtered* list, with
`.sort().slice()` after it):

```
  ✓ split transcript: one session per id, parsed from the newer file
  ✓ split transcript: the dupe does not eat another session's pool slots
  ✓ findTranscript resolves a split id to its newest file
  ✓ listTranscripts still enumerates both halves (the usage ledger depends on it)
Passed: 57  Failed: 0
```

### Follow-up worth filing (pre-existing, not touched here)

`## Fix` above lists `server/lib/analytics.ts:47` among the consumers that legitimately want
every file. That is true of line 47's `listTranscripts` call, but the resolve two lines down
is not:

```ts
transcripts.find(t => t.id.startsWith(entry.idPrefix))
```

That is a single-file lookup carrying exactly the assumption this bug is about — for a split
id it returns whichever half `readdirSync` yielded first, not the live one, so a kaizen
lesson can be joined against the abandoned half. It is a prefix match rather than an
equality one, so `findTranscript` does not drop in as-is; it needs a newest-per-id reduction
over the prefix matches. The reviewer flagged it as pre-existing and out of scope for this
diff, and it stayed out. **Worth a `/backlog-capture` bug of its own.**
