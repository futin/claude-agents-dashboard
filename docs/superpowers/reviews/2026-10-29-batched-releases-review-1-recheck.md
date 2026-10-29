# Batched releases plan — round 1 re-check

Scope: only the hunks in `plan-review1.diff` (plan lines 36–45, 104–106, 109–113, 157–158, 182–185, 224–225, 227–229, 240–246), plus a grep of the
rest of the plan for the formats those hunks replaced. Reviewer: Fable 5.1, 2026-10-29.

## Verdict

**APPROVE WITH FIXES** — one Important finding (a stated guarantee that does not hold for a mid-notes own-PR marker); everything else verified.

## Verified against the repos

| Plan line | Claim | Evidence |
|---|---|---|
| 41–42 | `~` is outside the scope alphabet `[a-z0-9-]` | `release-kit/src/conventional.ts:4` `RELEASING` regex `\(([a-z0-9-]+)\)` |
| 42, 45 | `Release-Items: 336:feat:kaizen, ~337:feat!:kaizen, …` is one trailer line to the v1.3.0 parser | `conventional.ts:83` `TRAILER = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/`; `:97–101` Map-size check, no `Release-PR` → `pr` undefined |
| 104–106 | `ParsedItem` does not exist yet; `ParsedTag`/`ReleaseType` do | `conventional.ts:30,72`; `src/index.ts` exports neither `ParsedItem` nor `ReleaseItem` |
| 157 | `ReleaseItem` does not exist yet in `read-releases.ts` | `release-kit/src/read-releases.ts:8–20` (`Release`, `ReleasesResponse` only) |
| 182–183 | merging a `feat:` PR into release-kit `main` cuts the tag | `release-kit/.github/workflows/self.yml` `release:` job, `if: github.event_name == 'push'`, uses `./.github/workflows/release.yml`; newest tag is `v1.3.0` → `v1.4.0` |
| 183–184 | `bump-consumers` opens `chore(deps): bump release-kit to v1.4.0`, auto-merge where the consumer allows it, in every consumer | `self.yml` `bump:` job (consumers: dashboard, backlog-manager, guide-manager, ui-kit); `bump-consumers.yml` input `auto-merge` default `true`; `scripts/bump-consumer.mjs:123` title, `:160–166` "Allow auto-merge" warning |
| 184–185 | the dashboard's bump PR goes red on `test/api-releases.test.ts` because `items` is new | `server/lib/releases.ts:38–40` returns `reader.read()` unmapped, so `items` reaches the response; `test/api-releases.test.ts:87` and `:113–122` are `deepStrictEqual` on the whole object; the suite is in `test/run-all.ts:157` |
| 185 | closing the bump PR does not get it reopened | `bump-consumer.mjs:105–107` — a closed PR from the bump branch counts as "a human has decided this version" |
| 224–225 | merging ui-kit's `feat:` PR cuts `v0.4.0` and opens bump PRs | `ui-kit/.github/workflows/release.yml:2–4` `push: branches: [main]`, `:25–33` `bump:` job (consumers: dashboard, backlog-manager, guide-manager); newest tag `v0.3.1` |
| 229 | C1 worktree and branch are new | no `../claude-agents-dashboard-notes-guide` dir; `docs/whats-new-guide` not in `git branch -a` |
| 240 | `feat/batched-releases` is new | not in `git branch -a` |
| 244–246 | expected `0.2.0` item values | `test/api-releases.test.ts:96–106` fixture tag: `feat(releases): version chip and What's new panel (#216)`, notes lines `:99–100`, `Release-Scope: releases`, `Release-PR: 216`, origin `:94` |
| checklist 7 | no stale `:t`, `Omit<ReleaseItem,'url'>`, "tag `v1.4.0`", `../claude-agents-dashboard-rollup` left elsewhere | `grep -nE ':t\b|Omit<|tag `v1\.4\.0`|dashboard-rollup|feat/batched-releases'` over the plan: only line 240 (the changed one) |

## Findings

### Important

- **[I] plan:38–39 — "never ends the item early" is only true for a marker on the item's *last* line.** The parse rule at plan:44–45 ends an item at the
  *first* line ending ` (#N)` for the next PR in `Release-Items`. Notes such as `see (#336)\nmore` for PR 336 are written as `see (#336)\nmore (#336)`;
  the reader ends item 336 at line 1 and the leftover `more (#336)` plus the blank line become the start of item 337's text. Rare (an author citing
  their own PR number mid-notes) but it corrupts two items silently, and the changed sentence promises it cannot happen. → Either strip a
  line-ending ` (#<own pr>)` from **every** line of the item's notes before writing (not only the trailing one), or make the reader end an item at the
  *last* such line before the next `###` heading / end of body; state which, and add the case to A3 Step 1 (plan:113) next to the trailing-marker test.

### Minor

- plan:113 — the own-PR-marker case states the body shape (`ends ` (#336)` once`) but not the parsed value; say `notes` round-trips without the
  marker (`- Lessons show a verdict badge.`), so the test pins the reader as well as the writer.
- plan:119 vs 117–118 and 160 — a rollup title-only item's `title` is prefix-stripped (`drop legacy log`), a per-PR item's `title` is the release-level
  `title` with its prefix (C2's expected value at plan:245 relies on that, via A5's "equal to their release-level fields"). A3 lists "title" for the
  per-PR item without saying which, so only A5's test would catch an implementer who strips it in A3. State "release-level `title`, prefix kept" at
  plan:119.
- plan:134 — "the squash title decides the bump": release-kit classifies by the PR's title from the API (`release-kit/src/release.ts:104`
  `checkTitle(pull.title)`), not the squash commit subject. Same result when the PR title is left alone; the wording points at the wrong thing to edit.
- plan:183–184 / 224 — `self.yml`'s consumer list includes ui-kit, and ui-kit's contract test is one-directional (`ui-kit/test/type-contract.test.ts:13`
  assigns release-kit's response *to* ui-kit's type, so a new required `items` on release-kit's `Release` is fine), so ui-kit's
  `chore(deps): bump release-kit to v1.4.0` PR is green and may auto-merge before Part B's held step. Line 224's "bump the devDependency … once it
  exists" is then "merge `main` (or that bump PR) into `feat/grouped-releases`"; worth one clause so nobody hand-edits a line that is already on `main`.
- plan:240 — C2 now names a branch but no worktree, while Part A, Part B and C1 each name both. Cosmetic; C2 is held.
- plan:244 — the second whole-object `deepStrictEqual` spans `:113–122` (the object literal is `:114–121`). Cosmetic.
- plan:104–106 — "exported" names `src/conventional.ts`; A3's Files list also has `src/index.ts`, so say whether `ParsedItem` is re-exported from the
  package root (A5 imports it from `./conventional.js` either way, so nothing breaks).

## Checklist pass

1. Coverage — the `~` flag, the own-PR marker rule, `ParsedItem`/`ReleaseItem` derivation and the release-by-merge held steps all map to spec §2
   (format left to the builder under the old-reader constraints), §3 (reader shape) and §Order/§5. No new scope.
2. Values — `Release-Items` example (plan:42) equals the test value (plan:112); the C2 item equals the fixture at `test/api-releases.test.ts:96–106`.
3. Reality — every path, name and tag verified above; `ParsedItem`, `ReleaseItem`, the C1/C2 branches and the C1 worktree are new as stated.
4. Interfaces — `ParsedItem` (A3) → `ReleaseItem = ParsedItem & { url?: string }` (A5), same spelling and shape as plan:47.
5. Order — A3 before A5; C1 independent; C2 held behind both tags.
6. Tests — the `scope: 't'` case (plan:112) discriminates the old `:t` suffix from the new `~` prefix; the own-PR case discriminates doubling. See the
   Important finding for the case the tests miss.
7. Conventions — behaviour and values only, no literal code; no stale old-format lines remain.
