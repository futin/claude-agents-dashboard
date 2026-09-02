---
id: bug-15
title: A session whose transcript split across two project dirs renders twice, then piles up until reload
created: 2026-09-02
tags: sessions, scan
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
- The pool arithmetic: with `maxSessions: 1` and a duplicated id whose two files are the
  two newest transcripts, the second-newest *distinct* session still gets the remaining
  display slot — the case a pre-slice dedupe fixes and a post-slice one does not.
- `findTranscript(root, id)` returns the newer ref for a split id, and `undefined` for an
  unknown id.
- `listTranscripts` itself still returns **both** files — the guard on the ledger.

## Done when

`GET /api/sessions` has as many unique ids as entries with an 11-way split corpus on
disk, the sessions list holds a stable row count across polls while a split session is
being actively written, and the chat drawer for a split session shows its newest turns.
