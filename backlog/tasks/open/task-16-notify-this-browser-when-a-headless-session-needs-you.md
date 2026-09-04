---
id: task-16
title: Notify this browser when a headless session needs you
created: 2026-09-04
from: idea-19
---

## Goal

A headless session spawned from the dashboard (`surface: 'dashboard'`, the cyan
`dashboard` pill) is the one class of session with **no desk-side channel at all**: no CLI
notification fires, because there is no CLI in front of you. Give this browser a narrow
notification for exactly that class — an OS banner with a per-event icon, one beep, and a
`N need you` pill in the header — reusing the poll it already makes, and say out loud where
it cannot reach.

Scoped so the argument that deleted the old layer (commit `6a05998`: "on a Mac it repeated
the CLI's own notification on the same screen") cannot come back: there is no CLI
notification to duplicate for a headless run. iOS is deliberately out of scope — ntfy is
that platform's channel, and a switch that looks On while `Notification` does not exist was
the original bug.

## Plan

**This plan specifies behaviour, signatures and exact expected values, and deliberately
contains no literal code blocks** (`.claude/CLAUDE.md` — handed code gets transcribed
verbatim, so a bug here would become a bug on the branch with nobody positioned to catch
it). Disagree with anything below that reads wrong at the keyboard. Size figures are soft
targets, never a reason to drop a rule.

Nothing on the server changes, and no field is added to `shared/types.ts`: the poll already
carries `surface`, `remoteQuestion`, `remotePlan`, `remoteReply` and `permissionWait` per
session (`shared/types.ts` `Session`).

### 1. `client/src/lib/holds.ts` — new, pure: one precedence ladder

`chatTab` in `client/src/components/SessionRow.tsx` currently owns the only definition of
"which hold wins". This feature needs the same ladder, so extract it rather than writing a
second one that can drift.

- `export type HoldKind = 'question' | 'plan' | 'reply' | 'permission'`.
- `holdKind(s: Session): HoldKind | null` — precedence, highest first: `remoteQuestion` →
  `'question'`, `remotePlan` → `'plan'`, `remoteReply` → `'reply'`, `permissionWait` →
  `'permission'`, otherwise `null`. Same order `chatTab` uses today; do not reorder it.
- `holdCount(sessions: readonly Session[]): number` — how many rows are waiting on you, any
  surface.
- Refactor `chatTab` to branch on `holdKind(s)`. Its labels, tones and `title` strings must
  come out **byte-for-byte unchanged** — this is a de-duplication, not a copy edit. (idea-7
  notes this precedence is currently untested; case 1 below is where it finally gets a test.)

### 2. `client/src/lib/webNotify.ts` — new, pure: what counts as an announcement

A narrowed revival of `git show 6a05998^:client/src/lib/alerts.ts` — status-based becomes
flag-based, and the scope gate is new. Read that file first; the dedupe design in it is
sound and worth keeping.

- `export type NotifyKind = 'question' | 'plan' | 'reply'`. **`permission` is excluded on
  purpose**: a headless run has no TTY, so no permission dialog exists to answer
  (`docs/subsystems/spawn.md` — "a headless run has no TTY, so a permission prompt has
  nowhere to go"). A banner for it would ask the reader to do something impossible.
- `notifyKind(s: Session): NotifyKind | null` — `null` unless `s.surface === 'dashboard'`;
  then `holdKind(s)`, with `'permission'` mapping to `null`.
- `kindMap(sessions): Map<string, NotifyKind>` — the baseline a poll leaves behind.
- `NotifyTarget` is `{ id: string; label: string; kind: NotifyKind }`, `label` being
  `sessionName || project` (same label rule the ntfy push uses).
- `diffNeeds(prev: ReadonlyMap<string, NotifyKind>, next: readonly Session[]):
  NotifyTarget[]` — a target for every session whose `notifyKind` is non-null and differs
  from `prev.get(id)`. Stays a pure diff: an empty `prev` yields the whole waiting set, and
  the *caller* is what skips the first snapshot.
- `notifyKey(t): string` — `` `${t.id}:${t.kind}` ``.
- `dedupe(targets, seen: Map<string, number>, now: number, ttlMs: number): NotifyTarget[]`
  — evict `seen` entries older than `ttlMs` on the way through (so a long-lived tab cannot
  grow the ledger), drop targets already in it, record the survivors. Mutates `seen`, which
  is the point.
- `notifyBody(t): string` — exact strings, chosen to match `PHRASE` in `server/lib/notify.ts`
  so the desk channel and the away channel read alike:
  - `question` → `<label> — question waiting`
  - `plan` → `<label> — plan waiting for review`
  - `reply` → `<label> — finished — reply window open`
- `NOTIFY_TITLE` — `Claude Sessions`.
- `iconColorVar(kind): string` — the CSS custom-property *name* only: `--amber` for
  question, `--cyan` for plan, `--mustard` for reply. Resolving and painting it is the
  hook's job, so this module stays pure and testable.

### 3. `client/src/hooks/useWebNotify.ts` — new, impure: the browser half

- `webNotifySupported(): boolean` — `typeof Notification !== 'undefined'`.
- `webNotifyPermission(): NotificationPermission | 'unsupported'`.
- `requestWebNotifyPermission(): Promise<NotificationPermission>` — every engine requires a
  user gesture, so this is called from the Settings click and nowhere else; returns
  `'denied'` when unsupported.
- `notifyIcon(kind): string | undefined` — a 64×64 canvas: a filled disc in the live theme
  colour read from `getComputedStyle(document.documentElement).getPropertyValue(iconColorVar(kind))`,
  with a glyph in `--on-accent` (`?` question, `>` plan, `<` reply — pick glyphs that survive
  at 20px, and say which you chose). Returned as a PNG data URL, memoised per
  `kind + resolved colour` so a theme switch repaints and a repeat does not. **This is the
  only styling a Web Notification allows** — title, body, icon, `tag`, `silent`; the banner
  itself is drawn by the OS and has no CSS. If canvas or the token is unavailable, return
  `undefined`: a missing icon must never cost the banner.
- `unlockAudio()` and `beep()` — revive from
  `git show 6a05998^:client/src/hooks/useSessionAlerts.ts` essentially as-is: one
  module-scope `AudioContext` (never one per beep), `resume()` only from a gesture, two
  ramped tones at 880/1174 Hz. Zero new deps, in keeping with the repo's posture.
- `announce(targets)` — `dedupe` against a module-scope ledger with a 60 000 ms TTL, then
  one `Notification` per fresh target with `body: notifyBody(t)`, `tag: t.id` (so repeats
  for one session collapse instead of stacking), `icon: notifyIcon(t.kind)` and
  `silent: true`; then **one** `beep()` for the batch, not one per target. `silent: true` plus
  our own beep is deliberate: exactly one sound per batch, and the same sound whatever the OS
  would have done. Every call wrapped so a throw cannot break the poll.
- `fireTestNotification(): Promise<string>` — fires regardless of state and returns a
  verbatim account, the same principle as `POST /api/notify/test` ("every failure here is
  invisible from the outside"). One string, ` · `-joined, from these pieces: `notification
  sent` / `notifications blocked for this site in browser settings` / `notification
  permission never granted — turn the switch off and on to ask` / `no Notification API in
  this browser` / `notification threw: <message>`, plus `sound played` / `sound blocked by
  the browser` / `no audio support`.
- `useWebNotify(sessions: Session[] | null | undefined)` — holds the previous `kindMap` in a
  ref. Three behaviours, all of which the old hook got right and which must survive:
  - **No baseline, no announcements.** The first snapshot after a load seeds the ref and
    returns, or every already-waiting session would fire at once on every page load.
  - **The ref updates even while the switch is off**, so turning it on mid-session cannot
    replay a backlog.
  - Announce only when the switch is on; the banner additionally needs permission
    `'granted'`, while the **beep does not** — a denied permission still leaves a sound.

### 4. Settings

- Add `notifyBrowser: boolean` to `Settings`, `DEFAULT_SETTINGS` (**`false`**) and
  `clampSettings` (via the strict `pickBool`). A flat key — `client/src/lib/settings.ts`
  opens with a warning that the stored blob is shallow-merged one level deep, so a nested
  object would never gain a later default.
- New group titled `Notify this browser · this device`, placed **immediately above** the
  existing `Push notifications · every device` group, so the desk channel reads next to the
  away channel. One row, `Notify this browser`, whose hint states the real scope in the
  copy: headless sessions only (the ones with the `dashboard` pill), only while the Sessions
  section is open.
- Turning the switch **on** calls `requestWebNotifyPermission()` and `unlockAudio()` from
  that same click. If the answer is `denied`, still store it on, and render a `set-warn`
  block saying notifications are blocked for this site so only the beep will fire — the
  group must never read On while being silently impossible, which is the rule the
  `notifyAvailable: false` warning already follows for ntfy.
- A `Test` button beside it, shaped like the existing push-test button, printing
  `fireTestNotification()`'s string verbatim.
- The whole group renders **nothing** when `webNotifySupported()` is false. iOS Safari and
  Chrome-on-iOS get no switch rather than a dead one; ntfy is their channel. Do not
  reintroduce a tab-title count as a fallback — `6a05998` rejected it because a poll-fed
  count is unreliable in exactly the throttled background tab where a title would be worth
  reading.

### 5. The header pill

- `Header` already receives the whole `SessionsResponse`, so no prop changes. In the `.sub`
  line, after the active count, render `<N> need you` when `holdCount(data.sessions) > 0`
  and nothing at all when it is zero.
- **The pill counts every surface, not just headless.** It mirrors the row hold tabs
  (`answer` / `plan?` / `reply?` / `allow?`) one for one, so a count labelled "need you"
  cannot omit a row that visibly says it needs you. The banner stays headless-only; the pill
  is the board's own summary. State that difference in one line in the docs, or the next
  reader will file it as a bug.
- No `title` attribute: it is dead on touch, and this board is read on a phone. The text
  says what it means.
- One new CSS rule below the theme-token block — amber ink on
  `color-mix(in srgb, var(--amber) 13%, transparent)`, the same recipe `.ag-pill.running`
  uses for green. **Tokens only**: a literal colour or shadow anywhere below that block
  breaks the light theme.

### 6. Docs

- `docs/subsystems/push-notify.md` — its "Why this exists, and why it replaced the browser
  alerts" section currently ends with the layer deleted outright. Add a subsection for what
  came back: the headless scope, why the duplication argument does not apply to a session
  with no CLI in front of it, the three events (and why `permission` is not one), that the
  banner's only styling is an icon, and the blind spots below.
- `docs/subsystems/settings.md` — the new group and the new per-device key.
- Leave every `docs-sync:` stamp alone; `/docs-sync` re-baselines them. `test/docs-links.test.ts`
  gates links and anchors, so keep any new link real.

### Blind spots — write these down, do not fix them here

1. **The poll's window.** Only the top `maxSessions` sessions by recency are in the payload
   at all (default 5). A sixth parked session announces nothing.
2. **Section-bound.** `SessionsView` owns the poll and unmounts on a section switch, so
   nothing fires while you sit on Management, Analytics, Usage or Settings. Chosen over
   lifting the poll to `AppShell`, which would poll every 3s on every section and turn a
   contained feature into a shell-wide change.
3. **Hidden tabs are throttled.** A background tab's timers can stretch to ~1/minute, so a
   banner can be up to a minute late.
4. **iOS gets nothing**, on purpose. ntfy is that platform's channel.

## Test cases

New `test/web-notify.test.ts`, registered in `test/run-all.ts` (an `import { run as
runWebNotify }` line plus a `failed += runWebNotify();` line), following the
`test/panel-collapse.test.ts` shape. Plus three additions to `test/client-settings.test.ts`.

`holds.ts`:

1. **Precedence, all four flags on** → `'question'`. With `remoteQuestion` false →
   `'plan'`. With both false → `'reply'`. With only `permissionWait` → `'permission'`. With
   none → `null`.
2. **`holdCount`** over a list of five (two with `remoteQuestion`, one with `permissionWait`,
   two clean) → `3`.

`webNotify.ts`:

3. `notifyKind` on `surface: 'local'` with `remoteQuestion: true` → `null`.
4. `notifyKind` on `surface: 'dashboard'` with only `permissionWait: true` → `null`.
5. `notifyKind` on `surface: 'dashboard'` with `remoteReply: true` → `'reply'`.
6. `diffNeeds` with an **empty** `prev` and one waiting dashboard session → one target
   (the diff stays pure; skipping the first snapshot is the caller's job).
7. `prev` already `'question'` for that id and the session still `'question'` → empty.
8. `prev` `'question'`, now `'reply'` → one target with `kind: 'reply'` (a different hold on
   the same session is still news).
9. Id absent from `prev` (it was working) and now `'question'` → one target.
10. `label` prefers `sessionName`; falls back to `project` when `sessionName` is null.
11. `notifyBody` for all three kinds, asserted against the three literal strings in §2, so a
    drift away from `server/lib/notify.ts`'s phrasing fails a test instead of going unnoticed.
12. `dedupe` drops a repeat inside the TTL; the same key passes once `now` has advanced past
    `ttlMs`; and the stale key is gone from the ledger afterwards — assert `seen.size`, not
    just the return value.
13. `dedupe` keeps two distinct sessions from one batch and drops an in-batch duplicate.
14. `notifyKey` differs for the same id under two kinds.

`client-settings.test.ts`:

15. `DEFAULT_SETTINGS.notifyBrowser === false`.
16. `clampSettings({ notifyBrowser: 'true' }).notifyBrowser === false` — a hand-edited
    string is not a boolean.
17. `clampSettings({ notifyBrowser: true, theme: 'chartreuse' }).notifyBrowser === true` —
    one bad sibling cannot discard it.

**Mutation check before claiming any of this green** (a guard test that stays green with the
guard deleted proves nothing): delete the `surface === 'dashboard'` gate in `notifyKind` and
confirm case 3 fails; restore it. Delete the `'permission'` → `null` mapping and confirm case
4 fails; restore it. Report both results.

Browser:

18. `In the browser (playwright MCP tools):` open `http://localhost:5174`, go to Settings,
    confirm a row named `Notify this browser` is present and reads Off; click On and confirm
    it reads On; reload and confirm it still reads On (localStorage); click `Test` and confirm
    the printed line is non-empty and names a real state — in a fresh Chromium the permission
    is `default`, so it must read the "permission never granted" string, **not** "notification
    sent".
19. `In the browser (playwright MCP tools):` on `http://localhost:5174` with the Sessions
    section open, evaluate `fetch('/api/sessions?limit=5&lookback=24&active=5')` in the page
    and count the returned sessions where any of `remoteQuestion`, `remotePlan`,
    `remoteReply`, `permissionWait` is true; confirm the header shows exactly `<that count>
    need you` when the count is above zero, and shows no such pill when it is zero.

## Done when

- `pnpm typecheck` is clean and `pnpm test` prints `ALL PASS`, with the new case count quoted
  from the output — never claimed without it.
- Cases 18 and 19 have been run and their observed result written down.
- Both mutation checks in §Test cases reported, pass or fail.
- `chatTab`'s labels, tones and tooltips are unchanged after the `holdKind` extraction —
  verified by reading the diff, and said so explicitly.
- The Settings group is absent where `window.Notification` does not exist. If no iOS device
  was in the loop, say it is **unverified** rather than implying otherwise.
- `push-notify.md` and `settings.md` updated, including the four blind spots and the one line
  on why the pill counts every surface while the banner does not. `docs-sync` stamps untouched.
