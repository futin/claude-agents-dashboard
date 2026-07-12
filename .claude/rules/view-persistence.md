# View persistence (Toolbar filters/sort)

The Toolbar's `view` object (`projects`, `statuses`, `window`, `sortKey`, `sortDir` — the
`View` interface in `client/src/lib/filterSort.ts`) is persisted to **localStorage** under key
`dashboard.view` so filters/sort survive a page refresh and tab-close. Wired in `App.tsx` via
`usePersistedState<View>('dashboard.view', DEFAULT_VIEW)` instead of plain `useState`.

- `hooks/usePersistedState.ts` — generic `useState` replacement: lazy init reads+parses the
  stored JSON once; an effect writes on every change. **Fail-open** — missing/bad JSON or a
  throwing `localStorage` (private mode / quota) falls back to the passed default, never crashes
  render. Object values are shallow-merged over the default (`{ ...fallback, ...parsed }`) so a
  value stored by an older release still gains any newly-added `View` field's default.
- **Client-only, zero deps** — no backend, no URL params (not shareable/bookmarkable by design).
- **Not persisted:** row-expansion state (`SessionList.tsx` `expandedIds`) stays ephemeral —
  session IDs churn, so restored expansions would mostly be stale.
