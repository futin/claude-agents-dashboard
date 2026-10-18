# Releases

The dashboard shows its own release history: a version chip at the foot of the side rail, and behind it a **What's new** drawer listing every release,
newest first. The record is the checkout's annotated `vX.Y.Z` tags, which the release workflow cuts on every releasing merge into `main`
([ci](../workflows/ci.md) §Releases). Design: [the release pipeline spec](../superpowers/specs/2026-10-15-release-pipeline-design.md) §App.

Code: `server/lib/releases.ts` (the memo), `serveReleases` in `server/api.ts`, `client/src/lib/releases.ts` (every decision the chip and drawer make, no
React), `client/src/hooks/useReleases.ts`, `client/src/components/ReleasesDrawer.tsx`, the chip in `SideRail.tsx`, the wiring in `AppShell` (`App.tsx`).

## `GET /api/releases`

Answers `ReleasesResponse` (`shared/types.ts`): `current` is the newest release tag reachable from HEAD and how many commits HEAD is past it, `releases`
every release tag, newest first. Parsing the tag messages (subject, notes, `Release-Type` / `Release-Scope` / `Release-PR` / `Release-Breaking`
trailers) is [release-kit](https://github.com/futin/release-kit)'s `readReleases`, pinned to an exact `vX.Y.Z` tag (`v1.1.0` as of 2026-10-18) — the second of the two packages `server/` may import
(`test/server-deps.test.ts`). It runs `git` and reads nothing else, so it adds no outbound call. A tag with no `Release-Type` trailer is the **baseline**:
where numbering starts, not a release of anything. Lightweight tags and names that are not exactly `vX.Y.Z` are ignored.

**The empty shape.** A folder that is not a checkout, a checkout with no tags, or any git failure answers `{ current: null, releases: [] }`, with 200.
`readReleases` never rejects, so the route has no error branch.

**The memo.** One read per change, not per request. The key is HEAD plus the mtimes of `packed-refs` and `refs/tags` under the **common** git dir
(`git rev-parse HEAD --git-common-dir`):

- HEAD alone is not enough: a tag fetched or cut by hand moves no HEAD, and the release workflow tags `main` after the merge you already pulled.
- The common dir, not `--git-dir`: in a linked worktree `.git` is a file and the worktree's own dir holds no tags, so a tag cut from the main checkout
  would never move the key.
- `refs/tags` changes when a loose tag is added or removed, `packed-refs` when `git pack-refs` or `git gc` moves tags into it.

A key git cannot produce is never memoised, so a transient failure is not pinned. Concurrent requests under one key share one read.
`test/api-releases.test.ts` covers each of these through the real route table.

## The chip

`v0.3.0`, or `v0.3.0+2` when HEAD is two commits past the tag (`chipLabel`). No chip at all when `current` is null. It is the rail's last element: under the
live line on Sessions, sunk to the rail's foot on every other section, and the last row of the phone menu, where tapping it closes the menu as every rail
entry does.

**The dot.** A cyan dot sits in the chip while the newest release (the baseline counts) is above the version stored under `localStorage`
`dashboard.releases.lastSeen` — a raw version string, not JSON. Opening the drawer stores the newest. A first visit, or a stored value that is not a
version, seeds the newest without showing the dot, so a fresh browser never flags the whole history as new. Storage that throws (a private window,
blocked site data) means no dot, never a crash. It is a per-browser convenience, not a record.

## The drawer

Opened from the chip, which refetches first; the list is also fetched once on load. There is no poll — a new release reaches the server only when someone
pulls or fetches tags, and the chip is rarely looked at. Each entry: version, type badge (Feature / Fix / Performance), a separate Breaking badge, date,
the title without its `type(scope)!: ` prefix (the badge already says it), the notes as markdown when there are any, and `PR #N` when the origin is on
GitHub. The baseline renders as a divider: `Versioning starts here · v0.1.0`.

Full screen below `md` (768px), like the chat drawer, with the back gesture closing it; a 400px right-hand panel over the scrim from `md` up. Escape, the ✕
and a scrim click close it. It is rendered in `AppShell`, outside `.nav`: the phone menu hides itself with a `transform`, which makes it the containing
block of any `position: fixed` child, so a drawer inside it would be clipped to the menu.

Badge colours are each status token on its own tint; `test/daylight-contrast.test.ts` reads those pairs out of `styles.css`. The Breaking tint is 14% —
at 16% daylight red measured 4.42:1 over `--strip-hi`.

## What is not here

No `git fetch` (the server reads only what the checkout already has), no GitHub API call, no `package.json` version. The GitHub Release pages are written by
the release workflow and are not read back.

<!-- docs-sync:
  sources:
    - server/lib/releases.ts
    - server/api.ts
    - shared/types.ts
    - client/src/lib/releases.ts
    - client/src/hooks/useReleases.ts
    - client/src/components/ReleasesDrawer.tsx
    - client/src/components/SideRail.tsx
    - client/src/App.tsx
  kind: subsystem
  verified: 142439e51a92c5c5faebaf0c867bc5a36fef7c57
-->
