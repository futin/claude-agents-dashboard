# Release pipeline Phase C part 2 — `/api/releases`, version chip, What's new drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases, never literal code** (user's global rule, overriding writing-plans' "code blocks
> required"). Bodies are the implementer's. Disagree with the plan where the code says otherwise, and say so in the commit. Length budgets are soft.

**Goal:** the dashboard shows the version it is running as a chip at the foot of the rail, and a drawer listing every release with its notes.

**Architecture:** `GET /api/releases` wraps release-kit's `readReleases(repoRoot())` in a memo keyed on HEAD plus the tag-ref mtimes. The client fetches it on
page load and again each time the drawer opens. The chip lives in `SideRail` (desktop rail foot, last row of the phone menu); the drawer is rendered by
`AppShell`, outside `.nav`, because `.nav.hid` sets a `transform` and a transformed ancestor would capture a `position:fixed` drawer.

**Tech Stack:** Node + tsx server (built-ins plus two pinned git-tag packages), Vite + React client, node-assert tests over tmpdir git fixtures.

**Spec:** `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §App — read path and UI, §Testing (Dashboard), §Rollout step 5.
Mockups: https://claude.ai/artifact/551GSn59vUB7z61B6kmKA5. The user picked **Variant A** (rail chip → side drawer) and **fetch on load + on drawer open**.

## Global Constraints

- Release-kit pinned as `github:futin/release-kit#v1.1.0` (`v1.1.0` → commit 18af40f). Never `#v1`: the floating major moves by hand.
- `shared/types.ts` first, then server, then client (`.claude/CLAUDE.md` "Adding an API field"). The client never imports `release-kit`.
- `release-kit` launches `git` only; no new outbound kind, `test/outbound.test.ts` unchanged and still green.
- `repoRoot()` from `server/lib/usage-history.ts`, never `process.cwd()`.
- No tags, not a checkout, git missing → `200 { current: null, releases: [] }`, never an error status.
- Chip text `v0.5.0`, or `v0.5.0+3` when `ahead > 0`. Hidden when `current` is `null`.
- Badges: `feat` Feature, `fix` Fix, `perf` Performance, plus a separate Breaking badge when `breaking`. Baseline renders as the divider "Versioning starts
  here".
- localStorage key `dashboard.releases.lastSeen`, every read and write in try/catch; a value that is not `X.Y.Z` counts as missing.
- Theme tokens only below the token block in `styles.css`; no color or shadow literal. New classes are the mockup's `rel-*` names.
- No `title` attribute for data (pointer-tooltip rule); this feature needs no tooltip at all.
- Wrap new prose at 160 columns.

## Review Focus

1. **A linked worktree.** `.git` is a file and tags live in the common dir. A tag created from the main checkout must show up in a server rooted in a
   worktree → Task 2 case 7.
2. **A tag lands with HEAD unchanged** (a `git fetch` brings a tag, or one is cut by hand). The memo must notice through the `refs/tags` / `packed-refs` mtime →
   Task 2 case 6, plus case 8: a tag deleted after packing disappears. The `packed-refs` mtime in the key is belt-and-braces — a packed delete still takes
   `refs/tags/<name>.lock`, so `refs/tags` moves too — and is not test-pinned on its own.
3. **localStorage throws** (private window, blocked storage). The chip still renders, with no dot, and opening the drawer does not throw → Task 3 cases.
4. **A release with empty notes.** No empty `.md` box and no stray gap; title plus PR link only → Task 5's visual fixture (`0.2.1`, empty notes) and Task 4
   step 3's browser check.
5. **The drawer on a phone.** Full screen, ✕ at 40px, back gesture closes it via `useBackClose`, and the menu closes when the chip is tapped → Task 4 manual
   check at 375px.

---

### Task 1: Dependency, contract types, the deps pin

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add github:futin/release-kit#v1.1.0`)
- Modify: `shared/types.ts` — new `Release`, `ReleaseType`, `ReleasesResponse`
- Modify: `test/server-deps.test.ts`
- Modify: `.claude/CLAUDE.md` §Code rules "Keep new deps out of `server/`"

**Interfaces — Produces:**
- `type ReleaseType = 'feat' | 'fix' | 'perf' | 'baseline'`
- `interface Release { version: string; date: string; title: string; type: ReleaseType; scope?: string; pr?: number; breaking: boolean; notes: string; url?: string }`
- `interface ReleasesResponse { current: { version: string; ahead: number } | null; releases: Release[] }`
- Field docs per spec §API (version without `v`, ISO date of tag creation, title without `(#N)`, releases newest first).

- [ ] **Step 1:** update `test/server-deps.test.ts` first. `ALLOWED` becomes `['lookout-widgets', 'release-kit']`; the single `PINNED_SPEC` becomes a map
  `{ 'lookout-widgets': 'github:futin/lookout-widgets#v0.1.0', 'release-kit': 'github:futin/release-kit#v1.1.0' }` with one pin case per entry. The header
  comment and the two named cases ("imports no npm package but …", "does import …") name both packages. The equality case stays equality.
- [ ] **Step 2:** `pnpm exec tsx -e "import('./test/server-deps.test.ts').then(m => process.exit(m.run()))"` → FAIL on the release-kit pin and on "does import"
  (nothing under `server/` imports it yet). Record the output.
- [ ] **Step 3:** `pnpm add github:futin/release-kit#v1.1.0`; confirm `package.json` reads exactly that spec and the lock resolves to `18af40f`.
- [ ] **Step 4:** add the three types to `shared/types.ts` beside the other response types.
- [ ] **Step 5:** `.claude/CLAUDE.md`: the "One npm package is allowed" paragraph becomes two packages by name. `release-kit` justification, one sentence: the
  shared tag-message reader the release workflow writes against (spec D7), zero runtime deps, Node built-ins only, launches `git` like `lib/git-fetch.ts`, so
  no new outbound kind. Pinned to a git tag, pinned in `test/server-deps.test.ts`.
- [ ] **Step 6:** the server-deps run still fails only on "does import" (Task 2 closes it). Do not commit a red suite: commit Task 1 and Task 2 together, or
  hold Task 1's commit until Task 2 is green.

### Task 2: `server/lib/releases.ts` and `GET /api/releases`

**Files:**
- Create: `server/lib/releases.ts`
- Modify: `server/api.ts` (handler), `server/index.ts` (route, beside `/api/account`, and the route list in its header comment)
- Create: `test/api-releases.test.ts`; register in `test/run-all.ts`
- Modify: `docs/overview.md` §HTTP surface (one row) and §Repo layout (a `lib/releases.ts` line)

**Interfaces:**
- Consumes: `readReleases(repoRoot: string): Promise<ReleasesResponse>` from `release-kit`; `repoRoot()` from `./usage-history.js`.
- Produces:
  - `releasesPayload(): Promise<ReleasesResponse>` — the memoised read.
  - `overrideReleasesRoot(dir: string | null): void` — test seam; `null` restores `repoRoot()`. Also clears the memo.
  - `releasesReadCount(): number` — how many times `readReleases` actually ran since the last override; tests use it to prove the memo.
  - `serveReleases(res: ServerResponse): Promise<void>` in `server/api.ts` → `sendJson(res, 200, await releasesPayload())`.

Behaviour of the memo key, `releasesKey(root): Promise<string | null>`: `git rev-parse HEAD --git-common-dir` in `root` (one call, two lines), then the
`mtimeMs` of `<common>/packed-refs` and `<common>/refs/tags` (`0` when missing), joined into one string. The common dir may be relative to `root`; resolve it.
Any git failure → `null`, and `null` is never cached: the read runs and its (empty) result is returned. A key equal to the memo's → the memo's promise,
so two concurrent requests share one read. The type returned by `readReleases` must be assignable to the shared `ReleasesResponse` without a cast — that
assignment is the compile-time check that the two contracts agree.

Fixtures: `GitFixture` from `test/git-fixture.ts`. Tags are made with `fx.git(dir, ['tag', '-a', name, sha, '-F', file, '--cleanup=verbatim'])` from a
message file, the way the release workflow writes them. Every case calls `overrideReleasesRoot(fixtureDir)` and restores `null` in `finally`. Requests go
through `withServer` from `test/api-harness.ts`.

- [ ] **Step 1: write `test/api-releases.test.ts`** with these cases, each asserting status 200 and the exact body:
  1. **not a checkout** — root is an empty tmpdir → `{ current: null, releases: [] }`.
  2. **no tags** — one commit, no tags → same empty shape.
  3. **baseline only** — `v0.1.0` with message `Baseline — versioning starts here` on HEAD → `current` `{ version: '0.1.0', ahead: 0 }`; one release,
     `type: 'baseline'`, `title: 'Baseline — versioning starts here'`, `breaking: false`, `notes: ''`, no `pr`, no `url`.
  4. **populated** — origin set to `https://github.com/futin/claude-agents-dashboard.git`; baseline, one commit, `v0.2.0` with the message
     `feat(releases): version chip and What's new panel (#216)` / blank / `- The rail shows the version.` / `- Every release, newest first.` / blank /
     `Release-Type: feat` / `Release-Scope: releases` / `Release-PR: 216` → `releases[0]` is `{ version: '0.2.0', title: 'feat(releases): version chip and
     What's new panel', type: 'feat', scope: 'releases', pr: 216, breaking: false, notes: '- The rail shows the version.\n- Every release, newest first.',
     url: 'https://github.com/futin/claude-agents-dashboard/pull/216' }` plus a `date` that parses; `releases[1].type === 'baseline'`; `current.ahead === 0`.
  5. **ahead moves** — case 3's repo; read; commit once; read again → `current.ahead` is `0` then `1`, and `releasesReadCount()` is 2.
  6. **tag with HEAD unchanged** — case 3's repo plus one commit; read (1 release); tag `v0.1.1` (`Release-Type: fix`) on HEAD; read → 2 releases,
     `current` `{ version: '0.1.1', ahead: 0 }`.
  7. **linked worktree** — main repo with baseline; `git worktree add` a second checkout; root = the worktree; read; tag `v0.2.0` from the **main** checkout;
     read → the worktree's response lists `0.2.0`.
  8. **packed refs** — case 6's state; read; `git pack-refs --all`; read → both releases still listed; `git tag -d v0.1.1`; read → `v0.1.1` is gone and
     `current.version` is `0.1.0` again.
  9. **memo holds** — two reads with nothing changed → bodies deep-equal and `releasesReadCount()` is 1.
  10. **concurrent** — two requests fired together on a fresh memo → both answer the same body and `releasesReadCount()` is 1.
  11. **a lightweight `v9.9.9` and a lightweight `v1`** beside the annotated baseline → `current.version === '0.1.0'`, one release.
- [ ] **Step 2:** run `pnpm exec tsx -e "import('./test/api-releases.test.ts').then(m => process.exit(m.run()))"` (adjust to the file's actual export shape) →
  FAIL, module missing.
- [ ] **Step 3:** implement `server/lib/releases.ts` per the Interfaces block, the handler and the route. `GET` only, like `/api/account`'s neighbours.
- [ ] **Step 4:** run the new suite, `test/server-deps.test.ts` and `test/outbound.test.ts` → all green. Paste the `✓` lines into the commit body.
- [ ] **Step 5:** overview row: `| GET /api/releases | the dashboard's own releases from local annotated vX.Y.Z tags (release-kit's readReleases), memoised on HEAD + tag refs |`.
- [ ] **Step 6:** `pnpm typecheck` green. Commit Tasks 1+2: `feat(releases): serve the dashboard's release history at /api/releases`.

### Task 3: client domain logic, `client/src/lib/releases.ts`

**Files:**
- Create: `client/src/lib/releases.ts`
- Create: `test/releases-client.test.ts`; register in `test/run-all.ts`

**Interfaces — Produces** (all pure; storage behind a port so tests need no DOM):
- `parseVersion(v: string): [number, number, number] | null` — `X.Y.Z` digits only, else `null`.
- `cmpVersion(a: string, b: string): number` — numeric per part; callers pass valid versions.
- `chipLabel(current: ReleasesResponse['current']): string | null`
- `interface SeenStore { get(): string | null; set(v: string): void }` and `localSeenStore(): SeenStore` — key `dashboard.releases.lastSeen`; both methods
  swallow exceptions (`get` → `null`).
- `unseen(newest: string | null, store: SeenStore): boolean` — the dot decision, with the first-visit seed as a side effect on the store.
- `markSeen(newest: string | null, store: SeenStore): void` — called when the drawer opens.
- `newestVersion(releases: Release[]): string | null` — `releases[0]?.version ?? null`; a baseline counts, so a baseline-only list's newest is `0.1.0`.
- `badges(r: Release): { kind: 'feat' | 'fix' | 'perf' | 'breaking'; label: string }[]` — `[]` for baseline.
- `displayTitle(title: string): string` — strips a leading Conventional Commits prefix (`type(scope)!: `), since the badge already says the type; a title
  with no prefix is returned unchanged. Spec-silent; the user chose stripping on 2026-10-16.
- `formatReleaseDate(iso: string): string` — local date, `en-GB` day, short month, year: `16 Oct 2026`. Unparseable → the input unchanged.

- [ ] **Step 1: write the test** with an in-memory `SeenStore` and a throwing one (both methods throw):
  - `parseVersion`: `'0.10.0'` → `[0,10,0]`; `'v0.1.0'`, `'0.1'`, `'0.1.0-rc1'`, `''`, `'garbage'` → `null`.
  - `cmpVersion('0.10.0', '0.9.0') > 0`; `cmpVersion('1.0.0', '0.99.99') > 0`; `cmpVersion('0.2.0', '0.2.0') === 0`.
  - `chipLabel(null)` → `null`; `{0.5.0, 0}` → `'v0.5.0'`; `{0.5.0, 3}` → `'v0.5.0+3'`.
  - `unseen`: newest `null` → `false`, store untouched. Empty store → `false` and the store now holds newest (first-visit seed). Store `'garbage'` → `false`,
    reseeded to newest. Store `'0.2.0'`, newest `'0.3.0'` → `true`, store still `'0.2.0'`. Store `'0.10.0'`, newest `'0.9.0'` → `false`. Throwing store →
    `false`, no throw.
  - `markSeen('0.3.0', store)` → store holds `'0.3.0'`; `markSeen(null, store)` → untouched; throwing store → no throw.
  - the real adapter: with `globalThis.localStorage` stubbed to an object whose `getItem`/`setItem` throw, `localSeenStore().get()` is `null` and `.set('0.1.0')`
    does not throw; with `globalThis.localStorage` `undefined`, the same. Restore the original global in `finally`.
  - `badges`: feat → `[Feature]`; fix → `[Fix]`; perf → `[Performance]`; feat + breaking → `[Feature, Breaking]` in that order; baseline → `[]`.
  - `displayTitle`: `'feat(releases): version chip'` → `'version chip'`; `'fix!: drop x'` → `'drop x'`; `'Baseline — versioning starts here'` unchanged;
    `'feat: '` → `''`.
  - `formatReleaseDate('2026-10-16T12:00:00Z')` → `'16 Oct 2026'` (midday UTC so no timezone flips the day); `'nope'` → `'nope'`.
- [ ] **Step 2:** run it → FAIL, module missing.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run → green.
- [ ] **Step 5:** commit `feat(releases): client release logic — chip label, unseen dot, badges`.

### Task 4: hook, chip, drawer, CSS

**Files:**
- Create: `client/src/hooks/useReleases.ts`
- Create: `client/src/components/ReleasesDrawer.tsx`
- Modify: `client/src/components/SideRail.tsx` (chip after `.foot`), `client/src/App.tsx` (own the hook + open state, render the drawer)
- Modify: `client/src/styles.css` (new `rel-*` block)

**Interfaces:**
- Consumes: Task 3's functions; `Markdown` from `components/Markdown.tsx`; `useBackClose` from `hooks/useBackClose.ts` (read its signature first).
- Produces:
  - `useReleases(): { data: ReleasesResponse | null; refresh: () => void }` — fetches on mount and on `refresh()`; a failed fetch keeps the last good data
    (same rule as `useAccount`). No interval.
  - `SideRail` gains `version?: { label: string; dot: boolean; onOpen: () => void } | null`. The chip is a `<button className="rel-chip">` rendered after the
    live line on every section (not gated on `live`), wrapped in the rail's `pick()` so the phone menu closes behind it. `aria-label` reads e.g.
    `Running v0.3.0+2 — open What's new` plus `, new releases` when the dot shows; `aria-haspopup="dialog"`.
  - `ReleasesDrawer({ data, onClose })` — `.rel-back` scrim (click closes) containing `<aside className="rel-drawer" role="dialog" aria-label="What's new">`;
    head: "What's new", `running v…` sub, ✕ (`.chat-x`). Escape closes; `useBackClose` arms the phone back gesture. Entries newest first: `.rel-entry` with
    `.rel-row` (`.rel-ver`, one `.rel-badge.<kind>` per `badges()`, spacer, `.rel-date`), `.rel-title` from `displayTitle`, `<Markdown>` only when `notes`
    is non-empty, and `<a className="rel-pr">PR #N</a>` only when `url` is present (`target="_blank" rel="noreferrer noopener"`). Baseline entry →
    `.rel-base` divider "Versioning starts here · v0.1.0".
  - `AppShell`: `dot` computed with `unseen(newestVersion(...), localSeenStore())` once per data change, in an effect (it seeds the store), never inline in JSX; opening calls `markSeen`, clears the dot and
    `refresh()`es. `version` prop is `null` while `chipLabel` is `null`.

CSS: port the mockup's `rel-*` rules (the artifact link above), translated to the app's tokens. Deliberate deltas from the mockup, not to be "fixed" back:
drawer 400px (mock 360px), Fix text `--amber-ink` (mock `--amber`). The divider copy "Versioning starts here · v0.1.0" extends the spec's "Versioning
starts here" with the version, as the chosen mockup draws it. Colors come from existing
tokens: Feature `--green` on `--green-tint`, Fix `--amber-ink` on `--amber-tint`, Performance `--cyan` on a `color-mix` tint of `--cyan` (define it in the
rule from the token, not as a new literal), Breaking `--red` on a `color-mix` of `--red`, dot `--cyan`. Drawer geometry: full screen below `md` (768px),
like `.chat`; a 400px right-hand panel from `md` up. Check the daylight theme by eye and with `test/daylight-contrast.test.ts` if
it covers new pairs.

- [ ] **Step 1:** implement the hook, the drawer, the chip and the CSS.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm build` → green.
- [ ] **Step 3: browser check** (worktree dev setup memory: servers on 4273/5273 via Bash, record pids, kill by pid). Verify against the real checkout's tags
  (`v0.1.0` only today, so chip `v0.1.0+N`): chip present on Sessions and on Usage; drawer opens, baseline divider shows, Escape and scrim close it; at
  375px the chip is the menu's last row, tapping it closes the menu and opens a full-screen drawer; the empty-notes Review Focus item via a fixture entry in
  the visual mock (Task 5) or a temporary local tag in a scratch clone, never in the real repo. Theme switch to daylight → badges legible. Screenshots for the PR.
- [ ] **Step 4:** commit `feat(releases): version chip and What's new drawer`.

### Task 5: visual fixture, docs

**Files:**
- Create: `test/visual/fixtures/releases.ts`; register `'/api/releases'` in `test/visual/fixtures/index.ts`
- Modify: `test/visual/views.spec.ts` (or whichever spec owns shell-level states) — one case with the drawer open at the phone and a desktop tier
- Create: `docs/subsystems/releases.md`; add its line to `docs/overview.md` §Map; one pointer sentence in `docs/workflows/ci.md` §Releases ("the dashboard
  reads these tags back at `GET /api/releases`, `docs/subsystems/releases.md`")

- [ ] **Step 1:** fixture: `current { version: '0.3.0', ahead: 2 }`; releases `0.3.0` feat with notes, `0.2.1` fix with empty notes and a PR, `0.2.0` feat +
  breaking, `0.1.0` baseline. Every `/api` GET the client issues must be mapped or mock-api fails the run — confirm the chip's fetch is.
- [ ] **Step 2:** `pnpm test:visual --update-snapshots` for the new case only if the harness allows filtering; otherwise run the full visual suite and
  confirm only the new snapshot plus any rail-foot snapshots changed. Every changed existing baseline is named in the PR (the chip appears in every view's
  rail). macOS only, on demand — say so in the PR.
- [ ] **Step 3:** `docs/subsystems/releases.md`: what the endpoint returns, the memo key and why (worktree common dir, HEAD unchanged on tag fetch), the
  empty-shape rule, the chip/dot/drawer rules, where the drawer is rendered and why (`.nav.hid` transform), the localStorage key, and what is not here
  (no fetch, no poll, no GitHub API). End with the repo's docs-sync stamp block like the sibling subsystem docs.
- [ ] **Step 4:** `test/docs-links.test.ts` green (new links resolve).
- [ ] **Step 5:** commit `docs(releases): subsystem doc, overview map, visual fixture`.

### Task 6: PR

- [ ] **Step 1:** whole-branch review by one fresh reviewer (report to a file; verdict + Critical/Important only, per `.claude/CLAUDE.md` §Subagent rules).
- [ ] **Step 2:** locally run only the suites the branch touched (CI is the full-suite gate). Push.
- [ ] **Step 3:** PR into `main`, title `feat(releases): version chip and What's new drawer`, body per `.github/pull_request_template.md` with a
  `## What's new` section (one to three user-facing lines — this becomes `v0.2.0`'s notes), *Why this shape*, *What changed* by boundary, *Verification*
  with command output and an explicit not-verified line (visual suite is macOS-only and on demand; the release workflow cutting `v0.2.0` happens only after
  merge).
- [ ] **Step 4:** CI green (`ci / checks`, `ci / pr-title`; `ci / skills` skips). After merge, the release run should tag `v0.2.0`; that is out of this
  plan's hands and gets checked with `git ls-remote --tags origin` if the session is still open.
