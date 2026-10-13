# Management Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **How to read a task.** Each task is complete on its own: it names every file, class, string and value it needs, so read only your task plus the
> Global Constraints. TypeScript is given as signatures and exact behaviour, not literal code; write the code yourself. CSS is given verbatim because its
> values are the design. If the spec and this plan disagree, the spec wins. If you think both are wrong, say so in your report rather than guessing.

**Goal:** Ship the redesigned Management section. Projects gets a drop-line pin reorder and a Folder-gone chip. Git's Cards | Table | Triage are replaced by
Inbox | Matrix | Inspector | Branches over one problems → levels rule, with the live sessions joined in, plus Open PR and Open folder keys.

**Architecture:** Projects keeps `usePinReorder`'s document-listener drag but stops reordering mid-drag. A pure `dropMark` places a fixed bar, and a portal
draws the ghost. Git gets a pure `lib/gitLevels.ts` (problems, levels, rank, stale rule, session join), a rewritten `lib/gitLayouts.ts`, shared parts in
`GitParts.tsx`, and one component per layout, all fed one `GitLayoutProps` bundle from `GitView`. The server adds `originUrl` to the `ok` repo (local
`git remote get-url origin`, userinfo stripped) and a token-guarded `POST /api/open-folder` that runs macOS `open` on a pinned path.

**Tech Stack:** Node + TypeScript via `tsx` (server, Node built-ins only), React 18 + Vite (client), node-assert tests in `test/` run by `test/run-all.ts`,
Playwright visual suite in `test/visual/` (macOS, on demand).

**Spec:** `docs/superpowers/specs/2026-10-13-management-redesign-design.md`. Read §2 and the section your task names. The mock
`docs/guides/mockups/redesign-mock.html` is the look.

## Global Constraints

- Branch: `management-redesign` (already checked out). Before each commit run `git status` and `git branch --show-current`, then
  `git add <your files>` and `git commit`. Never `git add -A`. End every commit message with the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Every task ends with `pnpm typecheck` and `pnpm test`, and both must exit 0.** Paste the `pnpm test` case-count line into your report. Never claim
  green without the output.
- ESM. Server imports use the `.js` suffix. Cross-boundary imports are `import type`. `server/` takes **no new dependency** and no new network call.
  **API fields go in `shared/types.ts` first**, then the server producer, then the client.
- `client/src/styles.css`: **no colour or shadow literal below the theme-token block**, tokens only. **No `max-width` media query**
  (`test/breakpoints.test.ts`): phone is the base tier, and the only allowed `min-width` values are 640, 768, 1024, 1280, 1536, 1537 and 1921. **Keep
  existing class names stable.** Never rename a live class.
- Token map for porting mock CSS: `--bg-surface`→`--strip`, `--bg-subtle`→`--strip-hi`, `--bg-track`→`--steel`, `--border`→`--hairline`,
  `--border-strong`→`--hairline2`, `--text-primary`/`-secondary`/`-tertiary`→`--ink`/`--ink2`/`--ink3`, `--green-600`→`--green` (text) or
  `--green-solid` (marks), `--green-200` and green tints→`--green-tint`, `--ink-inverse`→`--ink`, `--text-on-dark`→`--strip`, `--lift-card`→ dropped,
  `--lift-float`→`0 8px 24px var(--shadow2)`, `--r-sm`/`--r-md`/`--r-lg`/`--r-full`→`8px`/`12px`/`16px`/`999px`, `--cyan`→`--cyan`.
- Comments say *why* only. Prose and comments wrap at 160 columns. Test runs stay in the foreground. If you start a dev server, record its pid and kill only
  that pid.
- **Binding values** (verbatim; never vary them):
  - Projects classes: `.pj-tile.src`, `.pj-srw.src`, `.pj-ghost`, `.pj-mark.h`, `.pj-mark.v`, `.pin-saved.live`, `body.pj-dragging`, `.pj-gone`, `.pj-tip`.
    Head label while dragging: `Moving <name> · <n> of <N>`. Ghost position text: `<i> of <N>`, or `→ <to+1> of <N>` once a drop would move it.
    Chip text `Folder gone`. Tooltip text `Folder no longer exists. Hidden from every list until unpinned.`
  - Git levels: `needs`, `look`, `quiet`, `dead`. Labels `Needs you`, `Worth a look`, `All good`, `Can't read`. Status words `needs you`,
    `worth a look`, `all good`, `can't read`. Severities: **3** needs you, **2** worth a look, **1** a note. Level = highest sev: 3→`needs`, 2→`look`,
    1 or none→`quiet`; any non-`ok` state→`dead`. Rank `needs`0 `look`1 `quiet`2 `dead`3, then summed sev descending, then pin order.
  - Calm: uncommitted work under a session whose status is `working`, on the repo's checked-out branch, is sev 1 with `calm: true`.
  - Stale branch: `(behind ?? 0) >= 20` **or** `nowMs - lastCommitMs >= 604800000` (7 days).
  - Session join: `Session.projectPath` equals or lies under `RepoGitStats.toplevel`, `.path`, or the branch's `worktreePath`, **and**
    `Session.gitBranch === branch`. Status `working`→`working` (label `working`), `question`→`waiting` (`needs answer`), `idle`→`idle`
    (`idle <formatAgo(updatedMs)>`). `incomplete` → no agent.
  - Layouts: `inbox | matrix | inspector | branches`, labels `Inbox`, `Matrix`, `Inspector`, `Branches`. **Default `inbox`.** Stored legacy
    `cards`, `table`, `triage` (and anything unknown) read as `inbox`. `WIDE_ONLY_GIT_LAYOUTS = ['matrix']`. A phone draws `inbox` for a stored `matrix`.
    The key stays `management.gitLayout` in localStorage via `usePersistedState`.
  - Compare URLs: `https://github.com/<owner>/<repo>/compare/<trunk>...<branch>?expand=1` and
    `https://gitlab.com/<group…>/<project>/-/compare/<trunk>...<branch>?expand=1`. Hosts `github.com` and `gitlab.com` only. Any other host → no key.
  - `POST /api/open-folder`, body `{path: string}`. Order: 405 for a non-POST (router), 403 `{error: 'bad token'}`, 400
    `{error: 'expected {path: string}'}`, 501 `{error: 'open folder needs macOS'}` on non-darwin, 403 `{error: 'not a pinned project'}` unless `path`
    string-equals a listed pin's path, 500 `{error: 'open failed'}` on a failed `open`, 200 `{ok: true}`. Runs `execFile('open', [path])`, no shell.
    `test/outbound.test.ts` is unaffected.

## Review Focus

1. **Task 2, the drop line**: nothing reorders mid-drag, exactly one `POST /api/pins/order` fires on a release that moves, and none on Escape, cancel or a
   no-op release.
2. **Task 5, open-folder**: the membership gate is string equality against listed pins, and `open` runs through `execFile` with no shell.
3. **Task 6, gitLevels**: the calm rule fires only for a `working` agent, and the ranking is stable.
4. **Task 13, deletions**: no live class loses a rule while a component still uses it.

---

### Task 1: Trim the mock to Drop line only

**Files:**
- Modify: `docs/guides/mockups/redesign-mock.html` only.

**What to remove** (the MANAGEMENT `<script>` block starts near line 3999, its Projects half near line 4400, and the Projects CSS near line 1550):
- CSS: the `.pj-arr`, `.pj-arr .btn`, `.pj-arr .btn.ink` rules. The whole "Lift — fix 1" block (`#pin-body.dragging [data-prow]`,
  `#pin-body.dragging.lift …`, `.pj-tile.drag,.pj-srw.drag`, `.pj-tile.drag{border-color…}`, `.pj-srw.drag…`, `.pj-srw.drag+.pj-srw`, and its
  reduced-motion line). The "fix 2" rule `.pin-pick[data-layout="tiles"] .pj-tiles.pins{grid-auto-rows:1fr}`. The whole "Arrange" block (`.pj-pos`,
  `.pj-step*`, `#pin-body.arranging …`, `.pj-tile.moved,.pj-srw.moved`, `.pj-tile.moved .pj-pos…`, `.pj-srw.moved`). In the shared grip-colour rule
  `.pj-tile.drag .pin-grip,.pj-srw.drag .pin-grip,.pj-tile.src .pin-grip,.pj-srw.src .pin-grip{…}`, keep only the two `.src` selectors.
- JS state: `pinReorder`, `pinArrange`, `pinMoved` from `S`.
- JS: `REORDERS`, `pinBar()` and its use in `renderPinned()`; `stepper`, `flashMoved`, `movedTimer`, `arrangeStart`, `hasLead`; the `inside` helper; the
  click branches for `[data-preorder]`, `[data-parrange]` and `[data-pstep]`; `S.pinArrange` in the Pin-click guard and in the filter input's `disabled`;
  the Escape-ends-Arrange line in the keydown handler; the Lift branch of the pointer `move` handler (the `own` / `inside` early return and the live
  `pinOrder = next; paintBody()`).

**What it becomes:**
- `saved()`: while `S.pinDrag` is set → `<span class="pin-saved live" role="status">Moving <name> · <n> of <N></span>`, where n is
  `S.pinDropAt + 1` when `S.pinDropAt !== null`, else the pin's current 1-based position. Otherwise the `Saved` flash span alone.
- `grip(p)`: the filtering branch and the grip button only.
- `dragCls(p)`: `' src'` for the dragged pin, else `''`. `lead(p, on)`: `' g' + dragCls(p) + '" data-prow="' + p.dir` for a pin, `''` for an offer.
- `key(p, on)` → `pinBtn(p, on)`.
- `paintBody()`: `body.className = S.pinDrag ? 'dragging' : ''`.
- `pointerdown`: always the drop-line path (ghost, mark, `dropIndex`, `placeMark`). On release, `movePin(pinOrder, name, S.pinDropAt)` only when
  `S.pinDropAt !== null`. Escape and `pointercancel` restore.
- `S.pinDropAt` comment: `// the index the bar marks, or null`.
- **Header comment** (lines ~66–76, from "Projects is the list…" to "…Settings card of setting rows."): replace with this text, wrapped at the
  existing width:
  > Projects is the list that used to live in Settings › Pinned, now on the app ground: a toolbar with the Tiles | Columns | Lists pills and a filter box,
  > over the pinned and the recent projects with Unpin and Pin. Every pin leads with a ⠿ grip, and its reorder is a drop line: nothing moves until
  > release. The dragged pin dims in place behind a dashed edge, a ghost chip naming it follows the pointer, and a green bar marks the gap it will land in
  > (across the gap in one column, down it between Tiles). The Pinned head reads "Moving <name> · n of N" for the length of the drag. Release saves and
  > Saved flashes beside the count. Escape or a cancelled pointer puts everything back. ↑/←/↓/→ on a focused grip still moves a pin one place at once, and a
  > non-blank filter hides the grips. A pin whose folder is gone shows an amber Folder gone chip where its age would sit, the sentence its tooltip, so every
  > tile keeps one height. (Lift, where the pin moves under the pointer, and Arrange, ↑ ↓ steppers behind a Reorder key, were drawn and dropped.) Tiles
  > stacks the two groups as tiles, Columns puts them side by side one tile a row, Lists draws each column as a Settings card of setting rows.
- **CSS comment** (the "Pinned's reorder (live #193…) drawn three ways" block): replace with:
  > Pinned's reorder (live #193, usePinReorder.ts) is a drop line: nothing moves until you let go. The source dims in place (.src), a ghost chip follows
  > the pointer (.pj-ghost), and a green bar marks the landing gap (.pj-mark.h in one column, .pj-mark.v in the Tiles grid). The layout never changes
  > mid-drag, so tile sizes cannot matter. (Lift and Arrange were drawn and dropped.)
- Also fix the MANAGEMENT `<script>` block comment and the `<!-- PAGE: MANAGEMENT -->` comment if either still mentions a reorder bar.
- **Keep** `goneChip`, `.pj-gone`, `.pj-tip`, `.pj-srw .pj-tip`, `.pj-ghost`, `.pj-mark*`, `.pj-tile.src`, `.pj-srw.src`, `.pin-saved.live`,
  `body.pj-dragging`, `flashSaved` and the keyboard handler.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `grep -nE "pinReorder|pinArrange|pinMoved|data-preorder|data-parrange|data-pstep|pj-arr|pj-pos|pj-step|arranging|flashMoved|REORDERS|pinBar" docs/guides/mockups/redesign-mock.html`
  must print nothing. `grep -nw "Lift\|Arrange" docs/guides/mockups/redesign-mock.html` may show only the two "were drawn and dropped" sentences (the unrelated
  "Lifted from the live tab" comment does not match `-w`).
- [ ] **Step 3:** Parse every inline script:
  `node -e "const h=require('fs').readFileSync('docs/guides/mockups/redesign-mock.html','utf8');const s=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);s.forEach(c=>new Function(c));console.log('parsed',s.length)"`
  must print `parsed N` with no throw.
- [ ] **Step 4:** Open the file in the Browser pane (`preview_start` with `url: file://<absolute path>`). Go to Management › Projects. Drag a grip in
  Tiles and in Lists: a bar shows, nothing moves until release, and the head reads `Moving …`. Press Escape mid-drag. Hover the gone chip.
  `read_console_messages` with `onlyErrors: true` must be empty.
- [ ] **Step 5:** `pnpm typecheck` and `pnpm test` (unaffected, but run them: both exit 0).
- [ ] **Step 6:** Commit `docs(mock): Projects reorder is the drop line only`.

---

### Task 2: Projects — drop-line reorder

**Files:**
- Modify: `client/src/lib/pins.ts` (new `dropMark`, `DropMark`)
- Modify: `client/src/hooks/usePinReorder.ts` (rewrite the drag to Drop line)
- Modify: `client/src/components/management/ProjectsView.tsx`
- Modify: `client/src/styles.css` (the `.pj-*` / `.pin-*` block, ~1870–1960)
- Test: `test/pins-client.test.ts`

**`dropMark`** (spec §3.1): `export interface DropMark { orient: 'h' | 'v'; left: number; top: number; width: number; height: number }` and
`export function dropMark(items: readonly { name: string; rect: PinRect }[], dragged: string, to: number, gap: number): DropMark | null`.
- null when `dragged` is not in `items` or no other item exists.
- `others` = items without `dragged`. One column when every `rect.left` is within 1px of `items[0].rect.left`.
- `end = to >= others.length`. `r = end ? others[others.length - 1].rect : others[to].rect`.
- One column → `{orient:'h', left:r.left, width:r.right - r.left, height:3, top:(end ? r.bottom + gap : r.top - gap) - 1.5}`.
- Otherwise → `{orient:'v', top:r.top, height:r.bottom - r.top, width:3, left:(end ? r.right + gap : r.left - gap) - 1.5}`.
- Update the file's top JSDoc to name `dropMark`.

**`usePinReorder`**: new signature `usePinReorder(pinned, busy, reorder, filterBlank, gapPx: number): PinReorder`.

Keep unchanged: `GripProps`, the `busy` / `!filterBlank` / already-dragging / non-primary-mouse guards in `startDrag`, `preventDefault` on pointerdown,
the `document` listeners for `pointermove` / `pointerup` / `pointercancel` / `keydown` (Escape) matched by `pointerId`, **no `setPointerCapture`**,
`EDGE_PX = 48`, `SCROLL_STEP_PX = 10`, `SAVED_MS = 1500`, `save()`, the whole keyboard path (`onGripKey`, `pendingFocus`, the layout effect, the
`busy`-returns-to-null clear), `headError`, `errorFor`, `rowRef`, `cancel()`, and the effects that cancel on `busy` non-null and on `filterBlank` false.

Change:
- Remove the `dragOrder` field and the draft-reordering `follow()`.
- `PinReorder` gains `dropAt: number | null`, `headLabel: string | null`, `ghost: { name: string; pos: string } | null`,
  `ghostRef: (el: HTMLDivElement | null) => void` and `mark: DropMark | null`. Keep `dragging` (the source dirName).
- The `Drag` ref record holds `id`, `name`, `start` (order at drag start), `x`, `y`, `frame`, `dropAt`, `detach`.
- On each pointermove (and each auto-scroll frame after `scrollBy`): store x/y, and write the ghost element's `style.left = x + 14 + 'px'` and
  `style.top = y - 18 + 'px'` through the ghost ref (no React state). Then read the pinned items' boxes in DOM order (sort the row elements with
  `compareDocumentPosition`, as `follow()` does today), `to = dropIndex(items, name, {x, y})`. `next = movePin(start, name, to)`.
  `dropAt = next === start ? null : to`. `mark = dropAt === null ? null : dropMark(items, name, to, gapPx)`. Call `setState` only when `dropAt` changed
  or the mark's `left`/`top`/`width`/`height`/`orient` changed.
- `ghostRef`: stores the element and applies the last x/y at once, so the ghost appears under the pointer on its first paint.
- Release (`pointerup`) with `dropAt !== null` → `save(movePin(start, name, dropAt), name)` once. Every other end (release with `dropAt` null,
  `pointercancel`, Escape, `busy` non-null, filter non-blank, unmount) writes nothing. Every end clears `dragging`, `dropAt`, `ghost` and `mark`, and removes
  `pj-dragging` from `document.body` (added at drag start).
- A `pinned` change mid-drag: if the dragged pin is gone, end without writing. Otherwise `start` = new order, and `dropAt` / `mark` are cleared until the
  next move.
- `headLabel` while dragging = `Moving <pin name> · <n> of <N>`, n = `dropAt + 1` when set, else the pin's 1-based index in `start`, N = `pinned.length`.
  null otherwise. `ghost` while dragging = `{name, pos}`, pos = `→ <dropAt+1> of <N>` when `dropAt` is set, else `<index+1> of <N>`.
- Grip `aria-label` stays `Move <name>, position <i> of <n>`, read from prop order (no draft any more).
- Update the hook's JSDoc: drop line, nothing moves until release, why the ghost moves by ref.

**`ProjectsView`**:
- Pass `gapPx = layout === 'lists' ? 0 : 6` as the hook's fifth argument.
- `pinItems = pinnedShown.map(r => item(r, true))`. Remove the `applyPinOrder` import if nothing else uses it.
- `Item.drag` → `Item.src` (the dragged pin), and `leadCls` → `${grip ? ' g' : ''}${src ? ' src' : ''}`.
- Pinned aside: `moves.headLabel` → `<span className="pin-saved live" role="status">{moves.headLabel}</span>`. Otherwise today's `headError` /
  `Saved` spans.
- After `<div>{body}</div>`, render `createPortal(<>…</>, document.body)` (from `react-dom`) holding, when `moves.ghost` is set,
  `<div className="pj-ghost" ref={moves.ghostRef}><b>⠿</b>{moves.ghost.name}<i>{moves.ghost.pos}</i></div>`, and when `moves.mark` is set,
  `<div className={`pj-mark ${mark.orient}`} style={{ left, top, width, height }} />` (px numbers). The portal puts them outside `.shell`, whose `zoom`
  would otherwise scale a fixed box away from viewport coordinates.
- Update the component JSDoc: the drag is a drop line.

**CSS.** Delete these three live rules: `.pj-tile.drag,.pj-srw.drag{…}`, `.pj-srw.drag{…}`, and
`.pj-tile.drag .pin-grip,.pj-srw.drag .pin-grip{…}`. Update the "Pinned's grip (#193)" comment above them: no lift; the source dims and a bar marks the gap.
Add beside them:
```css
.pj-tile.src{opacity:.45;border-style:dashed;border-color:var(--hairline2)}
.pj-srw.src{opacity:.45}
.pj-tile.src .pin-grip,.pj-srw.src .pin-grip{color:var(--cyan);background:var(--strip-hi)}
body.pj-dragging,body.pj-dragging *{cursor:grabbing!important;user-select:none}
.pj-ghost{position:fixed;z-index:50;pointer-events:none;display:flex;align-items:center;gap:8px;padding:8px 14px 8px 10px;background:var(--strip);border-radius:12px;box-shadow:0 0 0 2px var(--cyan),0 8px 24px var(--shadow2);font-family:var(--font);font-size:14px;font-weight:500;color:var(--ink);white-space:nowrap;transform:rotate(-1.5deg)}
.pj-ghost b{font-size:15px;font-weight:400;color:var(--cyan)}
.pj-ghost i{font-style:normal;font-size:12px;font-weight:400;color:var(--ink3)}
.pj-mark{position:fixed;z-index:49;pointer-events:none;background:var(--cyan);border-radius:999px}
.pj-mark::before,.pj-mark::after{content:"";position:absolute;width:8px;height:8px;border-radius:999px;background:var(--cyan)}
.pj-mark.h::before{left:-4px;top:-3px}
.pj-mark.h::after{right:-4px;top:-3px}
.pj-mark.v::before{top:-4px;left:-2.5px}
.pj-mark.v::after{bottom:-4px;left:-2.5px}
@media (prefers-reduced-motion:reduce){.pj-ghost{transform:none}}
```
And beside `.pin-saved.err`: `.pin-saved.live{color:var(--cyan);font-weight:500}`.

- [ ] **Step 1: Write the failing `dropMark` cases** in `test/pins-client.test.ts`, using a `box(left, top, right, bottom)` helper:

  | items | dragged | to | gap | Expect |
  |---|---|---|---|---|
  | a(0,0,200,40), b(0,50,200,90), c(0,100,200,140) | a | 1 | 6 | `{orient:'h', left:0, width:200, height:3, top:92.5}` (before c) |
  | same | a | 2 | 6 | `top:144.5` (after c, the end) |
  | same | c | 0 | 0 | `top:-1.5` (before a) |
  | same | b | 0 | 6 | `top:-7.5` |
  | a(0,0,240,100), b(250,0,490,100) | a | 1 | 6 | `{orient:'v', top:0, height:100, width:3, left:494.5}` |
  | a(0,0,240,100), b(250,0,490,100), c(0,110,240,210) | c | 1 | 6 | `{orient:'v', left:242.5, top:0, height:100, width:3}` (before b) |
  | same | x (absent) | 0 | 6 | `null` |
  | a(0,0,200,40) only | a | 0 | 6 | `null` |

- [ ] **Step 2:** `pnpm test`: the new cases fail, nothing else does.
- [ ] **Step 3:** Implement `dropMark`, the hook, the view and the CSS.
- [ ] **Step 4:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 5: Pane check** (`pnpm dev` through `preview_start`, Management › Projects, at least 4 pins). Use real pointer events from `javascript_tool`
  where a mouse drag is not possible:
  - Drag the second pin down two places in **Lists**: no row moves while dragging, a horizontal bar shows in the gap, the head reads `Moving <name> · 4 of N`,
    and on release exactly one `POST /api/pins/order` is sent (`read_network_requests`).
  - Same in **Tiles** at 1280: the bar is vertical between tiles.
  - Escape mid-drag: no POST, and the bar, ghost and `.src` all clear. Release over the start position: no POST.
  - Focus the first grip, press ↓ three times then ↑ three times: focus stays on that grip and `window.scrollY` never changes.
  - The pane has no Answer token, so a save answers 403 and rolls back. The 200 path is the user's click (put it in the report's "not verified").
- [ ] **Step 6:** Commit `feat(projects): drop-line pin reorder`.

---

### Task 3: Projects — the Folder-gone chip

**Files:**
- Modify: `client/src/lib/projectsView.ts`, `client/src/components/management/ProjectsView.tsx`, `client/src/styles.css`
- Test: `test/projects-view.test.ts`

**Behaviour:**
- `projectsView.ts`: add `export const PROJECTS_GONE_CHIP = 'Folder gone';`. Keep `PROJECTS_MISSING` (its text is the tooltip's) and update its JSDoc to
  say it is the gone chip's tooltip.
- `ProjectsView`: new `GoneChip({ dirName })` renders
  `<button type="button" className="pj-gone" aria-describedby={`pj-tip-${dirName}`}>` containing
  `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M6 1.5 11 10.5H1z"/><path d="M6 5v2.2M6 8.6v.1"/></svg>`,
  the text `{PROJECTS_GONE_CHIP}`, and `<span className="pj-tip" role="tooltip" id={`pj-tip-${dirName}`}>{PROJECTS_MISSING}</span>`.
- In `TileGroup`'s `.pj-tfoot`: `it.gone ? <GoneChip/> : <span className="pj-age">…</span>`. In `ListCard`'s row control: the same swap for its
  `.pj-age`. Columns uses `TileGroup`, so it gets the chip too.
- `Notes` draws only the refusal line (`.pin-sub.err`). Remove the gone sentence. In `ListCard`, `hint` no longer depends on `it.gone`.
- Update the component JSDoc: a dead pin's note is the chip's tooltip, so every tile keeps one height.

**CSS** (next to `.pj-tile.gone`):
```css
.pj-gone{position:relative;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:0;border-radius:999px;background:color-mix(in srgb,var(--amber) 12%,transparent);color:var(--amber);font-family:var(--font);font-size:12px;font-weight:500;white-space:nowrap;cursor:help}
.pj-gone svg{flex:none}
.pj-gone:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.pj-tip{position:absolute;left:0;bottom:calc(100% + 8px);z-index:5;width:240px;padding:8px 10px;border-radius:8px;background:var(--ink);color:var(--strip);box-shadow:0 8px 24px var(--shadow2);font-size:12px;font-weight:400;line-height:1.45;white-space:normal;text-align:left;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s,transform .15s}
.pj-tip::after{content:"";position:absolute;left:16px;top:100%;border:5px solid transparent;border-top-color:var(--ink)}
.pj-gone:hover .pj-tip,.pj-gone:focus .pj-tip{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.pj-tip{transition:none}}
```
Inside the **existing** `@media (min-width:768px)` block that holds `.pj-cols .pj-tile{flex-direction:row;align-items:center}` (~line 1919), add the
leftward flip. From `md` the chip sits at the right edge of a Lists row and a Columns tile. Below `md` both put it at the left, where a leftward tip would
leave the screen:
```css
  .pj-srw .pj-tip,.pj-cols .pj-tile .pj-tip{left:auto;right:0}
  .pj-srw .pj-tip::after,.pj-cols .pj-tile .pj-tip::after{left:auto;right:16px}
```

- [ ] **Step 1: Failing test** in `test/projects-view.test.ts`: `PROJECTS_GONE_CHIP` is exactly `'Folder gone'`. The existing `PROJECTS_MISSING` text
  assertion stays.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 4: Pane check.** Unpinning cannot be done with no token, so in the pane override `fetch` for `/api/pins` in `javascript_tool`, or check with
  the user's real dead pin if one exists. Otherwise verify through the visual fixture in Task 15 and say so in the report. Check in Tiles, Columns and Lists
  at 375 and 1280: the tile is no taller than its neighbours, hover and Tab-focus show the tip, and the tip stays on screen.
- [ ] **Step 5:** Commit `feat(projects): Folder gone chip with its sentence as a tooltip`.

---

### Task 4: `originUrl` end to end, and the compare link

**Files:**
- Modify: `shared/types.ts` (the `ok` variant of `RepoGitStats`, ~line 1632)
- Modify: `server/lib/git-stats.ts` (`readGitFacts`, plus a new export `stripUserinfo`)
- Create: `client/src/lib/gitLinks.ts`
- Modify (fixture literals gain `originUrl` so typecheck passes): `test/git-stats-client.test.ts` (`okRepo`: `originUrl: null`),
  `test/git-sync-client.test.ts`, `test/hub-widgets.test.ts` (each `originUrl: null`), and `test/visual/fixtures/git-stats.ts` (aurora
  `'https://github.com/acme/aurora-api.git'`, harbor `'https://gitlab.com/acme/web/harbor-web.git'`)
- Test: `test/git-stats.test.ts`; Create: `test/git-links.test.ts` (register in `test/run-all.ts` beside `runGitStatsClient`, same import / `failed +=`
  pattern)

**Behaviour:**
- `shared/types.ts`, after `hasOrigin`: `originUrl: string | null;` with JSDoc: "`git remote get-url origin` from local config (no network), with any
  userinfo removed so no credential leaves the server; null without an origin or when it cannot be read."
- `stripUserinfo(url: string): string | null`:
  - Empty after trim → null.
  - Contains `://` → `new URL(url)`, and a throw → null. No username and no password → return the input unchanged (same string). Otherwise clear both
    and return `href`.
  - Else, scp-like (matches `/^[^@/:]+@([^/:]+):(.+)$/`) → `<host>:<path>`.
  - Else unchanged (a local path).
- `readGitFacts`: right after `hasOrigin` is computed, `originUrl = hasOrigin ? <read> : null`. The read runs `['remote', 'get-url', 'origin']` through
  the local `git` wrapper (not `expect0`): exit ≠ 0 or empty stdout → null, else `stripUserinfo(stdout.trim())`. Put `originUrl` in the returned object
  after `hasOrigin`. No other call changes. The calls stay strictly sequential.
- `client/src/lib/gitLinks.ts`, `gitCompareUrl(originUrl: string | null, trunk: string | null, branch: string): string | null`:
  - null when `originUrl` or `trunk` is null, or `branch === trunk`.
  - Parse host and path. `https://` or `http://` → host = URL host (no port), path = pathname. `ssh://` → `new URL`, host = hostname, path = pathname.
    scp-like `[user@]host:path` (no `://`) → host and path split at the first `:` after the optional `user@`. A parse failure → null.
  - Path: strip one trailing `/`, then one trailing `.git`, then a leading `/`. Segments = split on `/`, and any empty segment → null.
  - Host lower-cased: `github.com` needs exactly 2 segments. `gitlab.com` needs 2 or more. Anything else → null.
  - `enc(s) = s.split('/').map(encodeURIComponent).join('/')`.
  - github → `https://github.com/<path>/compare/<enc(trunk)>...<enc(branch)>?expand=1`.
  - gitlab → `https://gitlab.com/<path>/-/compare/<enc(trunk)>...<enc(branch)>?expand=1`.

- [ ] **Step 1: Failing git-stats cases** (real fixture repos via `withGitFixture`, spy runner, as the file's other cases do):
  - `originUrl: a clone of a local bare repo reports the bare path unchanged`. `r.originUrl` equals the bare path the fixture returned.
  - `originUrl: https with credentials comes back without them`. `fx.git(work, ['remote','set-url','origin','https://alice:s3cret@github.com/o/r.git'])`
    gives `'https://github.com/o/r.git'`, and the returned JSON contains no `s3cret`.
  - `originUrl: scp-like git@github.com:o/r.git → github.com:o/r.git`.
  - `originUrl: no origin → null and no get-url call`. A repo with no remote gives `null`, and `s.calls` holds no `['remote','get-url',…]`.
  - `stripUserinfo` table: `''`→null; `'https://github.com/o/r.git'`→same; `'https://tok@gitlab.com/g/s/r.git'`→`'https://gitlab.com/g/s/r.git'`;
    `'ssh://git@github.com/o/r.git'`→`'ssh://github.com/o/r.git'`; `'ssh://git@github.com:2222/o/r.git'`→`'ssh://github.com:2222/o/r.git'`;
    `'http://[bad'`→null; `'/tmp/x/origin.git'`→same.
- [ ] **Step 2: Failing `test/git-links.test.ts` cases** (`gitCompareUrl(origin, 'main', 'feat/x')` unless noted):

  | origin | Expect |
  |---|---|
  | `https://github.com/acme/app.git` | `https://github.com/acme/app/compare/main...feat/x?expand=1` |
  | `https://github.com/acme/app` | same |
  | `https://github.com/acme/app/` | same |
  | `http://github.com/acme/app.git` | same |
  | `ssh://github.com/acme/app.git` | same |
  | `ssh://github.com:22/acme/app.git` | same |
  | `github.com:acme/app.git` | same |
  | `git@github.com:acme/app.git` | same |
  | `https://GitHub.com/acme/app.git` | same |
  | `https://gitlab.com/grp/sub/app.git` | `https://gitlab.com/grp/sub/app/-/compare/main...feat/x?expand=1` |
  | `gitlab.com:grp/app.git` | `https://gitlab.com/grp/app/-/compare/main...feat/x?expand=1` |
  | `https://github.com/acme/app.git`, branch `fix/a b#c` | `…/compare/main...fix/a%20b%23c?expand=1` |
  | `https://github.com/acme/sub/app.git` | null (github needs exactly 2 segments) |
  | `https://bitbucket.org/acme/app.git` | null |
  | `https://github.example.com/acme/app.git` | null |
  | `/tmp/origin.git` | null |
  | `null` | null |
  | `https://github.com/acme/app.git`, trunk `null` | null |
  | `https://github.com/acme/app.git`, branch `main` | null |
- [ ] **Step 3:** `pnpm test`: the new cases fail.
- [ ] **Step 4:** Implement the type, server read, `stripUserinfo`, `gitLinks.ts` and the fixture literals.
- [ ] **Step 5:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 6:** Commit `feat(git-stats): originUrl with userinfo stripped, and a compare link helper`.

---

### Task 5: `POST /api/open-folder` and `useOpenFolder`

**Files:**
- Modify: `shared/types.ts` (add `OpenFolderRequest`, `OpenFolderResponse` near `PinsResponse`)
- Create: `server/lib/open-folder.ts`
- Modify: `server/api.ts` (new `serveOpenFolder` beside `servePinsOrder`), `server/index.ts` (route beside `/api/pins/order`, POST only, plus a
  route-list comment line `POST /api/open-folder → open a pinned project's folder in Finder (macOS; see api.ts)`)
- Create: `client/src/hooks/useOpenFolder.ts`
- Create: `test/api-open-folder.test.ts` (register in `test/run-all.ts` beside `runApiPins`)

**Behaviour:**
- Types: `export interface OpenFolderRequest { path: string }` and `export interface OpenFolderResponse { ok: true }`, with JSDoc naming the route.
- `server/lib/open-folder.ts` (Node built-ins only: `node:child_process`):
  - `export type OpenRunner = (cmd: string, args: string[]) => Promise<void>`. The default runs `execFile(cmd, args, { timeout: 5000 }, cb)`, with no
    shell and no string command line. It resolves when there is no error and rejects with the error.
  - `export function openFolderPlatform(): string` → the overridden platform, else `process.platform`.
  - `export function openFolder(path: string): Promise<void>` → `runner('open', [path])`.
  - `export function overrideOpenFolder(o: { run?: OpenRunner | null; platform?: string | null }): void`. A field left `undefined` leaves that seam alone,
    and `null` restores the default.
- `serveOpenFolder(config, req, res)`. The gates in this order:
  1. `!tokenOk(config, req)` → `sendJson(res, 403, {error: 'bad token'})`.
  2. `readJsonBody(req)`. Not an object, `typeof path !== 'string'`, or `path === ''` → `sendBadBody(res, {error: 'expected {path: string}'})`.
  3. `openFolderPlatform() !== 'darwin'` → 501 `{error: 'open folder needs macOS'}`.
  4. Rows = `listPinRows(config, getPinnedProjects(), { archivedIds: archivedSessionIds(), ...pinOptions() })` (the options `pinsPayload` builds).
     No row with `listed === true && path === body.path` (string equality, nothing normalised) → 403 `{error: 'not a pinned project'}`.
  5. `await openFolder(path)` throws → log one line `[dashboard] open folder failed: <message>` and answer 500 `{error: 'open failed'}`.
  6. 200 `{ok: true}`.
- `index.ts`: `if (u.pathname === '/api/open-folder') { if (req.method !== 'POST') return methodNotAllowed(res); return void serveOpenFolder(config, req, res); }`,
  matching the neighbours' style.
- `useOpenFolder(): { open(path: string): void; pending: boolean; note: string | null }`. It reads the token via
  `usePersistedState<string>('dashboard.answerToken', '')` and adds `Authorization: Bearer <token>` when one is set. It POSTs JSON `{path}`. While
  `pending`, a second `open` is a no-op. Results: 200 → note null. 403 with body `error === 'bad token'` →
  `Open folder needs the Answer token — set it under Settings › Local › Connection.` Any other 403 → `That folder is no longer pinned.` 501 →
  `Open folder works only when the dashboard server runs on macOS.` Anything else, network failure included → `Couldn't open the folder.` It never throws.

- [ ] **Step 1: Failing route cases** in `test/api-open-folder.test.ts`, copying `test/api-pins.test.ts`'s `withPins` / `plantProject` / `ENV` pattern.
  Pin directly with `setPinned(dirName, true)`. Each case installs `overrideOpenFolder({ run: spy, platform: 'darwin' })` (spy records `[cmd, args]`) and
  restores `overrideOpenFolder({ run: null, platform: null })` in `finally`:
  - `GET /api/open-folder → 405`.
  - `ANSWER_TOKEN set, no bearer → 403 bad token, runner not called`.
  - `body {} → 400`; `body {path: 3} → 400`; `non-JSON body → 400`; `body {path: ''} → 400` (each: runner not called).
  - `platform linux → 501 open folder needs macOS, runner not called` (path pinned).
  - `unpinned path → 403 not a pinned project` (plant a project but do not pin it).
  - `pinned path with a trailing slash → 403` (`cwd + '/'`).
  - `pinned path → 200 {ok: true}, runner called once with ['open', [cwd]]`.
  - `runner rejects → 500 open failed`.
- [ ] **Step 2:** `pnpm test`: the new cases fail.
- [ ] **Step 3:** Implement the types, lib, handler, route and hook.
- [ ] **Step 4:** `pnpm typecheck` and `pnpm test`: both exit 0. Confirm `test/outbound.test.ts` still passes unchanged (`open-folder.ts` imports no
  network module).
- [ ] **Step 5:** Commit `feat(api): POST /api/open-folder opens a pinned project's folder on macOS`.

---

### Task 6: The levels lib (`client/src/lib/gitLevels.ts`)

**Files:**
- Modify: `client/src/lib/gitStatsText.ts` (export the private `shownFetchError` as `gitShownFetchError`, and keep its call sites working)
- Create: `client/src/lib/gitLevels.ts`
- Create: `test/git-levels.test.ts` (register in `test/run-all.ts` beside `runGitStatsClient`)

**Exports** (all pure, `import type` for shared types):
- `export type GitLevel = 'needs' | 'look' | 'quiet' | 'dead'`
- `export type GitProblemKey = 'gone' | 'notgit' | 'error' | 'fetch' | 'dirty' | 'upstream' | 'pull' | 'push' | 'trunk' | 'remote' | 'detached' | 'stale'`
- `export interface GitProblem { sev: 1 | 2 | 3; k: GitProblemKey; short: string; text: string; calm?: true }`
- `export type GitAgentKind = 'working' | 'waiting' | 'idle'`; `export interface GitAgent { kind: GitAgentKind; label: string; sessionId: string }`
- `export interface GitAssessed { repo: RepoGitStats; problems: GitProblem[]; level: GitLevel; weight: number; verbs: string[] }`
- `export const STALE_BEHIND = 20`; `export const STALE_IDLE_MS = 604_800_000`
- `export const GIT_LEVELS: { key: GitLevel; label: string }[]` = needs `Needs you`, look `Worth a look`, quiet `All good`, dead `Can't read`
- `export const GIT_LEVEL_STATUS: Record<GitLevel, string>` = `needs you`, `worth a look`, `all good`, `can't read`
- `export const GIT_LEVEL_DOT: Record<GitLevel, string>` = needs `needs`, look `flight`, quiet `quiet`, dead `dead`
- `export const GIT_LEVEL_RANK: Record<GitLevel, number>` = 0, 1, 2, 3
- `export function gitPlural(n: number, word: string): string`: `<n> <word>` for 1, else `es` appended after `ch`/`sh`/`s`/`x`, else `s`
- `export function isStaleBranch(b: GitBranch, nowMs: number): boolean`: `(b.behind ?? 0) >= 20 || nowMs - b.lastCommitMs >= STALE_IDLE_MS`
- `export function agentOn(repo: RepoGitStats, branch: string | null, sessions: readonly Session[]): GitAgent | null` (spec §5.2):
  - null unless `repo.state === 'ok'` and `branch !== null`.
  - `within(p, root) = p === root || p.startsWith(root + '/')`.
  - A candidate has `s.gitBranch === branch`, `s.projectPath !== null`, status `working` / `question` / `idle`, and `within(projectPath, repo.toplevel)`, or
    `repo.path !== null && within(projectPath, repo.path)`, or the listed branch with that name has `worktreePath !== null && within(projectPath, worktreePath)`.
  - Best = working before question before idle, then the larger `updatedMs`.
  - Kind/label: working → `working`/`working`, question → `waiting`/`needs answer`, idle → `idle`/`idle <formatAgo(updatedMs)>`.
- `export function gitProblems(repo: RepoGitStats, sessions: readonly Session[], nowMs: number): GitProblem[]`: exactly the table in spec §5.1 (copied
  here):
  - `missing` → `[{sev:2,k:'gone',short:'folder gone',text:gitStateSentence(r)}]`; `not-git` → `[{sev:1,k:'notgit',short:'not a repository',text:…}]`;
    `error` → `[{sev:1,k:'error',short:"couldn't read",text:…}]`.
  - `ok`, built in this order:
    - `fetch`: `e = gitShownFetchError(r)` non-null → sev 3, short `fetchTroubleWord(e)`, text `Fetch <word with a leading "fetch " removed>, so the origin numbers are <formatAgo(fetchedAtMs)> old`,
      or `Fetch <…>, and origin has never been fetched` when `fetchedAtMs === null`.
    - `dirty`: `uncommitted > 0`. `agentOn(r, r.branch, sessions)?.kind === 'working'` → sev 1, `calm: true`, short `<n> uncommitted`, text
      `<gitPlural(n,'uncommitted change')>, and an agent is working on this branch`. Otherwise sev 3, same short, text
      `<gitPlural(n,'uncommitted change')> on <r.branch>` (`on the detached HEAD` when `r.branch === null`).
    - `u = gitUpstreamShown(r)`. `u.counts === null` → sev 1 `upstream`, short `<u.upstream> gone`, text `<u.upstream> is gone, so <r.branch> tracks nothing`.
      Else `behind > 0` → sev 3 `pull`, short `<b> to pull`, text `<r.branch> is <b> behind <u.upstream>`. Then `ahead > 0` → sev 2 `push`, short
      `<a> unpushed`, text `<gitPlural(a,'commit')> on <r.branch> not pushed yet`.
    - `trunk`: `d = r.trunkVsOrigin`, non-null with `ahead || behind` → sev 2. short = `<trunk> <b> behind` (ahead 0), `<trunk> <a> ahead` (behind 0),
      or `<trunk> <a> ahead, <b> behind`. text = `Local ` + `gitTrunkVsOriginText(r)`.
    - `remote`: `!hasOrigin` → sev 1, short `no remote`, text `No remote, so nothing here is backed up`.
    - `detached`: `branch === null` → sev 1, short `detached at <detachedSha>`, text `HEAD detached at <detachedSha>`.
    - `stale`: `n` = listed branches with `isStaleBranch`, n > 0 → sev 1, short `<gitPlural(n,'stale branch')>`, text
      `<gitPlural(n,'stale branch')> (≥ 20 behind or idle a week)`.
    - Then a stable sort by `sev` descending.
- `export function gitLevelOf(repo: RepoGitStats, problems: readonly GitProblem[]): GitLevel`
- `export function gitSyncVerbs(repo: RepoGitStats, problems: readonly GitProblem[]): string[]`: from the non-calm problems, in this order, `dirty`→`commit`,
  `pull`→`pull`, `push`→`push`, `trunk`→`update <trunk>`. `[]` for a non-`ok` repo.
- `export function assessGitRepo(repo, sessions, nowMs): GitAssessed` (weight = the sum of sev).
- `export function rankGitRepos(repos: readonly RepoGitStats[], sessions: readonly Session[], nowMs: number): GitAssessed[]`: assess each, then a
  stable sort by `GIT_LEVEL_RANK` ascending, then `weight` descending (ties keep input order).
- `export function gitSentence(text: string): string`: `text` when it ends with `.`, else `text + '.'`.

- [ ] **Step 1: Write the failing cases** in `test/git-levels.test.ts`. Build repos with an `okRepo(name, over)` like `test/git-stats-client.test.ts`'s
  (clean, level, on `main`, origin, `originUrl: null`, `toplevel: /p/<name>`, `path: /p/<name>`) and sessions with a `sess(over)` helper (every
  `Session` field filled; `projectPath: '/p/a'`, `gitBranch: 'feat'`, `status: 'working'`, `updatedMs: Date.now()`). `NOW = Date.now()`, `DAY = 86_400_000`.
  - `problems: clean level repo → [] and level quiet`.
  - `problems: missing → one gone sev 2, level dead`; `not-git → notgit sev 1, dead`; `error → error sev 1 short "couldn't read", dead`.
  - `problems: auth fetch error, fetched 3h ago → fetch sev 3, short "needs auth", text "Fetch needs auth, so the origin numbers are 3h old"`.
  - `problems: timeout fetch error never fetched → text "Fetch timed out, and origin has never been fetched"`.
  - `problems: lock fetch error → no fetch problem`.
  - `problems: 3 uncommitted on feat, no session → dirty sev 3, text "3 uncommitted changes on feat", level needs`.
  - `problems: 1 uncommitted → "1 uncommitted change on feat"`.
  - `problems: 3 uncommitted under a working session on feat → dirty sev 1 calm, text "3 uncommitted changes, and an agent is working on this branch", level quiet`.
  - `problems: under a question session → still sev 3`; `under an idle session → still sev 3`; `under an incomplete session → still sev 3`.
  - `problems: working session on another branch → sev 3`.
  - `problems: upstream origin/feat 2 behind 1 ahead → pull sev 3 "2 to pull" then push sev 2 "1 unpushed", text "1 commit on feat not pushed yet"`.
  - `problems: upstream origin/feat gone → upstream sev 1 "origin/feat gone"`.
  - `problems: upstream origin/main (trunk) 3 behind → no pull or push`.
  - `problems: trunk 0 ahead 3 behind → trunk sev 2 short "main 3 behind", text "Local main 3 behind origin", level look`;
    `1 ahead 0 behind → short "main 1 ahead"`; `1 ahead 2 behind → short "main 1 ahead, 2 behind"`.
  - `problems: no origin → remote sev 1, level quiet`; `detached at abc1234 → detached sev 1 "detached at abc1234"`.
  - `problems: branches behind 20 / idle 7 days / behind 19 and 6 days → stale counts 2, short "2 stale branches"`.
  - `problems: sorted by sev descending, ties in build order` (fetch error, 1 unpushed, trunk diverged, no stale → keys `['fetch','push','trunk']`).
  - `isStaleBranch: behind 20 → true; 19 → false; behind null and 7 days old → true; 7 days minus 1ms → false`.
  - `agentOn: projectPath equals toplevel → match`; `under toplevel → match`; `a sibling "/p/ab" of toplevel "/p/a" → no match`;
    `projectPath equals the branch's worktreePath → match`; `projectPath null → none`; `branch null → none`; `missing repo → none`.
  - `agentOn: working beats a newer idle; of two idle the newer wins; labels "working", "needs answer", "idle 40m"` (idle `updatedMs = NOW - 40 * 60_000`).
  - `rank: [quiet q, needs n, look l, dead d] → [n, l, q, d]`.
  - `rank: two needs repos, weights 6 and 3 → heavier first; equal weights keep pin order`.
  - `rank: dead missing (sev 2) before dead not-git (sev 1)`.
  - `syncVerbs: dirty + pull + push + trunk → ["commit","pull","push","update main"]`; `calm dirty only → []`; `missing → []`.
  - `gitPlural: ("stale branch", 2) → "2 stale branches"; ("commit", 1) → "1 commit"; ("fix", 2) → "2 fixes"`.
  - `gitSentence: "a" → "a."; "a." → "a."`.
  - `GIT_LEVELS / GIT_LEVEL_STATUS / GIT_LEVEL_DOT / GIT_LEVEL_RANK hold the binding values` (deepStrictEqual against the constraint list).
- [ ] **Step 2:** `pnpm test`: the new cases fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 5:** Commit `feat(git): problems → levels rule with the session join`.

---

### Task 7: The layouts lib and GitView wiring

**Files:**
- Modify: `client/src/lib/gitLayouts.ts` (rewrite)
- Create: `client/src/components/management/gitLayoutProps.ts` (type only)
- Modify: `client/src/components/management/GitView.tsx`
- Test: `test/git-stats-client.test.ts` (replace the four layout cases at ~57–81; keep the OWNED_KEYS case)

**`gitLayouts.ts`:**
- `export type GitLayout = 'inbox' | 'matrix' | 'inspector' | 'branches'`.
- `GIT_LAYOUTS` = `[{key:'inbox',label:'Inbox'},{key:'matrix',label:'Matrix'},{key:'inspector',label:'Inspector'},{key:'branches',label:'Branches'}]`.
- `DEFAULT_GIT_LAYOUT = 'inbox'`. `WIDE_ONLY_GIT_LAYOUTS = ['matrix']`, with a comment that its table has a 760px floor.
- `isGitLayout(v)` stays (true for the four keys only).
- New `export const LEGACY_GIT_LAYOUTS = ['cards', 'table', 'triage'] as const` and `export function parseGitLayout(v: unknown): GitLayout`: a current key →
  itself, anything else (legacy included) → `'inbox'`.
- `gitLayoutsFor(narrow)` and `drawableGitLayout(layout, narrow)` keep their shapes over the new lists.
- File JSDoc: the new shapes, the legacy mapping, the default, and Matrix being wide-only.

**`gitLayoutProps.ts`:**
```ts
export interface GitLayoutProps {
  repos: RepoGitStats[];            // pin order
  sessions: Session[];              // the live sessions payload, [] before it answers
  nowMs: number;                    // Date.now() at render
  clock: FetchClock | undefined;
  sync: GitSyncControl;
  fetchCtl: GitFetchControl;
  unpin: { busy: string | null; run: (dirName: string) => void };
  openFolder: (path: string) => void;
  narrow: boolean;
  setLayout: (l: GitLayout) => void;
}
```
(type-only imports from `shared/types`, `hooks/useGitSync`, `hooks/useGitFetch` and `lib/gitLayouts`).

**`GitView`:**
- `const sessionsState = useSessions({ limit: SYNC_SCAN_LIMIT })` (import `SYNC_SCAN_LIMIT` from `lib/gitSync`); `sessions = sessionsState.data?.sessions ?? []`.
- `const pins = usePins()`. `unpin.run(dirName)`: when `pins.busy` is null, `await pins.setPin(dirName, false)`. A non-null text → `unpinNote` state.
  Success → clear the note and `stats.refresh()`. `unpin.busy = pins.busy`.
- `const folder = useOpenFolder()`; `openFolder = folder.open`.
- `const layout = drawableGitLayout(parseGitLayout(stored), narrow)`. The switcher still maps `gitLayoutsFor(narrow)` and writes `setStored(l.key)`.
- Under `{sync.note && …}`, also `{unpinNote && <div className="git-sync-note">…</div>}` and `{folder.note && <div className="git-sync-note">…</div>}`.
- `GitBody` takes `props: GitLayoutProps` (built in GitView with `nowMs: Date.now()`, `setLayout: setStored`) plus `data`/`error`. Its empty and
  first-load branches are unchanged. Until Tasks 9–12 land, **every** layout key renders `<GitTriage repos={props.repos} sync={props.sync} clock={props.clock} />`
  as a placeholder, marked with a comment naming Task 13 as the point by which nothing may still use it.
- Update the JSDoc: four layouts, the sessions join, Unpin and Open folder.

- [ ] **Step 1: Replace the layout cases** in `test/git-stats-client.test.ts`:
  - `GIT_LAYOUTS lists Inbox, Matrix, Inspector, Branches in order; inbox is the default; matrix is wide-only`.
  - `drawableGitLayout: matrix on a phone draws inbox, on a laptop matrix; inbox, inspector and branches are never coerced`.
  - `gitLayoutsFor: narrow drops matrix (inbox, inspector, branches), wide keeps all four`.
  - `isGitLayout accepts the four keys and rejects cards, table, triage, grid and undefined`.
  - `parseGitLayout: cards, table and triage read as inbox; matrix stays matrix; "grid", 42, null and undefined read as inbox`.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 4:** Pane: Management › Git loads and shows the four pills. Each draws the Triage placeholder. A stored `"cards"` in
  `localStorage['management.gitLayout']` shows Inbox selected. No console errors.
- [ ] **Step 5:** Commit `feat(git): Inbox | Matrix | Inspector | Branches switcher, sessions and keys wired into GitView`.

---

### Task 8: Shared Git parts and their CSS

**Files:**
- Modify: `client/src/components/management/GitParts.tsx` (add exports; leave every existing export in place until Task 13)
- Modify: `client/src/lib/gitSync.ts` (add `syncKeyLabel`)
- Modify: `client/src/styles.css` (append to the git section)
- Test: `test/git-sync-client.test.ts`

**`syncKeyLabel(phase: SyncPhase | null, pending: boolean, opts: { verbs?: readonly string[]; label?: string } = {}): string`**: `Starting…` when pending.
`Syncing` when running. `Syncing…` when launching or unseen. Otherwise `opts.label`, else `Sync · <verbs.join(' + ')>` when verbs is non-empty, else `Sync`.
`syncButtonText` stays as it is.

**New parts in `GitParts.tsx`:**
- `GitLevelDot({ level }: { level: GitLevel })` → `<span className={`git-dot ${GIT_LEVEL_DOT[level]}`} aria-hidden="true" />`.
- `GitAgentChip({ agent }: { agent: GitAgent | null })` → null, or `<span className={`git-sess ${agent.kind}`}>{agent.label}</span>`.
- `GitDv({ ahead, behind }: { ahead: number; behind: number })` →
  `<span className="git-dv" aria-label={`${behind} behind, ${ahead} ahead`}><span className={behind ? 'b' : 'z'}>↓{behind}</span><span className={ahead ? 'a' : 'z'}>↑{ahead}</span></span>`.
- `GitDvBar({ ahead, behind, max })` → `<span className="git-dvbar" aria-hidden="true"><i className="bb" style={{width: gitBarWidth(behind, max, 56)}}/><i className="bc"/><i className="ba" style={{width: gitBarWidth(ahead, max, 56)}}/></span>`.
- `GitBranchDv({ b })` / `GitBranchDvBar({ b, max })`: `gitBranchCounts(b)` null → `<span className="git-dv"><span className="z">—</span></span>` /
  `<span className="git-dvbar" aria-hidden="true" />`. Otherwise the two parts above.
- `GitBranchLabel({ repo, b, sessions })` → `<span className="git-bname"><span className="git-bname-t">{b.name}</span><GitWorktreeBadge b={b}/><GitAgentChip agent={agentOn(repo, b.name, sessions)}/></span>`.
- `GitSyncButton` gains optional props `verbs?: readonly string[]`, `primary?: boolean` and `label?: string`. Text = `syncKeyLabel(phase, starting, {verbs, label})`.
  Class = `git-sync` + ` on` when running, else ` primary` when `primary` and not running. Everything else (availability, disabled rule, stopPropagation,
  aria-labels) is unchanged.
- `GitKeys({ a, ctx, bare = false, compact = false }: { a: GitAssessed; ctx: GitLayoutProps; bare?: boolean; compact?: boolean })` renders a fragment:
  - `a.level === 'dead'`: `<button type="button" className={`git-key${bare ? '' : ' primary'}`} disabled={ctx.unpin.busy !== null}>` with
    `Unpinning…` when `ctx.unpin.busy === a.repo.dirName`, else `Unpin`. Click → `e.stopPropagation(); ctx.unpin.run(a.repo.dirName)`. Nothing else.
  - `retry = a.problems.some(p => p.k === 'fetch')`. When set, `<button type="button" className="git-key[ primary]">` with `Retry` when compact, else
    `Retry fetch`. Primary when `compact ? a.level === 'needs' : !bare`. Disabled when `ctx.fetchCtl.pending || ctx.clock?.runningSinceMs != null ||
    (ctx.sync.tokenRequired === true && !ctx.fetchCtl.tokenStored)`. Click → stopPropagation, then `ctx.fetchCtl.start()`.
  - Then `<GitSyncButton repo={a.repo} sync={ctx.sync} verbs={bare || compact ? [] : a.verbs} primary={…} />`, where primary is
    `compact ? (!retry && a.level === 'needs') : (!bare && !retry && a.level !== 'quiet' && a.verbs.length > 0)`.

**CSS** (append after the `.git-qhead>.git-rowbtn` rule, ~line 2958, above the git section's `@media` blocks):
```css
/* Inbox | Matrix | Inspector | Branches — the parts they share (management-redesign spec §4.2) */
.git-panel{background:var(--strip);border-radius:16px;min-width:0}
.git-gh{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:16px 4px 8px}
.git-key{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;font-family:var(--font);font-size:12px;font-weight:500;line-height:1;color:var(--ink2);background:var(--strip-hi);border:0;border-radius:8px;cursor:pointer;white-space:nowrap;text-decoration:none;transition:color .15s,background .15s}
.git-key:hover:not(:disabled){color:var(--ink);background:var(--hairline2)}
.git-key:disabled{color:var(--ink3);cursor:default}
.git-key:focus-visible,.git-sync:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.git-key.primary,.git-sync.primary{color:var(--strip);background:var(--ink)}
.git-key.primary:hover:not(:disabled),.git-sync.primary:hover:not(:disabled){color:var(--strip);background:color-mix(in srgb,var(--ink) 85%,var(--strip))}
.git-key.primary:disabled,.git-sync.primary:disabled{color:var(--strip);opacity:.55}
.git-chip.dim{color:var(--ink3);border-style:dashed}
.git-sess{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;border-radius:999px;padding:1px 8px 1px 6px;white-space:nowrap;flex:none}
.git-sess::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.git-sess.working{color:var(--green);background:var(--green-tint)}
.git-sess.waiting{color:var(--amber);background:color-mix(in srgb,var(--amber) 13%,transparent)}
.git-sess.idle{color:var(--ink2);background:var(--strip-hi)}
.git-dv{display:inline-flex;gap:8px;font-size:12px;white-space:nowrap}
.git-dv .b{color:var(--ink2)}
.git-dv .a{color:var(--cyan);font-weight:600}
.git-dv .z{color:var(--ink3)}
.git-dvbar{display:inline-grid;grid-template-columns:56px 2px 56px;align-items:center;height:12px}
.git-dvbar i{display:block;height:6px;border-radius:2px}
.git-dvbar .bb{justify-self:end;background:var(--ink3)}
.git-dvbar .ba{justify-self:start;background:var(--cyan)}
.git-dvbar .bc{height:12px;border-radius:0;background:var(--hairline2)}
/* a branch row of Matrix's expanded row and of Inspector: the bar joins from sm */
.git-in-br{display:grid;grid-template-columns:minmax(0,1fr) auto 40px;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--hairline);font-size:13px;color:var(--ink)}
.git-in-br .git-dvbar{display:none}
.git-in-br.stale{color:var(--ink2)}
.git-in-br.stale .git-dvbar{opacity:.55}
/* chips wrap under the name rather than squeeze it */
.git-in-br .git-bname,.git-ib-brow .git-bname{flex-wrap:wrap;row-gap:4px}
.git-in-br .git-bname-t,.git-ib-brow .git-bname-t{flex:none;max-width:100%}
@media (min-width:640px){
  .git-in-br{grid-template-columns:minmax(0,1fr) 116px 90px 40px}
  .git-in-br .git-dvbar{display:inline-grid}
}
```

- [ ] **Step 1: Failing `syncKeyLabel` cases** in `test/git-sync-client.test.ts`: pending → `Starting…`; running → `Syncing` (even with verbs);
  launching → `Syncing…`; unseen → `Syncing…`; null phase with no opts → `Sync`; null with verbs `['commit','pull']` → `Sync · commit + pull`; ended
  with verbs `[]` → `Sync`; failed with `label: 'Clean up via Sync'` → `Clean up via Sync`; label beats verbs.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 4:** Commit `feat(git): shared parts for the four layouts`.

---

### Task 9: Inbox (`GitInbox.tsx`)

**Files:**
- Create: `client/src/components/management/GitInbox.tsx` (`export default function GitInbox(props: GitLayoutProps)`)
- Modify: `client/src/components/management/GitView.tsx` (`inbox` renders `<GitInbox {...props} />` in place of the placeholder)
- Modify: `client/src/styles.css` (after Task 8's block)

**Behaviour** (spec §4.3). `ranked = rankGitRepos(props.repos, props.sessions, props.nowMs)`. State: `filter: GitLevel | 'all'` (default `'all'`) and
`open: Set<string>` (empty). `show(l) = filter === 'all' || filter === l`.
1. `<div className="git-ib-sum">` with, for each `GIT_LEVELS` entry,
   `<button type="button" className={`git-ib-tile ${key}${filter === key ? ' on' : ''}`} aria-pressed={filter === key}>` containing
   `<span className="big">{count}</span><span className="lab"><GitLevelDot level={key}/>{label}</span>`. A click sets the filter to that key, or back to
   `'all'` when it already is.
2. Loud (`needs`, `look`, shown) → `<div className="git-ib-list">` of `<article className="git-panel git-ib-item">`:
   - `<div className="git-ib-top"><GitLevelDot/><div className="git-ib-main">` with `<div className="git-head"><span className="git-name">{name}</span><GitBranchChip repo/><GitAgentChip agent={agentOn(repo, repo.branch, sessions)}/></div>`,
     `<div className="git-ib-verdict">{gitSentence(problems[0].text)}</div>`, and when more problems exist
     `<ul className="git-ib-steps">` with each further problem as `<li className={p.calm ? 'calm' : p.sev >= 3 ? 'hot' : undefined}>{p.text}</li>`. Close
     `.git-ib-main`, then `<div className="git-ib-keys"><GitKeys a ctx={props}/></div>`, then close `.git-ib-top`.
   - When `repo.unmergedTotal > 0`: `<div className="git-ib-br"><button type="button" className="git-ib-tog" aria-expanded={isOpen}>` with
     `<span className="git-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>`, `{gitPlural(unmergedTotal, 'open branch')}`, and
     `{mergedCount > 0 && ` · ${mergedCount} merged hidden`}`. Open, each listed branch is
     `<div className="git-ib-brow"><GitBranchLabel/><GitBranchDv b/><span className="git-age">{formatAgo(b.lastCommitMs)}</span></div>`, then
     `<div className="git-ib-brow git-age">{gitNotShownText(unmergedTotal)}</div>` when `unmergedTotal > GIT_BRANCH_CAP`.
3. Quiet (shown) → `<div className="git-gh">All good</div><div className="git-ib-quiet">` of `<div className="git-ib-line">`: `<GitLevelDot level="quiet"/>`,
   `<span className="git-name">`, `<span className="git-ib-facts">` = `[gitBranchChipText(repo), ...problems.map(p => p.short), gitFetchedText(repo, clock).text].join(' · ')`,
   and `<GitKeys a ctx bare/>`.
4. Dead (shown) → `<div className="git-gh">Can't read</div><div className="git-ib-quiet">`, lines with facts `gitStateSentence(repo)` and `<GitKeys bare/>`.
5. Nothing at all shown under a non-`all` filter → `<div className="git-empty">No repo at this level.</div>`.

**CSS:**
```css
/* Inbox — count tiles that filter, then one ranked list (management-redesign spec §4.3) */
.git-ib-sum{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.git-ib-tile{border:0;text-align:left;font-family:var(--font);color:var(--ink);background:var(--strip);border-radius:16px;padding:14px 16px;display:flex;flex-direction:column;gap:2px;cursor:pointer;outline:2px solid transparent;outline-offset:-2px}
.git-ib-tile.on{outline-color:var(--ink)}
.git-ib-tile:focus-visible{outline-color:var(--cyan)}
.git-ib-tile .big{font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.git-ib-tile.needs .big{color:var(--amber)}
.git-ib-tile .lab{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2)}
.git-ib-list{display:flex;flex-direction:column;gap:10px}
.git-ib-item{padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.git-ib-top{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px}
.git-ib-top>.git-dot{margin-top:7px}
.git-ib-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.git-ib-verdict{font-size:14px;line-height:1.45;color:var(--ink)}
.git-ib-steps{display:flex;flex-direction:column;gap:6px;margin:4px 0 0;padding:0;list-style:none}
.git-ib-steps li{display:flex;gap:10px;align-items:baseline;font-size:13px;color:var(--ink2)}
.git-ib-steps li::before{content:"";width:5px;height:5px;border-radius:50%;flex:none;background:var(--hairline2);transform:translateY(-2px)}
.git-ib-steps li.hot{color:var(--ink)}
.git-ib-steps li.hot::before{background:var(--amber)}
.git-ib-steps li.calm::before{background:var(--green-solid)}
.git-ib-keys{display:flex;gap:6px;flex-wrap:wrap;width:100%;justify-content:flex-start;padding-left:20px}
.git-ib-br{margin-left:20px;padding-top:10px;border-top:1px solid var(--hairline)}
.git-ib-tog{display:inline-flex;align-items:center;gap:4px;padding:0;font-family:var(--font);font-size:12px;color:var(--ink2);background:none;border:0;cursor:pointer}
.git-ib-brow{display:grid;grid-template-columns:minmax(0,1fr) auto 44px;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid var(--hairline);font-size:13px;color:var(--ink)}
.git-ib-brow:last-child{border-bottom:0}
.git-ib-quiet{display:flex;flex-direction:column;padding:4px 18px;border:1px dashed var(--hairline2);border-radius:16px;--sync-paper:var(--strip)}
.git-ib-quiet .git-key{background:var(--strip)}
.git-ib-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 0;border-top:1px solid var(--hairline);font-size:13px}
.git-ib-line:first-child{border-top:0}
.git-ib-line .git-name{font-size:14px}
.git-ib-facts{flex:1;min-width:140px;color:var(--ink2);overflow-wrap:anywhere}
@media (min-width:640px){
  .git-ib-sum{grid-template-columns:repeat(4,minmax(0,1fr))}
  .git-ib-top{flex-wrap:nowrap}
  .git-ib-keys{width:auto;justify-content:flex-end;padding-left:0}
}
```

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 3: Pane** at 375 and 1280, on your real pins: the tiles count and filter (second click clears), loud items carry a verdict, steps and keys, a
  toggle opens branches, quiet and dead lines are dashed, and no horizontal scroll at 375 (`document.documentElement.scrollWidth <= innerWidth`). A dead
  pin's Unpin click answers 403 in the pane (no token): a note line shows.
- [ ] **Step 4:** Commit `feat(git): Inbox layout`.

---

### Task 10: Matrix (`GitMatrix.tsx`)

**Files:**
- Create: `client/src/components/management/GitMatrix.tsx` (`export default function GitMatrix(props: GitLayoutProps)`)
- Modify: `GitView.tsx` (`matrix` renders `<GitMatrix {...props}/>`)
- Modify: `client/src/styles.css`

**Behaviour** (spec §4.4, cells §5.4). `ranked` as in Inbox. State `row: string | null`.
- `tracked(r)` = `r.currentVsUpstream` unless null or `r.trunk !== null && upstream === 'origin/' + r.trunk` → null.
- `CHECKS` = six `{label, cell(a): {c: 'ok'|'bad'|'meh'|'live'|'na'; t: string}}` in order:
  - **Working tree**: `uncommitted > 0` → `{c: dirty problem calm ? 'meh' : 'bad', t: `${n} uncommitted`}`; else `{ok, 'clean'}`.
  - **Pushed**: `!hasOrigin` → `{meh,'no remote'}`; no tracked → `{na,'—'}`; tracked counts null → `{meh, `${upstream} gone`}`; ahead > 0 →
    `{meh, `${a} unpushed`}`; else `{ok,'yes'}`.
  - **Up to date**: no tracked or counts null → `{na,'—'}`; behind > 0 → `{bad, `${b} to pull`}`; else `{ok,'yes'}`.
  - **Trunk**: `trunkVsOrigin` null → `{na,'—'}`; diverged → `{meh, trunk + (b ? ` ↓${b}` : '') + (a ? ` ↑${a}` : '')}`; else `{ok, `${trunk} = origin`}`.
  - **Origin data**: `clock?.runningSinceMs != null && hasOrigin` → `{live,'fetching…'}`; `gitShownFetchError(r)` e → `{bad, `${fetchTroubleWord(e)} · ${fetchedAtMs === null ? 'never' : formatAgo(fetchedAtMs)}`}`;
    `fetchedAtMs` → `{ok, formatAgo(fetchedAtMs)}`; else `{na,'never'}`.
  - **Branches**: s = stale count; s > 0 → `{meh, `${unmergedTotal} · ${s} stale`}`; `unmergedTotal > 0` → `{ok, String(unmergedTotal)}`; else `{na,'0'}`.
- `<div className="git-panel git-mx-wrap"><table className="git-mx">`. thead: `Repo`, then each label followed by
  `<span className={`git-mx-cnt${n ? '' : ' z'}`}>{n}</span>` (n = ok repos whose cell `c` is `bad` or `meh`), then an empty `<th/>`.
- An `ok` row: `<tr className="git-mx-r" onClick={toggle}>`. `<td className="git-mx-rn">` holds
  `<button type="button" className="git-head git-rowbtn" aria-expanded={open}>` with
  `<span className="git-caret" aria-hidden="true">{open ? '▾' : '▸'}</span><GitLevelDot/><span className="git-name">{name}</span>`
  (the button has no click handler of its own, so the click bubbles to the row once), then `<span className="git-mx-sub">{gitBranchChipText(repo)}</span>`.
  Next, six `<td><span className={`git-cell ${c}`}>{t}</span></td>`, then `<td className="git-mx-act"><GitKeys a ctx compact/></td>`. One row open at
  a time.
- Open: `<tr className="git-mx-x"><td colSpan={8}>` with each listed branch as
  `<div className={`git-in-br${isStaleBranch(b, nowMs) ? ' stale' : ''}`}><GitBranchLabel/><GitBranchDvBar b max={gitBarMax(repo.branches)}/><GitBranchDv b/><span className="git-age">{formatAgo(b.lastCommitMs)}</span></div>`,
  or `<span className="git-age">No open branches.</span>`, then `<div className="git-age git-mx-note">{gitMergedText(mergedCount)}</div>` when
  `mergedCount > 0`.
- A dead row: `<tr className="off"><td className="git-mx-rn"><span className="git-head"><span className="git-caret"/><GitLevelDot level="dead"/><span className="git-name">…</span></span></td><td colSpan={6}><span className="git-cell na">{gitStateSentence(repo)}</span></td><td className="git-mx-act"><GitKeys a ctx bare/></td></tr>`.
- After the panel: `<div className="git-mx-legend">` with `<span className="git-cell ok">healthy</span><span className="git-cell bad">needs you</span><span className="git-cell meh">worth a look</span><span>— not applicable</span><span>↓ behind · ↑ ahead</span>`.

**CSS:**
```css
/* Matrix — a row per repo, a column per check, colour only on failure (management-redesign spec §4.4). Wide-only: the table's floor is 760px. */
.git-mx-wrap{padding:6px;overflow-x:auto}
.git-mx{width:100%;min-width:760px;border-collapse:collapse;font-size:13px;color:var(--ink)}
.git-mx th{padding:12px 4px 10px;font-size:11px;font-weight:500;text-align:left;white-space:nowrap;vertical-align:bottom;color:var(--ink2);border-bottom:1px solid var(--hairline2)}
.git-mx th:first-child,.git-mx th:nth-child(n+2){padding-left:12px}
.git-mx-cnt{display:inline-block;min-width:18px;margin-left:5px;padding:1px 5px;font-size:10px;font-weight:700;text-align:center;border-radius:999px;color:var(--amber);background:color-mix(in srgb,var(--amber) 14%,transparent)}
.git-mx-cnt.z{color:var(--ink3);background:var(--strip-hi)}
.git-mx td{height:46px;padding:0 4px;vertical-align:middle;border-bottom:1px solid var(--hairline)}
.git-mx tbody tr:last-child td{border-bottom:0}
.git-mx-r{cursor:pointer}
.git-mx-r:hover td{background:color-mix(in srgb,var(--strip-hi) 60%,transparent)}
.git-mx-rn{padding-left:12px!important;min-width:150px}
.git-mx-rn .git-head{flex-wrap:nowrap;align-items:baseline}
.git-mx-rn .git-name{font-size:14px;overflow-wrap:normal}
.git-mx-sub{display:block;margin:-1px 0 0 24px;font-size:12px;color:var(--ink3)}
.git-mx tr.off .git-name{color:var(--ink2)}
.git-mx-act{padding-right:12px!important;text-align:right;white-space:nowrap}
.git-mx-act>*+*{margin-left:6px}
.git-mx-x td{height:auto;padding:10px 12px 14px 36px;background:var(--strip-hi);border-bottom:1px solid var(--hairline2)}
.git-mx-note{text-align:left;padding-top:8px}
.git-cell{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;font-size:12px;white-space:nowrap;border-radius:8px}
.git-cell.ok{color:var(--ink3)}
.git-cell.ok::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green-tint)}
.git-cell.bad{font-weight:600;color:var(--amber);background:color-mix(in srgb,var(--amber) 11%,transparent)}
.git-cell.meh{font-weight:600;color:var(--mustard);background:color-mix(in srgb,var(--mustard) 13%,transparent)}
.git-cell.live{color:var(--cyan)}
.git-cell.na{color:var(--ink3)}
.git-mx-legend{display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin:12px 6px 0;font-size:12px;color:var(--ink2)}
.git-mx-legend .git-cell{height:20px}
.git-mx-legend .git-cell.ok{padding:0}
```

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 3: Pane** at 1280: the counts match the coloured cells, a row click expands and collapses its branches (one at a time), Tab reaches the name
  button and Enter toggles, a Sync / Retry key click does not toggle the row. At 375 the Matrix pill is absent and Inbox draws.
- [ ] **Step 4:** Commit `feat(git): Matrix layout`.

---

### Task 11: Inspector (`GitInspector.tsx`)

**Files:**
- Create: `client/src/components/management/GitInspector.tsx` (`export default function GitInspector(props: GitLayoutProps)`)
- Modify: `GitView.tsx` (`inspector` renders `<GitInspector {...props}/>`)
- Modify: `client/src/styles.css`

**Behaviour** (spec §4.5, tiles §5.5). `ranked` as before. State `pick: string | null`; `cur = ranked.find(x => x.repo.dirName === pick) ?? ranked[0]`.
`paneRef` on the pane. After a pick, when `props.narrow`, call
`paneRef.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })`.
- `<div className="split git-in">`:
  - `<div className="s-card list"><div className="list-h"><span className="ct">Repos</span><span className="proj-pill">{ranked.length}</span></div>`. Then per
    repo `<div className={`lrow${selected ? ' selected' : ''}`} role="button" tabIndex={0} aria-pressed={selected}>` (click, Enter or Space picks) with
    `<GitLevelDot/>`, `<span className="nm"><span className="t">{name}</span>{ok && <span className="proj-pill">{gitBranchChipText}</span>}</span>`,
    `<span className="pct git-in-fig">{tracked counts ? <GitDv {...counts}/> : null}</span>`, and
    `<div className="act-line"><span className={`spill g-${level}`}>{GIT_LEVEL_STATUS[level]}</span><span>·</span><span className={`act${level === 'needs' ? ' hot' : ''}`}>{why}</span>{ok && <span className={`ago${tone ? ' ' + tone : ''}`}>{agoText}</span>}</div>`.
    Here `why` = level quiet → `problems[0]?.short ?? 'clean · in step'`, else `problems[0].text`. `tone` and `agoText` come from
    `gitFetchedText(repo, clock)`: tone `live` → `fetching…`, else `fetchedAtMs === null ? 'never' : formatAgo(fetchedAtMs)`. `tracked` is as in Task 10.
  - `<div className="s-card inspect git-in-pane" ref={paneRef}>`:
    - `<div className="ins-head"><div className="who2"><div className="ct">{name}</div><div className="ins-meta"><GitLevelDot/><span className={`spill g-${level}`}>{status}</span>{ok && <span className="proj-pill">{branch chip text}</span>}<span className="git-in-path">{repo.path ?? ''}</span></div></div>`.
      Then, for an `ok` repo with a path, `<button type="button" className="git-key" onClick={() => ctx.openFolder(repo.path)}>Open folder</button>`.
      Then `<GitKeys a ctx/>`. Close `.ins-head`.
    - `<div className="git-in-checks">` of `<div className={`kv git-in-ck ${c}`}><span className="k">{k}</span><span className="v">{v}</span>{h && <span className="h">{h}</span>}</div>`.
      An `ok` repo shows the four tiles **Working tree**, **Your branch**, **Trunk**, **Origin data**. A dead repo shows one **State** tile. Values,
      classes and hints, verbatim:
      - Working tree: dirty and calm → `meh`, `<n> uncommitted`, `An agent is working here, so this is expected.`; dirty with a non-working agent on
        the branch → `bad`, `<n> uncommitted`, `An agent is on this branch but not working. Commit or stash.`; dirty with no agent → `bad`,
        `<n> uncommitted`, `Nobody is on this branch. Commit or stash.`; clean → `ok`, `Clean`, `Nothing to commit.`
      - Your branch: detached → `meh`, `Detached at <sha>`, `Check out a branch before committing.`; `onTrunk` → `ok`, `<branch>`,
        `On trunk, tracked beside.`; `currentVsUpstream` null → `ok`, `<branch>`, `No upstream set.`; upstream is `origin/<trunk>` → `ok`, `<branch>`,
        `Tracks <upstream>.`; counts null → `meh`, `<upstream> gone`, `Its upstream is gone; push to set a new one.`; else value
        `↓<b> ↑<a> vs <upstream>`, with class and hint: behind → `bad`, `Pull before you push.`; ahead → `meh`, `Commits on this machine only.`;
        level → `ok`, `In step.`
      - Trunk: `trunkVsOrigin` null and `hasOrigin` → `ok`, `gitTrunkVsOriginText(repo)`, no hint; null and no origin → `meh`, `No remote`,
        `Nothing here is backed up.`; diverged → `meh`, `<trunk> ↓<b> ↑<a>`, `Local <trunk> is stale; new branches would start old.` when b > 0, else
        `Local <trunk> has commits origin lacks.`; level → `ok`, `<trunk> = origin`, `In step with origin.`
      - Origin data: fetch error e → `bad`, `<formatAgo(fetchedAtMs) or never> old · <fetchTroubleWord(e)>`, hint auth
        `Run gh auth login in a terminal, then Retry fetch.`, offline `Check the network, then Retry fetch.`, timeout
        `Retry fetch; a slow remote can outlive the timeout.`, other `Retry fetch, or run git fetch in a terminal to see why.`; a fetch running with an
        origin → `live`, `fetching…`, no hint; fetched → `ok`, `<formatAgo(fetchedAtMs)> old`, `Auto-fetch <fetchPeriodText(intervalSecs)>.` when
        `clock?.intervalSecs` > 0, else `Auto-fetch is off.`; never → `ok`, `Never fetched`, `Not fetched yet.` with an origin, else `No remote to fetch.`
      - State (dead): `meh`, `gitStateSentence(repo)`, hint missing
        `The folder moved or was deleted. Unpin it, or pin it again at its new path under Projects.`, not-git
        `No .git above this folder. Pin the repo root instead.`, error `Git failed reading it; the next poll tries again.`
    - For an `ok` repo: `act` = listed branches not stale, `st` = stale. `max = gitBarMax(repo.branches)`. Row = the Task 10 `.git-in-br` row.
      - `<div className="git-in-sec"><div className="git-in-hd"><b>Active branches</b><span>{`${act.length} · ↓ behind ${trunk ?? 'base'} · ↑ ahead`}</span></div>`,
        then the rows, or `<div className="git-age git-in-none">None.</div>`.
      - When `st.length`: `<div className="git-in-sec"><div className="git-in-hd"><b>Stale</b><span>{`${st.length} · ≥ 20 behind or idle a week`}</span></div>`
        and its rows.
      - When `st.length || mergedCount`: `<div className="git-in-foot"><span>` holding `<m> merged branches can be deleted.` (when m > 0) and
        `<gitPlural(st.length,'stale branch')> to review.` (when > 0), joined with a space. After the span,
        `<GitSyncButton repo sync label="Clean up via Sync" />` (it renders nothing when Sync is unavailable).

**CSS:**
```css
/* Inspector — the Sessions split: ranked list beside one repo in depth (management-redesign spec §4.5) */
.split.git-in{grid-template-columns:minmax(0,1fr)}
.git-in .ct{font-size:19px;font-weight:500;letter-spacing:-.01em;line-height:1.3;color:var(--ink)}
.git-in .list-h .ct{font-size:16px}
.git-in .lrow .git-dot{width:9px;height:9px}
.git-in .lrow .act.hot{color:var(--amber)}
.git-in .lrow .ago.warn{color:var(--amber)}
.git-in .lrow .ago.live{color:var(--cyan)}
.git-in .lrow:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
.git-in-fig{font-weight:400}
.spill.g-needs{background:color-mix(in srgb,var(--amber) 14%,transparent);color:var(--amber)}
.spill.g-look{background:color-mix(in srgb,var(--mustard) 16%,transparent);color:var(--mustard)}
.spill.g-quiet{background:var(--green-tint);color:var(--green)}
.git-in-pane{display:flex;flex-direction:column;gap:20px}
.git-in-pane .ins-meta{margin-top:6px}
.git-in-path{font-size:12px;color:var(--ink3);overflow-wrap:anywhere}
.git-in-checks{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.git-in-ck{display:flex;flex-direction:column;gap:2px}
.git-in-ck .v{display:block;margin-top:4px;font-size:14px;font-weight:600;letter-spacing:0;line-height:1.35;overflow-wrap:anywhere;color:var(--ink)}
.git-in-ck .h{font-size:12px;color:var(--ink2)}
.git-in-ck.bad{background:color-mix(in srgb,var(--amber) 10%,transparent)}
.git-in-ck.bad .v{color:var(--amber)}
.git-in-ck.meh{background:color-mix(in srgb,var(--mustard) 11%,transparent)}
.git-in-ck.meh .v{color:var(--mustard)}
.git-in-ck.live .v{color:var(--cyan)}
.git-in-sec{display:flex;flex-direction:column}
.git-in-hd{display:flex;align-items:baseline;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--hairline2);font-size:12px;color:var(--ink3)}
.git-in-hd b{font-size:13px;font-weight:600;color:var(--ink)}
.git-in-none{text-align:left;padding:10px 0}
.git-in-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ink2)}
@media (min-width:640px){.git-in-checks{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1024px){.split.git-in{grid-template-columns:320px minmax(0,1fr)}}
@media (min-width:1280px){.split.git-in{grid-template-columns:400px minmax(0,1fr)}}
```
(`.split.git-in` outranks the Sessions `.split` widths at 768 and 1536 by specificity, whatever the order.)

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 3: Pane** at 375, 1024 and 1280: list and pane side by side from 1024 and stacked below, picking by click and by Enter, a pick at 375 scrolling
  the pane into view, Open folder sending one `POST /api/open-folder` (403 in the pane; a note line shows), and a dead pin showing its State tile.
- [ ] **Step 4:** Commit `feat(git): Inspector layout with Open folder`.

---

### Task 12: Branches (`GitBranches.tsx`), and the Delete… backlog idea

**Files:**
- Create: `client/src/components/management/GitBranches.tsx` (`export default function GitBranches(props: GitLayoutProps)`)
- Modify: `GitView.tsx` (`branches` renders `<GitBranches {...props}/>`)
- Modify: `client/src/styles.css`

**Behaviour** (spec §4.6). Assess every repo (`assessGitRepo`), keeping **pin order** (not ranked).
- `COLS` = `agent` `Agent on it` `a live session has it checked out`; `ready` `Ready` `0 behind trunk, nothing to rebase`; `drift` `Drifting`
  `behind trunk, still recent`; `stale` `Stale` `≥ 20 behind or idle a week`.
- Items = for each `ok` repo, each listed branch b with `agent = agentOn(repo, b.name, sessions)`. Column = `agent` when agent; else `stale` when
  `isStaleBranch(b, nowMs)`; else `ready` when `b.behind === 0`; else `drift` (null counts included).
- `<div className="git-bb-cols">` of `<div className="git-bb-col">` each: `<div className="git-bb-ch"><b>{label}</b> <span className="git-age">{n}</span><span className="git-bb-hint">{hint}</span></div>`,
  then cards or `<div className="git-bb-empty">Nothing here.</div>`.
- A card: `<div className={`git-panel git-bb-card${col === 'stale' ? ' stale' : ''}`}>`:
  - `<span className="git-bb-bn">{b.name}</span>`
  - `<span className="git-bb-ln"><span className="git-bb-repo">{repo.name}</span><GitWorktreeBadge b/></span>`
  - `<span className="git-bb-ln"><GitBranchDv b/><span className="git-age">{formatAgo(b.lastCommitMs)}</span></span>`
  - When `repo.branch === b.name`: `<span className="git-bb-ln start"><span className="git-chip">checked out</span>` plus, for each problem with `k` in
    `dirty`/`push`/`pull`, `<span className={`git-chip ${p.calm ? 'dim' : p.sev >= 3 ? 'amber' : 'mustard'}`}>{p.short}</span>`, then `</span>`.
  - On a failed fetch (`gitShownFetchError` e): `<span className="git-bb-warn">{`${fetchTroubleWord(e)} · ` + (fetchedAtMs === null ? 'origin never fetched' : `origin ${formatAgo(fetchedAtMs)} old`)}</span>`.
  - With an agent: `<span className="git-bb-ln start"><GitAgentChip agent/></span>`.
  - Keys `<span className="git-bb-ln end">`, drawn only when non-empty: when `repo.branch === b.name`, `<GitSyncButton repo sync />` (bare). When the
    column is `ready` and `url = gitCompareUrl(repo.originUrl ?? null, repo.trunk, b.name)` is non-null,
    `<a className="git-key" href={url} target="_blank" rel="noopener noreferrer">Open PR</a>`. No Delete key.
- After the columns, when non-`ok` repos exist: `<div className="git-bb-note">Not on the board: {list}. <button type="button" className="git-link" onClick={() => setLayout('inbox')}>Open Inbox</button></div>`,
  where list = `<name> (<problems[0].short>)` joined with `, `.

**CSS:**
```css
/* Branches — every open branch across the pins, a column per need (management-redesign spec §4.6) */
.git-bb-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
.git-bb-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.git-bb-ch{padding:0 4px;font-size:13px;color:var(--ink)}
.git-bb-ch .git-age{text-align:left}
.git-bb-hint{display:block;margin-top:2px;font-size:11px;color:var(--ink3)}
.git-bb-card{display:flex;flex-direction:column;gap:7px;padding:12px 14px}
.git-bb-card.stale{background:transparent;border:1px dashed var(--hairline2)}
.git-bb-bn{font-size:13px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.git-bb-ln{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.git-bb-ln.end{justify-content:flex-end;gap:6px}
.git-bb-ln.start{justify-content:flex-start;gap:6px}
.git-bb-warn{font-size:12px;font-weight:500;color:var(--amber)}
.git-bb-note{font-size:12px;color:var(--ink3);padding:0 4px}
.git-bb-repo{font-size:12px;color:var(--ink3)}
.git-bb-empty{padding:12px 14px;font-size:12px;color:var(--ink3);border:1px dashed var(--hairline2);border-radius:16px}
@media (min-width:640px){.git-bb-cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (min-width:1280px){.git-bb-cols{grid-template-columns:repeat(4,minmax(0,1fr))}}
```

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 3: Pane** at 375, 768 and 1280 (1, 2 and 4 columns): branches land in the right column, the checked-out card carries its chips and Sync, a
  Ready card on a github.com or gitlab.com repo has Open PR (check the `href` with `read_page`; do not click through), and Open Inbox switches the layout.
- [ ] **Step 4: File the Delete… idea** with `/backlog-capture` (the store is GitHub issues on `futin/claude-agents-dashboard`, per
  `backlog/source.json`; never write a file under `backlog/`). Kind: idea. Title: `Branches: a Delete… key on stale branch cards`. Body: "Management › Git
  › Branches drops the mock's Delete… key on Stale cards (management-redesign spec §2). Deleting a local branch is the first destructive Git action
  the dashboard would take, so it needs its own design: which branches qualify (merged-proven only, or stale too), a confirm step, the worktree case,
  and whether it goes through git-sync or a server route. Mock: docs/guides/mockups/redesign-mock.html, `branches()`." This posts an issue, so it needs
  the user's go-ahead. If you cannot get it, put the exact title and body in your report and the controller files it.
- [ ] **Step 5:** Commit `feat(git): Branches layout with Open PR`.

---

### Task 13: Finish GitView and delete the old layouts

**Files:**
- Delete: `client/src/components/management/GitCards.tsx`, `GitTable.tsx`, `GitTriage.tsx`, and `client/src/lib/gitTriage.ts`
- Modify: `client/src/components/management/GitView.tsx` (no placeholder left: inbox, matrix, inspector and branches each render their component)
- Modify: `client/src/components/management/GitParts.tsx` (remove exports nothing imports any more)
- Modify: `client/src/styles.css` (remove dead rules)
- Modify: `test/git-stats-client.test.ts` (remove the `triageGitRepos` import, the `// ── triage` block (~87–151), and the triage asserts in the
  upstream cases near ~505–515; keep the cases that test `gitUpstreamShown` / `gitUpstreamText` themselves. Update the file's top comment.)

**Behaviour:**
- `GitParts.tsx`: remove `gitGroupsByDir`, `GitDot`, and every component no remaining `.tsx` imports (check each with
  `grep -rn "<Name>" client/src`): expected `GitUpstreamChip`, `GitUncommittedChip`, `GitTrunkChip`, `GitFetched`, `GitDivergenceBar`, `GitNums`,
  `GitBranchRow`, `GitBranchList`. Keep `GitBranchChip`, `GitWorktreeBadge`, `GitSyncButton` and everything Task 8 added. Rewrite the top JSDoc.
  `lib/gitStatsText.ts` keeps its exports (they are tested copy).
- CSS: for each class below, delete its rules (including the lines in the git section's `@media` blocks ~2963–2976) **only if**
  `grep -rnw "<class>" client/src --include=*.tsx --include=*.ts` finds no use (`-w`, so `git-tr` does not match `git-trouble`; `git-bar` does match
  `git-bar-b`, and they all go together): `git-fetched`, `git-facts`, `git-state`, `git-branches`, `git-brow`,
  `git-bar`, `git-bar-b`, `git-bar-a`, `git-bar-c`, `git-nums`, `git-nums-b`, `git-nums-a`, `git-more`, `git-note`, `git-cards`, `git-card`,
  `git-table-wrap`, `git-table`, `git-tname`, `git-tr`, `git-sub`, `git-div`, `git-tri`, `git-tri-group`, `git-tri-h`, `git-arow`, `git-summary`,
  `git-head-row`, `git-head-end`, `git-sync-td`, `git-qhead`. **Keep** `git-rowbtn`, `git-caret`, `git-age`, `git-bname*`, `git-chip*`, `git-dot*`,
  `git-head`, `git-name`, `git-sync*`, `git-switch`, `git-toolbar`, `git-clock*`, `git-meter*`, `git-pop*`, `git-trouble*`, `git-empty`, `git-link`,
  `git-sync-note`. Update the section comments that described Cards / Table / Triage.
- `grep -rn "gitTriage\|GitCards\|GitTable\|GitTriage\|triageGitRepos" client server shared test` must print nothing.

- [ ] **Step 1:** Make the deletions and edits.
- [ ] **Step 2:** `pnpm typecheck` and `pnpm test`: both exit 0. `pnpm build` succeeds.
- [ ] **Step 3: Pane** at 375 and 1280, all four layouts: no console errors, nothing unstyled (compare each with its Task 9–12 look).
- [ ] **Step 4:** Commit `refactor(git): remove Cards, Table and Triage`.

---

### Task 14: Visual fixtures and re-baseline (macOS)

**Files:**
- Modify: `test/visual/fixtures/git-stats.ts`
- Create: `test/visual/fixtures/git-sessions.ts`
- Modify: `test/visual/fixtures/pins.ts` (add an exported `pinsWithGone`)
- Modify: `test/visual/views.spec.ts`
- Modify: `test/visual/__screenshots__/*` (re-baselined)

**Fixture data** (invented, `HOME = '/Users/dev'`; new projects `dirName: '-Users-dev-code-<name>'`, `path: `${HOME}/code/<name>``, `toplevel` = path):
- **aurora-api** (existing): keep everything; make its branches 7 by appending three literals after the helper's four:
  `spike/cache-warmup` (ahead 2, behind 24, `ago(3 * DAY)`), `docs/api-guide` (ahead 1, behind 2, `ago(9 * DAY)`), `chore/lint-rules`
  (ahead 1, behind 0, `ago(5 * HOUR)`), all `worktreePath: null`. Set `unmergedTotal: 7`. The shared working session on `feat/orders-rate-limit`
  makes its 3 uncommitted calm. Expected: **look** (2 unpushed, 2 stale).
- **harbor-web** (existing): unchanged apart from `originUrl`. Expected: **look** (trunk 3 behind). The shared question session sits on
  `feat/checkout-steps`.
- **lumen-cli** (new): branch `release/2.4`, `onTrunk: false`, uncommitted 0, trunk `main`, origin, `trunkVsOrigin {0,0}`, trunkRefs both,
  `currentVsUpstream: {upstream: 'origin/release/2.4', counts: {ahead: 0, behind: 5}}`, `fetchedAtMs: ago(3 * HOUR)`,
  `lastFetch: {atMs: ago(4 * MIN), error: 'auth'}`, `originUrl: 'https://github.com/acme/lumen-cli.git'`, branches `release/2.4` (ahead 6, behind 0,
  `ago(3 * HOUR)`), `feat/plugin-api` (ahead 11, behind 18, `ago(2 * DAY)`), `unmergedTotal: 2`, `mergedCount: 42`. Expected: **needs**.
- **beacon** (new): on `main`, clean and level, origin, `originUrl: 'https://github.com/acme/beacon.git'`, fetched `ago(4 * MIN)`, no fetch error, one
  branch `feat/dark-mode` (ahead 5, behind 0, `ago(1 * DAY)`), `unmergedTotal: 1`, `mergedCount: 0`. Expected: **quiet**, and a Ready card with Open PR.
- **tidepool** (new): `branch: null`, `detachedSha: 'a1b2c3d'`, `onTrunk: false`, trunk `main`, `hasOrigin: false`, `originUrl: null`,
  `trunkVsOrigin: null`, `trunkRefs: {local: true, origin: false}`, `currentVsUpstream: null`, `fetchedAtMs: null`, `lastFetch: null`, no branches.
  Expected: **quiet** (no remote and detached, both sev 1).
- **old-scripts** (new): `state: 'missing'`. **notes** (new): `state: 'not-git'`, path `${HOME}/notes`.
- Repo order: aurora, harbor, lumen, beacon, tidepool, old-scripts, notes. Expected rank: lumen, aurora, harbor, tidepool, beacon, old-scripts, notes.
  Update the file's top comment to list the states.
- `git-sessions.ts`: `export const gitSessions: SessionsResponse = { ...sessions, sessions: [...sessions.sessions, lumenIdle] }`. `lumenIdle` spreads
  `sessions.sessions.find(s => s.status === 'idle')!`, then overrides `id: 'c0ffee00-1111-4222-8333-444455556666'`, `project: 'lumen-cli'`,
  `projectPath: '/Users/dev/code/lumen-cli'`, `gitBranch: 'release/2.4'`, `sessionName: null`, `tasks: null`, `taskPlan: null`,
  `updatedMs: ago(40 * MIN)`, `lastTimestamp: agoIso(40 * MIN)`. Top comment: Git-only, so the Sessions shots keep their four rows.
- `pins.ts`: `pinsWithGone: PinsResponse = { ...pins, pinned: [...pins.pinned, { dirName: '-Users-dev-code-old-scripts', name: 'old-scripts', path: `${HOME}/code/old-scripts`, lastActiveMs: null, listed: false }] }`.

**`views.spec.ts`:** widen `kind` to
`'shot' | 'detail' | 'triage' | 'git-matrix' | 'git-inspector' | 'git-branches' | 'projects-tiles' | 'projects-columns' | 'projects-lists'`. Append
these cases (daylight, `contentWidth: 'fixed'`, `section: 'management'`):
- `git-matrix` 1280: `storage {'management.gitLayout': 'matrix'}`, `fixtures {'/api/sessions': gitSessions}`.
- `git-inspector` 375 and 1280: `storage {'management.gitLayout': 'inspector'}`, same fixtures.
- `git-branches` 375 and 1280: `storage {'management.gitLayout': 'branches'}`, same fixtures.
- `projects-tiles` 1280, `projects-columns` 1280, `projects-lists` 375: `managementTab: 'projects'`,
  `storage {'management.projectsLayout': <tiles|columns|lists>}`, `fixtures {'/api/pins': pinsWithGone}`.
- `EXPECTED_SHOTS = 84`. Its comment: `12 per view × 6 views + 2 drawer details + 2 triage + 5 git layouts + 3 projects layouts.`

- [ ] **Step 1:** Edit the fixtures and the spec. `pnpm typecheck` and `pnpm test`: both exit 0.
- [ ] **Step 2: Re-baseline (macOS only):** `pnpm test:visual --update-snapshots` (no `--`). Then `pnpm test:visual` must pass with no diff.
- [ ] **Step 3: Read the new and changed PNGs** before committing: the 8 new ones and every management shot. Check the Inbox order (lumen, aurora, harbor;
  then All good tidepool and beacon; then Can't read), the calm step on aurora, the waiting and idle chips, Matrix's counts, and the gone chip at the foot
  of the dead tile. A shot showing an error or empty state is a bug, not a baseline.
- [ ] **Step 4:** If `layout.spec.ts` overflow or the axe contrast check flags anything new, fix the CSS (token choice, wrapping). **Never** add entries
  to `test/visual/contrast-known.json` for new nodes.
- [ ] **Step 5:** Commit `test(visual): Git layouts, sessions join and the gone chip, re-baselined`, including the PNGs.

---

### Task 15: Docs

**Files:**
- Modify: `docs/subsystems/git-stats.md`, `docs/subsystems/view-persistence.md`, `docs/subsystems/settings.md`, `docs/overview.md`, `.claude/DESIGN.md`,
  `docs/subsystems/visual-tests.md`

**Edits** (only the lines that change; leave each file's trailing `docs-sync` stamp alone apart from its `sources` list):
- `git-stats.md`:
  - Under "What each number means": a bullet for `originUrl`. It comes from `git remote get-url origin`, local config only (no network). URL-form userinfo
    is cleared and scp-like `user@` is dropped, so no credential leaves the server. It is null without an origin.
  - §Client: replace "The layouts" and "The triage rule" with the four layouts (spec §4.3–4.6, one line each), the levels rule (sev 3 / 2 / 1, the
    level, the rank, the stale rule, calm only under a working agent), the session join (`useSessions({limit: 50})` in GitView, the three path rules,
    the status mapping), and the keys (Sync with its verbs, Retry fetch = Fetch all, Unpin on dead repos, Open PR via `gitCompareUrl` for github.com and
    gitlab.com, Open folder via `POST /api/open-folder`).
  - Fix "A branch row" for the new `.git-dv` (↓ behind ↑ ahead) and the 56px `.git-dvbar` halves.
  - Remove the Cards / Triage mentions in the fetched-text and Sync paragraphs.
  - `docs-sync` sources: remove the three deleted components and `gitTriage.ts`. Add `client/src/lib/gitLevels.ts`, `client/src/lib/gitLinks.ts`,
    `client/src/components/management/GitInbox.tsx`, `GitMatrix.tsx`, `GitInspector.tsx`, `GitBranches.tsx`, `gitLayoutProps.ts`,
    `server/lib/open-folder.ts` and `client/src/hooks/useOpenFolder.ts`.
- `view-persistence.md` (~line 68): `management.gitLayout` holds which of Inbox | Matrix | Inspector | Branches was picked, read through
  `parseGitLayout`. A stored legacy `cards` / `table` / `triage` reads as `inbox` (the default), and the next pick overwrites it. A phone draws Inbox
  without overwriting a stored `matrix`.
- `settings.md` (~line 30, the grip paragraph): the drag is a drop line (nothing moves until release, the source dims, a ghost follows, a bar from
  `dropMark` marks the gap, and the head reads `Moving <name> · n of N`). A dead pin shows a `Folder gone` chip whose tooltip holds the sentence, so every
  tile keeps one height.
- `overview.md`:
  - The `management/` component line: replace "GitCards / GitTable / GitTriage (the three shapes)" with "GitInbox / GitMatrix / GitInspector /
    GitBranches (the four shapes, fed one `GitLayoutProps`)".
  - hooks: add `useOpenFolder`. lib: replace "gitLayouts / gitTriage / gitStatsText (… Triage grouping …)" with "gitLayouts / gitLevels / gitLinks /
    gitStatsText (switcher rules, the problems → levels rule and session join, the compare link, the copy table)".
  - The API table: a `POST /api/open-folder` row after `/api/pins/order`: "open a pinned project's folder with macOS `open`. Token-guarded, path must be a
    listed pin's, 501 off macOS (see `[git-stats](subsystems/git-stats.md)`)" — the link is written relative to `docs/overview.md`.
  - The `server/lib` map: `open-folder.ts`.
- `.claude/DESIGN.md` §8.4b: Projects' grip sentence becomes the drop line (no lift any more, so drop "the one transient exception to no lift"). The
  amber-edge sentence gains "and a Folder gone chip in place of its age". Git's "three shapes" list and the four-inks paragraph become the four layouts
  and the four levels (amber needs you, mustard worth a look, green all good, `--ink3` can't read), one line each.
- `visual-tests.md`: `views.spec.ts` row → 84 shots, and the arithmetic sentence `12 × 6 + 2 + 2 + 5 + 3 = 84`. Name the Git-only `gitSessions` and
  `pinsWithGone` overrides beside the existing `fixtures` sentence.

- [ ] **Step 1:** Make the edits. `pnpm test` (it includes `test/docs-links.test.ts`) and `pnpm typecheck`: both exit 0.
- [ ] **Step 2:** Commit `docs: Management redesign (drop line, gone chip, four Git layouts, open-folder)`.
