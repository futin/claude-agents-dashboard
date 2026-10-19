# Plan review 1 — recheck: Management › CodeGraph

Date: 2026-10-19. Reviewer: Fable 5.1, fresh subagent. Scope: only the hunks in `plan-review-1.diff` against
`docs/superpowers/plans/2026-10-19-codegraph-view.md` (plan) and `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` (spec). Surrounding plan
lines read for context only. No document edited; no server started; no `codegraph sync`/`index` run (one read-only `codegraph status --json` to confirm
fixture field names).

## Verdict: APPROVE WITH FIXES

The changed sections are consistent with the spec and with each other, every cited symbol and line was found, and the new test cases pin behaviour that
would fail before implementation. Three Important items need a line each before execution; the rest is wording.

## Verified (changed lines, with the evidence)

| Plan line | Claim | Evidence |
|---|---|---|
| 55-56 | `projectPath` / `indexPath` are fields of `codegraph status --json`; fileCount 416 | live capture keys: `initialized,version,projectPath,indexPath,lastIndexed,fileCount,nodeCount,edgeCount,dbSizeBytes,walSizeBytes,backend,journalMode,nodesByKind,languages,pendingChanges,worktreeMismatch,index`; `fileCount 416`, `index.state 'complete'`, extraction 27/27 |
| 80-82 | 1.6.2 `index` takes `rebuild.pid` then recreates the DB | bundle (`@colbymchenry/codegraph-darwin-arm64/lib/dist/bin/codegraph.js`) `:832` `tryAcquireWriterLock(projectPath, 'rebuild', 'rebuild.pid')`, `:849-858` comment "discard .codegraph/codegraph.db + its WAL", `:859` `CodeGraph.recreate(projectPath)` — the pid file is live before the DB disappears, so the new `findGraphRoot` rule is sound |
| 84 | `startedAt` is epoch ms | `lib/dist/mcp/writer-lock.js:113` `startedAt: Date.now()` |
| 102-103 | `listed: false` pins with a path exist; spec:48 says `missing` | `server/lib/management.ts:728` `listed: listedPaths.has(ref.path)` with `path: ref.path`; spec:48 "A dead pin (`path: null` or `listed: false`) → `state: 'missing'`, no CLI launch" |
| 143 | `serveOpenFolder` refuses `listed !== true` at `server/api.ts:1807` | `api.ts:1807` `if (!rows.some(r => r.listed === true && r.path === path)) return sendJson(res, 403, …)` |
| 140 | rebuild live + non-`ok` read keeps stats / `building` | spec:79-81 (fail or time out → keep last good stats; none yet → `building`); extending to `none` matches the recreate window |
| 161, 194 | `Promise.all` double-start tests | pin "one launch" at both store and route level; both fail on an implementation that checks after its first `await` |
| 225 | `formatAgo` reads `Date.now()` at `client/src/lib/format.ts:29` | `format.ts:29-30` (JSDoc at 29, function at 30, `Date.now()` at 31) |
| 225 | mock's quiet line reads "indexed 2h ago" | mock v2 artifact, Now section: `416 files · 8.3k symbols · watching · indexed 2h ago` |
| 265 | `startGitPoll` in `gitPoll.ts`, `createPollGate` in `gitClock.ts` | `client/src/lib/gitPoll.ts:25`, `client/src/lib/gitClock.ts:105`; `useGitStats.ts:4-5` imports exactly these |
| 302-304 | `codegraph` is an nvm `#!/usr/bin/env node` shim | `which codegraph` → `~/.nvm/versions/node/v22.23.1/bin/codegraph`, first line `#!/usr/bin/env node`, `codegraph --version` → 1.6.2 |
| 315-316 | route map ~line 49, closed `kind` union at `views.spec.ts:19`, `EXPECTED_SHOTS` 86 | `test/visual/fixtures/index.ts:40-50` (last entry `/api/git-stats` at 49), `test/visual/views.spec.ts:19`, `:82` `const EXPECTED_SHOTS = 86;` |

## Findings

### Important

**[I] plan:302 — `WEB_PORT=<spare> pnpm start` does not move the prod server.** `pnpm start` is `cross-env NODE_ENV=production tsx server/index.ts`
(`package.json:10`) and the prod server listens on `config.port` (`server/index.ts:431`), which is `PORT`, default 4173 (`server/lib/config.ts:127`);
`WEB_PORT` is Vite's dev port (`config.ts:128`). As written the PATH duty binds 4173 — the port the same step says never to touch, and the user's own
prod instance when one is up. → `PORT=<spare> pnpm start` (and, since `.env` is read through `loadConfig`, say the env var overrides `.env`'s `PORT`).

**[I] plan:127 / 144-145 — the in-flight mark is per `dirName`, the run is per root; the order of the root-level checks is unstated.** A repo pin and
its subdirectory pin (plan:134 says they share one `run`) each pass their own mark, both `await findGraphRoot`, and if "own run on that root" is checked
before an awaited `livePid` (plan:144-145 lists it first), both reach "else record `run`" → two launches on one root. The `Promise.all` test at plan:161
covers only the same `dirName`. → State that after the last `await` the own-run check and `record run` are one synchronous step (or that the mark moves
to the root as soon as the root is known), and add the mirror case: repo pin + its subdirectory pin via `Promise.all` → one `started`, one `busy`, one
launch. Also "the mark … becomes the run's record on `started`" (plan:127) conflates the dirName mark with the root-keyed run — say which key the record
lives under.

**[I] plan:225 vs Task 4 Files (plan:205-208) — `formatAgo` is to be changed but `client/src/lib/format.ts` is not in the Modify list, and the
delegation direction is backwards.** "make `formatAgo` delegate to it" has the generic `format.ts` import from the feature module `codegraphText.ts`.
→ Put `ageAt(ms, nowMs)` in `client/src/lib/format.ts` beside `formatAgo` (which becomes `ageAt(ms, Date.now())`), add `Modify: client/src/lib/format.ts`
to Task 4's Files, and have `codegraphText.ts` consume it.

### Minor

- **plan:151 — `setCodegraphClock(now | null)` is introduced inside Step 1's parenthetical but missing from Task 2's Produces list (plan:126-131),** which
  is where the tests import from, and it does not say which timestamps the clock governs. → Add it to Produces: drives cache `atMs` and the TTL comparison,
  `run.startedAtMs`, `lastRun.endedAtMs` and `generatedAt`; `null` restores `Date.now`.
- **plan:81 — the bundle path is imprecise.** `@colbymchenry/codegraph/dist/bin/` holds only `.d.ts`; the JS is in the platform package
  `@colbymchenry/codegraph-darwin-arm64/lib/dist/bin/codegraph.js` (the spec says `dist/bin/codegraph.js`). The line numbers are right. → cite
  `lib/dist/bin/codegraph.js:832` (lock) and `:859` (`recreate`) so the reader finds both halves of the argument.
- **plan:80-82 vs spec:50-51 — a documented divergence.** The spec says a bare `.codegraph/` without the DB does not count and names the CLI's
  `resolveProjectPath` walk (`:276-296`, which checks `isInitialized`, i.e. the DB file); the plan adds the live-`rebuild.pid` case. It is needed for
  spec:80's `building` state and for the plan:157 test, but the plan header says the spec wins on behaviour. → One clause in the plan ("extends spec
  §Source's walk; spec §Levels' `building` state needs a root with no DB") or amend the spec.
- **plan:134 / 140 — a `none` read under a live rebuild carries no root.** `StatusRead` `none` has no `root`, yet the entry must be found "by root" to
  keep the previous `ok` stats and `building` needs `root`. The store resolves the root itself for the pid files, so it can key the entry by that; say
  so explicitly ("the store's own `findGraphRoot` result is the cache key, whatever kind the read came back as").
- **plan:315-316 — "the new kinds" are unnamed.** The closed union at `views.spec.ts:19` needs literal members; the four cases are three layouts plus phone
  Inbox, which in Git's pattern is the same kind at a phone tier, so likely three new members. → name them (e.g. `codegraph-inbox | codegraph-matrix |
  codegraph-inspector`).
- **plan:55-56 —** "keep the extra fields, the parser must ignore them" is good; `walSizeBytes`, `backend`, `journalMode`, `index.pendingRefs` are the
  ones present today. No change needed.

## Convention check

"Behaviour and test cases, not literal code" holds throughout the diff: signatures, expected values and edge cases only.
