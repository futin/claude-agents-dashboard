---
id: task-14
title: Back gesture closes the chat drawer on a phone
created: 2026-09-02
from: idea-16
updated: 2026-09-03T20:39:37Z
started: 2026-09-03T20:25:39Z
execute-elapsed: 838
---

## Goal

Give the chat drawer a second way out that works on a phone: the Android back
button and Safari's back swipe close the drawer instead of leaving the page.

Today the drawer has exactly two exits and both are desktop-only by accident —
`.chat-back`'s `onClick` (no scrim to tap at `<=700px`, where `.chat{width:100%}`,
`styles.css:652`) and the `Escape` keydown handler (`ChatDrawer.tsx:113-119`, no
Escape key on a phone). That leaves the ✕ button in `.chat-head` as a phone's
*only* exit. bug-10 was exactly that button going off-screen, and its fix
(`overflow-x:clip` on `.main`) stops the viewport widening rather than adding an
exit — so any future layout slip in `.chat-head` re-traps the user in a modal
they can only reload out of.

Done right this is also the mechanism a phone user already expects: on Android,
back dismissing the topmost sheet *is* the convention, and back leaving the app
while a modal is open is the behaviour that reads as broken.

## Decisions taken while grooming

idea-16 left two open questions. Both are answered here; overrule either by
saying so before this runs.

**1. Does back-closes-the-drawer surprise someone who expects back to leave the
page?** No — but only if the synthetic entry is cleaned up when the drawer closes
by any *other* means. If the user taps ✕ and the pushed entry is left on the
stack, the next back press pops an entry nobody is watching: the page does not
change and nothing visibly happens. *That* is the surprising outcome, not
back-closes-the-drawer. So the design below pairs every push with a `back()` on
programmatic close, and the test cases assert both halves.

**2. Should swipe-down-to-close come with it?** No. It is a second mechanism for
the same job and it is the fragile one: a downward drag inside `.chat-body`
(the scrolling element) has to be disambiguated from a scroll, which is
ambiguous exactly at `scrollTop === 0` where the gesture would start. The back
gesture is a platform affordance for ~40 lines and no gesture arbitration.
Deliberately YAGNI'd; capture it as its own idea if a phone user still feels
trapped after this lands.

**Scope is `ChatDrawer` only.** `SpawnPanel` is the app's other component with an
`onClose`, but it renders as an inline `.qpanel` above the session list, not a
fixed overlay, so it cannot trap anyone and it must not push a history entry.
Nothing else in the client touches the History API except
`deepLinkSession()`'s one `replaceState` (`lib/deepLink.ts:41`).

## Plan

Four files: one new pure module, one new hook, a two-line change to
`ChatDrawer`, and a new test module (plus its registration).

### 1. `client/src/lib/backClose.ts` — new, pure over an injected host

The whole mechanism lives here, driven through an injected host interface so it
is testable under `node:assert` with no DOM. Export:

- `interface BackCloseHost` — the seam. Members: `pushState(state, title)`,
  `back()`, `addEventListener(type: 'popstate', fn: () => void)`,
  `removeEventListener(type: 'popstate', fn: () => void)`,
  `defer(fn: () => void): number` (schedule as a *macrotask* and return a
  handle), `cancel(handle: number)`.
- `function armBackClose(host: BackCloseHost, onClose: () => void): () => void`
  — arms one history entry, returns its teardown.
- `function browserHost(): BackCloseHost` — the one impure function in the file:
  `window.history.pushState` / `window.history.back` / `window.addEventListener`
  / `window.removeEventListener` / `setTimeout` / `clearTimeout`. Not unit
  tested; the browser check below is what exercises it.

`armBackClose` behaviour, in order:

1. **Defer, don't push.** Schedule a callback through `host.defer` that (a)
   pushes one entry and (b) *then* registers the popstate listener. Nothing is
   pushed and no listener exists synchronously.

   This deferral is load-bearing, not a stylistic choice — see
   *Why the push is deferred* below. Do not "simplify" it to a synchronous push.
2. **Push state, not URL.** `pushState({ chatDrawer: true }, '')` with **no url
   argument**, so the entry carries the current URL unchanged. A visible URL
   change would collide with `deepLinkSession()`'s `?session=` strip and would
   make the drawer look bookmarkable, which `docs/subsystems/view-persistence.md`
   says it deliberately is not.
3. **A throwing `pushState` leaves the arm inert.** Safari throttles `pushState`
   (~100 calls / 30s) and `file://` can reject it. Catch it, skip the listener
   registration, and record that no entry exists — the drawer then behaves exactly
   as it does today. Critically, teardown must **not** call `back()` in this
   state: that would navigate the user off the dashboard, which is worse than the
   trap this task removes. Same fail-open posture as `deepLinkSession`'s catch.
4. **The popstate listener** calls `onClose()` **once**, removes itself, and
   records the entry as consumed. Our entry is the newest at push time (a push
   clears the forward stack), so the first popstate after arming can only mean
   our entry was popped.
5. **Teardown** — three states, and it is idempotent in all three:
   - deferred callback has not run → `host.cancel(handle)`. Nothing pushed, no
     `back()`.
   - popstate already fired → nothing. The entry is already gone and the
     listener already removed; a `back()` here would navigate the page.
   - entry live → `host.removeEventListener` **first**, then `host.back()`. The
     order is the re-entrancy guard: `back()` fires a popstate that would
     otherwise re-enter `onClose()`.

### 2. `client/src/hooks/useBackClose.ts` — new

`function useBackClose(onClose: () => void): void`.

Holds the latest `onClose` in a ref updated on every render, and runs
`armBackClose(browserHost(), …)` from a `useEffect` with **empty deps**, calling
through the ref.

Empty deps are mandatory. `SessionsView` passes
`onClose={() => setChatId(null)}` (`SessionsView.tsx:101`) — a fresh function
identity every render. A `[onClose]` dep list would re-arm on every render, i.e.
a push/`back()` storm at the 3s poll rate, and would trip Safari's `pushState`
throttle within a minute. The existing Escape effect uses `[onClose]` and gets
away with it because re-registering a listener is free; pushing a history entry
is not.

### 3. `client/src/components/ChatDrawer.tsx` — one import, one call

Call `useBackClose(onClose)` next to the existing Escape effect (~line 113), with
a short comment saying why it is there: same intent as Escape, for the input a
phone actually has. **Leave the Escape effect alone** — folding both into one
hook mixes two concerns and widens the diff for no gain.

### 4. Docs

- `docs/subsystems/chat.md` — the drawer's home doc. Add a short paragraph
  covering the drawer's three exits (✕, scrim on desktop, back on a phone) and
  the push/`back()` pairing that keeps a dead back press from existing. Add
  `client/src/lib/backClose.ts` and `client/src/hooks/useBackClose.ts` to its
  `docs-sync:` `sources:` list. **Do not hand-edit the `verified:` sha** — leave
  it; the next `/docs-sync` re-baselines it.
- `docs/overview.md` — the `hooks/` line in §Map (line ~178) names the client
  hooks; add `useBackClose` to it.
- `docs/subsystems/view-persistence.md` says "The one URL param in the app is the
  opposite of persistence". Still true — this task pushes an entry with **no URL
  change** — so that doc needs no edit. Confirm it reads correctly after the
  change rather than editing it reflexively.

### Why the push is deferred (do not remove this)

`history.back()` is **asynchronous**: it queues a traversal and its popstate
fires in a later task. A synchronous push therefore races any teardown whose
`back()` is still in flight, and there are two ways to reach that state:

- **`StrictMode` is enabled** (`client/src/main.tsx:15`). In dev React
  double-invokes effects: arm → teardown → arm. With a synchronous push that is
  push(B), `back()` queued, push(C) — and the queued `back()` then pops C, so the
  drawer slams shut the instant it opens. A dev-only failure that looks exactly
  like a real bug.
- **A keyed remount.** `<ChatDrawer key={chatSession.id}>`
  (`SessionsView.tsx:99`) remounts on a `chatId` change: cleanup then effect, same
  race, in production. Not reachable through today's UI (the scrim covers the
  rows, and the Toolbar's "+ New" is behind it), but it is one prop away.

Deferring both the push *and* the listener registration to a macrotask closes
both: a teardown that lands before the deferred callback cancels it outright
(nothing pushed, no `back()`), and a stale queued popstate finds no listener
installed. A macrotask specifically — `queueMicrotask` flushes before the pending
popstate task and would not fix either case.

### Known and accepted

Reloading the page while the drawer is open leaves the synthetic entry on the
stack with no drawer behind it (`chatId` is not persisted, by design). The next
back press then traverses to the previous entry, which reloads the dashboard.
Two same-URL entries and a reload is a strictly better outcome than the trap, and
detecting it would mean persisting drawer state — which
`docs/subsystems/view-persistence.md` rules out on purpose.

## Test cases

`test/back-close.test.ts` — new module, registered in `test/run-all.ts` (an
`import { run as runBackClose }` line plus a `failed += runBackClose();` line,
matching how `runDeepLink` is wired). Follow the shape of
`test/deep-link.test.ts`: `node:assert`, a local `test()` helper, `run()`
returning the failure count.

Every case drives a fake `BackCloseHost` that records an **ordered call log**
(so relative order is assertable, not just counts) and lets the test run or
cancel the deferred callback and fire popstate by hand. All eleven are pure — no
DOM, no jsdom, no new dependency.

1. **arms nothing synchronously** — immediately after `armBackClose`, before the
   deferred callback runs: `pushState` call count `0`, registered listener count
   `0`, `back` count `0`.
2. **the deferred callback pushes exactly one entry and registers exactly one
   listener** — after running it: `pushState` count `1`, listener count `1`. The
   pushed state's `chatDrawer` is `true` and the recorded url argument is
   `undefined` (the URL must not change).
3. **push comes before listener registration** — in the ordered log, the
   `pushState` entry precedes the `addEventListener` entry.
4. **teardown before the callback runs cancels it** — arm, tear down, then run
   every scheduled callback: `cancel` was called with the handle `defer`
   returned, `pushState` count `0`, `back` count `0`, listener count `0`.
5. **StrictMode double-invoke arms once** — arm, tear down, arm, then run every
   scheduled callback: `pushState` count `1`, live listener count `1`, `back`
   count `0`, `onClose` count `0`.
6. **a back press closes the drawer** — run the callback, fire popstate:
   `onClose` count `1`, listener count `0` (it removed itself).
7. **two back presses close it once** — fire popstate twice: `onClose` count
   `1`.
8. **programmatic close consumes the entry** — run the callback, then tear down:
   `back` count `1`, listener count `0`.
9. **programmatic close cannot re-enter `onClose`** — the re-entrancy guard, and
   the case that must fail if the guard is removed. After case 8's teardown, fire
   popstate: `onClose` count `0`. Separately assert from the ordered log that
   `removeEventListener` precedes `back`. Mutation check before calling this
   done: swap the two calls in the implementation and confirm this case goes red
   — if it stays green it is proving nothing (a listener still registered when
   `back()` fires is exactly the double-close bug).
10. **back-then-unmount does not navigate** — run the callback, fire popstate,
    then tear down: `back` count `0`. The complement of case 8, and the one that
    catches a teardown that calls `back()` unconditionally.
11. **teardown is idempotent** — after a landed push, call teardown twice:
    `back` count `1`, no throw.
12. **a throwing `pushState` leaves the arm inert** — a host whose `pushState`
    throws: run the callback, then tear down. `back` count `0`, listener count
    `0`, `onClose` count `0`, no exception escapes `armBackClose`. This is the
    case where a stray `back()` would eject the user from the dashboard.

Browser checks — both run against a phone-sized viewport, since the trap is
phone-only:

13. **In the browser (playwright MCP tools):** start the app
    (`pnpm dev`, http://localhost:5174). `browser_resize` to `390x844`,
    `browser_navigate` to the app, click the first session row's `chat` control to
    open the drawer, and confirm from `browser_snapshot` that the dialog labelled
    "Session chat history" is present. Then `browser_navigate_back`. The next
    snapshot must **not** contain that dialog, and must still show the dashboard's
    session list — not a blank page, not the browser's start page. (If no session
    row is available, spawn one from the Toolbar's "+ New" first, or point the
    scan at a fixture; a drawer is required for this check to mean anything.)
14. **In the browser (playwright MCP tools):** same viewport and page — the
    dead-back-press complement. Read `history.length` with `browser_evaluate`
    before opening the drawer, open it, close it with the ✕ button in the drawer
    header, then read `history.length` again. The two readings must be **equal**:
    an entry left behind is a back press that does nothing. Then
    `browser_navigate_back` once and confirm the snapshot is no longer the
    dashboard — proving back went back to the page the user came from rather than
    being swallowed.

## Done when

- `client/src/lib/backClose.ts`, `client/src/hooks/useBackClose.ts` and
  `test/back-close.test.ts` exist; `ChatDrawer.tsx` calls `useBackClose(onClose)`
  and its Escape effect is unchanged.
- `test/run-all.ts` registers the new module and `pnpm test` prints `ALL PASS`
  with a case count 12 higher than the pre-change total.
- Case 9's mutation check was actually run: with `removeEventListener` and
  `back()` swapped, case 9 fails; with the swap reverted, `pnpm test` is green
  again.
- `pnpm typecheck` is clean.
- `pnpm build` succeeds — `ChatDrawer` is a lazy chunk, so a broken import there
  fails at build time, not at test time.
- Browser checks 13 and 14 both pass, at `390x844`.
- `docs/subsystems/chat.md` documents the three exits and lists both new files in
  its `sources:`; `docs/overview.md` §Map names `useBackClose`. Neither
  `verified:` sha was hand-edited.
- The write-up states what was **not** verified: nobody has pressed a real
  Android back button or performed Safari's back swipe on a real phone. Playwright's
  `navigate_back` drives the same History API, but the gesture layer is untested
  — say so rather than claiming the phone case is proven.

## Outcome

**2026-09-03 — done as planned.** `client/src/lib/backClose.ts` (pure, host-injected),
`client/src/hooks/useBackClose.ts` (empty deps, latest-callback ref) and
`test/back-close.test.ts` (12 cases, registered in `test/run-all.ts`) are new;
`ChatDrawer.tsx` gained one import and one `useBackClose(onClose)` call beside the
untouched Escape effect. Docs: `docs/subsystems/chat.md` documents the three exits and
lists both new files in its `sources:`; `docs/overview.md` §Map names `useBackClose`.
Neither `verified:` sha was hand-edited. `docs/subsystems/view-persistence.md` was re-read
and still reads correctly — the pushed entry changes no URL, and the drawer stays in the
"not persisted" list — so it was left alone as the plan directed.

The deferral proved itself in the browser rather than only in unit tests: dev runs under
`StrictMode`, and `history.length` went 2 → 3 on open (one entry, not two), so the
arm→teardown→arm double-invoke did not double-push or self-close.

### Unit tests — `pnpm test`

```
=== backClose.ts ===

  ✓ arms nothing synchronously
  ✓ the deferred callback pushes one entry and registers one listener
  ✓ push comes before listener registration
  ✓ teardown before the callback runs cancels it
  ✓ a StrictMode double-invoke arms exactly once
  ✓ a back press closes the drawer
  ✓ two back presses close it once
  ✓ a programmatic close consumes the entry
  ✓ a programmatic close cannot re-enter onClose
  ✓ back-then-unmount does not navigate
  ✓ teardown is idempotent
  ✓ a throwing pushState leaves the arm inert

  12 passed, 0 failed
```

Suite tail: `ALL PASS`.

**Case count, +12 exactly.** Summing every module's per-module count: this branch 761.
The same sum over `git show HEAD:test/run-all.ts` (run as a temp `test/_baseline-run-all.ts`,
then deleted) is 749, also `ALL PASS`. 761 − 749 = 12.

### Case 9's mutation check — actually run

With `host.back()` and `host.removeEventListener(...)` swapped in the teardown:

```
  ✗ a programmatic close cannot re-enter onClose
failures: 1
```

Reverted; `pnpm test` prints `ALL PASS` again. Worth recording *which* assertion caught it:
the ordered-log assertion (`removeEventListener` before `back`). The `onClose` count stayed
0 under the swap because the fake host's `back()` only logs — a real browser's `back()`
fires the popstate that the still-registered listener would answer. The order assertion is
therefore the whole guard for this case; do not delete it as redundant.

### typecheck / build

```
> tsc --noEmit
exit=0
```
```
dist/assets/index-4mFQav1a.js  389.13 kB │ gzip: 111.41 kB
✓ built in 1.23s
```

### Browser checks, viewport 390×844 (playwright MCP, worktree dev on 4273/5273)

**Check 13 — back closes the drawer.** Opened the first row's `chat` control; the snapshot
carried `dialog "Session chat history"`, and `history.length` 2 → 3 with
`history.state === {"chatDrawer":true}` and `location.href` unchanged at
`http://localhost:5273/`. After `browser_navigate_back`: 0 hits for
`Session chat history`, 5 hits for `Open chat history` — the dashboard's session list is
still there, not a blank page.

**Check 14 — no dead back press.** `history.length` was 3 before opening, 3 after opening
(the push truncated the forward entry), and **3 after closing with ✕** — equal, with
`history.state === null` and `.chat` gone from the DOM, so the entry was spent rather than
left behind. A further `browser_navigate_back` landed on `about:blank`, i.e. back went to
where the user came from instead of being swallowed.

Note on that equality: because a forward entry existed, `history.length` reads 3 at all
three points. `history.state` returning to `null` is the load-bearing evidence that the
synthetic entry was consumed — the length reading alone would not have distinguished it.

### Not verified — needs a human

- **No real phone was involved.** Nobody pressed an Android hardware/gesture back button
  and nobody performed Safari's back-swipe. Playwright's `navigate_back` drives the same
  History API the gesture ends up in, so the state machine is proven; the **gesture layer
  above it is untested** — iOS's interactive back-swipe in particular can begin and be
  cancelled, and that path has not been exercised here.
- `browserHost()` itself has no unit test by design; only the two browser checks above
  exercised it, in Chromium via Playwright. No WebKit or Firefox run.
- Safari's `pushState` throttle was not induced — case 12 proves the *handling* against a
  fake that throws, not that Safari throws where we expect.
- The accepted case in the plan (reload with the drawer open leaves a stale entry) was not
  exercised; it is documented as accepted, not fixed.
