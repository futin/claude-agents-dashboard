# Plan re-check 1 — lookout-widgets producer (changed lines only)

Scope: the hunks in `scratchpad/plan-r1.diff` against `task.md` (619 lines). Spec: `docs/superpowers/specs/2026-10-08-lookout-widgets-producer-design.md`.
Contract: `../lookout/shared/contract/`. Every claim below was checked against code or by running Node; nothing was taken from the document.

## Verdict: APPROVE WITH FIXES

## Critical

**[C] task.md:138–139 — the `test` script fails on Node 20 and double-counts on Node 22 until every pattern has a match.**
`node --import tsx --test test/*.test.ts test/*/*.test.ts test/*.test.cjs` relies on the shell to expand the globs. `npm run` uses `sh`, which passes an
unmatched pattern through literally. Reproduced in a scratch dir holding only `test/contract/a.test.cjs` (one test):

- Node 20.19.5 (`~/.nvm/versions/node/v20.19.5`): `sh -c 'node --test test/*.test.cjs test/*/*.test.cjs test/*.test.ts'` → `Could not find '.../test/*.test.ts'`,
  no tests run. The line's own claim is right (a quoted `'test/**/*.test.cjs'` also gives `Could not find`), which is exactly why unmatched patterns are fatal there.
- Node 22.23.1 (the machine's default): the same command → `# tests 2` for one test. Node 22 treats the literal as a glob and its `*` matches across `/`
  (`node --test 'test/*.test.cjs'` alone also runs `test/contract/a.test.cjs`), so the matched files run twice.

In Task 1 neither `test/*.test.ts` (first file arrives in Task 5) nor `test/*.test.cjs` (Task 6) matches, so Step 5 (`npm test` → "all green") fails on the
declared engine floor and, on this machine, `# tests N` reports double the real count — which breaks Step 4's "ported case count equals the jest case count"
check at task.md:149.
→ Fix: either list only directories that exist at each step (Task 1: `test/contract/*.test.ts`; widen the script in Tasks 5 and 6 as files land), or use one
quoted pattern `'test/**/*.test.{ts,cjs}'` and state that running the package's tests needs Node ≥ 21 (consumers keep `engines >=20`; they load `dist/` only).
Either way, drop the sentence that frames unquoting as the safe choice.

## Important

**[I] task.md:348 — `<validator reason>` is a placeholder where the plan's own rule (task.md:15–17) requires the exact value.**
For an absolute `open`, `validateCatalog` reaches `optPath(o, 'open', '')` → `path()` with `where = ''` and fails with `open must be a relative path`
(`../lookout/shared/contract/validate.ts:56–64,120`). Combined with the line-331 format the expected array is exactly `['bad: dropped: open must be a relative path']`.
→ Write that literal.

## Verified (no finding)

| Plan line | Claim | Evidence |
|---|---|---|
| 43 | producer imports only `../contract/*` | spec line 31 |
| 116, 390 | `LICENSE` in the pack even with `"files": ["dist"]` | npm always includes package.json, README, LICENSE |
| 146 | `it.each` used in both ported files | `paths.test.ts:4,8`; `validate.test.ts:76,146,170,211,351` |
| 149 | count from `Tests: N passed` / `# tests N` | correct summaries; counting rule is right once the Critical above is fixed |
| 176, 187 | catalog key is `data` | `types.ts:30` |
| 189 | param key is `type: 'choice'` | `types.ts:17`, `validate.ts:100` |
| 210, 213–214, 331 | `HubHandler.dropped` is a plan addition, not in spec §3.3; consistent between Task 3 and Task 5 | spec lines 63–70; no contradiction |
| 356–357 | every re-exported name is produced earlier | `AppInfo` :159, `ActionReply` :162, handler types :210–212, `Dropped` :124, `examples` :126 |
| 429 | `findRepoRoot` in `test/docs-links.test.ts`, specifier `./docs-links.test.js` | `test/outbound.test.ts:14`, `test/docs-links.test.ts:19` |
| 447 | `serveSessions` :127, scan call :146–157, comments from :134 | `server/api.ts:127,134,146,157` |
| 448 | `failed += await runX()` registration shape | `test/run-all.ts:145,158`; `import { run as runX } from './x.test.js'` :4–14 |
| 486 | no icon is not a §2 requirement | spec line 23 ("the app passes its path as `app.icon`") |
| 529 | `const u = new URL(...)` :176, first `u.pathname ===` :177 | `server/index.ts:176–177` |
| 584 | `deps` stage on `node:20-alpine`, no `git` | `Dockerfile:2–6` (`corepack enable`, `pnpm install --frozen-lockfile`, no `apk add`) |

## Minor

- task.md:138: "Node 20's `--test` takes a quoted glob literally" is true (verified: `Could not find '.../test/**/*.test.cjs'` on 20.19.5) but the
  sentence reads as a justification for unquoting; after the Critical fix it should describe whichever choice remains.
- task.md:146: "the row formatted into the name" — jest's `%j` is the formatting the originals use (`paths.test.ts:4`, `validate.test.ts:170,211,351`);
  naming `JSON.stringify` keeps the ported names identical, which Step 4's "same names" asks for.
