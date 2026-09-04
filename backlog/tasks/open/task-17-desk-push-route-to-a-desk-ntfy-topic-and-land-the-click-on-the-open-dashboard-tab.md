---
id: task-17
title: Desk push: route to a desk ntfy topic and land the click on the open dashboard tab
created: 2026-09-04
from: idea-20
---

## Goal

When you are at the desk, a session that needs you rings **this Mac** instead of the
phone, and clicking that banner opens the session's drawer **in the dashboard tab that is
already open** — no second dashboard tab, no round trip over the tailnet.

Unset `NTFY_TOPIC_DESK` must preserve today's behaviour byte-for-byte, including the
number of `ioreg` spawns per push.

## Plan

> **Who decided this.** The design choice below and every row of the decision table were
> settled by the grooming session on 2026-09-04, **not by the user** — that session had no
> `AskUserQuestion` tool (absent from the tool list and from `ToolSearch`), the user was
> away from the terminal, and the instruction was to deliver a finished plan. So these are
> reasoned calls made on their behalf, not choices they made. Every one is re-openable;
> each carries the reason that would reverse it. If you are executing this and a decision
> reads wrong, say so rather than transcribing it.
>
> *(User reviewed and endorsed the design choice on 2026-09-04. The decision table below
> has still not been individually confirmed.)*

### Which of idea-20's three designs this is, and why

Design 3 (**localhost focus endpoint**), built on design 1's topic split, with design 3's
optional `osascript` step 4 dropped.

- **Design 1 alone** (desk topic + localhost `Click:`) fails the requirement the idea
  itself calls a dealbreaker: ntfy's service worker hardcodes `clients.openWindow` for a
  `Click:` URL, so every click is a new tab, and `clients.matchAll()` being same-origin by
  spec means no upstream ntfy fix could ever reach a tab on the dashboard's origin. Both
  facts are already verified in the idea against `https://ntfy.sh/sw.js`.
- **Design 2** (dashboard-owned VAPID web push) is the correct end state and is the only
  one that focuses the existing tab natively — but it is VAPID + RFC 8291 payload
  encryption + a subscription store + a service worker + a Settings surface, ~200–300 lines
  by the idea's own estimate, and it *still* only delivers while Chrome is running. It buys
  "focus the existing tab" at roughly 4× the cost of design 3 and is too big for one task.
  Not rejected on merit — deferred. If design 3's browser gate below fails, design 2 is the
  fallback, and it should be re-filed as its own idea rather than bolted onto this task.
- **Design 3** is design 1 plus one small endpoint and one optional field on a payload the
  client already polls. Every piece is an idiom this repo already has.

`osascript` step 4 (bring Chrome's window forward) is **YAGNI'd**: it is macOS-only, it
needs the Automation TCC grant that already blocked the iTerm2 attempt on 2026-09-04, and
its benefit over what `openWindow` already does — Chrome comes forward to show the
throwaway tab — is marginal. If focus placement turns out to annoy in daily use, file a
follow-up idea.

### Decisions on idea-20's open questions

| Question | Decision | Reason |
|---|---|---|
| Exclusive routing, or both topics? | **Exclusive** | `settings.idleSecs` is already tuned for the remote-answer hooks; a double-buzz on every alert is a worse default than a rare missed one. |
| Desk topic's own `NotifyPolicy` events? | **No — mirrors the phone** | Routing, not a second policy. `NotifyPolicy`, `DEFAULT_NOTIFY`, `mergeNotify` and the settings file format are all untouched, so there is no migration. |
| Idle unreadable (`null`, i.e. Docker / non-macOS)? | **Phone topic** | `null` means "cannot tell", and the phone is the channel that works without a browser running. Matches the idea's own guess and the direction `shouldNotify` already fails. |
| `idleSecs === 0`? | **Phone topic** | Zero disables the idle gate everywhere else in the app (`backAtDesk`, the hooks); it disables desk routing too. Free — `atDesk` below inherits it. |
| Port ambiguity in dev | **`DASHBOARD_LOCAL_URL`, defaulting to `http://localhost:${config.port}`** | See Task 6. The handoff is server-side, so the dev 5174/4173 origin split does not break it; only the no-dashboard-open redirect branch needs the override. |
| Does the click land on the drawer? | **Becomes an executable Playwright test case** — see `## Test cases`. |

### Overrides in force for this plan

Two, both deliberate, both from `.claude/CLAUDE.md` and the user's global rules:

1. **No literal code blocks.** `superpowers:writing-plans` requires them; this repo does
   not, because handed code gets transcribed verbatim and a bug in the plan then becomes a
   bug in the branch with nobody positioned to catch it. Behaviour, signatures, exact
   expected values and edge cases are specified below. **Disagree with anything here that
   is wrong** — that is the point of writing it this way.
2. **No separate plan document under `docs/`.** This `## Plan` section is the artifact
   (`.claude/CLAUDE.md` § Where things go).

Task sizes below are soft targets, not budgets.

### Global constraints

- **Zero new runtime deps in `server/`.** Node built-ins only. Nothing here needs more.
- **ESM, `.js` suffixes on server imports, `import type` across the FE/BE boundary.**
- **`NTFY_TOPIC_DESK` is a credential, exactly like `NTFY_TOPIC`** — ntfy topics are
  unauthenticated, so the string is both the address and the credential. **No endpoint may
  ever return it**, including `/api/settings` (which returns only the derived
  `notifyAvailable` boolean today — keep that shape).
- **Adding an API field goes `shared/types.ts` → server producer → client consumer**, in
  that order.
- **A notification must never delay or fail the request that triggered it.** Everything
  added to `maybeSend` stays inside its existing try/catch and stays fire-and-forget.
- Run `pnpm typecheck` and `pnpm test` before each commit. Register every new test file in
  `test/run-all.ts` (it is an explicit import list, not a glob).

### File map

| File | Change | Responsibility |
|---|---|---|
| `server/lib/notify.ts` | modify | new `atDesk` predicate; desk routing in `maybeSend`; `deskClickUrl`; `sendTest` reports the routed topic |
| `server/lib/idle.ts` | modify | `backAtDesk()` becomes a thin wrapper over `atDesk` |
| `server/lib/config.ts` | modify | `ntfyTopicDesk`, `localUrl` |
| `server/lib/focus.ts` | **create** | the pending-focus RAM store + the throwaway page's HTML |
| `server/api.ts` | modify | `serveFocus` handler; `notePoll()` inside `serveSessions`; attach `focusSession` to the payload |
| `server/index.ts` | modify | route `GET /api/focus` |
| `shared/types.ts` | modify | `SessionsResponse.focusSession?: string` |
| `client/src/components/SessionsView.tsx` | modify | consume `focusSession` → open the drawer |
| `test/notify.test.ts` | modify | routing + `atDesk` cases |
| `test/focus.test.ts` | **create** | store semantics |
| `test/api-focus.test.ts` | **create** | endpoint through the real route table |
| `.env.example`, `docs/subsystems/push-notify.md`, `docs/workflows/push-notify-setup.md`, `docs/overview.md` | modify | see Task 7 |

---

### Task 1 — Gate: can a `clients.openWindow()` tab close itself?

**This task is a spike. It keeps no code, and it decides whether Tasks 3–6 are built as
written.** Do it first; everything downstream assumes its answer.

The whole design rests on the throwaway tab disappearing. Chrome refuses `window.close()`
on tabs the user opened. Blink's actual rule (`LocalDOMWindow::close`) allows the close
when the page was opened by script **or** the browsing context's back/forward list has a
single entry — and a tab opened by `clients.openWindow` has exactly one history entry — so
the expected answer is **yes**. Expected is not verified.

- [ ] Publish one push by hand to a scratch ntfy topic with a `Click:` header pointing at
      any page that calls `window.close()` on load (a `data:` URL will not do — ntfy's SW
      needs an http(s) URL; serve one file from `python3 -m http.server` or point it at a
      throwaway endpoint you add and revert). Subscribe Chrome to that topic first.
- [ ] Click the banner. Record whether the tab closes, and whether the console shows
      `Scripts may close only the windows that were opened by them.`
- [ ] Write the answer into this task file under a `### Task 1 result` heading before
      starting Task 2.

**If it closes:** proceed as written.

**If it does not close:** do not switch designs mid-branch. Build Tasks 2–7 unchanged, and
have the page in Task 4 fall back to rendering `You can close this tab.` after a 500ms
self-close attempt. The primary win — the deep link landing in the *existing* tab — is
independent of the close. Note the failure in `## Outcome` and file design 2 as a new idea.

**Also worth recording while a banner is in front of you** (one line each, no extra work):
whether the macOS banner appears at all. Per
`~/.claude/.../memory/chrome-web-push-alerts-helper.md`, macOS System Settings →
Notifications lists **two identical "Google Chrome" rows**, and web push only displays if
`com.google.Chrome.framework.AlertNotificationService` — the alerts helper — is the one
enabled. If nothing shows, that is the cause, not the code.

---

### Task 2 — One "at the desk" predicate, one `ioreg` read per push

**Files:** modify `server/lib/notify.ts`, `server/lib/idle.ts`; modify `test/notify.test.ts`.

**Produces:** `atDesk(idleSecs: number | null, thresholdSecs: number): boolean`, exported
from `server/lib/notify.ts`.

Today "at the desk" is expressed twice: inline in `backAtDesk()` (`server/lib/idle.ts`) and
inverted inside `shouldNotify`'s `requireAfk` clause (`server/lib/notify.ts:71-78`). Task 6
needs it a third time. Extract it once.

- [ ] Add `atDesk(idleSecs, thresholdSecs)` to `server/lib/notify.ts`, next to
      `readIdleSecs`. It returns `true` only when `thresholdSecs !== 0 && idleSecs !== null
      && idleSecs < thresholdSecs`. Pure — no `getSettings()`, no `ioreg`, no I/O.

      **It goes in `notify.ts`, not `idle.ts`, purely to avoid a cycle:** `idle.ts` already
      imports `readIdleSecs` from `notify.ts`, so the reverse edge would make the two files
      mutually importing. Leave a one-line comment saying so, or the next reader will move
      it to the file where it reads like it belongs.

- [ ] Rewrite `backAtDesk()` in `server/lib/idle.ts` to be
      `atDesk((idleReader ?? readIdleSecs)(), getSettings().idleSecs)`. Behaviour must not
      change: the existing sweep tests in `test/pending.test.ts`, `test/plans.test.ts` and
      `test/messages.test.ts` drive it through `setIdleReader` and must stay green
      untouched. Keep its doc comment — the two fail directions and the `ioreg` cost warning
      are still true and are cited from three other files.

- [ ] In `maybeSend` (`server/lib/notify.ts:263`), read the idle value **at most once per
      push and only when a desk topic is configured**. Build a memoizing thunk over
      `readIdleSecs` — first call reads, later calls return the cached value — and pass it
      as `readIdle` to `shouldNotify`. Task 6 reads the same thunk for routing.

      The ordering property that must survive: with `NTFY_TOPIC_DESK` unset **and**
      `requireAfk` false, `readIdleSecs` is still called **zero** times. That is the whole
      reason `shouldNotify` takes a thunk rather than a value, and it is the one regression
      a reviewer should look for here.

- [ ] Tests in `test/notify.test.ts`, using the existing `test`/`policy`/`ctx` helpers:
      - `atDesk(10, 60)` → `true`
      - `atDesk(60, 60)` → `false` (boundary is exclusive, matching `backAtDesk` today)
      - `atDesk(61, 60)` → `false`
      - `atDesk(null, 60)` → `false`
      - `atDesk(0, 0)` → `false` (zero disables the gate)
      - `atDesk(-1, 60)` → `true` (a nonsense reading is not this function's problem; assert
        it rather than guard it, so a future guard has to change a test on purpose)
      - **Spawn-count case, and it must be mutation-proof:** with `NTFY_TOPIC_DESK` unset
        and `requireAfk` false, a counting `readIdle` records **0** calls. With `requireAfk`
        true it records exactly **1**. Then, with a desk topic set and `requireAfk` true,
        still exactly **1** — proving the memoization, not just its existence. Delete the
        memoization and this third case must go to 2, or it proves nothing.

- [ ] `pnpm typecheck && pnpm test`, then commit.

---

### Task 3 — The pending-focus store

**Files:** create `server/lib/focus.ts`; create `test/focus.test.ts`; register it in
`test/run-all.ts`.

**Produces:** `requestFocus(sessionId: string, nowMs?: number): void`,
`takeFocus(nowMs?: number): string | null`, `notePoll(nowMs?: number): void`,
`dashboardOpen(nowMs?: number): boolean`, `resetFocus(): void`, `focusPageHtml(): string`,
and the exported constants `FOCUS_TTL_MS`, `POLL_FRESH_MS`.

Every `nowMs` defaults to `Date.now()` and exists only so the expiry cases below can be
tested without sleeping. Production callers pass nothing.

RAM only, no persistence — a restart dropping a two-minute-old click is correct, and it is
the same posture `permissions.ts` and `spawn.ts` already take.

- [ ] `requestFocus(id)` stores `{ id, atMs: Date.now() }` in a **single slot**. A second
      call replaces the first: two clicks in a row mean you want the second session, and a
      queue would open a drawer you have already moved past.
- [ ] `takeFocus()` is **consume-once**. It returns the id and clears the slot; if the entry
      is older than `FOCUS_TTL_MS` it clears and returns `null`. Never returns the same id
      twice.
- [ ] `FOCUS_TTL_MS = 120_000`. Reasoning to put in the comment: the consumer is the
      `/api/sessions` poll, whose interval is user-set and clamped to a **60s maximum**
      (`client/src/lib/settings.ts:100`), so anything at or under 60s would silently drop a
      click for a user on the slowest setting. 120s covers that with slack and is still
      short enough that a click you abandoned cannot ambush you later.
- [ ] `notePoll()` records the last `/api/sessions` poll time. `dashboardOpen()` is
      `Date.now() - lastPollMs < POLL_FRESH_MS`, with `POLL_FRESH_MS = 90_000` — the same
      60s clamp plus 30s for one dropped tick.
- [ ] Both timestamps live in module-level `let`s. `resetFocus()` clears both; every test
      calls it first. **No `setTimeout` reaper** — both reads are already time-checked, so a
      timer would only add a handle to leak.
- [ ] Ship the throwaway page's HTML from this module too, as an exported function
      `focusPageHtml(): string` — it is this subsystem's own artifact, and keeping it here
      leaves `api.ts` a route table plus handlers. Task 4 specifies what it must do.
- [ ] Tests in `test/focus.test.ts`:
      - `takeFocus()` on a fresh store → `null`
      - `requestFocus('abc')` then `takeFocus()` → `'abc'`; a second `takeFocus()` → `null`
      - `requestFocus('a')`, `requestFocus('b')`, `takeFocus()` → `'b'` (latest wins)
      - expiry: to test it without sleeping, have `requestFocus` and `takeFocus` accept an
        optional `nowMs` parameter defaulting to `Date.now()`. `requestFocus('a', 0)` then
        `takeFocus(FOCUS_TTL_MS + 1)` → `null`; `takeFocus(FOCUS_TTL_MS - 1)` → `'a'`.
        Same shape for `notePoll`/`dashboardOpen` around `POLL_FRESH_MS`.
      - `dashboardOpen()` on a fresh store → `false` (nothing has polled yet)
- [ ] `pnpm typecheck && pnpm test`, then commit.

---

### Task 4 — `GET /api/focus` and the throwaway page

**Files:** modify `server/api.ts`, `server/index.ts`; create `test/api-focus.test.ts`;
register it in `test/run-all.ts`.

**Consumes:** Task 3's `requestFocus`, `dashboardOpen`, `focusPageHtml`.

**Produces:** `serveFocus(req: IncomingMessage, res: ServerResponse, params: URLSearchParams)`,
exported from `server/api.ts`. No `Config` argument — unlike its neighbours this handler
reads nothing from config; do not add one for symmetry.

Behaviour, in order:

- [ ] **Loopback guard, on the socket only.** Reject unless
      `classifyAddress(req.socket?.remoteAddress) === 'local'` — respond `403` with
      `{ error: 'local only' }`.

      **Use `classifyAddress`, never `classifyOrigin`.** `classifyOrigin` trusts the
      left-most `X-Forwarded-For` entry when the socket is loopback
      (`server/lib/origin.ts:141`), and that entry is attacker-supplied: a remote peer
      reaching the dashboard through `tailscale serve` can send
      `X-Forwarded-For: 127.0.0.1` and the proxy appends rather than replaces, so the
      left-most value is theirs. `classifyAddress` reads the socket and nothing else.
      Add a comment saying exactly this, and update `origin.ts`'s module header — its
      "nothing in the app makes an access decision from it" line stops being true the
      moment this lands, and that sentence is what today justifies the XFF branch.

      **Known residual, document it and accept it:** a remote user coming through a
      loopback-terminating proxy (`pnpm tunnel`) still passes. The capability granted is
      "make an open dashboard tab select session X" — no data returned, no persisted state.
      Anyone through that proxy already has the spawn and answer endpoints, which are
      orders of magnitude more powerful.

- [ ] **Shape-validate the id, do not existence-check it.** Accept only
      `/^[0-9a-fA-F-]{8,64}$/` — the same rule `readSessionParam` applies client-side
      (`client/src/lib/deepLink.ts:19`). On a bad shape respond `400`.

      Deliberately **do not** call `sessionExists()`: a different response for a real id
      would turn this unauthenticated endpoint into an id oracle. A valid-shaped unknown id
      is recorded and simply never matches a row.

- [ ] **`dashboardOpen() === true`** → `requestFocus(id)`, then respond `200 text/html`
      with `focusPageHtml()`.
- [ ] **`dashboardOpen() === false`** → **do not** record; respond `302` to
      `/?session=<id>` (id re-encoded). Nothing is polling, so a recorded focus would just
      expire; redirecting makes the throwaway tab become the dashboard. This is also what
      happens when the user is on the Management/Usage/Settings section — `SessionsView`
      unmounts and its poll stops — so that case degrades to design 1's behaviour (a new
      tab, correctly deep-linked) rather than to nothing at all.
- [ ] `Cache-Control: no-store` on both responses.

The page from `focusPageHtml()`:

- [ ] Static — no session id interpolated into it, so there is no escaping question and one
      constant string serves every request.
- [ ] Calls `window.close()` immediately on load. After 500ms, if still alive, replaces the
      body with `You can close this tab.` (Task 1's fallback).
- [ ] Body text before the close fires: `Opening on the dashboard…`. No session id, no
      label — this page is reachable by anything that reached the endpoint.
- [ ] Inline `<script>`; the server sets no CSP today (verified — no
      `Content-Security-Policy` anywhere in `server/`).

Routing in `server/index.ts`:

- [ ] Add `if (u.pathname === '/api/focus')` alongside the other exact-path routes. It has
      no path parameters, so ordering against the `/api/sessions/:id/...` regexes does not
      matter — but put it near `/api/health` rather than after the regex block, so the
      exact-path group stays contiguous.

Tests in `test/api-focus.test.ts`, driven **through `createRequestListener` over a real
socket**, the way `test/api-read-endpoints.test.ts` already does — that is the only way the
route table itself is covered:

- [ ] valid id + `dashboardOpen()` true → `200`, `content-type` starts `text/html`, body
      contains `window.close`
- [ ] valid id + `dashboardOpen()` true → a following `takeFocus()` returns that id
- [ ] valid id + `dashboardOpen()` false → `302`, `location` is `/?session=<id>`, and
      `takeFocus()` returns `null` (nothing was recorded)
- [ ] `?session=` missing → `400`
- [ ] `?session=../../etc/passwd` → `400`
- [ ] a 65-character hex id → `400` (boundary: 64 passes, 65 does not)
- [ ] **mutation-proof the guard:** a request whose socket address is not loopback → `403`.
      Drive it by calling `serveFocus` directly with a stub `req` whose
      `socket.remoteAddress` is `'100.101.102.103'`, since a test client on the loopback
      interface cannot produce a non-loopback socket. Delete the guard and this case must
      fail.
- [ ] **the XFF case, and this is the one that matters:** loopback socket **plus**
      `X-Forwarded-For: 100.101.102.103` → still `200`/`302`, i.e. the header is ignored in
      both directions. Then loopback socket plus `X-Forwarded-For: 127.0.0.1` from what
      would be a remote peer → also handled by the socket alone. Swap `classifyAddress` for
      `classifyOrigin` and the first of these two must fail.
- [ ] `pnpm typecheck && pnpm test`, then commit.

---

### Task 5 — Carry the focus on the poll and open the drawer

**Files:** modify `shared/types.ts`, `server/api.ts`,
`client/src/components/SessionsView.tsx`.

`shared/types.ts` first, then the producer, then the consumer.

- [ ] Add `focusSession?: string` to `SessionsResponse` (`shared/types.ts:1161`), documented
      in the same register as the `launching` field above it: consume-once, set only on the
      single poll that follows a `/api/focus` hit, optional so an older client ignores it.
- [ ] In `serveSessions` (`server/api.ts:118`): call `notePoll()` **first**, before the
      scan — the poll happened whether or not the scan throws.
- [ ] Attach `data.focusSession = takeFocus() ?? undefined` next to `data.launching`,
      **on the error snapshot too**, for the same reason `launching` is: a failed scan is
      exactly when you most want the click to still land.

      Do not set the key to `null` or `''` — `takeFocus()` returning `null` must leave the
      field absent.
- [ ] In `SessionsView` (`client/src/components/SessionsView.tsx:32`): a `useEffect` on
      `data?.focusSession` that calls `setChatId(id)` when it is a non-empty string.
      Server-side consume-once means no client-side dedupe is needed — but depend on
      `data.focusSession`, **not** on `data`, or every poll re-fires the effect with a stale
      id and the drawer becomes impossible to close.
- [ ] Do **not** touch `client/src/lib/deepLink.ts`. The `?session=` path and this path are
      independent entry points; `deepLinkSession()`'s consume-once memo is about a URL, not
      about this.
- [ ] **Manual check before committing** (no ntfy involved yet): `pnpm dev`, open
      http://localhost:5174, then in another tab hit
      `http://localhost:5174/api/focus?session=<a real session id from the list>`. The
      throwaway tab should close and the drawer should open in the first tab within one
      poll. Vite proxies `/api` to 4173, so this exercises the dev path too.
- [ ] `pnpm typecheck && pnpm test`, then commit.

---

### Task 6 — Config and the desk route

**Files:** modify `server/lib/config.ts`, `server/lib/notify.ts`, `.env.example`; modify
`test/notify.test.ts`.

**Consumes:** Task 2's `atDesk` and memoized idle thunk; Task 4's `/api/focus`.

This task is last on purpose: it is the one that points a real notification at
`/api/focus`, and by now that endpoint exists and works.

- [ ] `server/lib/config.ts`: add `ntfyTopicDesk: string` (env `NTFY_TOPIC_DESK`, default
      `''`) and `localUrl: string` (env `DASHBOARD_LOCAL_URL`, default
      `` `http://localhost:${port}` ``). Both trimmed; `localUrl` also strips trailing
      slashes, the way `publicUrl` and `ntfyServer` do. Add both to `DEFAULTS`
      (`DASHBOARD_LOCAL_URL: ''` there, with the port-derived default applied in
      `loadConfig` — `DEFAULTS` is a flat literal and cannot see `port`).

      `localUrl` **does** get a synthesized default, unlike `publicUrl`, and the doc comment
      must say why the two differ: an absent `publicUrl` has to stay distinguishable from a
      chosen one because `clickUrl` and `sendTest` both branch on it, whereas a desk URL is
      by construction "this machine" and `http://localhost:<port>` is the only sensible
      guess. Add the dev caveat: in `pnpm dev` the client is on `WEB_PORT` (5174) while
      `PORT` (4173) answers API only, so the redirect branch of `/api/focus` needs
      `DASHBOARD_LOCAL_URL=http://localhost:5174` to land on a page. The record-and-close
      branch works either way — the handoff is server-side, not same-origin.

- [ ] `server/lib/notify.ts`: add `deskClickUrl(config, sessionId)` returning
      `` `${config.localUrl}/api/focus?session=${encodeURIComponent(sessionId)}` ``. Unlike
      `clickUrl` it never returns `''` — `localUrl` always has a value.

- [ ] Routing in `maybeSend`, after the `shouldNotify` check passes and before `deliver`:

      Desk iff `config.ntfyTopicDesk !== '' && atDesk(idle(), settings.idleSecs)`, where
      `idle()` is Task 2's memoized thunk. Evaluate the topic check **first** so an unset
      desk topic short-circuits before the thunk is ever touched.

      Desk → publish to `ntfyTopicDesk` with `deskClickUrl`. Otherwise → `ntfyTopic` with
      `clickUrl`, exactly as today.

      `httpsSend` builds its URL from `config.ntfyTopic` (`server/lib/notify.ts:213`), so it
      needs the chosen topic passed in. Add an optional `topic` field to `NotifyPayload`
      and have `httpsSend` use `payload.topic ?? config.ntfyTopic`. Putting it on the
      payload rather than in a second `Config` argument keeps the `Sender` type unchanged,
      which matters — `setSender` is the seam every delivery test uses, and every existing
      test that asserts on a payload keeps compiling.

      Exclusive, per the decision table: exactly one publish per push, never two.

- [ ] `sendTest` (`server/lib/notify.ts:298`): route it the **same way a real push would
      route right now**, so the button proves the routing rather than only the transport.
      Its success line must say which one it used and where taps land — `sent to <server>
      (desk topic) · taps open <localUrl>` / `sent to <server> (phone topic) · taps open
      <publicUrl>`. Keep the existing no-public-URL warning on the phone branch; the desk
      branch has no equivalent, because `localUrl` is never empty.

      The `if (!config.ntfyTopic) return 'no NTFY_TOPIC set in .env — nothing to send to'`
      guard stays as the first line and keeps checking `ntfyTopic` specifically: a desk
      topic without a phone topic is a misconfiguration, not a supported mode.

- [ ] `.env.example`: add both keys to the existing `# --- Push notifications (ntfy)`
      block. Repeat the "TREAT THE TOPIC AS A SECRET" warning for `NTFY_TOPIC_DESK` — do
      not write "see above", because someone will copy one line. Note that the desk channel
      needs **no** `DASHBOARD_PUBLIC_URL` and no tunnel: `clickUrl` returns `''` without a
      public URL and the header is dropped, but the desk path has no such dependency, so
      working desktop notifications with a live deep link are available to someone who never
      sets up Tailscale.

- [ ] Tests in `test/notify.test.ts`, all through `setSender` + `setLabelResolver`:
      - desk topic set, idle `10`, threshold `60` → payload's topic is the desk topic and
        `click` starts with `http://localhost:` and contains `/api/focus?session=`
      - desk topic set, idle `120`, threshold `60` → phone topic, `click` is the
        `publicUrl` form
      - desk topic set, idle `null` → phone topic
      - desk topic set, `idleSecs: 0` → phone topic
      - **desk topic unset, idle `10`** → phone topic. This is the mirror case, and it is
        the one that would otherwise ship broken: prove the unset path is untouched, not
        only that the set path works.
      - exactly one `deliver` call per `maybeSend`, in both the desk and phone cases
      - `sendTest` with a desk topic set and idle `10` → the returned string contains
        `desk topic` and the `localUrl`
      - `sendTest` with `ntfyTopic` empty but `ntfyTopicDesk` set → still the
        `no NTFY_TOPIC set` string
- [ ] `pnpm typecheck && pnpm test`, then commit.

---

### Task 7 — Docs

**Files:** modify `docs/subsystems/push-notify.md`, `docs/workflows/push-notify-setup.md`,
`docs/overview.md`.

- [ ] `docs/subsystems/push-notify.md`: a **Desk routing** section covering the exclusive
      rule, the `atDesk` predicate and its three "phone wins" cases (`null`, `idleSecs === 0`,
      idle ≥ threshold), the one-`ioreg`-per-push property and why `readIdle` is a thunk,
      and the focus handoff end to end — ntfy `openWindow` → `/api/focus` → recorded →
      next `/api/sessions` poll → drawer → tab self-closes. Name the redirect branch and
      when it fires (nothing polling, or the user is on another section).

      Also correct the module's own framing where it now overstates: the header comment in
      `server/lib/notify.ts` says ntfy "is now the *only* channel that reaches you when you
      are not looking at the dashboard" and the doc says a Mac with no `NTFY_TOPIC` gets no
      ping. Both stay true, but the desk topic changes which device rings — say so where a
      reader will hit it.

- [ ] `docs/workflows/push-notify-setup.md`: how to subscribe Chrome to the desk topic,
      including that background notifications must be enabled explicitly in the ntfy web
      app's Settings tab or a tab must stay open, and that desktop Chrome/Firefox/Edge/Opera
      deliver only while the browser runs (Safari 16.1+ on macOS 13+ is the exception).

      **Include the macOS trap**, because it cost a full debugging session on 2026-09-04:
      System Settings → Notifications shows **two identical "Google Chrome" rows**, and web
      push is delivered by `com.google.Chrome.framework.AlertNotificationService` (the
      alerts helper), not `com.google.Chrome`. Enabling only the latter produces a
      notification that macOS records but never displays. Do **not** suggest diagnosing this
      from `com.apple.ncprefs` flags — they were byte-identical before and after the fix.

- [ ] `docs/overview.md`: add `lib/focus.ts` to the `server/lib` map (one line, matching the
      surrounding style), and extend the `lib/idle.ts` and `lib/notify.ts` lines to mention
      the shared `atDesk` predicate.

- [ ] Do not run `/docs-sync` as part of this task — these are hand edits to docs the change
      touches directly. Commit.

### Not in scope

- Design 2 (dashboard-owned VAPID web push). If Task 1's gate fails, file it as a new idea
  citing this task; do not build it here.
- The `osascript` window-focus step. Follow-up idea if focus placement annoys.
- Any change to `NotifyPolicy`, `DEFAULT_NOTIFY`, `mergeNotify`, or the Settings UI's push
  group. The desk topic mirrors the phone's events by decision, so none of them move.
- `client/src/hooks/useWebNotify.ts` and the `surface: 'dashboard'` browser layer. It solves
  a different problem (a spawned session with no CLI in front of it) and is unaffected.

## Test cases

Automated, added by the tasks above:

1. `atDesk` boundaries — `(10,60)` true; `(60,60)` false; `(61,60)` false; `(null,60)`
   false; `(0,0)` false; `(-1,60)` true.
2. Idle-spawn count — `NTFY_TOPIC_DESK` unset + `requireAfk` false → `readIdle` called **0**
   times; `requireAfk` true → **1**; desk topic set + `requireAfk` true → still **1**.
   Removing the memoization must take the third to 2.
3. Routing — desk topic set and idle below threshold → desk topic + `/api/focus` click URL;
   idle above → phone topic + `publicUrl` click; `null` idle → phone; `idleSecs: 0` → phone;
   **desk topic unset + idle below threshold → phone, unchanged**.
4. Exactly one `deliver` call per `maybeSend`, desk and phone alike.
5. `sendTest` names the topic it routed to, and still returns `no NTFY_TOPIC set` when
   `ntfyTopic` is empty but `ntfyTopicDesk` is set.
6. Focus store — empty → `null`; record then take → the id; take twice → `null`; latest
   write wins; expiry either side of `FOCUS_TTL_MS`; `dashboardOpen()` false on a fresh
   store and either side of `POLL_FRESH_MS`.
7. `/api/focus` through the real route table — `200` + HTML when a dashboard is polling;
   `302` to `/?session=<id>` when not, recording nothing; `400` on missing, malformed and
   65-char ids; `403` on a non-loopback socket; `X-Forwarded-For` ignored in both
   directions.
8. `SessionsResponse.focusSession` absent when nothing is pending, present exactly once
   after a `/api/focus` hit, and attached on the error snapshot too.

Manual / browser, run by the executing session:

9. **Task 1's gate** (see that task) — does a `clients.openWindow()` tab close itself?
   Record the answer in this file before continuing.
10. **In the browser (playwright MCP tools):** with `pnpm dev` running, open
    `http://localhost:5174/`, wait for the session list to render, then in a second tab
    navigate to `http://localhost:5174/api/focus?session=<id of a session visible in the
    list>`. Expected: that second tab closes on its own, and within one poll interval the
    **first** tab shows the chat drawer open on that session — the drawer header names it,
    and the session list is still behind it. Assert the first tab's URL is unchanged
    (no `?session=` was added), which is what distinguishes this path from the `?session=`
    deep link.
11. **In the browser (playwright MCP tools):** restart the dev server so nothing has polled
    yet — a fresh process has `dashboardOpen() === false` by construction, which avoids
    waiting out `POLL_FRESH_MS` or temporarily editing a constant. With no dashboard tab
    open, navigate to `http://localhost:5174/api/focus?session=<id>`. Expected: a redirect
    to `/?session=<id>`, the dashboard renders, and the drawer opens for that session.

    The `302` is **relative**, so it stays on whatever origin the tab was opened at — which
    is why this case works from 5174 without any config. In real use the tab is opened at
    `localUrl`, so it is that value, not the redirect, that needs
    `DASHBOARD_LOCAL_URL=http://localhost:5174` in dev (Task 6).
12. **Real push, at the desk** (needs a phone and a subscribed Chrome; not scriptable):
    with `NTFY_TOPIC_DESK` set and Chrome subscribed to it, trigger a real event while
    sitting at the keyboard. Expected: the banner appears on the **Mac**, the phone stays
    silent, clicking the banner lands the drawer in the already-open dashboard tab, and the
    tab ntfy opened disappears. Then leave the keyboard idle past `idleSecs` and trigger
    another: the **phone** buzzes and the Mac stays silent.

## Done when

- `pnpm typecheck` and `pnpm test` both pass, with the new case count reported.
- Task 1's gate answer is written into this file under `### Task 1 result`.
- Automated cases 1–8 pass, and each mutation-proof case named above has been shown to fail
  with its guard removed — a green test that stays green without the code it guards proves
  nothing.
- Browser cases 10 and 11 have been driven with the Playwright MCP tools and their outcome
  recorded.
- Case 12 is **the one that cannot be automated**; whether it was run — and its result — is
  stated explicitly in `## Outcome`. If it was not run, say "not verified, needs a human"
  rather than implying it passed.
- With `NTFY_TOPIC_DESK` unset, behaviour is unchanged: same topic, same click URL, same
  zero `ioreg` spawns when `requireAfk` is off. Test case 2 and case 3's mirror case are the
  proof.
- Docs updated per Task 7, and `docs/overview.md` lists `server/lib/focus.ts`.
