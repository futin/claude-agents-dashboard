---
docs-sync:
  sources:
    - client/src/hooks/usePersistedState.ts
    - client/src/App.tsx
    - client/src/components/SessionsView.tsx
    - client/src/components/Toolbar.tsx
    - client/src/lib/filterSort.ts
  kind: subsystem
  verified: fa1fa5b9daeb162acccef66d0e4d9a210ede95da
---

# View persistence (Toolbar filters/sort)

The Toolbar's `view` object (`projects`, `statuses`, `window`, `sortKey`, `sortDir` — the
`View` interface in `client/src/lib/filterSort.ts`) is persisted to **localStorage** under key
`dashboard.view` so filters/sort survive a page refresh and tab-close. Wired in
`SessionsView.tsx` via `usePersistedState<View>('dashboard.view', DEFAULT_VIEW)` instead of plain
`useState`; `AppShell` in `App.tsx` uses the same hook one level up to remember the open
section — though there it only *seeds* a plain `useState`, because the landing setting can
override it (see `dashboard.section` below).

- `hooks/usePersistedState.ts` — generic `useState` replacement: lazy init reads+parses the
  stored JSON once; an effect writes on every change. **Fail-open** — missing/bad JSON or a
  throwing `localStorage` (private mode / quota) falls back to the passed default, never crashes
  render. Object values are shallow-merged over the default (`{ ...fallback, ...parsed }`) so a
  value stored by an older release still gains any newly-added `View` field's default.
- **Other persisted keys** — each owned by its own subsystem; indexed here, documented there:
  `dashboard.settings` (theme, density, text scale, refresh rate, scan knobs, landing tab,
  alerts — see [settings](settings.md); re-clamped on every read by `clampSettings`, and the
  one key an inline script in `index.html` also reads, pre-paint, to avoid a theme flash);
  `dashboard.section` (Sessions | Management | Analytics | Settings, `App.tsx`) — always
  *written* on navigation, but only *read* on open when Settings → landing is `last`; any
  other value pins the opening section, resolved in the `useState` initializer so there's no
  flash of the previously-open one;
  `dashboard.chatFilter` (the chat drawer's all/text/you filter — see [chat](chat.md); validated
  with `isChatFilter` on read, so a stale value falls back to `all`);
  `dashboard.analyticsView` (the Analytics tab's own facets — see [analytics](analytics.md));
  `dashboard.answerToken` (see [remote-answer](remote-answer.md)); `management.scope` and
  `management.collapsed` (see [management](management.md)).
- **Client-only, zero deps** — no backend, no URL params (not shareable/bookmarkable by design).
- **Not persisted:** row-expansion state (`SessionList.tsx` `expandedIds`) stays ephemeral —
  session IDs churn, so restored expansions would mostly be stale.
- **Clearing them all** — Settings → Reset this device removes every key listed above
  (`OWNED_KEYS` in `hooks/useSettings.tsx`) and restores the defaults. It touches nothing on the
  server and nothing in `~/.claude`. Add a key here and it belongs in that list too.
