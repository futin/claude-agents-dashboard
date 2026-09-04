---
id: task-12
title: Derive the landing-view choices from the rail so Usage and Settings can be selected
created: 2026-09-02
from: idea-15
updated: 2026-09-03T20:10:45Z
started: 2026-09-03T19:56:19Z
execute-elapsed: 866
---

## Goal

"Opens on" in Settings offers every section the side rail offers — Sessions, Management,
Analytics, **Usage**, **Settings** — plus "Last used", and the validator in
`clampSettings` accepts exactly that same set. One list, derived from the rail, so the
picker and the validator cannot drift apart again (today they disagree in both
directions: `usage` is in neither, `settings` validates but can never be picked).

## Decisions taken during grooming

Both of idea-15's open questions were settled from the code rather than in an
interactive brainstorm — the user was away when this was groomed. Either is a one-line
change if they turn out wrong, and both are called out in the PR body.

1. **Settings *is* landable.** `Landing = Section | 'last'` already says so, `LANDINGS`
   in `client/src/lib/settings.ts:118` already validates `'settings'`, and
   `App.tsx`'s final render branch already renders it — so it is reachable today by a
   hand-edited localStorage value and behaves fine. The rail is present on every
   section, so landing there traps nobody. Excluding it would mean carrying an
   exclusion list, which is the second hand-maintained array this task exists to
   delete. Assumption stated: a section you can navigate to is a section you can land
   on, no exceptions.
2. **A stored section a future build removes needs no new guard.** Deriving `LANDINGS`
   from the rail's own list means a removed id stops validating the moment it leaves
   that list, and `clampSettings` falls the field back to `'last'` on its own.
   `isSection` in `App.tsx:42` stays where it is — it guards `dashboard.section` (the
   *last used* value), which never passes through `clampSettings` at all.

## Plan

Bounded change, one commit, five source files plus docs. No server change, nothing
crosses the API boundary, `shared/types.ts` is untouched — this is localStorage state.

**1. New `client/src/lib/sections.ts` — the single source of truth.**

Move out of `client/src/components/SideRail.tsx` and into this new module, unchanged in
content and order:

- the `Section` union (`'sessions' | 'management' | 'analytics' | 'usage' | 'settings'`),
- the section list, renamed `SECTIONS` on the way (same `{ id: Section; label: string }[]`
  shape, same five entries, same order — the rail's order is the picker's order),
- `isSection(v: unknown): v is Section`, still implemented against that list.

Why a `lib/` module and not an export from the component: `lib/settings.ts` needs the
list at **runtime** now, not just as a type, and `test/client-settings.test.ts` imports
`lib/settings.js` under `tsx` in plain Node. Importing a `.tsx` component from there
would drag `react/jsx-runtime` into a node-assert test's import graph for a five-element
array. `sections.ts` has no JSX and no imports.

**2. `client/src/components/SideRail.tsx` — consume, don't own.**

Import `SECTIONS` and `type Section` from `../lib/sections`; drop the local `Section`,
`TABS` and `isSection`; map over `SECTIONS` where it mapped over `TABS`. Markup, class
names, `aria-current`/`aria-label` and the `Props` interface all stay byte-identical —
this is a nav component, and `styles.css` class names are load-bearing. Do **not**
re-export `Section`/`isSection` from here: two import paths for one thing is how the
duplication starts.

**3. `client/src/App.tsx` — follow the moved exports.**

`isSection` and `type Section` now come from `./lib/sections`; `SideRail` still comes
from `./components/SideRail`. Two import lines instead of one, no logic change. The
`useState` initializer, the `change` callback and the `wide` test are untouched.

**4. `client/src/lib/settings.ts` — derive both lists.**

- Replace the `import type { Section } from '../components/SideRail'` with a value
  import of `SECTIONS` plus `type Section` from `./sections`.
- Add an exported `LANDING_OPTIONS: { value: Landing; label: string }[]` — `'last'`
  labelled `Last used`, then one entry per `SECTIONS` element carrying that section's
  own rail label. Exported because the picker renders it and the test asserts on it;
  keeping it here rather than in the view is what lets the test import it without React.
- Redefine the existing module-private `LANDINGS: Landing[]` as the values of
  `LANDING_OPTIONS`. `clampSettings`'s `landing:` line does not change — it already
  reads `LANDINGS`.
- Leave `Landing`, `DEFAULT_SETTINGS.landing` (`'last'`) and every other field alone.

**5. `client/src/components/settings/SettingsView.tsx` — render the derived list.**

Delete the local `LANDINGS` array at line 38 and import `LANDING_OPTIONS` from
`../../lib/settings` instead; the `<select>` at line ~151 maps over it. The `Opens on`
row's `name`/`hint` copy stays as-is — it already says "which section", and now that is
true of all five.

**6. `test/client-settings.test.ts` — cover `landing`, which today has zero cases.**

See `## Test cases`. Add them to the existing `run()` alongside the `usageTab` case they
mirror, in that style: `test('…', () => { … })` guarded by `if (…) p++; else f++;`.

**7. Docs — three touches, all one-liners.**

- `docs/overview.md`: add `sections` to the `client/src/ lib/` list (line ~182).
- `docs/subsystems/settings.md`: the per-device paragraph says "landing tab"; make it
  say the landing tab offers every rail section plus Last used, and name
  `lib/sections.ts` as where that set lives.
- `docs/subsystems/view-persistence.md` (~line 43): it points `dashboard.section` at
  "the `Section` union in `SideRail.tsx`" — repoint it at `lib/sections.ts`, and drop
  `Guides` from the section list it enumerates in the same breath (that tab was removed;
  the union has no `guides`).

No `docs-sync` stamp work beyond those edits, and no new subsystem doc — this changes
where an existing list lives, not what the subsystem does.

## Test cases

All in `test/client-settings.test.ts` (which already imports `clampSettings`,
`DEFAULT_SETTINGS`; add `LANDING_OPTIONS` from `../client/src/lib/settings.js` and
`SECTIONS`, `isSection` from `../client/src/lib/sections.js`).

1. **`landing: 'usage'` survives `clampSettings`** — `clampSettings({ landing: 'usage' })
   .landing === 'usage'`. This is idea-15's defect; it must fail before step 4 and pass
   after.
2. **Every rail section is an accepted landing** — for each `s` of `SECTIONS`:
   `clampSettings({ landing: s.id }).landing === s.id`. Five assertions, each with the id
   as the assert message so a failure names the section.
3. **`'last'` is still accepted and still the default** —
   `clampSettings({ landing: 'last' }).landing === 'last'`,
   `clampSettings({}).landing === 'last'`, `DEFAULT_SETTINGS.landing === 'last'`.
4. **Junk and removed sections fall back** — `clampSettings({ landing: 'guides' })
   .landing === 'last'` (a value from the build that had a Guides tab),
   `clampSettings({ landing: 42 }).landing === 'last'`,
   `clampSettings({ landing: '' }).landing === 'last'`. Complement of case 2 — the rule
   proved one way, then the other.
5. **The picker's set is the intended set, spelled out literally** —
   `LANDING_OPTIONS.map(o => o.value)` deep-equals
   `['last', 'sessions', 'management', 'analytics', 'usage', 'settings']`, and
   `LANDING_OPTIONS.length === 6`. Written as a literal on purpose, not derived from
   `SECTIONS`: a test that derives its expectation from the same array as the code under
   test passes no matter what either says. This one fails if a section is added to the
   rail without a decision about landing on it, which is the drift this task closes.
6. **Each option carries the rail's own label** — the `'usage'` option's label is
   `'Usage'`, the `'settings'` option's is `'Settings'`, the `'last'` option's is
   `'Last used'`. Guards against a third hand-written label list creeping back in.
7. **`isSection` still answers the rail, and `'last'` is not a section** — true for all
   five `SECTIONS` ids; false for `'last'`, `'guides'`, `''`, `undefined`, `42`. `'last'`
   returning false is the load-bearing one: `App.tsx` relies on it never being treated as
   a renderable section.
8. **In the browser (playwright MCP tools):** with `pnpm dev` running, open
   `http://localhost:5174`, go to **Settings**, and open the **Opens on** select — it
   lists six options, including **Usage** and **Settings**. Choose **Usage**, then reload
   the page: the Usage section is showing (its forecast/rates tabs are visible, not the
   sessions list), and the rail's Usage entry is the highlighted one. Then set **Opens
   on** back to **Last used** so the dev machine's own localStorage is left as found.

## Done when

- `pnpm test` passes, with the eight cases above included and the count printed.
- `pnpm typecheck` passes — it is what proves the three moved exports have no stale
  importer left anywhere.
- `pnpm build` passes: `SideRail` is in the eager Sessions bundle while `SettingsView` is
  lazy, and step 4 makes `lib/settings.ts` import a value from a module the rail also
  imports — the build is the check that this stayed a shared leaf module and did not pull
  a lazy chunk into the initial one.
- The browser check in case 8 came out as described, from a real reload rather than an
  in-page navigation — an in-page click would prove the rail works, not the landing
  preference.
- `client/src/lib/settings.ts` and `client/src/components/settings/SettingsView.tsx` no
  longer each define a `LANDINGS` array; `grep -rn "LANDINGS" client/src` shows one
  module-private definition derived from `LANDING_OPTIONS`, and nothing in
  `components/`.
- The three doc lines in step 7 match the code, and `pnpm test`'s `docs-links` case still
  passes.

## Outcome

**2026-09-03 — done as planned.** The rail's list moved to a new `client/src/lib/sections.ts`
(`Section`, `SECTIONS`, `isSection`), `SideRail.tsx` now consumes it instead of owning it, and
`lib/settings.ts` derives both the picker's `LANDING_OPTIONS` and the module-private `LANDINGS`
validator from that one array. `SettingsView.tsx`'s hand-written four-entry list is gone. All
seven plan steps landed; nothing crossed the API boundary.

Two deviations from the plan, both trivial: `App.tsx` ended up with the `lib/sections` import
sorted next to `lib/deepLink` rather than beside the component import, matching the file's
existing grouping; and `LANDING_OPTIONS` was added to `settings.ts` one step before `LANDINGS`
was derived, so the two defect cases could go red on the real bug rather than on a missing
export (an absent named export is a link-time error that would have taken the whole test file
down and proved nothing).

### Red before green

With `LANDINGS` still hardcoded, the two cases that name the defect failed and nothing else did:

```
  ✗ the landing preference accepts usage, the section it used to drop
    Expected values to be strictly equal:

'last' !== 'usage'

  ✗ every rail section is an accepted landing
    usage

'last' !== 'usage'

  16 passed, 2 failed
```

### `pnpm test` — exit 0

```
=== client/lib/settings.ts ===

  ✓ anything unusable falls back to the defaults
  ✓ one bad field cannot discard the rest
  ✓ numbers are clamped to the offered range
  ✓ the client caps match the server caps
  ✓ every advertised theme is a distinct id
  ✓ the Usage sub-tab defaults to the forecast and rejects anything else
  ✓ the landing preference accepts usage, the section it used to drop
  ✓ every rail section is an accepted landing
  ✓ last used is still accepted and still the default
  ✓ junk and removed sections fall back to last used
  ✓ the picker offers exactly the six intended choices
  ✓ each landing option carries the rail's own label
  ✓ isSection answers the rail, and last is not a section
  ✓ scanQuery carries all three knobs
  ✓ full chat text is off by default and coerces to a boolean
  ✓ chatQuery adds full=1 only when the toggle is on
  ✓ intervals read as humans write them
  ✓ the fresh-browser session cap matches the server default

  18 passed, 0 failed
```

Whole suite: `TEST EXIT: 0`, `ALL PASS`, 1133 ✓ cases (7 of them new). `=== docs links ===`
still `4 passed, 0 failed`, so step 7's three doc edits resolve.

### `pnpm typecheck` — exit 0

```
$ tsc --noEmit
typecheck exit: 0
```

No stale importer of the three moved exports anywhere in the tree.

### `pnpm build` — exit 0

```
dist/assets/SettingsView-RPPsTtqk.js    39.12 kB │ gzip:  6.11 kB
dist/assets/UsageView-C9yEX8ZF.js       39.29 kB │ gzip:  7.24 kB
dist/assets/index-DfaLpF2B.js          389.19 kB │ gzip: 111.28 kB
✓ built in 1.17s
```

`SettingsView` and `UsageView` are still their own lazy chunks — `sections.ts` folded into the
eager `index` chunk as the shared leaf it was meant to be, and did not drag a lazy chunk into
the initial one.

### Mutation check on the drift guard

Dropping `{ id: 'usage', … }` from `SECTIONS` — the exact regression this task exists to
prevent — turns three of the new cases red:

```
  ✗ the landing preference accepts usage, the section it used to drop
  ✗ the picker offers exactly the six intended choices
  ✗ each landing option carries the rail's own label
  15 passed, 3 failed
```

Note that "every rail section is an accepted landing" correctly stayed green under that
mutation: it derives its expectation from `SECTIONS`, which is precisely why case 5 spells the
six values out as a literal. Restored: `18 passed, 0 failed`.

### Browser check (case 8)

Run against a dev server started **in this worktree** on `PORT=4273 WEB_PORT=5273` — port 5174
was already serving the *main* checkout's code, which would have given a false pass. That
server was left untouched (`5174: 26937`, `4173: 26948` still alive after teardown; only PIDs
on 5273/4273 were killed).

- The rail still renders all five buttons under `navigation "Sections"` after the move.
- Settings → **Opens on** listed exactly six options: `Last used, Sessions, Management,
  Analytics, Usage, Settings`.
- Chose **Usage**, then reloaded the page (a real `page.goto`, not an in-page click):

  ```json
  {
    "landing": "usage",
    "storedSection": "settings",
    "railOn": ["Usage"],
    "ariaCurrent": ["Usage"],
    "sessionsListPresent": false
  }
  ```

  `dashboard.section` was still `settings` from the visit before, so the page opening on Usage
  is the *landing preference* winning over last-used — not navigation. The Usage view's
  Forecast / Token value tabs were showing, and the rail's Usage entry carried both `.on` and
  `aria-current="page"`.
- **Opens on** was set back to `Last used` afterwards, and the browser was closed.

### Not verified

- Only the derived-list behaviour was exercised in a browser; the other four themes/densities
  were not re-checked, as no CSS or token changed.
- The two grooming assumptions still stand unproven *as preferences* rather than as code:
  landing on **Settings** is now selectable, and a section a future build removes falls back to
  `Last used` with no dedicated guard. Both behave as designed and are covered by tests, but
  whether Settings *should* be an offered landing is a product call the user has not made —
  it is a one-line change to `LANDING_OPTIONS` if not.
