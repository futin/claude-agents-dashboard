# Settings → Local / Shared pages (redesign branch)

Port of `docs/guides/mockups/redesign-mock.html` artboards `#set-local` / `#set-shared`
to the client. Behaviour and test cases only — no literal code.

## Shape

- Settings becomes two pages, **Local** (this browser's `localStorage`) and **Shared**
  (the server's `.dashboard-settings.json`), picked the way Usage picks Forecast /
  Token value: a tree under the rail row on desktop, a pill switch in the section bar
  on the phone. Exactly one of the two is visible at any width; both write one setting.
- Each page: a **band** on the app ground (title 19/500 + scope pill + one-line
  subtitle, no card), then sub-category **cards** in two hand-balanced columns.
  - Local · col 1: Display, New sessions, Reset · col 2: Live data, Notify this browser
    (absent where `Notification` is), Connection.
  - Shared · col 1: Push notifications · col 2: Remote answers, Usage forecast.
- **Answer token** moves from *Remote answers* to a new Local card **Connection** — it is
  `localStorage`, so a Shared page carrying it would break the categories' promise.
- Group titles lose their ` · this device` / ` · every device` suffix: the page is the scope.

## Changes by boundary

### Client — model (`client/src/lib/settings.ts`)
- New flat field `settingsTab: SettingsScope` where `SettingsScope = 'local' | 'shared'`,
  default `'local'`, validated with `pickOne`. Mirrors `usageTab` exactly.

### Client — rail (`client/src/components/SideRail.tsx`)
- Generalise the Usage-only tree: a table of `{section → sub-items + which setting key
  they write}` covering `usage` (`usageTab`) and `settings` (`settingsTab`). Rendered only
  while that section is open, as today. Labels: **Local**, **Shared**.

### Client — page (`client/src/components/settings/`)
- `SettingsView` reads `settings.settingsTab`, renders the band + phone switch, and one
  of two column layouts. Rows, hooks, warnings, test buttons: unchanged logic, regrouped.
- `SettingsGroup` gains a required `sub` line and renders as a card
  (title 19/500, subtitle 13 `--ink2`). New `SettingsBand` (title, scope, subtitle) and a
  scope pill.
- The `needsToken` warning (Shared page) points at *Local › Connection* by name, since
  the token field is no longer "below".
- Reset row renamed **Reset this browser**; hint says "every Local setting".

### Client — CSS (`client/src/styles.css`, settings block only; tokens only)
- `.set` no `max-width`; `.set-cols` 2-col grid (`align-items:start`), `.set-col` stacked
  16px; single column ≤ 1100px.
- `.set-group` → card: `--strip`, 1px `--hairline`, radius 16, padding 24, no shadow.
- `.set-row` → no box: 16px vertical padding, `--hairline` top rule, first row none;
  hint `max-width:56ch`.
- Controls one family, 36px, radius 12, 1px `--hairline2`: select / number / text /
  buttons. `.set-seg` becomes the pill switch (recessed `--steel` track, raised `--strip`
  active) — the rules now under `.usage-tabs .set-seg` move to the base and `.usage-tabs`
  keeps only its `display` swap. `.set-tabs` shares those display rules.
- Theme picker: 5-col grid, 3 equal bars 28px, radius 12; selected = `--ink` border + ring.
- `.set-warn` → flat tinted box, radius 12, `color-mix(… var(--amber) 12%, transparent)`.
- `.set-scope` pill: `--strip` on the ground, `--ink` text, `--ink2` dot; `.shared` =
  `color-mix(… var(--green) 22%, transparent)` fill, `--green` text.
- Phone (≤700px): rows stack, `.set-tabs` shown, columns already single.

### Client — shell (`client/src/App.tsx`)
- `wide` includes `settings` (two columns need the 1280px wrap).

### Docs
- `docs/subsystems/settings.md`: the two pages, `settingsTab`, where Answer token lives,
  the phone/desktop swap; group names without suffixes.
- `docs/subsystems/view-persistence.md` line 68 and `push-notify.md` lines 5/49: new names.
- `.claude/DESIGN.md` §8: one paragraph on the settings cards being the first
  reference-design cards on the board (radius 16, hairline, no shadow).

## Tests (`test/client-settings.test.ts`)
- `settingsTab` defaults to `'local'`; `clampSettings({settingsTab:'shared'})` → `'shared'`;
  `'nonsense'` and `7` → `'local'`; one bad sibling (`theme:'chartreuse'`) does not
  discard `settingsTab:'shared'`.
- Existing cases unchanged; `pnpm test` and `pnpm typecheck` must both print green.

## Verify in the browser (`pnpm dev`)
- Daylight: both pages at 1400px and 390px; rail tree shows Local/Shared only while
  Settings is open; phone shows the pill and hides the tree.
- Midnight: every new surface still reads (no literal colours — `grep -nE "#[0-9a-f]{3,6}"`
  on the settings block returns nothing).
- Flip a Local toggle on the Local page → persists; flip Away after on Shared → `saving…`
  shows on that row only.

## Not in scope
- Re-skinning the other sections' cards; usage/analytics keep their current chrome.
- Any server change. No API field is added.
