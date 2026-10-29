# Batched releases with readable notes

Supersedes D2 of [the release pipeline spec](2026-10-15-release-pipeline-design.md) ("every merged PR is a candidate release") for repos that opt in.
Everything else in that spec stays: the tag is the record (D3), squash merges (D4), local tag reads (D5), release-kit as the shared home (D7).

## Why

Every `feat`/`fix`/`perf` PR merged into `main` cuts its own tag today. This repo has cut 50 tags from 2026-10-16 to 2026-10-28, about 4 a day
(measured 2026-10-29), so about 110 a month. Nobody deploys this app; it runs from a checkout. A "release" here is only a changelog entry, and nobody would
cut one for a single PR by hand.

The notes are also weak. Of the last 48 tags, 24 carry no notes at all and the drawer shows only the PR title (measured 2026-10-29). The ones that do
carry notes are written for an implementer (`v0.27.0` explains `--compare <project> <since> <field.path>` and its JSON fields). The PR template's
`## What's new` hint is one comment line with no example, and nothing checks it was filled in.

## The reader

**The maintainer, catching up.** The person reading What's new is the user themself, a day or a week later, asking "what changed in my tool since I last
looked?". Notes are written for that reader: one line per change, at feature level, phrased so the change is recognisable without opening the PR, and
the whole of a version scannable in about ten seconds.

Good: `Routines: a run that times out now shows how long it ran before it was stopped.`
Bad: `` `--compare` prints JSON with median, values and missing per side. ``

## Goals

1. **One version per day at most**, not one per PR: a daily scheduled run plus a manual "release now", each cutting a single tag that rolls up every
   releasable PR merged since the last tag.
2. **Readable notes written when the PR is opened**, by its author (most PRs here are opened by Claude sessions), and collected by CI unchanged.
3. **A check that the notes exist**, so an empty `What's new` on a releasing PR is caught before merge rather than discovered in the drawer.
4. **The drawer shows a rolled-up version as a short grouped list**, each item still linking to its PR.

## Non-goals

- Changing the other release-kit callers (backlog-manager, guide-manager, lookout, ui-kit). They keep per-PR releases until each opts in separately.
- Rewriting existing tags. The 50 per-PR tags stay as they are and keep rendering.
- Claude, a Routine, or this laptop anywhere in the release path. A local Routine was considered to cut the tag and write a summary, and rejected: it
  would release only when the Mac is awake, push tags with local credentials, and duplicate release-kit's idempotent re-run and ordering guards. Notes
  quality is fixed at PR time instead, where the author knows what changed.
- A "Release now" button in the dashboard. The Actions tab and `gh workflow run release.yml` cover it.
- Editing the PR-authoring skills in other plugins (backlog-execute, finishing-a-development-branch). They fill in the repo's template; the template and
  the CI check are what carry the rule.

## Anti-goals

Any of these makes the work a failure even if it runs:

- A release that depends on this machine being on.
- Losing per-PR traceability: every item in a rolled-up version must still name its PR.
- Breaking the other four release-kit callers, or their drawers, on the next `v1` move or `bump-consumers` run.
- Old per-PR tags rendering worse than they do today.

## Design

### 1. Notes at PR time

- **Template.** The `## What's new` hint in `.github/pull_request_template.md` becomes a real guide, still inside an HTML comment so an untouched
  template yields empty notes: who the reader is (above), one bullet per user-visible change, the change first in plain words, no area prefix (the
  drawer groups by the title's scope, so a `Routines:` prefix would repeat its own heading), no file paths, flags, field names or function names, and the
  good/bad pair above, minus its prefix, as the example. It also states the opt-out (below).
- **`None` never reaches a tag.** The release writer drops a `None` opt-out in both modes, so a `None` PR's tag has empty notes and shows its title alone,
  exactly as an empty section does today. Per-PR output is unchanged for every PR that does not use the marker. The CI check and the writer recognise
  `None` through one exported release-kit function, so the two cannot drift.
- **Repo rule.** `.claude/CLAUDE.md` §PR rules gains one bullet: `What's new` is written for the maintainer catching up, follows the template's guide,
  and is required on `feat`/`fix`/`perf`. Claude sessions load this file; they do not reliably read template comments.
- **Check.** A releasing PR (`feat`/`fix`/`perf`, by the same title regex `pr-title` uses) fails CI when its `What's new` section, extracted exactly as
  the release workflow extracts it (comments stripped, up to the next `^## `), is empty. It passes with any notes, or with an explicit opt-out line
  `None` (optionally `None — <reason>`) for a releasing change with nothing worth saying. Non-releasing types are never checked. The check re-runs when
  the PR body is edited (the dashboard's `ci.yml` already triggers on `edited`).
  - Lives in release-kit's `ci-node.yml` as an **opt-in input**, off by default, so the other callers see no change.
  - *My call:* it runs as a step inside the existing `pr-title` job rather than as a new job, so no ruleset's required-checks list has to change. The
    builder may choose otherwise if that proves awkward, but must then update the `main-pr-only` ruleset in every opted-in repo.

### 2. Rollup release (release-kit)

A new opt-in mode on release-kit's reusable `release.yml`; the default stays per-PR, so callers that do not set it are unaffected. The only change to
per-PR output is the `None` drop (§1), which touches no existing tag and no PR without the marker.

- **Scheduled runs.** The reusable workflow sets `DEFAULT_BRANCH` from `github.event.repository.default_branch`
  (`release-kit/.github/workflows/release.yml:54`), and `release-cli.ts:104-105` exits with `DEFAULT_BRANCH is not set` when it is empty. A `schedule`
  event's payload does not reliably carry `repository`, and no caller has ever run the workflow from a schedule. So it falls back to
  `github.event.repository.default_branch || github.ref_name` (a scheduled run's ref is the default branch), and the first scheduled run is checked by
  its log. A scheduled run is not a dispatch, so `onNewer` is `skip` there (`release-cli.ts:107`), as for push runs today.

- **Range** is unchanged: first-parent commits from the newest `vX.Y.Z` tag reachable from the target up to the target. PR lookup and title
  classification per commit are unchanged, including the `no PR for <sha>` skip.
- **Nothing releasable in the range** (only `docs`/`chore`/… PRs, or none) → no tag, green run. This is the normal outcome of most daily runs on quiet days.
- **Otherwise one tag** on the target commit, with one GitHub Release mirroring it.
- **Version bump** is the largest any PR in the range would have caused under the existing table: breaking > `feat` > `fix`/`perf`.
- **Items.** Each releasable PR in the range is one item carrying its type, scope, breaking flag, PR number, title, and notes. Notes are its `What's new`
  section as extracted today; an empty section or a `None` opt-out means the item shows its title alone. So the tag message carries an item's PR title
  only when the item has no notes, and the reader's item `title` is required only then (an item with notes may omit it).
- **Grouping** is by the PR title's conventional-commit scope. A PR whose notes span two areas is filed under its title's scope alone.
- **Tag message.** Human-readable on its own (it is also the GitHub Release body and what `git show <tag>` prints): items grouped by scope, unscoped
  items last, each item's notes followed by its PR number. A subject line for the version as a whole (*my call:* the scopes it touches and the item
  count, e.g. `Kaizen, Routines — 5 changes`; `5 changes` alone when no item has a scope). The exact format is the builder's, under these constraints:
  - the reader recovers every item field listed above without ambiguity;
  - it stays parseable with git's own trailer rules, written with `--cleanup=verbatim` as today;
  - a per-PR tag written by any earlier release-kit version still parses to exactly what it parses to today;
  - **an old reader must not misread a rollup tag.** Tags are read from every fetched tag, and the dashboard fetches pinned repos itself
    (`server/lib/git-fetch.ts`) across two machines sharing one remote, so a checkout still on `release-kit#v1.3.0` will meet rollup tags. Today's
    `parseTagMessage` (`release-kit/src/conventional.ts`) treats the message as `baseline` unless its final paragraph is wholly `Key: value` trailers with
    **no repeated key** (it compares a `Map`'s size to the line count) and a valid `Release-Type`. So the final paragraph keeps exactly that shape,
    `Release-Type` set to the highest type, and per-item data lives outside it or under keys that never repeat. An old reader then shows a rollup tag
    as one entry: its subject, and the grouped list as notes. A bumped release-kit major would not help here, because the old parser is already pinned.
  - **A rollup tag's trailer block carries `Release-Type` (and `Release-Breaking` when any item breaks), never `Release-PR` or `Release-Scope`.** An old
    reader turns `Release-PR` into the entry's `PR #N` link (`release-kit/src/read-releases.ts:64-67`, `ui-kit/src/releases/ReleasesPanel.tsx:44-48`), so
    one would link the whole version to a single PR. This is also the new reader's discriminator: `Release-PR` present means a per-PR tag, read as a
    one-item release.
- **Idempotence and ordering** keep today's guarantees: a re-run over a tagged target with its Release present does nothing, a missing Release is
  repaired, a dispatch behind a newer tag fails with `a newer release exists: <tag>`.
- **Transition.** The first rollup run in a repo starts from the newest per-PR tag like any run. History becomes per-PR tags followed by rollup tags.

### 3. Reader and API shape

release-kit's `createReleasesReader` returns, per release, its list of items alongside the existing release-level fields. Three cases:

| Tag | `type` | `items` |
|---|---|---|
| baseline (no `Release-Type`) | `baseline` | `[]`; the drawer's baseline divider is untouched |
| per-PR (`Release-PR` present) | its type | exactly one item |
| rollup | the highest type | one per PR, N ≥ 1 |

Release-level `type`/`breaking` stay meaningful (the highest/any across items) for consumers that only show a badge. A rollup's release-level `title` and
`notes` stay exactly what `parseTagMessage` returns today (the subject and the pre-trailer body); `items` is parsed in addition. That keeps the GitHub
Release body whole, since `release.ts:82-83` builds it from `parseTagMessage().subject/.notes`, and keeps old readers showing the grouped list. The drawer
renders `items`, never release-level `notes`, for a rollup. `shared/types.ts` `ReleasesResponse` follows whatever release-kit exports; `shared/types.ts` changes first, per the repo's
add-an-API-field rule.

*Versioning, my call:* the writer change is opt-in and the reader change is additive (old tags parse the same), so this is a release-kit minor (`v1.x`),
not `v2`: release-kit's README (`README.md:227`) reserves `v2` for a breaking change to the inputs or the job names, and new opt-in inputs are neither.

### 4. Drawer (ui-kit)

ui-kit owns its own copy of the wire types (`ui-kit/src/types.ts`, with no runtime dependency on release-kit) and the dashboard client renders that copy
(`client/src/components/ReleasesDrawer.tsx:1`), not `shared/types.ts`'s. So ui-kit's `Release` gains the item list too, and
`ui-kit/test/type-contract.test.ts` keeps proving release-kit's `ReleasesResponse` is assignable to ui-kit's, fixtures included.

A one-item release renders exactly as today. A multi-item release renders: the version header (version, date, type badge from the highest type,
Breaking badge if any item breaks), then items grouped under their scope, each item showing its notes (or title) and its PR link. Same tokens, same
class-naming discipline, phone width full-screen as today. **Mockups before UI code**: two or three variants as an Artifact, real class names, phone
width, shown to the user first.

### 5. This dashboard adopts it

- `.github/workflows/release.yml`: drop the `push` trigger; add a daily `schedule` (*my call:* `0 4 * * *` UTC, so a version is waiting in the
  morning); keep `workflow_dispatch` with its `sha` input and the `concurrency: release` block unchanged (a schedule and a dispatch can overlap); set the
  rollup mode.
- `.github/workflows/ci.yml`: turn the notes check on. It passes no `kit-ref` today (default `v1`), so the rollout pin adds one there too.
- Bump the pinned release-kit and ui-kit versions.
- Docs: `docs/workflows/ci.md` §Releases (cadence, rollup, the notes check; its "Delete the section from PRs with nothing user-visible" sentence is
  replaced by the `None` opt-out) and `docs/subsystems/releases.md` (items, the grouped drawer).

### Order

1. **Notes** (§1): release-kit check, then this repo's template, rule and opt-in. Ships value alone: per-PR notes improve the next day.
2. **Rollup writer + reader** (§2, §3) in release-kit, tagged `v1.x.y`.
3. **Drawer** (§4) in ui-kit, tagged.
4. **Adoption** (§5) here.

*My call, on the floating `v1`:* during rollout this repo pins release-kit's workflows to the exact new tag (`uses: …@v1.x.y`, `kit-ref: v1.x.y`), since
a reusable workflow rejects an input it does not have yet. Moving `v1` stays the manual force-push release-kit's README describes, done by the user, never
by an executor: it puts both workflows live for every caller at once. Once `v1` is moved, this repo may return to `@v1`.

## Success

- This repo cuts at most one version a day, none on days with no releasable merge.
- Every item merged after phase 1 carries notes or an explicit `None`.
- The other four callers' release behaviour and drawers are unchanged.

## Known limits

- **The release is not the deployment.** Merging into `main` stays immediate (branches sync with `main` early to avoid conflicts), and the code is live
  as soon as a checkout pulls. Only the changelog lags, by up to a day. A `next-release` branch merged nightly was considered and rejected: it delays the
  code itself, not just its label, and lets branches drift from `main` all day. An "Unreleased" drawer section for merged-but-untagged PRs was also
  offered and declined by the user (2026-10-29): the chip's `+N` is enough. Urgent changelog entries use the manual dispatch.
- GitHub may start a scheduled run late under load, and disables schedules in public repos after 60 days without activity. This repo is public
  (checked 2026-10-29), so a quiet two months needs the schedule re-enabled; manual dispatch still works.
- The dashboard chip shows `vX.Y.Z+N` for the hours between a merge and the next run, which is the intended reading of `+N`.

## Left to the builder

The tag-message format inside the constraints above, the reader's exported type names, how `ci-node.yml` and `release.yml` name their new inputs, test
fixtures, and whether `None` matching is case-insensitive.
