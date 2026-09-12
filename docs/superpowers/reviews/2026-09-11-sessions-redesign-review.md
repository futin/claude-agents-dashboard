# Review — Sessions page redesign (branch `redesign`, uncommitted)

Reviewed against `docs/superpowers/plans/2026-09-11-sessions-redesign.md`. Diff: 18 tracked files
changed (+1433/−1213), 3 deletions (`Header.tsx`, `SessionList.tsx`, `SessionRow.tsx`), 7 new
files (`AsideAccount.tsx`, `AsideBoard.tsx`, `Popover.tsx`, `sessions/*`, `lib/triage.ts`,
`test/triage.test.ts`). `redesign-mock.html` and `.claude/launch.json` ignored as instructed.

## Verdicts

- **Spec compliance: PASS with one deviation** — Triage hero cards ship one action and the
  hold's tool call, not the question text and two actions the plan named (see I-4).
- **Task quality: GOOD, not mergeable as-is** — logic is sound and tested; two cross-section
  regressions (a deleted shared CSS rule, stale docs-sync sources) need fixing first.

## Verification (run 2026-09-11)

```
$ pnpm typecheck
> tsc --noEmit
(exit 0)

$ pnpm test
=== filterSort.ts ===        Passed: 32  Failed: 0
=== triage.ts + chatTab ===  Passed: 12  Failed: 0
…
  18 passed, 0 failed
ALL PASS
(exit 0)

$ pnpm build
dist/assets/ChatDrawer-DCw2Mg7X.js   26.61 kB │ gzip:  7.65 kB
dist/assets/index-VUaelohF.js       192.49 kB │ gzip: 61.09 kB
✓ built in 953ms
(exit 0)
```

Not verified: anything visual (widths 700–1100px, phone, the four dark themes, popover focus
order) — the plan's own "needs a human" list stands.

## 1. Spec compliance, point by point

| Plan item | Status | Where |
| --- | --- | --- |
| Two columns on `wrap broad`, 320px aside | ✓ | `App.tsx:56`, `styles.css:222` |
| Aside · Account: gauges + time strips, `token-expired`/`signed-out` line | ✓ | `AsideAccount.tsx` |
| Aside · Board: clock, origin, 4 facts, remote-answers switch, 36px New session gated on `spawnAvailable` | ✓ | `AsideBoard.tsx:44-63` |
| <1100px aside above as two-card row; <700px stacked | ✓ | `styles.css:597-603, 604-605` (`order:-1`, 2-col grid → 1fr) |
| Toolbar: labelled switcher left; one track with filter btn · hairline · `Sort: <key> (dir)` · sort btn | ✓ | `Toolbar.tsx:52-97` |
| Both popovers: outside click + Escape close, one at a time | ✓ | `Popover.tsx:10-27`, single `open` state `Toolbar.tsx:38` |
| Filter btn raised only with a filter, count badge | ✓ | `Toolbar.tsx:69`, `.ictl.on` |
| Filter popover: Project pills ("All projects" first), Status multi-pick with dot, `ACTIVITY_WINDOWS` switch, Clear all disabled at 0 | ✓ | `Toolbar.tsx:100-131` |
| Sort popover: 4 keys + tick + hint, asc/desc switch | ✓ | `Toolbar.tsx:134-150` |
| Board: Needs you / Working / Quiet via `triageGroups`; open card inline | ✓ | `BoardView.tsx` |
| List: table with the named columns; open row expands full width | ✓ | `ListView.tsx`, `colSpan={7}` matches 7 cols |
| Split: 300px list + inspector; first row default; not persisted | ✓ (list is 320px, 280 <1100) | `SplitView.tsx:18`, `styles.css:509` |
| Tiles: 2/3 col metric cards, open spans 2, dashed phantom | ✓ | `TilesView.tsx`, `styles.css:540-546` |
| Triage: hero cards with **question text + two actions**, then Working / Idle lists | **Partial** — one action, shows `chatTab().title` + current tool call | `TriageView.tsx:53-76` (I-4) |
| Expanded body one component, reused by Board/List/Tiles/Split; none in Triage | ✓ | `sessions/Expanded.tsx` |
| Phantoms in every view, never interactive | ✓ Board (Working col), List, Split, Tiles, Triage | each view's `Launch*` |
| Empty + loading one component | ✓ | `sessions/EmptyState.tsx`, `SessionsView.tsx:103-105` |
| `View.layout`, default `board`, `LAYOUTS` order, persisted, shallow-merge default | ✓ | `filterSort.ts:59-107`, `usePersistedState.ts:17` |
| `SORT_LABEL`, `filterCount`, `triageGroups`, `chatTab`/`HOLD_TABS` moved to `holds.ts` | ✓ | `filterSort.ts:39-46,197`, `triage.ts`, `holds.ts:37-72` |
| `MultiSelect.tsx` deleted | ✗ kept — `AnalyticsToolbar.tsx:9` still needs it | right call; plan was wrong (M-1) |
| Docs: sessions.md Views/toolbar/phantoms; view-persistence `layout` + `splitId`; DESIGN §8.3 | ✓ | all three edited |
| Tests: every listed case | ✓ 5 new filterSort cases (27→32), 12 triage/chatTab cases | `test/filter-sort.test.ts:258-293`, `test/triage.test.ts` |

## 2. Correctness

Checked and clean:

- **Event propagation.** `ChatButton` stops propagation (`atoms.tsx:118`); `Expanded` root stops
  it (`Expanded.tsx:23`). Board renders `Expanded` and `.bfoot` as *siblings* of the clickable
  `.bmain` (`BoardView.tsx:37-45`); List renders it in its own `<tr>` with no handler
  (`ListView.tsx:32-34`); Tiles rely on the stop (`TilesView.tsx:26,40`); Split's inspector has
  no toggle handler at all. No path toggles a row from a chat button or the expanded body.
- **Hooks.** `useDismiss` deps `[ref, open, onClose]` complete; `close` is `useCallback`-stable
  (`Toolbar.tsx:40`). `toggle` uses a functional `Set` update (`SessionsView.tsx:88-94`). The
  prune effect and the `shown/empty` memo are unchanged from HEAD.
- **Null / empty payload.** `data?.launching ?? []` (`SessionsView.tsx:83`); `AsideAccount`
  returns `null` with nothing to draw; `AsideBoard` returns `null` until either poll answers;
  `Toolbar` gets `[]`; `chatSession` guarded on `data`. `triageGroups([])` → three empties.
- **Keys.** Cols by `c.key`, sessions by `s.id`, phantoms by `sessionId`, List uses `Fragment key`.
- **Split fallback.** `find(...) ?? sessions[0] ?? null` — a filtered-out `splitId` degrades to
  the first row, never to a blank inspector while rows exist.

## 3. Regressions in other sections

- **I-1 `.spacer{flex:1}` was deleted** (HEAD `styles.css:419`; 0 matches now). Still rendered
  by `ChatDrawer.tsx:171`, `PanelChrome.tsx:26,62`, `analytics/AnalyticsView.tsx:48,122`.
  `.chat-head` survives because `.chat-title` has its own `flex:1`; `.qp-head` (`styles.css:858`)
  and `.an-bar`/`.an-head` (`styles.css:729,740`) do not — the panel minimise caret, the
  Analytics review badge/refresh button and the per-report tokens/time lose their right
  alignment. Restore the one-liner.
- `AnalyticsToolbar` (`select`, `.tb-dir`, `MultiSelect`): rules re-scoped to
  `.analytics .toolbar …` (`styles.css:623-637`); `AnalyticsView` root is `.analytics` ✓. The
  toolbar's `margin-bottom:18px` moved with them ✓. `.tb-multi*`/`.tb-pop*` kept ✓.
- `RemoteAnswerToggle`/`OriginBadge`: `.ra-pill`, `.ra-switch`, `.ra-track`, `.ra-warn` kept ✓.
- ChatDrawer's `.proj-pill/.branch/.tok/.pct/.ag-pill` restyled in place (12px pills); the
  `.chat-head .proj-pill,.branch` clamp at `styles.css:680` still applies ✓. Tint changes
  (`.ag-pill.kaizen` magenta→green, `.surface.dashboard` cyan→magenta) reach `SessionDetail`
  and `ChatDrawer` too — intentional per DESIGN.md, but note it in the PR.
- Orphan sweep (every static `className` in `client/src` vs. `styles.css`): only `.spacer` is a
  new orphan. `ctl` (`Toolbar.tsx:57`) has no rule but is harmless. `an-col`, `an-lesson`,
  `mgmt-cmd`, `up-hourrow` were already orphans at HEAD. No file renders `.plate`, `.row`,
  `.row-chat`, `.r2`, `.caret`, `.dot`, `.tb-new`, `.rows`; `.ra-pill.on` never existed as a
  rule at HEAD either.

## 4. CSS rules

- No literal colour (`#…`, `rgb(`, `hsl(`, named) below the token block ends at
  `styles.css:103` — swept; every value is `var(--…)`, `color-mix(… var(--…) …)`, `transparent`
  or `none` ✓. Shadows all `var(--shadow)`/`var(--shadow2)`/`var(--ink)` ✓.
- Ground-track rule honoured: `.seg{background:var(--hairline2)}` (`:328`); popover switch
  `.pop .sw{background:var(--steel)}` (`:356`) ✓.
- `prefers-reduced-motion` (`:1055-1056`) covers `.sdot,.cbtn,.need::before,.tl-bar,.chat` ✓.

## 5. Accessibility

- Switcher: `role="tablist"`/`role="tab"` + `aria-selected` (`Toolbar.tsx:52-64`). Popover
  triggers: `aria-haspopup="dialog"`, `aria-expanded`, `aria-label` with the count
  (`Toolbar.tsx:70-73,86-89`). Popover: `role="dialog" aria-label` (`Popover.tsx:36`). Escape
  closes ✓. SVGs `aria-hidden` ✓.
- **I-3 rows/cards/tiles are pointer-only.** `BoardView.tsx:37` (`div role="button"`),
  `ListView.tsx:46` (`tr onClick`), `TilesView.tsx:26` (`div role="button"`), `SplitView.tsx:27`
  (`div role="button" aria-pressed`) — none has `tabIndex` or `onKeyDown`; `grep` finds no
  keyboard handler in `components/sessions/`. The old `.row-main` had the same gap, so this is
  pre-existing, but the redesign multiplies it by four views. The chat button is the only
  focusable path into a session.
- M-2 `tablist` without roving tabindex / arrow keys / `aria-controls` is non-conformant; a
  `role="radiogroup"` of `aria-pressed` buttons, or a real tabs pattern, would be honest.
- M-3 `Popover` never moves focus in or restores it; Escape from inside drops focus to body.

## Findings

### Critical
None.

### Important
- **I-1** `client/src/styles.css` — `.spacer{flex:1}` deleted; still used by
  `components/ChatDrawer.tsx:171`, `components/PanelChrome.tsx:26,62`,
  `components/analytics/AnalyticsView.tsx:48,122`. Restore it (one line, any block).
- **I-2** Stale references to the deleted components. `docs/overview.md:200-204` (the file map
  still lists Header / MultiSelect-as-facet / SessionList/Row and none of the new files);
  `docs-sync: sources:` blocks naming deleted paths — `docs/subsystems/spawn.md:656-657`,
  `remote-plan.md:196`, `remote-answer.md:299`, `permission-notify.md:186`,
  `session-surfaces.md:283`, `remote-message.md:267`, `usage-limits.md:1386`; prose —
  `view-persistence.md:28` (`SessionList`), `spawn.md:198,482,486`, `remote-answer.md:229,259`,
  `remote-plan.md:57`, `permission-notify.md:63`, `remote-message.md:73`.
- **I-3** `components/sessions/BoardView.tsx:37`, `ListView.tsx:46`, `TilesView.tsx:26`,
  `SplitView.tsx:27` — interactive rows not keyboard-operable (no `tabIndex`/`onKeyDown`).
  Pre-existing pattern, now in four views.
- **I-4** `components/sessions/TriageView.tsx:53-76` — plan specified the hold's question text
  and two actions (primary → drawer, secondary display-only); shipped one action and
  `chatTab().title` + the tool call. The in-code comment explains why (the question text lives
  in the pending store, not on `Session`). Reasonable, but it is a deviation the plan's owner
  should sign off or the plan should be amended.

### Minor
- **M-1** Plan says `MultiSelect.tsx` is deleted; it is kept for `AnalyticsToolbar`. Amend the plan.
- **M-2** `Toolbar.tsx:52` `tablist`/`tab` without arrow-key navigation or `aria-controls`.
- **M-3** `Popover.tsx` — no focus management (move in / restore on close).
- **M-4** `Toolbar.tsx:57` `className="seg ctl"` — `.ctl` has no rule; drop or define.
- **M-5** `lib/holds.ts:5-7` docblock still says "the header's need-you count".
- **M-6** `TriageView.tsx:31` Working caption always reads "none blocked".
- **M-7** `ChatDrawer.tsx:179` still tints `.pct` inline with `var(--orange)`/`var(--text)`;
  `.pct.warn` now exists and is the token-honest route.
- **M-8** `SessionsView.tsx:41` — `expanded` ids are never pruned when a session leaves the
  payload. Trivial leak, pre-existing.
- **M-9** Old `.plate .usage` sat beside the counts; the Account card now renders nothing when
  `SHOW_USAGE` is off, so the aside is a single Board card there. Matches the plan's "renders
  nothing while there is nothing to draw"; flagging only because the mock shows two cards.
