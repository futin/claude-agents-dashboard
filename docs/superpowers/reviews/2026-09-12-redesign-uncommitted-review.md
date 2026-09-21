# Review — uncommitted delta on `redesign` (chat modal · management columns · gauge spacing · Last used)

Subject: everything in the working tree that is not committed — `git diff HEAD` (73 files,
+8347/−3199) plus 6 untracked files (`management/TypeColumn.tsx`, `usage/Sheet.tsx`,
`hooks/useManagementScope.tsx`, `lib/walkRows.ts`, `test/split-plan.test.ts`,
`test/walk-rows.test.ts`). The committed history is out of scope.

The Sessions-page slice of this same delta was reviewed separately in
`2026-09-11-sessions-redesign-review.md`; this pass re-checks that review's open items and
concentrates on the four parallel workstreams that followed it — the chat modal, Management's
three columns, the Account-gauge spacing, and the `Last used` session-view setting — plus the
integration seam all four met in `client/src/styles.css`.

## Verdicts

- **Spec compliance: PASS.** DESIGN.md §8.5 and §8.6 are implemented as written, including the
  parts that are easy to get wrong: the item column is a fixed 420px open *and* closed
  (measured), the transcript's height is identical with and without a pinned panel (measured),
  the pinned layer carries no shadow, the plan is a titled clipped block rather than a blind
  toggle, the scope lives in the rail with a phone-only `<select>` as its single alternate, and
  the five themes all define every token the new rules consume.
- **Task quality: GOOD, not mergeable as-is.** No Critical defects and no integration damage in
  `styles.css` — the thing most likely to have broken did not. What is left is seven Important
  items: two wrong statements the forecast page makes on screen, one keyboard trap in the plan
  block, one persisted key Reset forgets, one title that silently rewrites an identifier, and
  two sets of docs that now contradict the code they describe — one of them the doc for the
  very feature this delta shipped.

## Verification (run 2026-09-12, on this working tree)

```
$ pnpm typecheck
> tsc --noEmit
(exit 0)

$ pnpm test
… 18 suites …
  18 passed, 0 failed
ALL PASS
(exit 0)

$ pnpm build
dist/assets/ManagementView-BsbJCRhR.js   12.47 kB │ gzip:  4.15 kB
dist/assets/ChatDrawer-DHni3ow7.js       29.52 kB │ gzip:  8.45 kB
dist/assets/UsageView-Cm1wnnAf.js        36.88 kB │ gzip: 12.07 kB
dist/assets/index-DJjjGrgC.js           195.65 kB │ gzip: 61.95 kB
✓ built in 772ms
(exit 0)
```

### Measured in the running app

A dev server was already up on :5174 (Vite, serving this working tree); measurements were taken
through the browser pane with `getBoundingClientRect`, not from screenshots.

| Claim | Result |
| --- | --- |
| Management item column 420px open and closed | **Verified.** At 1440px: closed `grid-template-columns: 190px 420px`, list box 420.0px; after clicking an item, `190px 420px 470px`, list box still 420.0px. `document.body.scrollWidth === innerWidth` in both states. |
| Transcript height unchanged with and without a pinned panel | **Verified.** Desktop 1440×900: `.chat-body` 703px with an empty `.chat-pinned`, 703px with a 320px panel injected, 703px with a 2000px panel injected (the layer capped at 704px = `calc(100% + 1px)` and scrolled itself). Phone 375×720: 401px in all three. |
| No shadow under a pinned panel | **Verified.** `getComputedStyle(.chat-pinned).boxShadow === 'none'`, same for an injected `.qpanel`. |
| Gauge: percentage, time-strip spacer and labels share one right edge | **Verified.** `.u-pct` is exactly 36.0px; `.u-bar` and `.u-time` right edges both 1348.0px; the label row's content edge lands on the same 1348. Forcing the text to `0%`, `100%` and `888%` left all three unchanged. |
| Five themes define every token | **Verified.** Cycling `data-theme` through all five returns non-empty `--board/--strip/--strip-hi/--hairline2/--shadow2/--scrim` for each. |
| Phone (375×720) | **Verified.** No horizontal overflow on Sessions or Management; `.mgmt-scopesel` `display:block` while `.rail-sub` is `display:none` (exactly one scope control); the modal is full-screen at exactly 375×720, top 0, with a 40×40 ✕ inside the viewport. |
| One `/api/management` fetch per refresh | **Not measured.** Read from source only: `useManagementIndex` is called once (`useManagementScope.tsx:50`) and gated on `active`; the page reads the context. Note that a *refresh* on a project scope is two requests, not one — the index plus `useProjectScope`'s own refetch on the bumped `refreshKey`. |

### Not verified

The four dark themes visually (only their tokens were read), 700–1330px on Management, the
`prefers-reduced-motion` paths, screen-reader output, and every panel state that needs a live
hold (a pending question, a proposed plan, a reply window) — the running board had none, so
`QuestionPanel`, `PlanPanel`, `MessagePanel` and `ResumePanel` were read, not driven. The
pinned-layer measurements above used an injected `.qpanel` stand-in of a known height, which
proves the layout rule but not those components' own content.

## 1. The `styles.css` integration seam — clean

This was the ranked risk and it did not materialise. Checks run over the current file:

- **No orphaned rules from the deletions.** Every class in the `mgmt* / mitem* / msub* / msrc /
  chat* / qp* / qpanel / pb* / cmsg* / md* / mdetail* / rail* / set* / seg / pop / ictl / u-*`
  namespaces resolves to a `className` in `client/src`. `ScopeMenu`'s `.mgmt-menu*` rules are
  gone with the component — zero matches. `.spacer{flex:1}`, deleted in the sessions pass and
  filed as I-1 there, is restored at `styles.css:416`.
- **No duplicate or conflicting selectors.** A full brace-matched scan of the file finds three
  selectors declared twice — `.shell` (`:112` zoom, `:150` display), `.mitem.on` (`:735`/`:737`,
  adjacent and deliberate), `.qpanel.spawn` (`:1112`/`:1118`) — none of which conflict.
- **No literal colour below the token block.** `#rgb`, `rgb(`, `rgba(`, `hsl(` all return zero
  matches after line 112. Of the 27 `box-shadow` occurrences, every one that names a colour names
  a token (`var(--shadow2)`, `var(--ink)`, `var(--strip-hi)`); the rest are `none` (`:257`,
  `:938`, `:1038`) or a `transition` property (`:449`). The new `--u-pct-w` / `--u-gap` custom
  properties are lengths, declared on `.usage` and consumed by four rules in the same block.
- **Specificity between the chat and management blocks:** no shared selectors. The one place the
  chat modal could have been reached by another section's rules is that it renders *inside*
  `.sessions` (`SessionsView.tsx:152`), so `.sessions .metric` (`:420`) and `.kv .v .metric`
  (`:550`) both match the sidecar's context figure. They agree on 24px either by specificity or
  by source order, so nothing is visibly wrong — but the value is now written three times
  (`:420`, `:550`, `:898`) and a change to one of them will not reach the other two.

## 2. Persisted-state safety

| Key | Validated on read | Cleared by Reset | Documented |
| --- | --- | --- | --- |
| `dashboard.layout` | ✓ `isLayout` inside `resolveLayout` (`settings.ts:239`) | ✓ `useSettings.tsx:18` | ✓ `view-persistence.md:52` |
| `management.type` | ✓ resolved during render (`ManagementView.tsx:49`) | **✗ — see I-4** | ✓ `view-persistence.md:60` |

Both fail open: a hand-edited `dashboard.layout` lands on `board`, a `management.type` naming a
type the scope or filter does not have falls through to `groups[0]`, and `management.scope`
naming a project that aged out resolves to `global` in the provider (`useManagementScope.tsx:54`).
`management.collapsed` remains the one key with no shape guard — `new Set(collapsedKeys)` at
`ItemList.tsx:47` throws on a stored non-iterable — but that is unchanged from HEAD and outside
this delta.

## 3. Correctness, checked and clean

- **`resolveLayout`** (`settings.ts:239`). `'last'` + junk → `board`; a concrete shape ignores
  `stored` entirely; `resolveLayout('last','last')` → `board` (the sentinel is never a shape).
  All four branches are covered by `test/client-settings.test.ts:107-151`, and `LAYOUTS` is
  pinned to five entries in two separate suites so the picker cannot grow a sixth toolbar button.
- **`splitPlan`** (`PlanPanel.tsx:43`). Fence tracking, the unterminated-fence direction, a
  heading after a paragraph, the deliberate non-idempotence — all pinned by
  `test/split-plan.test.ts`. The only gap is inside `plainTitle` (I-6).
- **`ManagementView`'s derived state.** Scope, type and selection all resolve during render, so
  a scope switch cannot strand a selection from the previous scope, and the file column simply
  disappears rather than rendering an empty inspector. `DetailPane`'s `entry` prop is now
  non-nullable and its empty branch is gone with the empty state.
- **`useManagementIndex(refreshKey, active)`.** The `active` gate means a Sessions visitor never
  fetches the config scan; leaving and re-entering re-scans while keeping the previous index
  visible (`index: prev.index` on the loading transition), so there is no flash of "loading".
- **Chat scroll behaviour** is untouched by the modal rewrite: the prepend/anchor logic and
  `overflow-anchor:none` survive, and the filter switch still re-anchors to the tail.

## Findings

### Critical

None.

### Important

- **I-1 · The forecast figure strip asserts a projection it does not have.**
  `client/src/lib/usageProfile.ts:407-420` prints `Projected crossing · none ·
  "the week coasts to its reset"` whenever `exhaustAt` is null — and the server sets
  `exhaustAt: null` in the *absent* branch too (`server/api.ts:640-650`), where there is no walk
  at all. `UsageProfile.tsx:449` renders the strip unconditionally, above the
  `walk.length === 0` branch at `:460` that prints `absentText(walkAbsent)`.
  **Failure:** turn off *Record usage history* and open Usage › Forecast. The page says
  "Usage recording is **off**, so nothing new is being learned" and, four inches above it,
  "the week coasts to its reset" — a positive claim about the week made from zero evidence.
  Same for `walkAbsent: 'no-rate'` and `'no-window'`. The tile needs `walk.length` (or the
  absent reason) to print `—`.

- **I-2 · A crossing in the walk's last hour reads as "no crossing" in the totals row.**
  `client/src/lib/walkRows.ts:130` adds `unpayable += hours` only for slices *after* the one that
  crossed, so a crossing inside the final slice leaves `unpayableHours === 0`;
  `UsageProfile.tsx:325` keys the totals caption off that counter alone.
  **Failure:** a walk of `cum = [20,40,60,80,105]` with `startHead = 80` and the reset at the end
  of the fifth hour returns `{ endHead: -5, unpayableHours: 0 }` (reproduced). The totals row
  then prints "the window coasts to its reset" in one cell while its own **Left** cell prints
  `−5` in the `over` style and the day row above it says "empty at …". The caption should key off
  `endHead < 0`, not `unpayableHours`.

- **I-3 · Enter on a link inside the plan collapses the plan instead of following the link.**
  `client/src/components/PlanPanel.tsx:175-179`. The `onClick` handler at `:170-174` guards with
  `(e.target).closest('a')` and a selection check; the `onKeyDown` handler has neither, and calls
  `e.preventDefault()` on Enter/Space before toggling.
  **Failure:** a proposed plan containing `[the mock](docs/guides/mockups/redesign-mock.html)`.
  Expand the plan, Tab to that link, press Enter — the link does not activate and the plan folds
  shut under the reader. (Related: `role="button"` on a container that holds links is invalid
  ARIA; while the box is clipped its links are still in the tab order but invisible.)

- **I-4 · Reset does not clear `management.type`.** `client/src/hooks/useSettings.tsx:17-20`.
  `OWNED_KEYS` gained `dashboard.layout` but not `management.type`, against the comment directly
  above it ("View-state keys the Reset button clears alongside the settings themselves").
  **Failure:** pick **Hooks** in Management's type column, go to Settings › Reset and confirm.
  Every other view-state key is cleared; Management still opens on Hooks instead of the `Skills`
  default. (It self-heals only if that type has gone away — which is precisely when it would not
  have been noticed.)

- **I-5 · `sessions.md` documents the opposite of the `Last used` behaviour this delta shipped.**
  `docs/subsystems/sessions.md:41-45` — "Which of the five is showing is **not** persisted:
  `SessionsView` seeds a plain `useState` … (`defaultLayout`, default `board`) … A reload lands
  back on the setting" — and `:409-412` — "the switcher … is the one control here that survives
  nothing … ephemeral state". The code persists `dashboard.layout` on every switch
  (`SessionsView.tsx:45-50`) and `DEFAULT_SETTINGS.defaultLayout` is `'last'`
  (`settings.ts:134`), so the default build *does* reopen the last shape.
  **Failure:** a reader follows `sessions.md`, expects a reload to return to Board, and gets
  Triage. The file also now contradicts `view-persistence.md:52-66` and `settings.md`, which the
  same workstream updated correctly. `client/src/components/Toolbar.tsx:38-39` carries the same
  stale "never persisted" claim in its docblock.

- **I-6 · `plainTitle` strips underscore emphasis that `markdown.ts` renders literally.**
  `client/src/components/PlanPanel.tsx:25` (`.replace(/(\*\*|__)(.+?)\1/g, '$2')`). The file's own
  contract at `:17-20` is that the strip is limited to what `markdown.ts` renders inline, so the
  title "can never say less than the heading did" — but `INLINE_RE`
  (`client/src/lib/markdown.ts:52`) handles backticks, `**…**`, `*…*` and `[…](…)` only. It has
  no `__` rule at all.
  **Failure:** a plan headed `## Rename __init__ handling` titles the panel
  `Rename init handling` while the plan body two lines below renders `__init__` verbatim — the
  two disagree, which is the exact drift §8.6 makes the title the heading's own text to avoid.
  Worse intraword: `## Fix the a__b__c key` → `Fix the abc key`, and `` ## Use `__init__` here ``
  → `Use init here`, altering the contents of a code span. `test/split-plan.test.ts:76` pins the
  wrong behaviour (`'## Rename __the__ rail'` → `'Rename the rail'`) six lines before
  `:87-91` asserts the invariant it breaks.

- **I-7 · Docs elsewhere still describe shapes this delta deleted.** Each is a false statement
  about the current code, verified against it:

  | file:line | claims | actually |
  | --- | --- | --- |
  | `docs/subsystems/chat.md:165` | "The `chat` tab (`.row-chat`) is a **sibling** of … (`.row-main`)" | neither class exists; `atoms.tsx` `ChatButton` stops propagation |
  | `docs/subsystems/chat.md:172` | "All five share `PanelChrome`'s head (badge · hint · minimise caret)" | `PermissionBanner` is `.pbanner` with no chrome; `ResumePanel` hand-rolls `.qp-head` with no minimise |
  | `docs/subsystems/settings.md:195` | "the drawer stays flush right" | `.chat` is a centred modal over the scrim |
  | `docs/subsystems/settings.md:225` | "The header's `N need you` pill" | a *Need you* fact row in `AsideBoard`; `Header.tsx` is deleted |
  | `docs/subsystems/push-notify.md:74` | "The header's `N need you` pill is a different thing" | same |
  | `docs/overview.md:275` | "header account usage bars" | the `AsideAccount` card in the sessions aside |

### Minor

- **M-1** `client/src/styles.css` — `.qpanel.gone` has no rule anywhere; HEAD had
  `.qpanel.sent,.qpanel.gone{padding:8px 16px}`. The class rendered by `QuestionPanel.tsx:81`,
  `PlanPanel.tsx:103` and `MessagePanel.tsx:51` is now inert, and both one-line notes take the
  full 18px/24px panel padding. Plausibly intended; say so, or restore the tighter pair.
- **M-2** `client/src/styles.css:1118` — `.qpanel.spawn{max-height:none;overflow:visible}` is now
  a no-op (`.qpanel` lost its `max-height:56vh`; the cap moved to `.chat-pinned`), and its
  comment still explains a "fixed-height chat drawer" that no longer caps anything.
- **M-3** `client/src/components/Toolbar.tsx:71` — `className="seg ctl"`; `.ctl` has no rule.
  (Carried over unfixed from the sessions review's M-4.)
- **M-4** `client/src/components/QuestionPanel.tsx:172` — `className="qp-opt other"`; there is no
  `.qp-opt.other` rule. The `Other` row's styling comes entirely from `.qp-otherbox`.
- **M-5** `client/src/lib/walkChart.ts:193` — `cross < i` skips the synthetic zero node when the
  crossing lands exactly on an integer x, and `below: head < 0` at `:197` then leaves that node
  above the rule. Reproduced with `cum = [50,75,100,125]`, `gain = 25`, `startHead = 50`
  (`crossingX === 2`): the headroom segment runs `[0,1,2,3]` — painting the 25-point deficit in
  the *above-the-rule* ink — and the debt segment is a single point, so the debt area is
  zero-width. Requires exact float equality (`cum === 100`, or `cum[0] >= 100` at `:278`), which
  is why it is Minor rather than Important; `cross <= i` fixes it.
- **M-6** `client/src/lib/walkChart.ts:345` — `stepTitle` hardcodes the sign, so a zero-weight
  hour tooltips "−0.0 pts this hour".
- **M-7** `client/src/components/usage/UsageProfile.tsx:209` with `walkChart.ts:173` — at
  `utilizationPct >= 100` the axis label still prints `Math.round(startHead)` ("0 pts" /
  "−20 pts") while `yHead` clamps it to the bottom of the box, on top of the `empty` and debt
  labels.
- **M-8** `client/src/lib/usageRatesFormat.ts:370-373` — `pricedShare` divides by the `utilSum` over
  the *current* range while the total row prints `coverage.pricedPct` over the 14-day baseline.
  With every model idle in the current window but priced in the baseline, every Share cell reads
  `—` beside a non-zero total.
- **M-9** `docs/overview.md:223-228` — the `lib/` list gained `walkRows` but never listed
  `triage.ts` (new in this delta, and the source of `triageGroups`).
- **M-10** `docs/subsystems/sessions.md` `docs-sync: sources:` lists only `atoms.tsx`,
  `BoardView.tsx` and `TriageView.tsx` out of the nine files under `components/sessions/`, and
  omits `AsideAccount.tsx`. Every path that *is* listed exists — a scan of every `sources:` block
  under `docs/subsystems/` found no missing file.
- **M-11** `docs/subsystems/settings.md:3` — "The fourth section tab"; Settings is the fifth
  entry in `SECTIONS` (`client/src/lib/sections.ts:15-19`). Pre-existing, not this delta's doing.
- **M-12** `client/src/components/QuestionPanel.tsx:9` — `const OTHER = '\0other'` embeds a raw
  NUL byte, so git classifies the file as binary (`Bin 7096 -> 9088 bytes`). The byte predates
  HEAD, but the consequence lands here: the most heavily rewritten component in the chat
  workstream shipped with **no reviewable textual diff**, and no three-way merge is possible on
  it. `' other'` as an escape would read identically to the code and keep the file text.
- **M-13** The sessions review's I-3 is still open: `BoardView.tsx:37`, `ListView.tsx:46`,
  `TilesView.tsx:26` and `SplitView.tsx:27` are pointer-only (no `tabIndex`/`onKeyDown`), and
  `Popover.tsx` still neither moves focus in nor restores it on close.

## Test coverage gaps worth closing

Everything below passes today; none of it is asserted anywhere.

- `resolveLayout` is well covered, but nothing asserts that **Reset clears `dashboard.layout`** —
  the assertion that would have caught I-4 for its sibling key.
- `plainTitle` has no case for `__…__`, intraword `a__b__c`, or emphasis marks inside a code
  span (I-6). The suite asserts the invariant in prose at `:87-91` and contradicts it at `:76`.
- `headSegments` has no case where `crossingX` returns an integer (M-5), and none where
  `startHead <= 0` (M-7).
- `walkRows` has no case where the crossing falls in the final slice (I-2), none where `resetsAt`
  precedes the last step (the `Math.max(0, …)` at `walkRows.ts:99` silently yields `hours = 0`
  for the tail), and the fractional first row is only asserted at exact local noon.
- `forecastStats` is never called with `walk: []` and a `walkAbsent` reason (I-1).

## What a human still has to look at

The four dark themes rendered rather than read; Management between 700px and 1330px; the
`prefers-reduced-motion` paths; and every wait panel with a real hold behind it — a pending
question, a proposed plan, a reply window and a resume offer stacked in the new floating layer.
Nothing in this review drove those; the layer was measured with a stand-in of a known height.
