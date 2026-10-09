# Review 1 — `2026-10-09-pin-reorder-design.md`

Reviewer: fresh subagent (Fable 5.1), read-only. Verified every code claim against the tree at `main` (`d6d34b9`); the mockup file was read in full.
Doc lines are `design.md:<n>`; mockup lines are `mockups.html:<n>`.

## Verdict: APPROVE WITH FIXES

No Critical findings. Six Important ones — four false or incomplete statements of fact, one internal contradiction (keyboard focus vs disabled grips),
one 409 path an implementer must guess at. Every table value in §6 recomputes correctly.

## Important

### I1 — `client/package.json` does not exist (design.md:22)

The spec grounds "no drag library" on "`client/package.json` has only `react` and `react-dom`". There is no such file; the one `package.json` is at the repo
root and its `dependencies` (`package.json:34-41`) are `@fontsource/barlow`, `@fontsource/barlow-condensed`, `@fontsource/ibm-plex-mono`, `lookout-widgets`,
`react`, `react-dom`. The conclusion (zero dnd dep) holds, the cited evidence does not.
→ Cite the root `package.json` and say "no drag-and-drop dependency", not "only react and react-dom".

### I2 — The Lookout git widget already follows pin order, so "only the two surfaces" is false (design.md:18, :166-171)

`server/lib/hub-widgets.ts:53` ("each group in pin order") and `docs/subsystems/hub-widgets.md:61` document that the Git pending tile's rows are grouped
pull / push / unreadable and ordered by pin order inside each group; the data comes from `readGitStats`, which reads `getPinnedProjects()`
(`server/lib/git-stats.ts:422`). Reordering pins therefore reorders the tile without any code change. The decision row says "Only the two surfaces that
already do: Management › Pinned and Management › Git" and §7 lists "Lookout's git widget ordering" as out of scope — both read as if the widget is unaffected,
which an implementer (and the PR's "what changed" section) would repeat.
→ Rewrite the row: three surfaces already read the stored order (Pinned, Git, the Lookout git tile) and all three follow it with no change; drop or reword the
§7 bullet so it says "no code change to the widget", not that its ordering is out of scope.

### I3 — Keyboard reorder contradicts "grips disabled while busy" (design.md:92 vs :95-96, :16)

Line 16 says the order saves on each key press; line 92 says grips are `disabled` while `busy` is non-null; lines 95-96 say "Focus stays on the moved row's
grip after the re-render". Each ArrowUp/Down sets `busy = 'order'` (line 77), which disables the focused grip. Chrome moves focus to `body` when the focused
element becomes disabled (Firefox keeps it), so after the first press the next ArrowDown reaches no handler, `preventDefault` never runs, and the page scrolls
instead of moving the row — behaviour that differs by browser. The existing `PinPicker.tsx:80` pattern (`disabled={busy !== null}`) is what the spec is
extending, so this will be built as written.
→ Pick one and state it: either grips use `aria-disabled` + an early return in the handlers while busy (focus survives), or the moved grip is re-focused once
`busy` clears (and key presses arriving while busy are dropped, not queued). Say which, and add the browser-pane check "press ↓ three times fast on Chrome".

### I4 — 409 path: the error can land on a row that no longer exists, and the re-fetch's own failure is unspecified (design.md:75, :98-99)

On 409 `reorder` re-fetches `GET /api/pins`, replaces `pins`, and returns "Pins changed in another tab — reloaded." Line 98-99 then shows that text "under the
dragged row (the existing `error` state, keyed by that dirName)" — `PinPicker.tsx:39,51` keys the error by dirName and renders it only inside that row. The
commonest 409 cause is that very row having been unpinned in the other tab, so the message renders nowhere. Separately, the re-fetch is a second network call
whose failure (checklist 3) has no stated outcome: roll back to the pre-drag `pins`, keep the optimistic order, or set `pins` to null?
→ State where the 409 text goes when the dirName is gone (e.g. beside the Pinned heading where `Saved` goes), and state that a failed re-fetch rolls back to
the pre-drag `pins` and returns the network text.

### I5 — Mockup elements not carried into §4.4 and not called out as dropped (design.md:103-111 vs mockups.html:82-85, :106)

§4.4 says "Ported from the mockup, tokens only" and lists four rules. Variant A in the mockup also has: `.pin-row.moved` — a 0.9s `flash` keyframe on the
row that just moved (`mockups.html:84-85`, reduced-motion exemption at `:106`, driven from `commit()` at `:252`); `.pin-row.drag .pin-grip{color:var(--cyan)}`
and `cursor:grabbing` on the grip rather than the row (`:83`); the phone-layout column shifts `.pin-row.g .pin-age{grid-column:2}` / `.qp-term{grid-column:3}`
(`:69-70`), without which the existing `.pin-age{grid-column:1}` / `.qp-term{grid-column:2}` rules (`styles.css:1832-1833`) put the age under the grip and the
Unpin over the path. An implementer reading the four bullets as exhaustive ships none of these; one reading "ported from the mockup" ships all of them.
→ Either list every proposed rule from `mockups.html:66-93` that ships, or say "every rule under `/* proposed additions */` for variant A ships, except …"
and name the exceptions (the `.moved` flash is the one that is a product decision).

### I6 — §5 Docs misses the doc that describes the Pinned page (design.md:113-117)

`docs/subsystems/settings.md:21-22` is where the Management › Pinned page's rows are described ("the pins under a heading of their own with an Unpin each,
the rest under another with a Pin each, one filter over both"); it is not in §5. `configs.md:96-107` (listed) covers the server-side pin rule, not the page.
`.claude/DESIGN.md:323` also says Pinned "moved unchanged" from Settings — a grip column is a change to that card.
→ Add `docs/subsystems/settings.md` (the Pinned page paragraph) to §5; decide whether DESIGN.md §8.4b gets a sentence.

## Minor

- design.md:116 — `configs.md` has no `§Pinned projects` heading (`## Mechanism`, `## Invariants` only; the pin text is a bullet at `:96`). Say "the Pinned
  projects bullet under §Mechanism".
- design.md:49 — `shared/types.ts:1588` JSDoc on `PinsResponse` reads "Payload of `GET /api/pins`, and of a successful `POST /api/pins`"; the new route
  answers the same body, so that comment and the route list at `server/index.ts:10` want one line each. Neither is in §3.2 or §5.
- design.md:59 — clamp to `[0, order.length - 1]` is `[0, -1]` for an empty `order`; harmless only if the "name not in order → same reference" check runs
  first. State the check order.
- design.md:83 — the mockup moves the dragged row when the pointer is anywhere inside another row's rect (`mockups.html:317`), not at its vertical midpoint.
  The spec's midpoint rule is the better one (no oscillation); say the mockup differs.
- design.md:84 — "On pointerup, if the draft differs from the order at drag start" — once `onReorder` is called the draft should be dropped in favour of the
  (optimistically updated) `pinned` prop, or the row flickers when the 200 reply lands. One sentence.
- design.md:85 — "Escape cancels": Safari does not focus a `<button>` on pointerdown, so a keydown listener on the grip will not see Escape mid-drag; the
  listener must be on `document`/`window` for the drag's lifetime. Implementation detail, but the browser-pane check at :162 runs on Chromium only.
- design.md:109 — the grip's 28×36 hit area is the phone's drag handle; `.claude/DESIGN.md:168` names 44px as "the touch floor, which the strip is bound by".
  The row is taller than 44 (two lines + 20px padding), so the grip could span the row height (`height:100%` / `align-self:stretch`) without widening the
  column. Taste; note it or reject it.
- design.md:146 — the existing case at `test/api-git-stats.test.ts:77` already proves "reordering the pins reorders the answer" (via unpin + re-pin); the new
  case is a near-duplicate through `setPinOrder`. Fine to keep — just name it so the two titles differ.
- design.md:162 — add the second-finger case to the pane checklist: a touch drag in progress while another finger taps Unpin on a different row changes the
  `pinned` prop mid-drag; the spec says nothing about what the draft does then (reset to the new prop order is the safe answer).
- mockups.html:123 — the mockup's note says the order "saves on drop"; the spec also saves per key press (design.md:16). Consistent, but the mockup's prose
  only mentions drop.

## Verified true (no finding)

- `settings.ts` pin store, `setPinned` appends via `clampPinned` (`server/lib/settings.ts:330-341`); `persist`, `readStored`, `cached`, `resetSettings` as
  described (`:94`, `:167`, `:309`, `:343`).
- `servePinsWrite` gate order and messages (`server/api.ts:1714-1729`); `sendBadBody` is 400 (`:450-454`); `readJsonBody` returns null on non-JSON (`:343-348`);
  `methodNotAllowed` is 405 (`server/index.ts:137-140`); `/api/pins` wiring (`:222-225`); `pinsPayload` is module-private in `api.ts` (`:1655`).
- `listPinRows` preserves `dirNames` order (`server/lib/management.ts:713-732`); `readGitStats` maps pins in order (`git-stats.ts:422-424`); Cards and Table
  iterate `repos` unsorted (`GitCards.tsx:16`, `GitTable.tsx:34`); `triageGitRepos` keeps input order per group (`client/src/lib/gitTriage.ts:17-21`).
- `pruneProjects` / `clearFilters` same-reference convention (`client/src/lib/filterSort.ts:160-168`, `:256-259`); `usePins` messages and `busy` slot
  (`client/src/hooks/usePins.ts:40-58`); `PinPicker` error keyed by dirName, rows keyed by dirName, buttons disabled on any busy (`PinPicker.tsx:39,51,79-80`);
  launch sheet passes no `pinned` (`SpawnPanel.tsx:189`).
- Management › Pinned sits in `.set` (`ManagementView.tsx:25`), so `.set .pin-list{max-height:none;overflow-y:visible}` (`styles.css:1819`) and `.main` has
  no `overflow-y` (`:279`) — document scroll, as :85 says. `md` = 768px (`.claude/DESIGN.md:244`, `styles.css:1837`). All five tokens exist (`styles.css:15-29`).
- Sessions rail / Configs sidebar / launch sheet sort by `lastActiveMs` (`management.ts:644`, `:704`; `configs.md:99`).
- §6 `movePin` table: all eight rows recompute as stated. `setPinOrder` table: consistent with §3.1. `test/pins-client.test.ts` already imports from
  `lib/pins.js` (`:3`); the three other test files exist.
- Browser-pane limits match memory `browser-verification-limits` (token POSTs prove only 403).
- No `.claude/rules/` directory. CLAUDE.md hard rules touched (tokens only, zero deps, ESM, shared types first, docs in subsystems) are respected.
