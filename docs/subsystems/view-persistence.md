# View persistence (Toolbar filters/sort)

The Toolbar's `view` object (`projects`, `statuses`, `window`, `sortKey`, `sortDir` — the
`View` interface in `client/src/lib/filterSort.ts`) is persisted to **localStorage** under key `dashboard.view` so filters/sort survive a page refresh and tab-close. Wired in
`SessionsView.tsx` via `usePersistedState<View>('dashboard.view', DEFAULT_VIEW)` instead of plain
`useState`; `AppShell` in `App.tsx` uses the same hook one level up to remember the open
section — though there it only *seeds* a plain `useState`, because the landing setting can
override it (see `dashboard.section` below).

- `hooks/usePersistedState.ts` — generic `useState` replacement: lazy init reads+parses the
  stored JSON once; an effect writes on every change. **Fail-open** — missing/bad JSON or a
  throwing `localStorage` (private mode / quota) falls back to the passed default, never crashes
  render. Object values are shallow-merged over the default (`{ ...fallback, ...parsed }`) so a
  value stored by an older release still gains any newly-added `View` field's default.
  A stored view written before the shape moved out of `View` still carries a `layout` key;
  nothing reads it, and it is inert rather than worth a migration.
- **Stale project names self-heal** — the `projects` facet is the one field whose valid values
  are *data*, not a fixed enum, so a persisted selection can outlive the sessions it named
  (the project went quiet, or fell out of the `limit`/`lookback` window). Left alone every row
  fails the filter and the list empties with no sign that a filter did it.
  `pruneProjects(selected, sessions)` in `lib/filterSort.ts` (pure, unit-tested)
  drops selected names a payload does not contain; an effect in `SessionsView.tsx` applies it
  on every poll, so losing the last surviving name lands back on "All projects". An **empty
  payload prunes nothing** — no rows is no evidence, and the first poll of a mount arrives
  before any rows do. The tradeoff is deliberate: a filtered project that momentarily drops
  out of the top-`limit` ranking clears the filter rather than showing an empty list.
- **The empty state names its own cause** — `sessions/EmptyState.tsx` has two empty branches, not one.
  `describeEmpty(sessions, view, nowMs)` in `lib/filterSort.ts` runs on the *unfiltered*
  payload and returns `{ payloadEmpty, total, culprits }`, where `culprits` lists which of
  the three facets (projects → statuses → window, fixed order) rejected at least one row.
  An empty payload keeps the original "No recent sessions in the lookback window." — the
  server's `lookbackHours`, true only there; anything else reads "All *n* sessions are hidden
  by the … filters." with a **Clear filters** button (`clearFilters(view)`, which resets the
  three facets and keeps the sort). `SessionsView` computes one `nowMs` for `applyView` and
  `describeEmpty` together, so the window predicate cannot disagree with its own explanation.
  This is the general case `pruneProjects` deliberately does not cover: a status filter, an
  activity window, or a selected project that still exists but has nothing inside the window
  — none of them stale, all of them able to empty the list.
- **Other persisted keys** — each owned by its own subsystem; indexed here, documented there:
  `dashboard.settings` (theme, density, text scale, refresh rate, scan knobs, landing tab
  — see [settings](settings.md); re-clamped on every read by `clampSettings`, and the
  one key an inline script in `index.html` also reads, pre-paint, to avoid a theme flash);
  `dashboard.section` (Sessions | Usage | Management | Analytics | Settings —
  the `Section` union in `lib/sections.ts`, switched on in `App.tsx`) — always
  *written* on navigation, but only *read* on open when Settings → landing is `last`; any
  other value pins the opening section, resolved in the `useState` initializer so there's no
  flash of the previously-open one. Whichever of the two wins is passed through `isSection`
  first, so a value naming a section this build no longer has (the removed Guides tab) lands
  on `sessions` rather than falling through `App.tsx`'s chain to Settings.
  A `?session=` deep link outranks both and forces
  `sessions` (see the URL-param note below);
  `dashboard.layout` (which of the five shapes the switcher was left on — the shape note
  below, and [settings](settings.md); guarded by `isLayout` inside `resolveLayout`, so a
  stale or hand-edited value falls back to `board`);
  `dashboard.chatFilter` (the chat drawer's all/text/you filter — see [chat](chat.md); validated
  with `isChatFilter` on read, so a stale value falls back to `all`);
  `dashboard.analyticsView` (the Analytics tab's own facets — see [analytics](analytics.md));
  `dashboard.answerToken` (see [remote-answer](remote-answer.md)); `management.scope`,
  `management.type` (which of the type column's rows the item column is showing) and
  `management.collapsed` (see [management](management.md) — all three resolve during render,
  so a scope that aged out, a type the filter emptied and a sub-group that no longer exists
  fall back rather than stranding the page).
- **Client-only, zero deps** — no backend, and nothing here is shareable/bookmarkable by
  design. The one URL param in the app is the opposite of persistence: `?session=<id>`, the
  deep link a tapped push notification opens (`lib/deepLink.ts`, put in ntfy's `Click` header
  by `server/lib/notify.ts` — see [push-notify](push-notify.md)). `deepLinkSession()` reads it
  once, memoises the answer for its two callers (`AppShell` picking the section,
  `SessionsView` opening the drawer), and strips it from the URL via `history.replaceState`,
  precisely so a refresh or a bookmark does *not* replay it.
- **Which of the five shapes draws the list is deliberately NOT in `dashboard.view`.** It
  used to be a `View` field, which made one click in the switcher the shape every future load
  opened in. The shape is not a filter, and it does not belong in the object the filters are
  persisted in. It now works exactly like the section does, one key over:
  `dashboard.layout` (a bare `Layout` string) is **always written** by the switcher, and
  `defaultLayout` in `dashboard.settings` (see [settings](settings.md)) decides whether a
  load reads it back. `resolveLayout(settings.defaultLayout, stored)` — pure, in
  `lib/settings.ts`, unit-tested — is the whole rule: a concrete shape wins outright and the
  stored value is not consulted; `last` (the default) replays it; `last` with nothing or junk
  stored lands on `DEFAULT_LAYOUT` (`board`), the fail-open `isLayout` gives it. Resolved in
  `SessionsView`'s `useState` initializer, so there is no flash of the wrong shape.
  Writing the key even while a concrete shape is pinned is deliberate: flipping the setting
  back to **Last used** then resumes from the shape you were actually using, not from a value
  frozen when you pinned one.
  ⚠️ `'last'` is a *setting* value only — it is **not** in `LAYOUTS`, which is the toolbar's
  own button list. The picker's options are the separate derived `LAYOUT_OPTIONS`
  (`'last'` prepended to `LAYOUTS`, the shape `LANDING_OPTIONS` has), so the switcher stays
  five buttons while the picker and the validator still cannot drift from it.
- **Not persisted:** which cards are open (`SessionsView.tsx` `expanded`) and the split
  view's inspected session (`splitId`), the open chat drawer (`SessionsView.tsx` `chatId`, seeded from the deep link above), and the
  [launch panel](spawn.md) (`SessionsView.tsx` `spawnOpen` — a one-shot form, not a view
  setting) stay ephemeral — session IDs churn, so restored expansions and drawers would
  mostly be stale.
- **Clearing them all** — Settings → Local › Reset this browser removes every key listed above
  (`OWNED_KEYS` in `hooks/useSettings.tsx`) and restores the defaults. It touches nothing on the
  server and nothing in `~/.claude`. Add a key here and it belongs in that list too.

<!-- docs-sync:
  sources:
    - client/src/hooks/usePersistedState.ts
    - client/src/App.tsx
    - client/src/components/SessionsView.tsx
    - client/src/components/Toolbar.tsx
    - client/src/components/settings/SettingsView.tsx
    - client/src/lib/filterSort.ts
    - client/src/lib/settings.ts
    - client/src/hooks/useSettings.tsx
  kind: subsystem
  verified: 0da757e27d2847eb57fca181bf516a3e9c130caa
-->
