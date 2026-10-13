# Management redesign — Projects drop line, Folder-gone chip, and four Git layouts

Decisions settled with the user on 2026-10-13. Source of truth for the look: [`docs/guides/mockups/redesign-mock.html`](../../guides/mockups/redesign-mock.html)
(header comment, the MANAGEMENT CSS block and the MANAGEMENT `<script>` block). Supporting analysis of the five Git variants:
[`2026-10-12-management-git-ux-mockups.html`](2026-10-12-management-git-ux-mockups.html). Plan: [`../plans/2026-10-13-management-redesign.md`](../plans/2026-10-13-management-redesign.md).

## 1. Why

**Projects.** The live grip (#193, `client/src/hooks/usePinReorder.ts`) moves the dragged pin under the pointer. Tiles of different heights (a dead pin
carries an extra sentence) change the boxes under a still pointer, so a swap can bounce back. The mock drew three fixes (Lift, Drop line, Arrange); the user
picked **Drop line**: nothing moves until release, so tile sizes stop mattering. The dead pin's sentence becomes a chip with a tooltip, so every tile in a
group has one height in all three layouts.

**Git.** Cards, Table and Triage each answer "what does this repo look like", not "what needs me". The Git UX analysis drew five variants. The user picked
four of them to **replace** all three live layouts: Inbox (the default), Matrix, Inspector and Branches. They share one problems → levels table, which
replaces `lib/gitTriage.ts`. They also read the live sessions, so uncommitted work under a working agent reads as expected rather than forgotten.

## 2. Decisions

| Question | Decision |
|---|---|
| Order of work | Projects first, then Git, one plan. |
| Projects reorder | **Drop line only.** The source item dims in place (`.src`, dashed). A ghost chip (`.pj-ghost`) follows the pointer. A green bar (`.pj-mark.h` in one column, `.pj-mark.v` in the Tiles grid) marks the landing gap. The Pinned head reads `Moving <name> · <n> of <N>` while a drag runs. Release saves once; Escape and `pointercancel` cancel. ↑←↓→ on a focused grip still moves a pin one place and saves at once. The `Saved` flash stays, and a non-blank filter still hides the grips. Lift and Arrange are **not** shipped. |
| Dead pin note | **Folder-gone chip** (`.pj-gone` with a `.pj-tip` tooltip shown on hover and focus) in place of the age, in Tiles, Columns and Lists. The `PROJECTS_MISSING` sentence moves into the tooltip. No tile or row grows a second note line for it. |
| The mock | Trimmed first (plan Task 1) to Drop line only: the Lift and Arrange variants, the reorder varbar and their state go. The gone chip stays. |
| Git layouts | **Inbox \| Matrix \| Inspector \| Branches** replace Cards \| Table \| Triage. `GitCards.tsx`, `GitTable.tsx`, `GitTriage.tsx` and `lib/gitTriage.ts` are deleted. |
| Grouping | The mock's `problems()` → levels table becomes `client/src/lib/gitLevels.ts` (§5.1): four levels (`needs`, `look`, `quiet`, `dead`), severities 3 / 2 / 1, the stale rule, the session join, and a rank by level, then by summed severity, then by pin order. |
| Persistence | `management.gitLayout` stays a localStorage key read through `usePersistedState`. The union is `inbox \| matrix \| inspector \| branches`, default `inbox`. A stored legacy `cards`, `table` or `triage` reads as `inbox`. |
| Phone | Matrix is wide-only (its table has a 760px floor), like Table was: a phone is not offered it and draws Inbox, and the stored `matrix` survives for the next wide window. Inbox, Inspector and Branches draw at every width. |
| Keys | Ship **Open PR** (Branches › Ready cards) and **Open folder** (Inspector head). **Delete… is dropped** and filed as a backlog idea. |
| Open PR | New `originUrl: string \| null` on the `ok` `RepoGitStats`. The server reads `git remote get-url origin` (local config, no network) and strips any userinfo. The client builds a compare link for github.com and gitlab.com only (§6.2). Any other host gets no key. |
| Open folder | New `POST /api/open-folder` `{path}`. Accepted only when `path` is the path of a pin that is listed now. Runs macOS `open <path>` through `execFile` (no shell). Non-darwin → 501. The runner and the platform are injectable for tests. |
| Kept live behaviour | GitView's band, toolbar, `GitClockChip` and its popover, Sync and Fetch all, the git-sync chat, and the `.git-sync-note` line. |

## 3. Projects — the drop line

### 3.1 `lib/pins.ts` — `dropMark`

New pure export beside `dropIndex`:
`dropMark(items: readonly {name: string; rect: PinRect}[], dragged: string, to: number, gap: number): DropMark | null`, where
`DropMark = { orient: 'h' | 'v'; left: number; top: number; width: number; height: number }` (viewport px, for a `position:fixed` element).

- `null` when `dragged` is not in `items`, or no other item exists.
- `others` = `items` without `dragged`. One column = every `rect.left` within 1px of the first item's, the same test `dropIndex` uses.
- `end` = `to >= others.length`. The reference box is `others[others.length - 1]` when `end`, else `others[to]`.
- One column → `{orient: 'h', left: r.left, width: r.right - r.left, height: 3, top: (end ? r.bottom + gap : r.top - gap) - 1.5}`.
- Grid → `{orient: 'v', top: r.top, height: r.bottom - r.top, width: 3, left: (end ? r.right + gap : r.left - gap) - 1.5}`.
- `gap` is half the gap between items: `0` in Lists (rows touch), `6` in Tiles and Columns (their `.pj-tiles` gap is 12px).

### 3.2 `usePinReorder` — rewritten to Drop line

The hook keeps its signature and adds one parameter: `usePinReorder(pinned, busy, reorder, filterBlank, gapPx)`.

What stays as it is: the `document` listeners matched by `pointerId`, never `setPointerCapture`, the `busy` and `filterBlank` guards, the mouse-button
check, edge auto-scroll (48px band, 10px a frame), the keyboard path with its pending-focus re-focus, `Saved` for 1500ms, `headError` / `errorFor`, and
`cancel()`.

What changes:

- **Nothing reorders during a drag.** The `dragOrder` field is removed. The page draws `pinned` in prop order throughout, and the dragged item carries
  `.src` instead of `.drag`.
- Each pointer move (and each auto-scroll step) reads every pinned item's live box in DOM order, takes `to = dropIndex(items, name, pointer)`, and sets
  `dropAt` to `to` when `movePin(order, name, to)` returns a new array, else to `null`. `mark` is `dropMark(items, name, to, gapPx)` when `dropAt` is
  non-null, else `null`. State is set only when `dropAt` or the mark's box changes, not on every move.
- **The ghost** moves through a ref: the pointer handler writes `left = clientX + 14px` and `top = clientY - 18px` straight to the element's style, so a
  move costs no render. The ref callback applies the last known pointer when the element mounts.
- **Release** with `dropAt !== null` → `reorder(movePin(start, name, dropAt))` once (optimistic, so the list re-sorts at once). Release with `dropAt`
  null, `pointercancel`, Escape, `busy` turning non-null, or the filter turning non-blank → nothing is written.
- A `pinned` change mid-drag that drops the dragged pin cancels. Any other `pinned` change resets `start` to the new order and clears `dropAt` and `mark`
  until the next move.
- `document.body` carries `pj-dragging` for the drag's lifetime.
- New fields: `dropAt: number | null`, `headLabel: string | null` (`Moving <name> · <n> of <N>`, where n is `dropAt + 1` when set, else the pin's current
  1-based position), `ghost: {name: string; pos: string} | null` (pos `→ <to+1> of <N>` when `dropAt` is set, else `<i> of <N>`),
  `ghostRef: (el: HTMLDivElement | null) => void`, and `mark: DropMark | null`.

### 3.3 `ProjectsView`

- Pinned items are always `pinnedShown` (no `applyPinOrder(pinned, dragOrder)` branch). `leadCls` gives ` g` plus ` src` for the dragged pin.
- The Pinned head's aside is `<span class="pin-saved live" role="status">{headLabel}</span>` while `headLabel` is set, else today's `headError` / `Saved`.
- The ghost and the mark render through `createPortal(…, document.body)`, outside `.shell`, whose `zoom` (text scale) would otherwise scale a fixed box
  away from the viewport coordinates `getBoundingClientRect` reports. Ghost markup: `<div class="pj-ghost" ref={ghostRef}><b>⠿</b>{name}<i>{pos}</i></div>`.
  Mark: `<div class="pj-mark h|v" style={{left, top, width, height}} />`.
- `gapPx` passed to the hook: `layout === 'lists' ? 0 : 6`.

### 3.4 The Folder-gone chip

- `lib/projectsView.ts` gains `PROJECTS_GONE_CHIP = 'Folder gone'`. `PROJECTS_MISSING` keeps its text and becomes the tooltip's.
- A pin with `listed: false` draws, in place of its `.pj-age` (Tiles foot, Columns foot, Lists control):
  `<button type="button" class="pj-gone" aria-describedby="pj-tip-<dirName>">` holding a 12px warning-triangle SVG (`aria-hidden`), the text
  `Folder gone`, and `<span class="pj-tip" role="tooltip" id="pj-tip-<dirName>">{PROJECTS_MISSING}</span>`.
- `Notes` stops drawing the gone sentence. It still draws the refusal error (`.pin-sub.err`).
- The tip opens upward and right from the chip. Where the chip sits at the card's right edge, it opens leftward: Lists rows and Columns tiles, **from `md`
  only**. Below `md` both put the control under the label at the left, where a leftward tip would run off the screen. (The mock flips Lists rows at every
  width.)

### 3.5 CSS

Ported from the mock with live tokens (§7). New: `.pin-saved.live`, `body.pj-dragging`, `.pj-tile.src`, `.pj-srw.src`, the `.src` grip, `.pj-ghost`
(and its `b`, `i`), `.pj-mark` (`.h`, `.v`, `::before`, `::after`), `.pj-gone`, `.pj-tip`, and the flipped tips. Removed: the Lift rules `.pj-tile.drag`,
`.pj-srw.drag` and `.pj-tile.drag .pin-grip, .pj-srw.drag .pin-grip`.

## 4. Git — what the page draws

### 4.1 GitView

`GitView` keeps its band, toolbar (switcher plus `GitClockChip`), the `.git-sync-note` lines and the `ChatDrawer`. It gains:

- `useSessions({ limit: SYNC_SCAN_LIMIT })`, its own call (the decision), so the join sees every live row up to the server's cap of 50, not the Sessions
  page's `maxSessions`. `sessions = data?.sessions ?? []`.
- `usePins()`, for the Unpin key on dead repos: `setPin(dirName, false)`, then `stats.refresh()` on success, or a note line with the returned text.
- `useOpenFolder()` (§6.3), for the Open folder key, with its own note line.
- `const layout = drawableGitLayout(parseGitLayout(stored), narrow)`.
- Every layout gets one props bundle, `GitLayoutProps`: `repos` (pin order), `sessions`, `nowMs` (`Date.now()` at render), `clock`, `sync`, `fetchCtl`,
  `unpin: {busy, run}`, `openFolder`, `narrow`, `setLayout`.

### 4.2 Shared parts (`GitParts.tsx`)

- `GitLevelDot({level})` → `<span class="git-dot needs|flight|quiet|dead">`.
- `GitAgentChip({agent})` → `<span class="git-sess working|waiting|idle">{label}</span>`.
- `GitDv({ahead, behind})` → `.git-dv` with `↓<behind>` (`.b`, or `.z` when 0) then `↑<ahead>` (`.a`, or `.z` when 0), and an `aria-label` of
  `<behind> behind, <ahead> ahead`.
- `GitDvBar({ahead, behind, max})` → `.git-dvbar` with `i.bb`, `i.bc`, `i.ba`; side widths `gitBarWidth(n, max, 56)` px.
- `GitBranchLabel({repo, b, sessions})` → `.git-bname` > `.git-bname-t` + `GitWorktreeBadge` + the agent chip for that branch.
- A branch with null counts draws an empty `.git-dvbar` and a `.git-dv` holding one `.z` dash `—`.
- `GitKeys({a, ctx, bare, compact})` — the mock's `keys()` (§4.7).
- `GitSyncButton` gains optional `verbs`, `primary` and `label`. Its text comes from `syncKeyLabel` (§5.3), and `primary` adds `.primary` only while idle.

### 4.3 Inbox (default)

- Four count tiles (`.git-ib-sum` > `button.git-ib-tile.<level>`; `.on` and `aria-pressed` on the picked one; `.big` count; `.lab` dot and label). A
  click picks that level as the filter, and a second click returns to all. The filter is per mount and not stored.
- **Loud** repos (`needs`, `look`), ranked, each an `article.git-panel.git-ib-item`: `.git-ib-top` = dot, `.git-ib-main` (head: name, branch chip, agent
  chip on the checked-out branch; `.git-ib-verdict` = the first problem's text as a sentence; `ul.git-ib-steps` = the rest, `li.calm` for a calm problem,
  `li.hot` for sev 3), and `.git-ib-keys`. Under them, when the repo has unmerged branches, `.git-ib-br` holds a toggle
  (`button.git-ib-tog`, `aria-expanded`, caret ▸/▾ in `.git-caret`, `<n> open branch(es)` from `unmergedTotal`, plus ` · <m> merged hidden` when
  `mergedCount > 0`). Open, it lists every listed branch as `.git-ib-brow` (label, `GitDv`, age), then the capped-list note when
  `unmergedTotal > 50`. Every toggle starts closed.
- **All good** (`quiet`): `.git-gh` "All good", then one dashed `.git-ib-quiet` box of `.git-ib-line`s: dot, name, `.git-ib-facts` (branch or detached
  chip text, each problem's short, the fetched text, joined with ` · `), and bare keys.
- **Can't read** (`dead`): `.git-gh` "Can't read", the same box, facts = `gitStateSentence`, key Unpin.
- A filter that leaves nothing shows `.git-empty` `No repo at this level.`

### 4.4 Matrix (wide only)

- `.git-panel.git-mx-wrap` > `table.git-mx`: head `Repo`, the six checks, an empty action column. Each check header carries `.git-mx-cnt` (`.z` when 0) =
  the number of `ok` repos whose cell is `bad` or `meh`.
- Ranked rows. An `ok` repo is `tr.git-mx-r`. Clicking it toggles one expanded row (one open at a time). The name cell holds `button.git-rowbtn`, which
  carries `aria-expanded` and lets the keyboard reach the toggle: caret, dot, name, then `.git-mx-sub` with the branch chip text. Then six
  `.git-cell.<ok|bad|meh|live|na>` cells (§5.4), then `.git-mx-act` with the compact keys.
- A dead repo is `tr.off`: name, one `colspan=6` `.git-cell.na` with the state sentence, and an Unpin key.
- The expanded row `tr.git-mx-x` (`colspan=8`) lists `.git-in-br` branch rows (stale ones `.stale`), or `No open branches.`, then the merged line.
- `.git-mx-legend` under the panel: `healthy`, `needs you`, `worth a look`, `— not applicable`, `↓ behind · ↑ ahead`.

### 4.5 Inspector

- `div.split.git-in` > `div.s-card.list` (`.list-h`: `.ct` "Repos" and a `.proj-pill` count; `.lrow` per ranked repo) beside
  `div.s-card.inspect.git-in-pane`.
- `.lrow` (`role="button"`, `tabIndex=0`, Enter / Space pick, `.selected` on the pick): `GitLevelDot`, `.nm` (`.t` name, `.proj-pill` branch chip for an
  `ok` repo), `.pct.git-in-fig` (`GitDv` of the tracked upstream's counts), `.act-line` (`.spill.g-<level>` status word, `·`, `.act` reason, `.hot` when
  `needs`, `.ago` fetched short with tone class).
- The pane: `.ins-head` (`.who2` > `.ct` name + `.ins-meta` = dot, status spill, branch pill, `.git-in-path`; then an Open folder `git-key` for an `ok`
  repo with a path, then the repo's keys), four `.kv.git-in-ck.<class>` check tiles (§5.5), Active branches and Stale sections (`.git-in-sec` >
  `.git-in-hd` + `.git-in-br` rows), and `.git-in-foot` (merged and stale counts, plus a `Clean up via Sync` sync key).
- The pick defaults to the top-ranked repo, and falls back to it when the picked one leaves the list. On a narrow window a pick scrolls the pane into view
  (`block: 'start'`, smooth unless reduced motion), since the pane stacks under the list there.

### 4.6 Branches

- `.git-bb-cols` of four `.git-bb-col`s: **Agent on it** (`a live session has it checked out`), **Ready** (`0 behind trunk, nothing to rebase`),
  **Drifting** (`behind trunk, still recent`), **Stale** (`≥ 20 behind or idle a week`). Each has a `.git-bb-ch` head (`<b>` label, `.git-age` count,
  `.git-bb-hint`).
- Every listed branch of every `ok` repo, in pin order then server order, goes in the first column that fits: an agent on it → Agent on it; stale → Stale;
  `behind === 0` → Ready; anything else, null counts included → Drifting.
- A card is `div.git-panel.git-bb-card` (`.stale` in Stale): `.git-bb-bn` name; `.git-bb-ln` repo (`.git-bb-repo`) and worktree badge; `.git-bb-ln` dv and
  age. The checked-out branch adds a `checked out` chip, its dirty / push / pull problems as chips (`.dim` calm, `.amber` sev 3, `.mustard` otherwise),
  and a bare Sync key. A failed fetch adds `.git-bb-warn`. An agent adds its chip. A Ready card with a compare link adds **Open PR**.
- An empty column shows `.git-bb-empty` `Nothing here.`
- Non-`ok` pins go in one `.git-bb-note` line: `Not on the board: <name> (<short>), ….`, then a `.git-link` **Open Inbox** that sets the layout to `inbox`.

### 4.7 Keys (`GitKeys`)

Per the mock's `keys()`:

- `dead` → **Unpin** (`.primary` unless bare); `Unpinning…` while `unpin.busy` is this dirName; disabled while `unpin.busy` is non-null.
- A failed fetch (`k: 'fetch'`) → **Retry fetch** (`Retry` when compact), `.primary` unless bare (compact: only at level `needs`). It runs
  `fetchCtl.start()`. Disabled while `fetchCtl.pending`, while the clock says a fetch runs, or while the server wants a token this device has not stored.
- Then the Sync key. It is primary when not bare, no Retry is drawn, the level is not `quiet`, and there is at least one sync verb (compact: primary at
  level `needs` when no Retry is drawn). It is labelled `Sync · <verbs joined by ' + '>` unless bare or compact.
- Every key stops click propagation (a Matrix row toggles on click).

**Retry fetch and Unpin are new.** The live tab has neither, although the decision list calls them live behaviours. Retry runs the existing Fetch all,
because no per-repo fetch route exists.

## 5. Git — the rules (`client/src/lib/gitLevels.ts`)

### 5.1 Problems

`gitProblems(repo, sessions, nowMs): GitProblem[]`, where `GitProblem = {sev: 1 | 2 | 3; k; short; text; calm?: true}`. Built in this order, then
stably sorted by `sev` descending:

| k | When | sev | short | text |
|---|---|---|---|---|
| `gone` | `state: 'missing'` | 2 | `folder gone` | `gitStateSentence(r)` |
| `notgit` | `state: 'not-git'` | 1 | `not a repository` | `gitStateSentence(r)` |
| `error` | `state: 'error'` | 1 | `couldn't read` | `gitStateSentence(r)` |
| `fetch` | last fetch error not null and not `lock` | 3 | `fetchTroubleWord(e)` | `Fetch <word without a leading "fetch ">, so the origin numbers are <formatAgo(fetchedAtMs)> old`, or `…, and origin has never been fetched` when `fetchedAtMs` is null |
| `dirty` | `uncommitted > 0`, a **working** agent on the checked-out branch | 1, `calm` | `<n> uncommitted` | `<n> uncommitted change(s), and an agent is working on this branch` |
| `dirty` | `uncommitted > 0`, otherwise | 3 | `<n> uncommitted` | `<n> uncommitted change(s) on <branch>` (`on the detached HEAD` when detached) |
| `upstream` | `gitUpstreamShown(r)` with `counts: null` | 1 | `<upstream> gone` | `<upstream> is gone, so <branch> tracks nothing` |
| `pull` | shown upstream, `behind > 0` | 3 | `<behind> to pull` | `<branch> is <behind> behind <upstream>` |
| `push` | shown upstream, `ahead > 0` | 2 | `<ahead> unpushed` | `<ahead> commit(s) on <branch> not pushed yet` |
| `trunk` | `trunkVsOrigin` non-null and not 0 / 0 | 2 | `<trunk> <b> behind` / `<trunk> <a> ahead` / `<trunk> <a> ahead, <b> behind` | `Local ` + `gitTrunkVsOriginText(r)` |
| `remote` | `!hasOrigin` | 1 | `no remote` | `No remote, so nothing here is backed up` |
| `detached` | `branch === null` | 1 | `detached at <sha>` | `HEAD detached at <sha>` |
| `stale` | ≥ 1 stale listed branch | 1 | `<n> stale branch(es)` | `<n> stale branch(es) (≥ 20 behind or idle a week)` |

Plurals follow the mock's `plural`: `es` after `ch`, `sh`, `s` or `x`, else `s`, nothing for 1.

### 5.2 Levels, rank, staleness, the join

- **Level**: any non-`ok` state is `dead`. Otherwise the highest sev present: 3 → `needs`, 2 → `look`, 1 or no problems → `quiet`.
- **Weight**: the sum of every problem's sev. **Rank**: `needs` 0, `look` 1, `quiet` 2, `dead` 3 ascending, then weight descending, then pin order (a
  stable sort).
- **Stale branch**: `(b.behind ?? 0) >= 20` or `nowMs - b.lastCommitMs >= 604_800_000` (7 days).
- **Session join** (`agentOn(repo, branch, sessions)`): only an `ok` repo and a non-null branch. A session matches when
  `s.gitBranch === branch`, `s.projectPath` is non-null, and the path equals or lies under (`root + '/'`) `repo.toplevel`, `repo.path`, or that branch's
  `worktreePath`. Status maps `working` → `working` (label `working`), `question` → `waiting` (label `needs answer`), and `idle` → `idle` (label
  `idle <formatAgo(updatedMs)>`). `incomplete` matches nothing. When several match, the order is working, then waiting, then idle, and the newest
  `updatedMs` breaks a tie. The result is `{kind, label, sessionId}` or null.
- **Calm** applies only under a `working` agent, so a waiting or idle agent leaves uncommitted work at sev 3. Matrix's Working-tree cell and Inspector's
  Working-tree tile read the same calm flag. The mock lets any agent soften those two, which disagrees with its own `problems()`. The build follows
  `problems()`.
- **Labels and inks**: `GIT_LEVELS` = Needs you, Worth a look, All good, Can't read. Status words: `needs you`, `worth a look`, `all good`, `can't read`.
  Dots: `needs` → `.git-dot.needs` (amber), `look` → `.git-dot.flight` (mustard), `quiet` → `.git-dot.quiet` (green), `dead` → `.git-dot.dead` (no rule,
  so the base `--ink3`).

### 5.3 Sync verbs and the key's text

- `gitSyncVerbs(repo, problems)` reads the non-calm problems: `dirty` → `commit`, `pull` → `pull`, `push` → `push`, `trunk` → `update <trunk>`, in that
  order.
- `syncKeyLabel(phase, pending, {verbs, label})` in `lib/gitSync.ts`: `Starting…` when pending; `Syncing` running; `Syncing…` launching or unseen;
  otherwise `label`, else `Sync · <verbs joined by ' + '>` when verbs is non-empty, else `Sync`.
- `canSync` is unchanged: `ok` and `hasOrigin`. The mock's `syncKey` also hides Sync on a detached HEAD. The build keeps the live rule (decision 6: live
  Sync behaviour stays).

### 5.4 Matrix cells

`tracked(r)` = `currentVsUpstream` unless it is null or its upstream is `origin/<trunk>`.

| Check | Cell |
|---|---|
| Working tree | `uncommitted > 0` → `meh` when calm, else `bad`, `<n> uncommitted`; else `ok` `clean` |
| Pushed | `!hasOrigin` → `meh` `no remote`; no tracked → `na` `—`; tracked `counts: null` → `meh` `<upstream> gone`; `ahead > 0` → `meh` `<a> unpushed`; else `ok` `yes` |
| Up to date | no tracked, or `counts: null` → `na` `—`; `behind > 0` → `bad` `<b> to pull`; else `ok` `yes` |
| Trunk | `trunkVsOrigin` null → `na` `—`; diverged → `meh` `<trunk>` + ` ↓<b>` if b + ` ↑<a>` if a; else `ok` `<trunk> = origin` |
| Origin data | a fetch running and `hasOrigin` → `live` `fetching…`; fetch error → `bad` `<word> · <formatAgo(fetchedAtMs) or never>`; `fetchedAtMs` → `ok` `formatAgo(fetchedAtMs)`; else `na` `never` |
| Branches | stale count s > 0 → `meh` `<unmergedTotal> · <s> stale`; `unmergedTotal > 0` → `ok` `<unmergedTotal>`; else `na` `0` |

### 5.5 Inspector check tiles

| Tile | Value and hint |
|---|---|
| Working tree | dirty, calm → `meh`, `<n> uncommitted`, `An agent is working here, so this is expected.`; dirty with a non-working agent → `bad`, same value, `An agent is on this branch but not working. Commit or stash.`; dirty, none → `bad`, `Nobody is on this branch. Commit or stash.`; clean → `ok` `Clean`, `Nothing to commit.` |
| Your branch | detached → `meh` `Detached at <sha>`, `Check out a branch before committing.`; on trunk → `ok` `<branch>`, `On trunk, tracked beside.`; no upstream → `ok` `<branch>`, `No upstream set.`; upstream is `origin/<trunk>` → `ok` `<branch>`, `Tracks <upstream>.`; upstream gone → `meh` `<upstream> gone`, `Its upstream is gone; push to set a new one.`; else `↓<b> ↑<a> vs <upstream>`: `bad` + `Pull before you push.` when behind, `meh` + `Commits on this machine only.` when ahead, `ok` + `In step.` |
| Trunk | `trunkVsOrigin` null → `hasOrigin` ? `ok` `gitTrunkVsOriginText(r)`, no hint : `meh` `No remote`, `Nothing here is backed up.`; diverged → `meh` `<trunk> ↓<b> ↑<a>`, `Local <trunk> is stale; new branches would start old.` when behind, else `Local <trunk> has commits origin lacks.`; level → `ok` `<trunk> = origin`, `In step with origin.` |
| Origin data | fetch error → `bad` `<age> old · <word>` (age `never` when null), hint by error: auth `Run gh auth login in a terminal, then Retry fetch.`, offline `Check the network, then Retry fetch.`, timeout `Retry fetch; a slow remote can outlive the timeout.`, other `Retry fetch, or run git fetch in a terminal to see why.`; running → `live` `fetching…`; fetched → `ok` `<age> old`, `Auto-fetch <fetchPeriodText>.` or `Auto-fetch is off.`; never → `ok` `Never fetched`, `Not fetched yet.` with an origin, else `No remote to fetch.` |
| (dead) State | `meh`, `gitStateSentence`, hint: missing `The folder moved or was deleted. Unpin it, or pin it again at its new path under Projects.`; not-git `No .git above this folder. Pin the repo root instead.`; error `Git failed reading it; the next poll tries again.` |

## 6. Server and the two new keys

### 6.1 `originUrl`

- `shared/types.ts` first: the `ok` variant of `RepoGitStats` gains `originUrl: string | null`, documented as the origin's URL from local config with
  userinfo removed, null without an origin or when it cannot be read.
- `server/lib/git-stats.ts`: right after `hasOrigin`, when it is true, run `git remote get-url origin` through the same `git` wrapper. A non-zero exit or
  empty output → null. Otherwise `stripUserinfo(stdout.trim())`. The call reads `.git/config` and makes no network call. It runs in the repo's existing
  strictly sequential chain.
- `stripUserinfo(url): string | null` (exported). Empty → null. A URL with `://`: parse with `new URL`, and a parse failure → null. With no username or
  password, the input is returned unchanged. Otherwise the username and password are cleared and `href` is returned. scp-like
  `user@host:path` (no `://`, `@` before the first `:`) → `host:path`. Anything else (a local path) is unchanged.

### 6.2 The compare link (`client/src/lib/gitLinks.ts`)

`gitCompareUrl(originUrl, trunk, branch): string | null`.

- Accepted origin shapes: `https://host/path`, `http://host/path`, `ssh://[user@]host[:port]/path`, and scp-like `[user@]host:path`. One trailing `/`,
  then one trailing `.git`, then a leading `/` are stripped from the path.
- Hosts, case-insensitive and exact: `github.com` (path must be exactly 2 non-empty segments) and `gitlab.com` (2 or more).
- github → `https://github.com/<path>/compare/<trunk>...<branch>?expand=1`. gitlab → `https://gitlab.com/<path>/-/compare/<trunk>...<branch>?expand=1`.
  Trunk and branch are encoded per `/`-segment with `encodeURIComponent`, so slashes survive.
- null when `originUrl` or `trunk` is null, `branch === trunk`, the host is anything else, or the path is malformed. The Open PR key is drawn only for a
  non-null link: `<a class="git-key" href target="_blank" rel="noopener noreferrer">Open PR</a>`. A payload from an older server has no `originUrl` field;
  read it as `?? null`.

### 6.3 `POST /api/open-folder`

- Types: `OpenFolderRequest {path: string}` and `OpenFolderResponse {ok: true}` in `shared/types.ts`.
- `server/lib/open-folder.ts`: `openFolderPlatform()` (default `process.platform`), `openFolder(path)` (default runner
  `execFile('open', [path], {timeout: 5000})`, no shell, resolving on exit 0 and rejecting otherwise), and the test seam
  `overrideOpenFolder({run?, platform?})` where null restores the default.
- Handler `serveOpenFolder` in `server/api.ts`, wired in `server/index.ts` as POST-only (any other method → the existing `methodNotAllowed`, 405). Gates
  in order:
  1. `tokenOk` fails → 403 `{error: 'bad token'}`.
  2. Body is not `{path: string}` with a non-empty path → `sendBadBody` 400 `{error: 'expected {path: string}'}`.
  3. `openFolderPlatform() !== 'darwin'` → 501 `{error: 'open folder needs macOS'}`.
  4. `path` is not string-equal to the `path` of a `listed` row of `listPinRows(config, getPinnedProjects(), {archivedIds: archivedSessionIds(), ...pinOptions()})`
     → 403 `{error: 'not a pinned project'}`. Nothing is joined or normalised, so `/a/b/` does not match `/a/b`.
  5. The runner rejects → 500 `{error: 'open failed'}`.
  6. Otherwise 200 `{ok: true}`.
- `test/outbound.test.ts` is **not affected**. It flags `node:http(s)`, `net`, `tls`, `dgram` and `fetch(`. `open-folder.ts` imports
  `node:child_process`, and `open` opens a Finder window without any network call.
- Client `hooks/useOpenFolder.ts`: `{open(path), pending, note}`. It POSTs with the `dashboard.answerToken` Bearer header as `usePins` does. Notes:
  403 `bad token` → `Open folder needs the Answer token — set it under Settings › Local › Connection.`; 403 otherwise → `That folder is no longer pinned.`;
  501 → `Open folder works only when the dashboard server runs on macOS.`; anything else → `Couldn't open the folder.`; success clears it.

## 7. CSS port and token map

Every rule ported from the mock swaps the mock's tokens for the live ones. The mock's own header (MANAGEMENT CSS block) lists the first six. The rest were
checked against the `client/src/styles.css` token block on 2026-10-13:

| Mock | Live |
|---|---|
| `--bg-surface` | `--strip` |
| `--bg-subtle` | `--strip-hi` |
| `--bg-track` | `--steel` |
| `--border` / `--border-strong` | `--hairline` / `--hairline2` |
| `--text-primary` / `-secondary` / `-tertiary` | `--ink` / `--ink2` / `--ink3` |
| `--green-600` as text | `--green` |
| `--green-600` as a mark (dot, `::before`) | `--green-solid` |
| `--green-600` 13–16% tint, `--green-200` | `--green-tint` |
| `--ink-inverse` (fill) / `--text-on-dark` (ink on it) | `--ink` / `--strip` (the live `.newbtn` pairing) |
| `--lift-card` | dropped: live cards carry no lift |
| `--lift-float` | `0 8px 24px var(--shadow2)` |
| `--r-sm` / `--r-md` / `--r-lg` / `--r-full` | `8px` / `12px` / `16px` / `999px` |
| `--cyan` | `--cyan` (in daylight both are the green accent, so the "green bar" is `--cyan`) |

Also:

- **No `max-width` media query**, because `test/breakpoints.test.ts` fails on one. The mock's queries are inverted mobile-first onto the ladder: 560 / 640
  → `sm` 640, 860 → `lg` 1024, 1100 → `xl` 1280.
- The mock's `.card` / `.tagpill` / `.status` are the live `.s-card` / `.proj-pill` / `.spill`, so `.status.g-*` ships as `.spill.g-*`.
- Existing live rules the mock repeats (`.git-age`, `.git-bname`, `.git-bname-t`, `.git-caret`, `.git-chip*`, `.git-sync*`, `.git-dot*`) are kept as they
  are, not re-ported.

## 8. Tests

New files are registered in `test/run-all.ts` beside their neighbours: `test/git-levels.test.ts`, `test/git-links.test.ts`, `test/api-open-folder.test.ts`.
The plan lists every case by name. Summary:

- `pins-client.test.ts`: `dropMark`, column and grid, start / middle / end, gap 0 / 6, null cases.
- `projects-view.test.ts`: `PROJECTS_GONE_CHIP`.
- `git-stats.test.ts`: `originUrl` from a real fixture (local path unchanged, https with credentials stripped, scp-like user stripped, no origin → null
  with no `get-url` call) and `stripUserinfo` cases.
- `git-links.test.ts`: every accepted shape, both hosts, nested gitlab groups, branch encoding, every null case.
- `api-open-folder.test.ts`: 405, 403 token, 400 ×3, 501, 403 not pinned (including a trailing-slash variant), 200 with the runner called once with
  `('open', [path])`, 500 on a rejecting runner.
- `git-levels.test.ts`: every problem row of §5.1, the levels, ranking ties, calm under each session status, the join's three path rules and its
  priority, `isStaleBranch` at both thresholds, sync verbs.
- `git-stats-client.test.ts`: the new layout union, `parseGitLayout`'s legacy mapping and narrow coercion. The triage cases go with `gitTriage.ts`.
- `git-sync-client.test.ts`: `syncKeyLabel`.
- Visual: the Git fixture gains mock-style repo states, a Git-only sessions fixture and a pins fixture with a dead pin. `views.spec.ts` adds Matrix,
  Inspector, Branches and Projects shots. Re-baselined with `pnpm test:visual --update-snapshots` on macOS.

**Not unit-tested, checked in the browser pane:** the drop-line drag (bar placement in each layout, the ghost, one POST on release, Escape), the gone tip
on hover and focus, each layout's clicks, Open folder and Open PR. The pane has no Answer token, so writes answer 403 there. The 200 paths of reorder,
Unpin and Open folder are the user's to click.

## 9. Docs

`docs/subsystems/git-stats.md` (Client section, originUrl in the reader facts, docs-sync sources), `docs/subsystems/view-persistence.md`
(`management.gitLayout`), `docs/subsystems/settings.md` (the Projects reorder paragraph and the gone chip), `docs/overview.md` (component, hook and lib
maps, the API table row for `POST /api/open-folder`, the `server/lib` map), `.claude/DESIGN.md` §8.4b, `docs/subsystems/visual-tests.md` (the shot
count), and the `server/index.ts` route-list comment.

## 10. Out of scope

- Delete… on stale branches (filed as a backlog idea).
- A per-repo fetch route (Retry fetch runs Fetch all).
- Inspector as the expanded state of an Inbox row, and the analysis's "Refined cards" (V5).
- Hiding Open folder on a non-macOS host (the key shows and the 501 note explains).
- Sorting anything by level outside Management › Git (the Lookout git-pending tile keeps its own groups).

## 11. Where the mock and the decisions disagreed

| Point | Mock | Resolution |
|---|---|---|
| Drag head label | Drop line reads `Drop <name> · …` | `Moving <name> · n of N` (decision 2); Task 1 changes the mock to match. |
| Gone tip in Lists | flips leftward at every width | leftward only from `md`, where the control sits at the right edge; Columns tiles get the same flip, which the mock lacks. |
| Calm dirty work | Matrix / Inspector soften under any agent | only under a working agent, as `problems()` says. |
| Sync on detached HEAD | hidden | kept: live `canSync` (decision 6). |
| Retry fetch, Unpin | drawn as if live | not live; built new (§4.7). |
| Backlog item | "a `backlog/` entry in the existing file format" | `backlog/` holds only `source.json` pointing at GitHub issues (`futin/claude-agents-dashboard`); the item is filed with `/backlog-capture`, never a hand-written file. |
| Fixture fields | `upstream`, `fetched`, `fetchError`, `ago` | live `currentVsUpstream`, `fetchedAtMs`, `lastFetch.error`, `lastCommitMs`; states the mock lacks (`error` repo, upstream gone, null counts) get the rows in §5. |
