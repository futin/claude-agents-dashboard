# Side-rail Section Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the dashboard's four-button section switch from a horizontal row above the content to a vertical rail down the left edge, degrading to a horizontal scroll strip on phones.

**Architecture:** A new `.shell` flex box wraps a sticky `.rail` (200px, `flex:0 0 200px`) and a `.main` column that inherits the page padding the `body` used to own. `SectionTabs.tsx` is renamed `SideRail.tsx` and re-styled with new class names; the existing `.wrap` max-width caps nest unchanged inside `.main`, so the content column keeps today's reading measure and left alignment. All styling is existing theme tokens — no new colors, no new dependency, nothing crosses the API boundary.

**Tech Stack:** React 18 + TypeScript, Vite, plain CSS in `client/src/styles.css` (no CSS framework, no CSS modules). Backend untouched.

**Spec:** [`docs/superpowers/specs/2026-08-15-side-rail-nav-design.md`](../specs/2026-08-15-side-rail-nav-design.md)

## Global Constraints

- **Never hardcode a color or a shadow** in `styles.css` below the theme-token block at the top. The five themes are pure `[data-theme]` token overrides; one literal breaks the `daylight` (light) theme. Every value in this plan is an existing `var(--…)` token.
- **Client-only change.** Do not touch `shared/types.ts`, anything under `server/`, or any file in `test/`. The backend is zero-runtime-dep by design.
- **No new dependency**, client or server.
- **Rail width is 200px**, matching the `.mgmt` sidebar already in this stylesheet (not the reference app's 208px).
- **Responsive breakpoint is `max-width:700px`**, matching every other media query in this stylesheet (not the reference app's 768px).
- **`pnpm test` must report 322 passing** at the end of every task. No test file changes anywhere in this plan.
- **Class names are load-bearing.** `client/src/styles.css` is a verbatim port of the original inline `renderPage()` CSS; keep every class name not listed in this plan exactly as-is.
- **React auto-escapes** — there is no `esc()` helper and no `dangerouslySetInnerHTML` in this codebase. Do not add either.

## Why there are no unit tests in this plan

This repo has **no client component test harness** — no vitest, no jsdom, no testing-library. Check `package.json` if you doubt it. `test/` is 24 node-assert suites over backend domain logic plus a handful of *pure* client libs (`lib/settings.ts`, `lib/markdown.ts`, `lib/alerts.ts`), run by `tsx test/run-all.ts`.

Everything this plan changes is layout and markup — a component that renders four buttons, and CSS. There is no pure function to assert on, and standing up jsdom + testing-library to assert "the nav has four buttons" would add two dev dependencies and test nothing that a screenshot doesn't show better.

So the test cycle for each task below is:

1. `pnpm typecheck` — the real safety net here. The `Section` type is imported across three files; the rename breaks the build if any import site is missed.
2. `pnpm test` — proves nothing backend or pure-client moved (322 cases).
3. `pnpm build` — proves the lazy chunks still split.
4. **Browser verification with explicit, checkable observations** — not "looks right", but named states at named viewports on named themes.

Treat step 4 as seriously as a failing assert. "I made the change and it compiled" is not a passing task.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `client/src/components/SideRail.tsx` | **new** (renamed from `SectionTabs.tsx`) — owns the `Section` union type, the section list, and the rail's markup + a11y attributes |
| `client/src/components/SectionTabs.tsx` | **deleted** |
| `client/src/App.tsx` | the shell: `.shell` > `.rail` + `.main` > `.wrap`; section state and lazy section loading, unchanged |
| `client/src/lib/settings.ts` | unchanged except line 21's import path (it derives `Landing` from `Section`) |
| `client/src/components/Header.tsx` | the summary block: timestamp, active-count sub-line, usage bars. No longer owns the app title |
| `client/src/styles.css` | `.shell` / `.rail` / `.rail-link` / `.rail-brand` / `.main` rules replace `.tabs` / `.tab`; `body` loses its padding |
| `docs/overview.md`, `.claude/CLAUDE.md` | architecture-map lines naming the old component |

---

## Task 1: The rail and the shell

Replaces the horizontal tab row with the sticky left rail, in one coherent change — a commit that ships half a nav is not reviewable. No brand block yet (Task 2 adds it together with the title removal, so the title never appears twice).

**Files:**
- Create: `client/src/components/SideRail.tsx`
- Delete: `client/src/components/SectionTabs.tsx`
- Modify: `client/src/App.tsx` (whole file)
- Modify: `client/src/lib/settings.ts:21` (import path only)
- Modify: `client/src/styles.css:100` (body padding), `client/src/styles.css:104-108` (replace the tab rules)
- Test: none — see "Why there are no unit tests in this plan"

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `client/src/components/SideRail.tsx` exports
  - `export type Section = 'sessions' | 'management' | 'analytics' | 'settings'` (unchanged union, moved file)
  - `export function SideRail(props: { section: Section; onChange: (s: Section) => void }): JSX.Element`

  Task 2 adds a `.rail-brand` element inside `SideRail`'s `<nav>`; the props signature does not change.

- [ ] **Step 1: Create the new component file**

Create `client/src/components/SideRail.tsx`. This is `SectionTabs.tsx` with the class names, element type, and a11y attributes changed — the `Section` union, the `TABS` array, and its order are copied across untouched, because `lib/settings.ts` derives the landing-page setting from that union and the settings UI lists the sections in this order.

```tsx
export type Section = 'sessions' | 'management' | 'analytics' | 'settings';

const TABS: { id: Section; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'management', label: 'Management' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' }
];

interface Props {
  section: Section;
  onChange: (s: Section) => void;
}

/**
 * Top-level section switch: live sessions monitor · config management ·
 * analytics · settings. A rail down the left edge on desktop, a horizontal
 * scroll strip below 700px — see docs/superpowers/specs/2026-08-15-side-rail-nav-design.md.
 */
export function SideRail({ section, onChange }: Props) {
  return (
    <nav className="rail" aria-label="Sections">
      {TABS.map(t => (
        <button
          key={t.id}
          className={section === t.id ? 'rail-link on' : 'rail-link'}
          aria-current={section === t.id ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Delete the old component file**

```bash
git rm client/src/components/SectionTabs.tsx
```

- [ ] **Step 3: Run typecheck to verify it fails**

```bash
pnpm typecheck
```

Expected: FAIL — two errors, `Cannot find module './components/SectionTabs'` in `App.tsx` and `Cannot find module '../components/SectionTabs'` in `lib/settings.ts`. This is the point of the step: it enumerates every import site the rename has to fix. If you see a third error, there is an import site this plan did not anticipate — fix it the same way.

- [ ] **Step 4: Fix the type-only import in the settings lib**

In `client/src/lib/settings.ts`, line 21 currently reads:

```ts
import type { Section } from '../components/SectionTabs';
```

Change it to:

```ts
import type { Section } from '../components/SideRail';
```

Nothing else in that file changes — `export type Landing = Section | 'last'` on line 34 still resolves.

- [ ] **Step 5: Rewrite App.tsx around the new shell**

Replace the whole of `client/src/App.tsx` with this. Two things change: the import on line 3, and the returned markup in `AppShell` — the section state, the landing-preference resolution, and the `wide` derivation are all carried over verbatim, comments included.

```tsx
import { lazy, Suspense, useState } from 'react';

import { SideRail, type Section } from './components/SideRail';
import { SessionsView } from './components/SessionsView';
import { usePersistedState } from './hooks/usePersistedState';
import { SettingsProvider, useSettings } from './hooks/useSettings';

// Lazy: these chunks load only when their section is opened, so the sessions
// view's bundle is unaffected.
const ManagementView = lazy(() => import('./components/management/ManagementView'));
const AnalyticsView = lazy(() => import('./components/analytics/AnalyticsView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

export function App() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}

/**
 * Inside the provider so the landing preference is readable before the first
 * paint of a section — `useSettings` can't be called in `App` itself.
 */
function AppShell() {
  const { settings } = useSettings();
  const [stored, setStored] = usePersistedState<Section>('dashboard.section', 'sessions');
  // A `landing` other than 'last' pins the opening tab. Resolved once, in the
  // initializer, so there's no flash of the previously-open section; after that
  // navigation is normal and the last section is still remembered for next time.
  const [section, setSection] = useState<Section>(
    settings.landing === 'last' ? stored : settings.landing
  );

  const change = (s: Section): void => {
    setSection(s);
    setStored(s);
  };

  // The three-pane management view and the analytics cards need the room;
  // sessions and settings are single-column and read better narrow.
  const wide = section === 'management' || section === 'analytics';

  return (
    <div className="shell">
      <SideRail section={section} onChange={change} />
      <main className="main">
        <div className={wide ? 'wrap wide' : 'wrap'}>
          {section === 'sessions' ? (
            <SessionsView />
          ) : section === 'management' ? (
            <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
              <ManagementView />
            </Suspense>
          ) : section === 'analytics' ? (
            <Suspense fallback={<div className="an-empty">loading…</div>}>
              <AnalyticsView />
            </Suspense>
          ) : (
            <Suspense fallback={<div className="mgmt-empty">loading…</div>}>
              <SettingsView />
            </Suspense>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Take the page padding off `body`**

In `client/src/styles.css`, line 100 currently reads:

```css
body{font-family:var(--font);background:var(--board);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased;line-height:1.4;padding:var(--body-pad)}
```

Drop only the final `padding` declaration:

```css
body{font-family:var(--font);background:var(--board);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased;line-height:1.4}
```

Why: a rail that reaches the viewport edge cannot sit inside the body's padding. `--body-pad` moves to `.main` in the next step and keeps its `[data-density="compact"]` override, so compact mode still tightens the page.

Leave lines 101-102 (`.wrap`, `.wrap.wide`) exactly as they are — the content column keeps its 820px / 1280px caps and its `margin:0` left alignment.

- [ ] **Step 7: Replace the tab rules with the rail rules**

In `client/src/styles.css`, delete lines 104-108 in full — the `/* rack selector */` comment and the four rules `.tabs`, `.tab`, `.tab:hover`, `.tab.on`. Nothing else in the codebase references those class names; you removed their only consumer in Step 2.

Put this in their place:

```css
/* rack selector — the section rail down the left edge. Sticky and full-height
   so its right rule runs the length of the board. The height is divided by
   --font-scale because body{zoom} (line 92) makes 100vh resolve against the
   unzoomed viewport: at text scale 110% a plain 100vh rail overhangs by 10%. */
.shell{display:flex}
.rail{flex:0 0 200px;display:flex;flex-direction:column;gap:2px;align-self:flex-start;position:sticky;top:0;height:calc(100vh / var(--font-scale,1));overflow-y:auto;padding:20px 12px;background:var(--strip);border-right:1px solid var(--hairline)}
.rail-link{font-family:var(--display);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;text-align:left;color:var(--ink3);background:none;border:0;border-radius:2px;padding:8px 10px;cursor:pointer;transition:color .15s,background .15s}
.rail-link:hover{color:var(--ink2);background:var(--strip-hi)}
/* the accent bar sits on the LEFT edge here — a bottom bar marks position in a
   row, but reads as a divider in a column */
.rail-link.on{color:var(--ink);background:var(--strip-hi);box-shadow:inset 2px 0 0 var(--cyan),inset 0 1px 0 var(--edge)}
.main{flex:1;min-width:0;padding:var(--body-pad)}
/* phone: the rail lies down into a scrollable strip above the content, and the
   accent bar goes back to the bottom edge where a row wants it */
@media (max-width:700px){
  .shell{flex-direction:column}
  .rail{flex:none;width:auto;height:auto;position:static;flex-direction:row;gap:4px;padding:8px 10px;overflow-x:auto;border-right:none;border-bottom:1px solid var(--hairline)}
  .rail-link{flex:none;white-space:nowrap}
  .rail-link.on{box-shadow:inset 0 -2px 0 var(--cyan),inset 0 1px 0 var(--edge)}
}
```

Every color and shadow above is a token (`--strip`, `--strip-hi`, `--hairline`, `--ink`, `--ink2`, `--ink3`, `--cyan`, `--edge`). If you find yourself typing a `#` or an `rgba(`, stop — you are breaking the `daylight` theme.

- [ ] **Step 8: Run typecheck and tests to verify they pass**

```bash
pnpm typecheck
```

Expected: PASS, no output.

```bash
pnpm test
```

Expected: PASS, 322 cases. If the count differs, something outside this task's file list changed — find out what before continuing.

- [ ] **Step 9: Build**

```bash
pnpm build
```

Expected: PASS. In the output chunk list, confirm `ManagementView`, `AnalyticsView`, and `SettingsView` are still **separate chunks** from the main bundle — the lazy splitting is load-bearing for the sessions view's bundle size, and nesting them one level deeper in `App.tsx` must not have collapsed them.

- [ ] **Step 10: Verify in the browser — desktop**

Start the dev server (do **not** use Bash for this):

`preview_start` with `{name: "dev-alt-port"}` — the config in `.claude/launch.json`, which serves on port 5600 so it cannot collide with a `pnpm dev` the user already has running.

Then `resize_window` to `{preset: "desktop"}` (1280×800) and check each of these by name:

1. The rail is on the left, full viewport height, with a 1px right border that runs to the bottom of the window.
2. All four labels — Sessions, Management, Analytics, Settings — are present and uppercase.
3. The active item has a tinted background and a 2px cyan bar on its **left** edge.
4. Content starts immediately right of the rail with normal page padding, not flush against the border and not indented twice.
5. Click Management. The three-pane view mounts and the content column widens (`.wrap.wide`, 1280px).
6. Click Analytics, then Settings, then back to Sessions. Each mounts; the rail's active marker follows every click.
7. Reload the page. The section you were last on is restored (the `dashboard.section` localStorage key).

Then check `read_console_messages` for errors — expect none.

- [ ] **Step 11: Verify in the browser — the light theme**

In the running app go to **Settings → theme → Daylight**. This is the one light theme and therefore the only place a hardcoded color shows up: a literal survives all four dark themes and fails only here.

Confirm on `daylight`: the rail background is the pale strip color (not a dark block), the labels are dark ink on it, the active item's bar is the theme's teal `--cyan`, and the right border is visible against the page.

Then switch back to **Midnight** and confirm the rail is dark again.

- [ ] **Step 12: Verify in the browser — phone**

`resize_window` to `{preset: "mobile"}` (375×812), then reload the page so the layout re-runs from scratch.

1. The rail is now a horizontal strip across the top, not a 200px column.
2. All four labels are reachable — the strip scrolls horizontally if they do not all fit.
3. The active item's accent bar is on the **bottom** edge, not the left.
4. The strip has a bottom border and no right border.
5. The page does **not** scroll horizontally.
6. Open a session's chat drawer. It still covers the full viewport (it is `position:fixed;inset:0`) and the rail is behind it, not poking through.

- [ ] **Step 13: Verify in the browser — text scale**

Back at `{preset: "desktop"}`, go to **Settings → text scale → 110%**.

Confirm the rail's right border still ends exactly at the bottom of the viewport — it neither overhangs (creating a scrollbar on a short page) nor stops short. This is the `calc(100vh / var(--font-scale,1))` from Step 7 doing its job; if it is wrong, this is where you find out.

Repeat at 90%. Then set it back to 100%.

- [ ] **Step 14: Screenshot the result**

`computer` with `{action: "screenshot"}` at desktop and at mobile, on `midnight`. These are the proof for the review gate — attach both.

- [ ] **Step 15: Commit**

```bash
git add client/src/components/SideRail.tsx client/src/components/SectionTabs.tsx client/src/App.tsx client/src/lib/settings.ts client/src/styles.css
git commit -m "feat(ui): move the section switch to a left rail"
```

Stage those five paths explicitly — the working tree has unrelated in-flight changes to `server/`, `test/`, `shared/`, and `docs/` that must not ride along. Run `git status --short` after committing and confirm they are all still unstaged.

---

## Task 2: Brand block, and the title stops appearing twice

The rail gets its wordmark and `Header.tsx` gives up its `<h1>` in the same commit, so no build in history ever shows the title twice. A reviewer can reject this task and keep Task 1.

**Files:**
- Modify: `client/src/components/SideRail.tsx` (add the brand element)
- Modify: `client/src/components/Header.tsx` (remove the `<h1>`)
- Modify: `client/src/styles.css` (add `.rail-brand` / `.rail-kicker`, hide the brand in the mobile block)
- Test: none — see "Why there are no unit tests in this plan"

**Interfaces:**
- Consumes: `SideRail` and the `.rail` / `@media (max-width:700px)` CSS block from Task 1.
- Produces: nothing new for later tasks. `SideRail`'s props signature is unchanged.

- [ ] **Step 1: Add the brand block to the rail**

In `client/src/components/SideRail.tsx`, insert the brand as the first child of the `<nav>`, above the `TABS.map(…)`:

```tsx
  return (
    <nav className="rail" aria-label="Sections">
      {/* the app's only wordmark — Header.tsx deliberately has no <h1> */}
      <p className="rail-brand">
        <span className="rail-kicker">Claude</span>
        <br />
        Dashboard
      </p>
      {TABS.map(t => (
```

The rest of the component is untouched.

- [ ] **Step 2: Remove the title from the header**

In `client/src/components/Header.tsx`, the returned block currently opens:

```tsx
      <div className="head">
        <h1>Claude Sessions</h1>
        <span className="meta">{meta}</span>
      </div>
```

Drop the `<h1>` line only:

```tsx
      <div className="head">
        <span className="meta">{meta}</span>
      </div>
```

No CSS change is needed for this: `.head` is `display:flex` and `.head .meta` carries `margin-left:auto`, so the timestamp stays right-aligned on its own line.

Leave `.head h1` in `styles.css` (line 111) alone for now — it is three declarations and removing it is a separate cleanup, not part of this change.

- [ ] **Step 3: Style the brand block**

In `client/src/styles.css`, add these two rules immediately after the `.rail{…}` rule from Task 1 and before `.rail-link{…}`:

```css
/* the app's wordmark, in the rail rather than the page — a kicker over the name */
.rail-brand{font-family:var(--display);font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;line-height:1.15;color:var(--ink);padding:0 10px;margin-bottom:18px}
.rail-kicker{font-family:var(--mono);font-size:9.5px;font-weight:400;letter-spacing:.14em;color:var(--ink3)}
```

Then, inside the existing `@media (max-width:700px)` block you added in Task 1, add one line — the horizontal strip has no room for a wordmark:

```css
  .rail-brand{display:none}
```

- [ ] **Step 4: Run typecheck, tests, build**

```bash
pnpm typecheck
```

Expected: PASS.

```bash
pnpm test
```

Expected: PASS, 322 cases.

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: Verify in the browser**

With the dev server from Task 1 still running (`preview_start` `{name: "dev-alt-port"}` again if it is not), at `{preset: "desktop"}`:

1. The rail's top shows a small mono "CLAUDE" kicker over "SESSIONS DASHBOARD" in condensed display type.
2. The words "Claude Sessions" appear **exactly once** on the page — the old `<h1>` is gone from above the timestamp.
3. The timestamp is still there, right-aligned, above the active-count line.
4. The usage bars still render below it.

Then `resize_window` to `{preset: "mobile"}` and reload: the brand is hidden, the four labels still fill the strip.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/SideRail.tsx client/src/components/Header.tsx client/src/styles.css
git commit -m "feat(ui): move the wordmark into the rail"
```

---

## Task 3: Update the architecture maps

Three doc lines name the component that no longer exists. This repo's docs are load-bearing — `docs/overview.md` is the map agents read before changing a subsystem, and `.claude/CLAUDE.md` is auto-loaded into every session's context.

**Files:**
- Modify: `docs/overview.md:118`
- Modify: `.claude/CLAUDE.md:65`, `.claude/CLAUDE.md:67`
- Test: none — documentation

**Interfaces:**
- Consumes: the final component name `SideRail` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Update the overview map**

In `docs/overview.md`, line 118 currently reads:

```
  App.tsx         section tabs (Sessions | Management | Analytics | Settings), lazy views
```

Change it to:

```
  App.tsx         shell: side rail (Sessions | Management | Analytics | Settings) + lazy views
```

- [ ] **Step 2: Update the project instructions**

In `.claude/CLAUDE.md`, line 65 currently reads:

```
  src/App.tsx     section tabs (Sessions | Management | Analytics | Settings), lazy-loads all but Sessions
```

Change it to:

```
  src/App.tsx     shell: side rail (Sessions | Management | Analytics | Settings), lazy-loads all but Sessions
```

And line 67 currently reads:

```
  components/{Header,SessionList,SessionRow,Toolbar,SectionTabs}
```

Change it to:

```
  components/{Header,SessionList,SessionRow,Toolbar,SideRail}
```

- [ ] **Step 3: Check for a stale reference anywhere else**

```bash
grep -rn "SectionTabs" --exclude-dir=node_modules --exclude-dir=.git .
```

Expected: only hits inside `docs/superpowers/` (the spec and this plan, which describe the rename and should keep saying `SectionTabs`). Any hit in `client/`, `server/`, `test/`, `docs/overview.md`, or `.claude/CLAUDE.md` is a miss — fix it.

- [ ] **Step 4: Commit — read this before staging**

`.claude/CLAUDE.md` **already has uncommitted changes** in the working tree from unrelated in-flight work. Check before you stage:

```bash
git diff .claude/CLAUDE.md
```

If the diff shows *only* your two line edits, stage both files:

```bash
git add docs/overview.md .claude/CLAUDE.md
git commit -m "docs: rename SectionTabs to SideRail in the architecture maps"
```

If the diff shows **other** changes as well, do **not** stage the whole file. Commit `docs/overview.md` alone and tell the user that `.claude/CLAUDE.md` carries their in-flight edits, so its two rename lines are left staged-by-hand or unstaged for them to include in their own commit:

```bash
git add docs/overview.md
git commit -m "docs: rename SectionTabs to SideRail in the architecture map"
```

---

## Final verification

- [ ] `pnpm typecheck` — PASS
- [ ] `pnpm test` — PASS, 322 cases
- [ ] `pnpm build` — PASS, lazy chunks still split
- [ ] `git status --short` — the pre-existing in-flight changes to `server/`, `shared/`, `test/`, `scripts/`, `docs/subsystems/`, `docs/workflows/`, and `client/src/components/settings/SettingsView.tsx` are all still **unstaged and unmodified by this work**
- [ ] Desktop screenshot on `midnight` and on `daylight`
- [ ] Mobile screenshot at 375×812
- [ ] All four sections mount; `.wide` still applies on Management and Analytics; the reload-restores-section behavior still works
