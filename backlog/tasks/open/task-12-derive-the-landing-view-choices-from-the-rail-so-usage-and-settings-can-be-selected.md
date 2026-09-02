---
id: task-12
title: Derive the landing-view choices from the rail so Usage and Settings can be selected
created: 2026-09-02
from: idea-15
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
