# Review 1 — Batched releases with readable notes

Document: `docs/superpowers/specs/2026-10-29-batched-releases-design.md` (156 lines, reviewed 2026-10-29).
Code read: release-kit at `926e12d` (tags to `v1.3.0`): `src/conventional.ts`, `src/release.ts`, `src/release-cli.ts`, `src/git.ts`,
`src/read-releases.ts`, `src/releases-reader.ts`, `.github/workflows/{ci-node,release,bump-consumers}.yml`, `scripts/pr-title.mjs`, `README.md`;
ui-kit at `v0.3.1`: `src/releases/{ReleasesPanel,ReleasesDrawer,logic}.tsx`, `src/types.ts`; dashboard: `.github/workflows/{ci,release}.yml`,
`.github/pull_request_template.md`, `shared/types.ts:789-813`, `server/lib/releases.ts`, `server/lib/git-fetch.ts:29`, `docs/workflows/ci.md:54-90`,
`docs/subsystems/releases.md`, the pipeline spec's D2–D7 table, and the tag history (`git for-each-ref`). GitHub docs (events-that-trigger-workflows)
fetched for the `schedule` row.

## Verdict: APPROVE WITH FIXES

Nothing in the document ships wrong behaviour against the code as it stands, but four points leave an implementer guessing or state a fact the code
does not support. All four are cheap to fix in the text.

## Facts verified true

| Doc line | Claim | Evidence |
|---|---|---|
| 3–4 | D2/D3/D4/D5/D7 as described | `docs/superpowers/specs/2026-10-15-release-pipeline-design.md:30-35` |
| 8 | 50 tags, 2026-10-16 → 2026-10-28 | `git for-each-ref` — 50 tags, first `v0.1.0` 10-16, last `v0.28.0` 10-28 |
| 12 | 24 of the last 48 tags have no notes | recomputed: 24 of the last 48 (25 of all 50) |
| 13 | `v0.27.0` explains `--compare <project> <since> <field.path>` | `git tag -l --format='%(contents)' v0.27.0` |
| 13–14 | template hint is one comment line, no example | `.github/pull_request_template.md:20` |
| 35, 50 | four other callers: backlog-manager, guide-manager, lookout, ui-kit | each repo's `.github/workflows/release.yml` `uses: futin/release-kit/.github/workflows/release.yml@v1` |
| 65 | same title regex as `pr-title` | `scripts/pr-title.mjs:7` imports `checkTitle`; `src/conventional.ts:4` `RELEASING` |
| 68 | `ci.yml` triggers on `edited` | `.github/workflows/ci.yml:7` |
| 69 | `ci-node.yml` exists, inputs opt-in-able | `release-kit/.github/workflows/ci-node.yml:10-33` |
| 70 | `pr-title` is a job in `ci-node.yml`, PR-only | `ci-node.yml:79-97` |
| 76–77 | range = first-parent since newest reachable `vX.Y.Z`; `no PR for <sha>` skip | `src/release.ts:142-153`, `:99` |
| 81 | bump table breaking > feat > fix/perf | `src/conventional.ts:49-55` |
| 89 | `--cleanup=verbatim` | `src/release.ts:74` |
| 93–94 | `parseTagMessage` → `baseline` unless final paragraph is all trailers, no repeated key (Map size vs line count), valid `Release-Type` | `src/conventional.ts:86-102` |
| 92 | dashboard fetches pinned repos itself | `server/lib/git-fetch.ts:29-30` (`fetch origin`, tags arrive by auto-follow) |
| 97–98 | idempotence; `a newer release exists: <tag>` on dispatch, skip otherwise | `src/release.ts:87-94`, `:135-140`; `src/release-cli.ts:107` |
| 103 | `createReleasesReader` | `src/releases-reader.ts:35`; used at `server/lib/releases.ts:3,20` |
| 105 | `shared/types.ts` `ReleasesResponse`; add-an-API-field rule | `shared/types.ts:817`; `.claude/CLAUDE.md` §Code rules |
| 120 | dashboard `release.yml` has `push` + `workflow_dispatch` with `sha` | `.github/workflows/release.yml:7-15` |
| 124 | both docs exist with those sections | `docs/workflows/ci.md:54`, `docs/subsystems/releases.md:51` |
| 133 | `kit-ref` input on both reusable workflows; README describes manual `git tag -f v1` + `git push -f origin v1` | `ci-node.yml:30`, `release.yml:16`, `README.md:214-224` |
| 149 | repo is public; public repos lose schedules after 60 idle days | `gh repo view --json visibility` → PUBLIC; GitHub docs, schedule section |
| 151 | chip shows `vX.Y.Z+N` | `ui-kit/src/releases/logic.ts:24` (`chipLabel`, doc `v0.3.0+2`) |
| 12 (drawer shows title alone when no notes) | `ui-kit/src/releases/ReleasesPanel.tsx:37-43` |

## Important

**[I] spec:120 — a `schedule` trigger does not supply `DEFAULT_BRANCH` the way the reusable workflow reads it.** `release-kit/.github/workflows/release.yml:54`
sets `DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}` and `src/release-cli.ts:104-105` exits 1 with `DEFAULT_BRANCH is not set` when it is
empty. GitHub's events reference lists the `schedule` row's webhook payload as "Not applicable" (`GITHUB_SHA` = last commit on default branch, `GITHUB_REF`
= default branch), so `github.event.repository` is not guaranteed on a scheduled run, and nothing in the siblings has ever run `release.yml` from a
schedule to prove it works. If the field is absent, every daily run fails and the feature's goal 1 ships broken. → In §2 or §5, state that the rollup
mode's workflow derives the trunk from `github.event.repository.default_branch || github.ref_name` (on `schedule`, `ref_name` is the default branch by
the same table), and that the first scheduled run is verified by dumping `toJSON(github.event)`. Also note `onNewer` is `skip` on a scheduled run
(`release-cli.ts:107` rejects only on `workflow_dispatch`), which matches line 98 but is worth saying since the schedule is a new event name.

**[I] spec:75 contradicts spec:61–62 — "the default stays per-PR, byte-for-byte" vs "the release writer drops a `None` opt-out in both modes".** Dropping
`None` changes the per-PR writer's output for any PR in any caller whose `What's new` section is the literal `None` (today `extractWhatsNew`
`src/conventional.ts:61-69` would return `None` and `formatTagMessage` `:80` would write it as notes). An implementer cannot satisfy both sentences.
→ Reword line 75: "the default stays per-PR; its only change is the `None` drop in §1, which affects no existing tag and no PR that does not use the
marker".

**[I] spec:103–105, 111–115 — the wire type has three copies, the spec names one.** Besides release-kit's `Release`/`ReleasesResponse`
(`src/read-releases.ts:8-20`) and the dashboard's own `shared/types.ts:794-813`, ui-kit keeps a third copy in `ui-kit/src/types.ts:1-26`, owned there "so
ui-kit has no runtime dependency on release-kit" and pinned by `ui-kit/test/type-contract.test.ts` (assignability of release-kit's type into ui-kit's).
The dashboard's client renders `ui-kit`'s `ReleasesResponse`, not `shared/types.ts`'s (`client/src/components/ReleasesDrawer.tsx:1`). §4 says the drawer
renders items but never says ui-kit's type copy and contract test gain `items`, so an implementer doing §3 then §4 would discover it at typecheck time.
→ In §4 add: "ui-kit's `src/types.ts` copy gains the item shape and `test/type-contract.test.ts` keeps proving release-kit's type assignable to it."

**[I] spec:91–96 — the old-reader constraint leaves `Release-PR` open, and that is the one key an old reader would misread.** `parseTagMessage`
`src/conventional.ts:103,113` sets `pr` from `Release-PR`, `read-releases.ts:64-67` then builds `url`, and `ReleasesPanel.tsx:44-48` renders `PR #N`
for the whole entry. If the builder writes any item's number under `Release-PR` in a rollup's trailer block (it "never repeats", so it passes the
constraint as written), a `release-kit#v1.3.0` checkout links the entire rolled-up version to one PR, which is exactly the misread line 91 forbids.
The same key is the natural discriminator between a per-PR tag (one item, `Release-PR` present) and a rollup tag for the new reader, and the spec does
not say what that discriminator is. → State: a rollup's final paragraph carries `Release-Type` (and `Release-Breaking` when any item breaks) and never
`Release-PR` or `Release-Scope`; the new reader reads a tag with `Release-PR` as a one-item release and anything else with `Release-Type` as a rollup.

## Minor

- spec:8 — 50 tags over 13 days is 3.8/day → ≈115/month, not "about 110". Harmless; say "roughly 110–120" or recompute.
- spec:12 — "last 48" is an odd window when the repo has exactly 50 tags; all 50 gives 25 with no notes. Either number is true; say why 48 (or use 50).
- spec:65 — "up to the next `^## `" omits the second stop `extractWhatsNew` has: a line starting `🤖 Generated with` (`src/conventional.ts:67`). Since the
  check reuses the function ("exactly as the release workflow extracts it"), behaviour is right; the parenthetical is incomplete.
- spec:87 — the subject rule "the scopes it touches and the item count" has no stated form for a range whose items are all unscoped. Builder's call, but
  name it (e.g. `5 changes`).
- spec:109 — "per release-kit's own rule" is not what the README states: `README.md:227` says `v2` is for "a breaking change to the inputs or the job
  names". Adding an opt-in input is not that, so `v1.x` is right; cite the rule as it is written.
- spec:120 — says drop `push`, add `schedule`, keep `workflow_dispatch`; it does not say the `concurrency: group: release, cancel-in-progress: false`
  block (`.github/workflows/release.yml:21-24`) stays. It must (a schedule and a dispatch can overlap); one word.
- spec:124 — `docs/workflows/ci.md:76-77` currently tells authors "Delete the section from PRs with nothing user-visible", which the new check would
  fail for a releasing PR. §5's doc update covers it; say that sentence is the one to replace with the `None` opt-out.
- spec:133 — the dashboard's `ci.yml` does not pass `kit-ref` today (`.github/workflows/ci.yml:21-28`, default `v1`); the rollout pin needs it added
  there too, not only in `release.yml`. "release-kit's workflows" (plural) implies it; one explicit word avoids a missed pin.
- spec:155 — the `None` grammar (`None` / `None — <reason>`, em dash) is shared by the CI check and the writer; the spec should say both read it through
  one exported function so they cannot drift, even though the case rule is left open.

## Edge cases checked and found covered

Empty range (line 79), re-run on a tagged target and missing Release (97), dispatch behind a newer tag (98), `no-pr` commits mid-range (77), old reader
on a rollup tag (91–96, with the `Release-PR` caveat above), `None` PR in per-PR mode (61), PR with no body at all (`extractWhatsNew(null)` → `''`, fails
the check for a releasing title — intended by line 65), bump PRs (`chore(deps)`, never checked), schedule disabled after 60 idle days (149), overlapping
schedule and dispatch (existing concurrency group, see Minor).

## Scope and hard rules

Out-of-scope items are named (lines 35–42) and nothing in scope depends on them. CLAUDE.md rules touched: add-an-API-field order (line 105, respected),
`server/` dependency pin to an exact `vX.Y.Z` tag (line 123, respected), `styles.css` never restyling `.uk-*` (drawer change lives in ui-kit, respected),
`main` PR-only (every change is a PR, respected), mockups-before-UI memory rule (line 115, respected). No `.claude/rules/` directory exists.
