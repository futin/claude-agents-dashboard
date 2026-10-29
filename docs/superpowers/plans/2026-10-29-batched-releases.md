# Batched Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour and exact test cases, never literal code** (overrides writing-plans' "code blocks required"). Signatures, values and
> edge cases are binding; bodies are yours. Disagree with the plan when the code says otherwise, and say so in your report. Size budgets are soft.

**Goal:** One release per night (or on demand) that rolls up every releasable PR since the last tag, with notes written at PR time and checked in CI.

**Architecture:** release-kit gains an opt-in `rollup` mode in its engine and reusable workflow, an opt-in What's-new check in `ci-node.yml`, a `None`
opt-out, and a reader that returns per-release `items`. ui-kit renders a multi-item release grouped by scope. The dashboard adopts both once they are tagged.

**Tech Stack:** TypeScript, Node 22 built-ins, `node --test` via tsx, GitHub Actions reusable workflows, React (ui-kit).

**Spec:** `docs/superpowers/specs/2026-10-29-batched-releases-design.md` (in this worktree, branch `docs/batched-releases-spec`).

## Global Constraints

- Callers that set no new input see **no behaviour change**: `ci-node.yml` and `release.yml` defaults stay per-PR / no notes check.
- The only per-PR output change is the `None` drop; every existing tag parses exactly as today.
- A rollup tag's final paragraph is wholly `Key: value` trailers, **no key repeats**, carries `Release-Type` (highest type) and `Release-Breaking: true`
  when any item breaks, and **never** `Release-PR` or `Release-Scope`.
- A rollup's release-level `title`/`notes` stay what `parseTagMessage` returns (subject, pre-trailer body); `items` is parsed in addition.
- PR titles, bodies and notes never reach a `run:` line through `${{ }}`; they travel through `env:` only.
- release-kit ships committed `dist/`; rebuild it (`pnpm build`) in every task that changes `src/`, or `test/dist-drift.test.ts` fails.
- ui-kit: stable `uk-releases-*` class names, colours only through existing `--uk-*` tokens, no new runtime dependency.
- release-kit's version for this work is `v1.4.0` (minor: opt-in inputs only). ui-kit's is `v0.4.0`.
- **Held, never done by an executor:** push, PR, merge, creating or moving tags (`v1.4.0`, `v1`, `v0.4.0`).

## Wire format (decided here, used by A3–A5 and B)

Rollup tag message:

- **Subject:** capitalised scopes in first-appearance order, comma-joined, then ` — N changes` (`1 change` when N = 1). No scoped item → `N changes`.
  Example: items scoped `kaizen, routines, kaizen` → `Kaizen, Routines — 3 changes`.
- **Body:** one group per scope in subject order, unscoped last. A group is a `### <Capitalised scope>` line (unscoped: `### Other`), a blank line, then
  its items oldest first, separated by blank lines. An item is its notes (or its title without the `type(scope)!: ` prefix when it has none), with
  ` (#N)` appended to its last line. A trailing ` (#N)` the author already wrote for the item's **own** PR is stripped first, so it is never doubled and
  never ends the item early.
- **Trailers:** `Release-Type: <highest>`, `Release-Breaking: true` (only when any item breaks), and one `Release-Items:` line: comma-separated entries
  `[~]<pr>:<type>[!][:<scope>]` in body order. `!` marks breaking; a leading `~` marks a title-only item (no notes) — `~` is outside the scope
  alphabet `[a-z0-9-]`, so no scope can be mistaken for the flag. Example: `Release-Items: 336:feat:kaizen, ~337:feat!:kaizen, 320:fix:routines`.
- **Parse:** a message with `Release-Items` is a rollup; with `Release-PR` it is per-PR (one item); with neither and no `Release-Type` it is baseline.
  The rollup reader walks the body: `###` lines are group headings, and an item ends at the first line ending ` (#N)` where N is the next PR in
  `Release-Items` order. Item text before that marker (marker stripped, trimmed) is its `notes`, or its `title` when the entry has `~`.

`ReleaseItem` (release-kit, exported): `{ pr: number; type: ReleaseType; scope?: string; breaking: boolean; title?: string; notes: string; url?: string }`.
`Release` gains `items: ReleaseItem[]` (release-kit: required; ui-kit and the dashboard's `shared/types.ts`: optional, since an older server omits it).

## Review Focus

1. A rollup range holding only `docs`/`chore` PRs (or none) → no tag, no Release, green run. (A4)
2. Re-run over a target whose rollup tag exists but whose Release is missing → Release created, no second tag. (A4)
3. An item whose notes contain their own `### ` heading or a line ending `(#123)` for some other PR → parsed items unchanged. (A3)
4. Today's `parseTagMessage` (v1.3.0 logic) over a rollup message → not baseline, `pr` and `scope` undefined, `notes` = the grouped body. (A3)
5. An API response with no `items` (older server) → drawer renders exactly as today. (B2)

---

## Part A — release-kit (worktree `../release-kit-rollup`, branch `feat/rollup-releases` from `main`)

Run tests with `pnpm test` (foreground, one run per step); typecheck `pnpm typecheck`; dist `pnpm build`.

### Task A1: `None` opt-out

**Files:** Modify `src/conventional.ts`, `src/release.ts` (`releaseCommit`'s `formatTagMessage` call), `src/index.ts`. Test `test/conventional.test.ts`, `test/release.test.ts`.

**Interfaces — Produces:** `isNoneOptOut(notes: string): boolean`; `releaseNotes(body: string | null): string` = `extractWhatsNew(body)`, or `''` when that is an opt-out.

- [ ] **Step 1: failing tests** — `isNoneOptOut` true for `None`, `none`, `None — internal only`, `None - internal`, `  None  `; false for `''`,
  `Nonexistent flag fixed`, `None of the tabs flicker now`, `- None`. `releaseNotes` of a body whose section is `None — refactor` → `''`; of a section with
  real notes → those notes unchanged. `runRelease` per-PR over a PR whose section is `None` → tag message has no notes paragraph (subject, blank, trailers).
- [ ] **Step 2:** run, expect FAIL (not exported).
- [ ] **Step 3:** implement; match case-insensitively `^None(\s+[—-]\s+.+)?$` on the trimmed text. Per-PR writer uses `releaseNotes`.
- [ ] **Step 4:** `pnpm build && pnpm test` → PASS.
- [ ] **Step 5:** commit `feat: a None opt-out in What's new never reaches a tag`.

### Task A2: opt-in notes check

**Files:** Modify `src/conventional.ts`, `src/index.ts`, `scripts/pr-title.mjs`, `.github/workflows/ci-node.yml` (inputs; `pr-title` job), `README.md`.
Test `test/conventional.test.ts`, `test/pr-title.test.mjs`, `test/workflows.test.mjs`.

**Interfaces — Consumes:** `checkTitle`, `extractWhatsNew`, `isNoneOptOut`. **Produces:** `checkNotes(title: string, body: string | null): { ok: boolean; reason?: string }`.

- [ ] **Step 1: failing tests**
  - `checkNotes('feat(x): y', bodyWith(''))` → not ok, reason contains `What's new`. Same for a body whose section is only the template comment, and
    for a `null` body.
  - ok for: notes present; `None`; `None — internal`; `docs: y` with an empty section; `chore!: y`-style invalid title (title check owns that).
  - CLI: with `REQUIRE_NOTES=true`, `PR_TITLE='fix: a'`, `PR_BODY` empty → exit 1, stderr names `What's new`; without `REQUIRE_NOTES` the same input
    exits 0 (today's behaviour). `PR_BODY` unset with `REQUIRE_NOTES=true` counts as empty.
  - workflows: `ci-node.yml` declares exactly **seven** inputs, the new `require-notes` boolean defaulting to `false`; the `pr-title` step's env carries
    `REQUIRE_NOTES` from the input and `PR_BODY` from `github.event.pull_request.body`; no `run:` interpolates `${{ }}` (the existing test keeps passing).
- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3:** implement; the notes check runs inside the existing `pr-title` job and step (no new job, so no ruleset change). README: an
  "Adopting the notes check" paragraph — the input, that callers must trigger CI on `edited`, and the `None` opt-out.
- [ ] **Step 4:** `pnpm build && pnpm test` → PASS.
- [ ] **Step 5:** commit `feat: opt-in check that a releasing PR has What's new notes`.

### Task A3: rollup message format and parse

**Files:** Modify `src/conventional.ts`, `src/index.ts`. Test `test/conventional.test.ts`.

**Interfaces — Produces:** `RollupItem = { pr: number; title: string; type: ReleaseType; scope?: string; breaking: boolean; notes: string }`;
`formatRollupMessage(items: RollupItem[]): string` (items oldest first, length ≥ 1); `ParsedTag` gains `items: ParsedItem[]` with
`ParsedItem = { pr: number; type: ReleaseType; scope?: string; breaking: boolean; title?: string; notes: string }`, defined standalone in
`src/conventional.ts` and exported (A5 derives `ReleaseItem` from it); `parseTagMessage` fills it per the three-case table (baseline `[]`, per-PR one item
carrying `title`, rollup N).

- [ ] **Step 1: failing tests** (fixture: items `336 feat kaizen notes "- Lessons show a verdict badge."`, `337 feat! kaizen no notes title
  "feat(kaizen)!: drop legacy log"`, `320 fix routines notes "Timeouts show how long a run lasted."`, `341 perf no scope notes "Faster scan."`)
  - subject `Kaizen, Routines — 4 changes`; body groups in order `### Kaizen`, `### Routines`, `### Other`; `337` renders as `drop legacy log (#337)`.
  - trailers exactly `Release-Type: feat`, `Release-Breaking: true`, `Release-Items: 336:feat:kaizen, ~337:feat!:kaizen, 320:fix:routines, 341:perf`.
  - a scope literally named `t` (`feat(t): x`, notes present) round-trips with `scope: 't'` and its notes, not as title-only.
  - an item whose notes already end ` (#336)` (its own PR) → body line ends ` (#336)` once, and every later item still parses.
  - one item only → subject `Kaizen — 1 change`; all unscoped → `2 changes`. `Release-Type` ranks `feat` > `fix` > `perf` (a `fix` + `perf` mix →
    `fix`, in either order); breaking never changes the type, only adds `Release-Breaking`.
  - round trip: `parseTagMessage(formatRollupMessage(fx))` → `type: 'feat'`, `breaking: true`, `pr`/`scope` undefined, `title` = subject, `notes` =
    the body, and `items` equal to fx with `title` present only on `337` (`drop legacy log`, prefix stripped) and `notes: ''` there.
  - per-PR tag from today's `formatTagMessage` → one item with its pr, type, scope, breaking, title and notes; every other field exactly as today
    (existing tests unchanged). Baseline message → `items: []`.
  - Review Focus 3: an item whose notes contain `### Sub` and a line `see (#123)` → items unchanged.
  - Review Focus 4: copy today's `parseTagMessage` body into the test as `parseV130` (it is what pinned checkouts run) and assert on the rollup message:
    `type` not `baseline`, `pr` and `scope` undefined, `notes` equals the grouped body.
  - CRLF input parses the same.
- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3:** implement per §Wire format. Write with `--cleanup=verbatim` in mind: `###` lines must survive.
- [ ] **Step 4:** `pnpm build && pnpm test` → PASS.
- [ ] **Step 5:** commit `feat: rollup tag message — one tag, many PRs, old readers still parse it`.

### Task A4: engine rollup mode

**Files:** Modify `src/release.ts`. Test `test/release.test.ts` (reuse its `fake()` and `makeRepo` fixtures).

**Interfaces — Consumes:** `formatRollupMessage`, `releaseNotes`. **Produces:** `runRelease` option `mode?: 'per-pr' | 'rollup'` (default `'per-pr'`);
`Outcome.action` unchanged; in rollup every included commit's outcome is `released` with the shared version.

- [ ] **Step 1: failing tests** (base tag `v0.5.0`)
  - range `fix A`, `docs B`, `feat C` → exactly one new tag `v0.6.0` on the **target** (C's commit), message lists A and C, one Release created;
    outcomes: base `already-released`, A `released 0.6.0`, B `not-releasing`, C `released 0.6.0`.
  - target is a `docs` commit after `fix A` → tag `v0.5.1` sits on the docs commit.
  - Review Focus 1: range of only `docs`/`chore` → no tag, no Release, outcomes all `not-releasing`/`already-released`, no throw.
  - Review Focus 2: run twice; second run creates nothing. Delete the Release in the fake between runs → second run repairs it, still one tag.
  - breaking `fix!` with `feat` while major 0 → `v0.6.0` with `Release-Breaking: true`; at `v1.2.3` → `v2.0.0`.
  - a commit with no PR in the middle → `no-pr` warning, others still rolled up.
  - `mode` omitted → all existing per-PR tests pass unchanged.
- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3:** implement: collect step 1–3 per commit as today; skip tagging per commit; after the loop, if any releasable item, describe the base at
  the target, bump by the largest item, push one tag on the target, create its Release. A target that already carries a version tag is handled by step 1
  for that commit and adds nothing.
- [ ] **Step 4:** `pnpm build && pnpm test` → PASS.
- [ ] **Step 5:** commit `feat: rollup mode cuts one tag for every releasable PR in the range`.

### Task A5: reader items

**Files:** Modify `src/read-releases.ts`, `src/index.ts`. Test `test/read-releases.test.ts`.

**Interfaces — Consumes:** `ParsedItem` (A3). **Produces:** exported `ReleaseItem = ParsedItem & { url?: string }`; `Release.items: ReleaseItem[]`; each
item's `url` is `<base>/pull/<pr>` when the origin is GitHub.

- [ ] **Step 1: failing tests** — a repo with baseline, two per-PR tags and one rollup tag (fixture from A3) → baseline `items: []`; per-PR releases one
  item each, equal to their release-level fields, with `url`; the rollup release `items.length === 4`, each with its own `url`, release-level `pr`/`url`
  absent. Non-GitHub origin → no `url` anywhere. Existing assertions unchanged.
- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `pnpm build && pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** commit `feat: the releases reader returns each release's items`.

### Task A6: CLI and workflow

**Files:** Modify `src/release-cli.ts`, `.github/workflows/release.yml`, `README.md`. Test `test/release-cli.test.ts`, `test/workflows.test.mjs`.

- [ ] **Step 1: failing tests**
  - CLI: `RELEASE_MODE=rollup` passes `mode: 'rollup'` to `runRelease`; unset or `per-pr` → `'per-pr'`; any other value → exits 1 naming
    `RELEASE_MODE`. `DEFAULT_BRANCH` empty still exits 1 with today's message (the fallback lives in the workflow).
  - workflows: `release.yml` declares exactly **four** inputs, the new `mode` string defaulting to `per-pr`; the CLI step env has `RELEASE_MODE` from the
    input and `DEFAULT_BRANCH: ${{ github.event.repository.default_branch || github.ref_name }}`; the header comment no longer says "on push" only.
- [ ] **Step 2:** run, expect FAIL.
- [ ] **Step 3:** implement. README: "Adopting rollup releases" — `mode: rollup`, a `schedule` + `workflow_dispatch` caller example in prose, the
  `concurrency` block kept, the 60-day public-repo schedule caveat, and that `onNewer` is `skip` for scheduled runs.
- [ ] **Step 4:** `pnpm build && pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** commit `feat: release.yml takes mode: rollup and runs from a schedule`.

**Held after Part A:** push `feat/rollup-releases` and open a PR titled `feat: …` (the squash title decides the bump). Merging it **is** the release:
release-kit's `self.yml` cuts `v1.4.0` from that title, and `bump-consumers` then opens `chore(deps): bump release-kit to v1.4.0` PRs, with auto-merge
where a consumer enables it, in every consumer. The dashboard's bump PR stays red until C2, because `test/api-releases.test.ts` pins whole release
objects and `items` is new; close it in favour of C2. Moving `v1` stays a manual step after that.

## Part B — ui-kit (worktree `../ui-kit-rollup`, branch `feat/grouped-releases` from `main`)

### Task B0: mockups

- [ ] Build two variants of a rollup entry at phone width with the real `uk-releases-*` classes, as one private Artifact: (a) scope sub-headings with
  bullets under one version header; (b) flat bullets with a small scope label per item. Recommend (a) (it matches the tag body). Under autopilot, take
  the recommendation and park the choice for the user.

### Task B1: types, guard, fixtures

**Files:** Modify `src/types.ts`, `src/releases/logic.ts` (`isReleasesResponse`), `fixtures/releases.ts`, `package.json` (devDependency
`release-kit` → `#v1.4.0`, **only at the held step**). Test `test/logic.test.ts`, `test/type-contract.test.ts`.

**Interfaces — Produces:** `ReleaseItem` and `Release.items?: ReleaseItem[]` mirroring release-kit's; fixture `rollup` (one rollup release of 3 items
across 2 scopes, one item title-only, one breaking) plus `mixed` gaining a per-PR release with `items` of length 1.

- [ ] **Step 1: failing tests** — `isReleasesResponse` accepts a response with and without `items`, rejects `items` that is not an array or holds an item
  without a numeric `pr`. Type contract: release-kit's `ReleasesResponse` is assignable (verify against a **local** link to `../release-kit-rollup`,
  installed into a scratch copy, never committed).
- [ ] **Step 2–4:** fail, implement, `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** commit `feat: release items in the wire types`.

### Task B2: grouped entry

**Files:** Modify `src/releases/ReleasesPanel.tsx`, `src/styles.css`. Test `test/releases-ui.test.tsx`, `test/styles.test.ts`.

- [ ] **Step 1: failing tests**
  - a release with `items.length > 1` renders the header row as today (version, badge of release `type`, Breaking badge, date), **no** release-level
    title or notes, then one `.uk-releases-group` per scope in item order with a `.uk-releases-scope` label (capitalised; `Other` for unscoped), each
    item a `.uk-releases-item` showing its notes (via `renderNotesHtml` + host `sanitize`) or its title, and its own `.uk-releases-pr` link `PR #N`.
  - `items.length === 1` and Review Focus 5 (no `items`) → DOM identical to today's for the same release (snapshot the existing markup).
  - baseline unchanged. Hostile notes inside an item are sanitised like release notes.
  - styles test: new rules use only `--uk-*` tokens with fallbacks, like their neighbours.
- [ ] **Step 2–4:** fail, implement, `pnpm build && pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 5:** commit `feat: the drawer groups a rolled-up release by scope`.

**Held after Part B:** bump the `release-kit` devDependency to `#v1.4.0` once it exists, push, open a PR titled `feat: …`; merging it cuts `v0.4.0`
through ui-kit's `release.yml` and opens its own bump PRs in consumers.

## Part C — dashboard

### Task C1: notes guide (ships now — its own `docs:` PR: worktree `../claude-agents-dashboard-notes-guide`, branch `docs/whats-new-guide` from `main`)

**Files:** Modify `.github/pull_request_template.md` (`## What's new` comment), `.claude/CLAUDE.md` (§PR rules, one bullet).

- [ ] Rewrite the comment per spec §1: the reader (the maintainer catching up a day or a week later), one bullet per user-visible change, change first in
  plain words, no area prefix, no paths/flags/field or function names, the good and bad examples from the spec without their prefix. **Do not mention
  `None` yet** — today's per-PR writer would print it.
- [ ] CLAUDE.md bullet: `What's new` is written for the maintainer catching up and follows the template's guide; required on `feat`/`fix`/`perf`.
- [ ] Verify: `pnpm test` for `test/` suites that read the template or CLAUDE.md, if any (`grep -rl pull_request_template test/`); otherwise none.
- [ ] Commit `docs: What's new is written for the maintainer catching up`.

### Task C2: adoption (blocked on `release-kit v1.4.0` and `ui-kit v0.4.0` existing on GitHub — held; later branch `feat/batched-releases` from `main`)

**Files:** `package.json` + lockfile (pins), `.github/workflows/release.yml`, `.github/workflows/ci.yml`, `shared/types.ts` (`ReleaseItem`, optional
`Release.items`), `.github/pull_request_template.md` (add the `None` opt-out), `docs/workflows/ci.md` §Releases, `docs/subsystems/releases.md`,
`test/api-releases.test.ts` (its whole-object `deepStrictEqual`s at `:87` and `:113-121` gain `items`: the baseline `items: []`; the `0.2.0` release one
item `{ pr: 216, type: 'feat', scope: 'releases', breaking: false, title: "feat(releases): version chip and What's new panel", notes: '- The rail shows
the version.\n- Every release, newest first.', url: 'https://github.com/futin/claude-agents-dashboard/pull/216' }`).

- [ ] `release.yml`: `on:` = `schedule` `0 4 * * *` + `workflow_dispatch` (keep `sha`); keep `permissions` and `concurrency`; `uses: …@v1.4.0`,
  `kit-ref: v1.4.0`, `mode: rollup`.
- [ ] `ci.yml`: `require-notes: true`, `uses: …@v1.4.0`, `kit-ref: v1.4.0`.
- [ ] Pins `release-kit#v1.4.0`, `ui-kit#v0.4.0`; `pnpm install`; `pnpm typecheck`; `pnpm test` for `test/api-releases.test.ts` and
  `test/server-deps.test.ts`; `pnpm build`.
- [ ] Docs: ci.md cadence, rollup, the notes check, and its "Delete the section from PRs with nothing user-visible" sentence replaced by the `None`
  opt-out; releases.md items and the grouped drawer.
- [ ] Commit `feat(releases): nightly rollup releases with checked What's new notes`.
