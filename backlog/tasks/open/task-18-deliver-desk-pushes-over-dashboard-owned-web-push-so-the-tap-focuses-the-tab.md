---
id: task-18
title: Deliver desk pushes over dashboard-owned web push so the tap focuses the tab
created: 2026-09-04
from: idea-21
---

## Goal

Tapping a desk notification puts the dashboard tab **in front of you**, with the right
session drawer open — not one tab away from it.

Today the tap lands in a throwaway `/api/focus` tab opened by ntfy.sh's service worker. That
worker is cross-origin, so it can never see or focus a dashboard tab (`clients.matchAll()` is
same-origin by spec), and the page it opens has no user activation to spend on
`WindowClient.focus()`. **No fix on the ntfy path is possible** — the fix is to own the
transport.

Phase 1 replaces the *desk* channel with dashboard-owned Web Push: our service worker, on our
origin, handling `notificationclick` — an event that does carry user activation. ntfy keeps
the phone. Success is the tap landing you on the dashboard with zero further clicks and no
throwaway tab flashing past.

## Plan

### ⚠️ Plan conventions — read before executing

**This plan specifies behaviour, signatures and exact test *values*. It deliberately contains
no literal implementation code**, overriding `superpowers:writing-plans`' "No Placeholders /
code blocks required" rule, per `.claude/CLAUDE.md` §Subagent rules. Handed code gets
transcribed verbatim and a bug in the plan becomes a bug in the branch with nobody positioned
to catch it. **You are expected to disagree with this plan where it is wrong** — if a step
does not survive contact with the code, say so rather than forcing it.

The one exception is *data*: the RFC test vectors in Task 1 and the byte lengths throughout
are literal and exact. They were computed on this machine on 2026-09-04 (Node v22.23.1), not
recalled. If one does not reproduce, the bug is ours, not the vector's.

Size guidance below is a **soft target**, never a rule to compress a load-bearing guard away.

### Scope decision taken without asking

`AskUserQuestion` is not available in this session (searched by exact name; absent), so this
fork was settled during grooming rather than with the user:

> **Phase 1 is the desk channel only. ntfy stays the phone transport, untouched.**

Taken because it is the idea's own recommendation, it is where the reported pain is, it needs
no phone in the loop to verify, and it builds ~90% of a later mobile phase anyway. **What
would change it:** wanting ntfy.sh out of the loop entirely for privacy (it currently sees
every notification body) — that is phase 2 and needs an iOS Home-Screen PWA install, so it
should be filed as its own idea rather than widened into this task.

### Architecture

Server signs a VAPID JWT (RFC 8292) and POSTs an `aes128gcm`-encrypted payload (RFC 8291)
straight to the browser's own push service (FCM / Mozilla autopush / Apple). Our service
worker at the dashboard origin receives it, raises the banner, and on click focuses the
existing dashboard tab and navigates it to `/?session=<id>`.

Three things fall out for free: no throwaway tab, no `Click`-header dependency, and the
background-notifications trap in `docs/workflows/push-notify-setup.md` stops applying on this
path (it is an ntfy-web-app artefact).

**Relationship to `bug-18`** (a tap claimed by whichever dashboard tab polls first): the web
push path addresses one *subscription* — one browser — so the consume-once race does not
exist on it. **Do not close bug-18.** It still describes the ntfy fallback and the phone path,
both of which still go through `/api/focus`. Cross-reference it in the docs; leave the item open.

### Global constraints

- **Zero new runtime deps in `server/`.** `node:crypto` + `node:https` only. Verified
  sufficient on Node v22.23.1 (see Task 1's gotchas).
- ESM throughout; server imports carry the `.js` suffix. Server is never compiled.
- **`shared/types.ts` first**, then the server producer, then the client consumer.
- No hardcoded color or shadow in `styles.css` below the theme-token block.
- The new state file is gitignored, like `.dashboard-settings.json`.
- Fire-and-forget contract holds: a notification must never delay or fail the request that
  triggered it. `maybeSend` still cannot throw.

### File structure

Create:

| Path | Responsibility |
|---|---|
| `server/lib/webpush.ts` | The protocol, and nothing else. VAPID JWT, RFC 8291 encryption, the HTTP POST. Knows nothing about sessions, config or the dashboard. |
| `server/lib/subscriptions.ts` | The store: the VAPID keypair's lifecycle and the list of subscribed browsers, on disk. |
| `client/public/sw.js` | The service worker. Plain JS, unbundled, served verbatim at origin root. |
| `client/src/lib/pushSubscribe.ts` | Pure browser-side helpers (key decoding, subscribe/unsubscribe wrappers). |
| `client/src/hooks/useDeskPush.ts` | Subscription state for the Settings row. |
| `test/webpush.test.ts`, `test/subscriptions.test.ts`, `test/api-push.test.ts`, `test/push-subscribe.test.ts` | See `## Test cases`. |

Modify: `shared/types.ts`, `server/lib/notify.ts`, `server/api.ts`, `server/index.ts`,
`client/src/main.tsx`, `client/src/components/settings/SettingsView.tsx`, `.gitignore`,
`test/notify.test.ts`, `test/run-all.ts`, `docs/subsystems/push-notify.md`,
`docs/workflows/push-notify-setup.md`, `docs/overview.md`.

---

### Task 1 — `server/lib/webpush.ts`, proven against the RFC vectors

The only task with real cryptographic risk. Do it first and do it test-first: everything
downstream is plumbing, and a silent divergence here produces a push service that answers
`201 Created` and a browser that shows nothing.

**Exports (exact signatures later tasks depend on):**

- `generateKeypair(): { publicKey: string; privateKey: string }` — both base64url.
  `publicKey` is the 65-byte uncompressed P-256 point (leading `0x04`), `privateKey` the raw
  32-byte scalar.
- `vapidAuthHeader(endpoint: string, subject: string, keys: { publicKey: string; privateKey: string }, nowSec?: number): string`
  — returns the full `Authorization` value.
- `encryptPayload(plaintext: string | Buffer, p256dh: string, auth: string, opts?: { salt?: Buffer; keypair?: { publicKey: string; privateKey: string } }): Buffer`
  — `opts` exists only so the vector test can pin the salt and ephemeral keypair. Production
  passes nothing.
- `sendPush(sub: { endpoint: string; p256dh: string; auth: string }, plaintext: string, keys: { publicKey: string; privateKey: string }, subject: string): Promise<PushResult>`
- `export const VAPID_SUBJECT` — the JWT's `sub`. RFC 8292 requires a `mailto:` or `https:`
  URI; push services do not validate it, they only keep it to contact whoever is pushing.
  Use the repo URL (`https://github.com/futin/claude-agents-dashboard`), **not** a `mailto:` —
  an https subject is spec-valid and puts no email address into a header sent to Google and
  Mozilla. A constant here rather than a `Config` key: it is not something a user would ever
  want to change, and `config.ts` is already long.
- `interface PushResult { ok: boolean; status: number; detail: string; gone: boolean }` —
  `gone` is true on 404/410 only, and is what tells the store to prune.
- `setPushTransport(fn: PushTransport | null): void` — the test seam, mirroring `setSender`
  in `notify.ts` so no test opens a socket. `null` restores https.

**Behaviour, and the six places this goes wrong:**

1. `crypto.hkdfSync(digest, ikm, salt, info, keylen)` — that argument order, `ikm` **before**
   `salt`, which is the reverse of how the RFC prose reads. It returns an **`ArrayBuffer`,
   not a `Buffer`**; wrap every result in `Buffer.from` or the concatenations silently
   misbehave.
2. The VAPID JWT must be signed **ES256 as raw R‖S**, via `dsaEncoding: 'ieee-p1363'`. Node's
   default is DER, which is 70–72 bytes (71 on a sample run here) instead of 64, and push
   services reject it. Build the signing `KeyObject` from a JWK
   `{ kty: 'EC', crv: 'P-256', d, x, y }` where `x` is public-point bytes 1–33 and `y` is
   33–65 — `createECDH` alone cannot sign.
3. `aud` is the endpoint's **origin**, not the full URL:
   `new URL(endpoint).origin` → `https://fcm.googleapis.com`. Sending the path fails auth.
4. `exp` must be ≤ 24h out; use **now + 43200** (12h). JWT header is exactly
   `{"typ":"JWT","alg":"ES256"}`; claims are `aud`, `exp`, `sub`. Header value format is
   `vapid t=<jwt>, k=<publicKey>` — note the comma-space.
5. **`key_info` for the PRK is `"WebPush: info\0" || ua_public(65) || as_public(65)`** — that
   order, subscriber's key first. The PRK uses the *auth secret* as HKDF salt; the CEK
   (`"Content-Encoding: aes128gcm\0"`, 16 bytes) and nonce (`"Content-Encoding: nonce\0"`,
   12 bytes) use the record salt. Every one of those info strings ends in a real NUL byte.
6. The plaintext gets a **`0x02`** delimiter byte appended before encryption — the *last
   record* marker. `0x00` means "more records follow" and the browser will discard the message.

Body layout, 86 bytes of header then ciphertext:
`salt(16) ‖ rs(4, big-endian, 4096) ‖ idlen(1, = 65) ‖ as_public(65) ‖ AES-128-GCM(plaintext ‖ 0x02)`.
Total length is therefore `86 + plaintextBytes + 1 + 16`.

Request headers: `Authorization` (above), `Content-Encoding: aes128gcm`,
`Content-Type: application/octet-stream`, `TTL: 60`, `Urgency: high`.

`sendPush` **never rejects** — same contract as `httpsSend` in `notify.ts`. Timeout 5s
(longer than ntfy's 2s: this is a real TLS handshake to a third-party push service, and a
2s budget would report working pushes as failures). A timeout or transport error resolves
`{ ok: false, status: 0, gone: false }`.

Soft target ≈ 200 lines including doc comments.

---

### Task 2 — `server/lib/subscriptions.ts`, the store

Shaped like `settings.ts` and `remoteState.ts` — module cache, fail-open read, `persisted`
flag, `reset*()` seam. This is the third and last thing the app writes to disk.

- File: `.dashboard-push.json` in `process.cwd()`. **Add it to `.gitignore` in this same
  task**, next to `.dashboard-settings.json`. Never inside `~/.claude` (read-only under Docker).
- Written with **mode `0o600`**. It holds the VAPID private key. That key only lets its holder
  push notifications to this user's own browsers, so it is not catastrophic — but it is a
  signing key and a world-readable one is gratuitous.
- Shape: `{ vapid: { publicKey, privateKey }, subs: PushSubscriptionRecord[] }`.
- `PushSubscriptionRecord = { id, endpoint, p256dh, auth, label, createdAt }` — **flat**, while
  the wire type `PushSubscriptionInput` in Task 3 nests the two keys under `keys`. That is
  deliberate, not drift: the nested shape is what the browser's `subscription.toJSON()`
  produces and so is what the endpoint must accept, and the flat shape is what `sendPush`
  takes. `addSubscription` is the one place that converts, so the conversion has exactly one
  home. `id` is the
  first 16 hex chars of `sha256(endpoint)`, so **re-subscribing the same browser replaces its
  record instead of accumulating a duplicate** — Chrome hands back the same endpoint for the
  same registration, and a list that grows on every page load would push N times per event.

**Exports:** `getVapidKeys()` (generates and persists once, on first call, then returns the
cached pair), `listSubscriptions()`, `addSubscription(input, label)` → the record,
`removeByEndpoint(endpoint)` → boolean, `removeById(id)` → boolean, `isPersisted()`,
`resetSubscriptions()`.

**`privateKey` must never leave this module in anything a handler serialises** — same rule
`ntfyTopic` follows in `config.ts`. `listSubscriptions()` returns records, which do not carry
it; there is no getter that returns the whole file.

A corrupt or unreadable file reads as "no subscriptions, no keys yet" and does not throw
(fail-open, like `settings.ts`). A failed *write* sets `persisted = false` rather than
throwing, and the Settings row surfaces it — a subscription that will not survive a restart
is exactly the invisible failure this repo keeps re-learning about.

---

### Task 3 — types and the four endpoints

`shared/types.ts` first (repo rule), then `server/api.ts`, then `server/index.ts`'s route table.

**Types:** `PushSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }`,
`PushKeyResponse { publicKey: string; devices: number }`,
`PushSubscribeResponse { id: string; persisted: boolean }`,
`PushTestResponse { outcome: string }`.

**Endpoints:**

| Route | Guard | Behaviour |
|---|---|---|
| `GET /api/push/key` | none | `{ publicKey, devices }`. A VAPID public key is public by construction — it is what the browser needs to subscribe — and `devices` is a bare count. |
| `POST /api/push/subscribe` | `tokenOk` | Validate (below), store, return `{ id, persisted }`. |
| `POST /api/push/unsubscribe` | `tokenOk` | `{ endpoint }` → `{ ok: true }`. **Idempotent** — an unknown endpoint is still 200. |
| `POST /api/push/test` | `tokenOk` | Push to every subscription, prune any that come back `gone`, return one prose `outcome` naming how many succeeded and the first failure's detail. Mirrors `sendTest`'s contract: the only honest answer to "is this working?" is to fire one and report. |

**Why this is not a duplicate of the existing `POST /api/notify/test`.** That one routes
exactly as a real push would route *right now*, which is its whole point — and which means it
cannot reach a web push subscription unless you happen to be at the desk when you press it.
This one tests the subscription itself, unconditionally. Different questions: "is my routing
right?" versus "did this browser's subscription survive?". Keep both, and say so in the doc
comment or the next reader will delete one.

**Validation on `subscribe` — this is the security-critical part of the task.** `endpoint` is
attacker-supplied data that the server will then make an outbound HTTP request to, and
`tokenOk` **defaults open** (`ANSWER_TOKEN` is empty by default). Without a scheme check this
endpoint is an SSRF primitive pointed at the loopback interface and the cloud metadata
service. Reject with **400** unless all of:

- `endpoint` parses as a URL, its protocol is exactly `https:`, and its length is ≤ 2048.
  (`https:` only — every real push service is HTTPS, so this costs nothing and closes
  `http://`, `file://` and everything else in one clause.)
- `p256dh` base64url-decodes to **exactly 65 bytes** whose first byte is **`0x04`**.
- `auth` base64url-decodes to **exactly 16 bytes**.
- `label`, if present, is a string; truncate to 64 chars. It is displayed, so it must not be
  trusted for length.

Follow `serveNotifyTest`'s existing shape for `tokenOk` and `sendBadBody`.

---

### Task 4 — routing in `server/lib/notify.ts`

`routePush` currently returns `{ topic, click, desk }`. Widen it to a discriminated union:

- `{ transport: 'webpush' }`
- `{ transport: 'ntfy'; topic: string; click: string; desk: boolean }`

**Decision order, and it matters:**

1. `atDesk(readIdle(), thresholdSecs)` **and** `listSubscriptions().length > 0` → `webpush`.
2. else `config.ntfyTopicDesk` and `atDesk(...)` → the ntfy desk topic, **exactly as today**.
3. else the phone topic, exactly as today.

Web push winning over the ntfy desk topic is what keeps the existing "exclusive, not both"
rule — one buzz per event, never two. Clause 2 surviving unchanged is what keeps a user who
has not subscribed yet from silently losing the feature.

Keep the `readIdle` memoisation and its thunk shape: an unsubscribed, desk-topic-less run must
still never spawn `ioreg`. Check `listSubscriptions()` *after* `atDesk` for the same reason —
a disk read for a push that is not going to the desk anyway is waste.

**Web push payload** (JSON, encrypted): `{ title, body, tag, sessionId, url }`.

- `title`/`body` are the existing `'Claude Code'` and `` `${label} — ${phrase}` `` — unchanged,
  so the wording stays in one place.
- `tag` is the session id, so a second push for the same session replaces the first banner
  rather than stacking.
- `url` is `` `${config.localUrl}/?session=${encodeURIComponent(sessionId)}` `` — **the
  dashboard route, not `/api/focus`.** The whole point is that our own worker navigates an
  existing tab directly; routing through `/api/focus` would reintroduce the throwaway tab this
  task exists to delete.

`maybeSend` branches on `route.transport` and still cannot throw: a rejected web push promise
must be swallowed the same way the ntfy one is, or an unhandled rejection takes the process
down. `sendTest` reports which transport it actually used, so the Settings button proves the
routing and not merely the transport — the property it already has.

---

### Task 5 — `client/public/sw.js`, the service worker

Plain JavaScript, no build step, no TypeScript. `client/public/` does not exist yet — create
it. Vite serves it at origin root in dev and copies it to `client/dist/` on build, so
`/sw.js` resolves in both modes; `server/index.ts`'s MIME table already maps `.js`.

**`push`:** parse the JSON, then `event.waitUntil(self.registration.showNotification(title, { body, tag, data: { url } }))`.
It must be `registration.showNotification` — the `Notification` **constructor does not exist
in a worker at all**, and not on iOS even inside an installed PWA. A malformed or bodyless
push must still raise *something* rather than throw, or Chrome logs a worker error and shows
its own generic "This site has been updated in the background" banner.

**`notificationclick`** — the reason this whole task exists:

1. `event.notification.close()`.
2. Inside one `event.waitUntil(...)` chain: `clients.matchAll({ type: 'window', includeUncontrolled: true })`.
3. Find the first client whose URL origin equals `self.location.origin`.
4. If found: **`client.focus()` first, then `.navigate(url)` on what focus resolves to.** That
   order is load-bearing — `navigate()` returns a *fresh* `WindowClient` and focusing the
   stale handle afterwards is the failure this task is fixing, one layer down.
5. If none: `clients.openWindow(url)`.

Do not `await` anything before step 4 that is not part of that chain; user activation is spent
by the first async boundary the spec does not preserve.

**`pushsubscriptionchange`:** re-subscribe with the same `applicationServerKey` and POST the
new subscription to `/api/push/subscribe`. Chrome rotates endpoints, and without this the
feature dies silently weeks later with no error anywhere — the exact failure mode this
subsystem's docs already devote a section to.

**`install` → `self.skipWaiting()`, `activate` → `self.clients.claim()`.** Otherwise editing
this file needs every tab closed before the change takes effect, and the next session debugs a
stale worker for an hour. (Same class of trap as the stale-HMR-tab problem already recorded
against this repo.)

**No web app manifest in this phase.** Desktop Chrome, Firefox and Edge allow push from an
ordinary page with a registered worker; a manifest is only needed for the iOS Home-Screen
install, which is phase 2. Adding one now is scope the desk channel does not need.

**No `fetch` handler and no caching.** This is not an offline PWA. A fetch handler would put a
stale-asset bug between the user and every page load for zero benefit here.

`/sw.js` must not be served with a long `Cache-Control`. `server/index.ts` sets none today —
keep it that way; do not "helpfully" add one while in there.

---

### Task 6 — client wiring and the Settings row

`client/src/lib/pushSubscribe.ts` (pure, unit-testable):

- `pushSupported(): boolean` — `'serviceWorker' in navigator && 'PushManager' in window`.
- `urlBase64ToUint8Array(b64url: string): Uint8Array` — `-`→`+`, `_`→`/`, right-pad with `=`
  to a multiple of 4, then `atob`. `pushManager.subscribe` requires a `Uint8Array`; handing it
  the base64 string fails with an unhelpful `InvalidCharacterError`.
- `currentSubscription()`, `subscribe(publicKey)`, `unsubscribe()`.

`client/src/hooks/useDeskPush.ts` → `{ state, detail, subscribe, unsubscribe, test }` where
`state` is one of `'unsupported' | 'denied' | 'off' | 'on' | 'busy'`.

`client/src/main.tsx`: register `/sw.js` at scope `/`, guarded on `'serviceWorker' in
navigator`, failure logged and non-fatal. The dashboard must still work with no worker.

`SettingsView.tsx`: one **"Desk notifications · this browser"** row inside the existing push
block, using the existing `SettingsRow`. Distinct copy per state — `unsupported` and `denied`
must not both render as "off", because they need different actions from the user (nothing, vs.
reset the site permission in browser settings). Surface `persisted === false` as a warning.
No new colors; reuse the tokens already in `styles.css`.

**`Notification.requestPermission()` must be called from a click handler.** Never on mount —
Chrome ignores an ungestured request and the row would sit in `'default'` forever with no
error. That is why this is a button.

---

### Task 7 — docs

- `docs/subsystems/push-notify.md`: a "Desk delivery over web push" section — the transport
  decision table from Task 4, why the ntfy path *could not* have been fixed
  (cross-origin `clients.matchAll`, no user activation), and the residual: **Chrome, Firefox
  and Edge deliver web push only while the browser is running**; Safari 16.1+ on macOS 13+ is
  the one desktop browser that delivers with the browser closed, so it is the better desk
  receiver. Cross-reference `bug-18` as still-open for the ntfy and phone paths.
- `docs/workflows/push-notify-setup.md`: the subscribe step; state that the
  background-notifications trap does **not** apply to this path; keep every ntfy section — the
  phone still uses it.
- `docs/overview.md` §Map: `server/lib/webpush.ts`, `server/lib/subscriptions.ts`,
  `client/public/sw.js`.
- Re-stamp the docs-sync provenance on every doc touched.

## Test cases

`pnpm test` (`test/run-all.ts`) — register each new file there. Node-assert, tmpdir fixtures,
same style as the existing suite.

### `test/webpush.test.ts` — the crypto

1. **RFC 8291 §A.2 vector.** Verified to reproduce byte-for-byte on this machine, Node
   v22.23.1, 2026-09-04. With `salt` and the AS keypair pinned via `opts`:
   - plaintext `When I grow up, I want to be a watermelon`
   - `ua_public` `BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`
   - `auth` `BTBZMqHH6r4Tts7J_aSIgg`
   - `as_public` `BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8`
   - `as_private` `yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw`
   - `salt` `DGv6ra1nlYgDCS1FRnbzlw`
   - **expected `encryptPayload(...).toString('base64url')`:**
     `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`

   This one assertion covers all four HKDF info strings, the `key_info` concatenation order,
   the auth-secret-as-salt step, the `0x02` delimiter and the 86-byte header layout. **It is
   the mutation proof for the entire module** — break any of them and it fails. If it does not
   reproduce, the implementation is wrong; the vector was executed, not remembered.

2. **Round trip.** Encrypt to a freshly generated UA keypair with a random salt, then decrypt
   from the UA side (derive the shared secret with the UA private key and the `as_public`
   read back out of the body at offset 21). Expect the original plaintext and a trailing byte
   of `0x02`. Catches the case where case 1 is passed by a hardcode.

3. **Length.** For that same 41-byte plaintext, `encryptPayload(...).length === 144`
   (`86 + 41 + 1 + 16`).

4. **VAPID header shape.** `vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123', 'mailto:a@b.c', keys, 1_000_000_000)`:
   starts with `vapid t=`; contains `, k=` followed by `keys.publicKey`; the JWT splits on `.`
   into exactly 3 parts; part 1 decodes to `{"typ":"JWT","alg":"ES256"}`; part 2 decodes to
   `aud === 'https://fcm.googleapis.com'` (**origin only — no `/fcm/send/abc123`**),
   `sub === 'mailto:a@b.c'`, `exp === 1000043200`.

5. **Signature encoding.** The JWT's signature segment decodes to **exactly 64 bytes**, and
   `crypto.verify('sha256', signingInput, publicKeyObject, sig)` with
   `dsaEncoding: 'ieee-p1363'` returns true. Mutation proof for gotcha 2: drop the
   `dsaEncoding` option and the length becomes 70–72 (71 on a sample run here) and this fails.

6. **`sendPush` status mapping**, with `setPushTransport` stubbed: `201` →
   `{ ok: true, gone: false }`; `410` → `{ ok: false, gone: true }`; `404` → `gone: true`;
   `429` → `{ ok: false, gone: false }`; a transport that *rejects* → resolves
   `{ ok: false, status: 0, gone: false }` rather than propagating. The last case is the
   fire-and-forget contract.

7. **`sendPush` request shape.** The stub captures headers and body: `Content-Encoding` is
   `aes128gcm`, `TTL` is present, `Authorization` starts with `vapid t=`, and the body's first
   16 bytes equal the salt at the start of `encryptPayload`'s output.

### `test/subscriptions.test.ts` — the store (tmpdir cwd)

8. First `getVapidKeys()` creates `.dashboard-push.json`; a second call after `resetSubscriptions()`
   in the same tmpdir returns the **same** pair (generated once, not per call).
9. That file's mode is `0o600`.
10. `addSubscription` twice with the same `endpoint` → `listSubscriptions().length === 1`, and
    the second call's `p256dh` is the one stored.
11. Two different endpoints → length 2, distinct `id`s.
12. `removeByEndpoint` with an unknown endpoint → `false`, list unchanged.
13. A file containing `not json at all` → `listSubscriptions()` returns `[]` and does not
    throw. Same for a file whose `subs` is a string rather than an array.
14. No exported function returns `vapid.privateKey` in an object a handler would send.

### `test/api-push.test.ts` — endpoints, through `createRequestListener`

Follow `test/api-focus.test.ts`'s harness. A valid body means `p256dh` = a real 65-byte
base64url point (reuse the vector's `ua_public`) and `auth` = the vector's 22-char `auth`.

15. `GET /api/push/key` → 200; `publicKey.length === 87` (65 bytes as base64url); `devices` is
    a number.
16. `POST /api/push/subscribe` with a valid body → 200 with an `id`; store now lists 1.
17. **`endpoint: 'http://169.254.169.254/latest/meta-data/'` → 400, store unchanged.** The
    SSRF guard, and mutation-proof: delete the scheme check and this turns 200.
18. `endpoint: 'file:///etc/passwd'` → 400. `'https://x/' + 'a'.repeat(3000)` → 400.
19. `p256dh` decoding to 64 bytes → 400. `p256dh` whose first byte is `0x03` → 400. `auth`
    decoding to 15 bytes → 400. Each leaves the store unchanged.
20. With `ANSWER_TOKEN` set: subscribe with no bearer → 403 **and store unchanged**; with the
    correct bearer → 200. (Asserting the store, not just the status — a 403 that still wrote
    would pass a status-only test.)
21. `POST /api/push/unsubscribe` with an unknown endpoint → 200 `{ ok: true }`, store unchanged.
    With a known one → 200 and the store drops to 0.
22. `POST /api/push/test` with 0 subscriptions → 200 and an `outcome` that says so rather than
    claiming success.

### `test/notify.test.ts` — routing (extend the existing file)

23. At desk, ≥1 subscription → the web push transport is called and the **ntfy sender is not**.
24. At desk, 0 subscriptions, `ntfyTopicDesk` set → the ntfy desk topic, byte-identical to
    today. No regression for an unsubscribed user.
25. **Not** at desk, subscriptions present → the phone ntfy topic, and web push is **not**
    called. The untested complement of 23 — the rule proved one way hides its bug in the mirror.
26. The web push plaintext parses to `{ title: 'Claude Code', body: '<label> — question waiting', sessionId, url }`
    where `url === '<localUrl>/?session=<id>'` and **contains no `/api/focus`**.
27. `readIdle` is called **at most once** per `maybeSend` — the existing memoisation assertion
    must still pass with the new `listSubscriptions()` clause in the path.
28. A web push transport that throws synchronously → `maybeSend` returns normally, throws
    nothing, and no unhandled rejection is raised.
29. With no subscriptions and no desk topic, `listSubscriptions` is never reached before
    `atDesk` short-circuits — i.e. no disk read for a phone-bound push.

### `test/push-subscribe.test.ts` — the client lib

30. `urlBase64ToUint8Array` on the vector's `ua_public` → 65 bytes, `[0] === 4`.
31. It handles inputs needing 0, 1 and 2 `=` of padding, and both `-` and `_` in the alphabet.

### Browser checks

**The harness auto-denies permission prompts in this repo** (recorded from a previous run), so
the subscribe → push → focus loop is **not** machine-verifiable here. Do not write a test that
assumes a granted permission; assert the denied/default rendering instead and leave the real
loop to the desk check below.

32. `In the browser (playwright MCP tools):` open `http://localhost:5174/`, wait for the app to
    render, then evaluate `navigator.serviceWorker.getRegistration('/')` — expect a
    registration whose `scope` ends with `/` and whose `active.scriptURL` ends with `/sw.js`.
33. `In the browser (playwright MCP tools):` fetch `/sw.js` from the page — expect HTTP 200, a
    `content-type` containing `javascript`, and a body containing both `notificationclick` and
    `pushsubscriptionchange`.
34. `In the browser (playwright MCP tools):` open `http://localhost:5174/`, click the
    **Settings** rail item, and expect a row labelled `Desk notifications · this browser`
    rendering its unsupported/denied copy — **not** the word `on`.

### Desk check — human, and it must be declared unverified in the PR

35. In Chrome at the desk (`.env` has `DASHBOARD_LOCAL_URL=http://localhost:5174` under dev),
    subscribe from Settings, switch to another tab in the same window, trigger a question, and
    on the banner tap confirm **both**: Chrome comes forward **and** the dashboard tab is the
    active tab, with the right session drawer open. No throwaway tab appears at any point.

    Per `.claude/CLAUDE.md` §PR rules this cannot be claimed green from the branch — it needs
    a human at the machine and it goes in the PR body as an explicit *Unproven* row.

## Done when

- `pnpm typecheck` is clean and `pnpm test` passes, both with the command output pasted and
  the case count named. No "should pass" without the output.
- Test 1 (the RFC 8291 vector) is present and green. **This is the gate on Task 1** — without
  it the module is unproven no matter how many other tests pass.
- Test 5 is present and green (raw R‖S, 64 bytes) — the second half of the crypto proof.
- Test 17 is present and green, and has been mutation-checked: temporarily delete the `https:`
  scheme check, confirm the test goes red, restore it. A guard test that stays green with the
  guard deleted proves nothing.
- Tests 24 and 25 pass, proving the ntfy desk topic and the phone topic are both unregressed
  for a user who never subscribes.
- Browser checks 32–34 run and pass under the Playwright MCP tools.
- `server/` still has **zero** runtime dependencies — confirm by reading `package.json`, not
  by assuming.
- `.dashboard-push.json` is in `.gitignore` and is not in `git status`.
- `docs/subsystems/push-notify.md`, `docs/workflows/push-notify-setup.md` and
  `docs/overview.md` describe the new transport, and their docs-sync stamps are re-baselined.
- `bug-18` is still **open**, now cross-referenced from the docs as applying to the ntfy and
  phone paths only.
- The PR body carries the desk check (35) as an explicit *Unproven* row.
