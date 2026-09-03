---
id: bug-16
title: A logged-out CLI shows no usage bars and no hint at all
created: 2026-09-03
tags: usage, header
updated: 2026-09-03T18:43:59Z
groom-elapsed: 144
---

## Symptom

The header's 5h / Week bars silently disappear, with no hint under them, when the
`claude` CLI is signed out. Observed 2026-09-03: `/api/sessions` returned
`usageStatus: "unavailable"`, `usage: null`, and the header rendered nothing at all —
visually identical to a network failure, an endpoint 429, or `SHOW_USAGE=false`. The
actual cause was a plain logout, which the user could have fixed in one command had
anything said so. It read as "the usage feature is broken".

The stored credential is present but **blank**, not expired:

| field | value |
|---|---|
| `accessToken` | `""` (length 0) |
| `refreshToken` | `""` (length 0) |
| `expiresAt` | `0` |
| `refreshTokenExpiresAt` | 1789972878848 (2026-09-22 — *not* past) |

`claude auth status` on the same host: `{"loggedIn": false, "authMethod": "none"}`.
Sessions kept working throughout because the entrypoint was `claude-desktop`
(`~/.claude/sessions/<pid>.json`, CLI 2.1.258), which carries its own auth — so the
board looked healthy in every respect except the bars.

## Repro

1. `claude auth logout` (or reach the same blanked-credential state any other way).
2. `curl -s localhost:4173/api/sessions | jq '.usageStatus, .usage'`
   → `"unavailable"`, `null`.
3. Load the board: no bars, no hint, no explanation anywhere in the UI.

## Affects

- `server/lib/usage.ts:126` — `tokenFromCredsBlob`: `if (!token) return { state: 'missing' }`.
  An empty-string `accessToken` is a *string*, so it passes the `typeof` check and then
  fails the truthiness check, collapsing "blank credential" into the same `missing` as
  "no keychain item at all" and "not macOS".
- `server/lib/usage.ts:279` — `t.state === 'expired' ? 'token-expired' : 'unavailable'`:
  every non-`ok`, non-`expired` state becomes the generic `unavailable`, which is also
  what a failed fetch, a 429 and a thrown error produce.
- `server/lib/usage.ts:288` — `autoRenew` is gated on `expired` only. Correct as written
  (no spawn conjures credentials that were never stored) and **not** what should change.
- `client/src/components/Header.tsx:23` — renders a hint for `'token-expired'` only;
  `'unavailable'` renders nothing.
- `shared/types.ts` — `usageStatus` union needs the new member.

## Cause

One chain of four steps, each verified against the code:

1. `tokenFromCredsBlob` (`server/lib/usage.ts:127`) tests the token for *truthiness*
   right after testing it for *type*. `""` is a string, so it clears the `typeof` check
   and then fails `!token` — a present-but-blank credential returns
   `{ state: 'missing' }`, the same value returned for no keychain item at all, a
   non-macOS host, and unparseable JSON. The expiry check on the next line (`:128`) is
   never reached, which is why the observed `expiresAt: 0` never surfaced as `expired`
   either.
2. `readToken` (`:107`) can carry exactly one distinction upward — `sawExpired` — so its
   fallback is `expired` or `missing`, with no third option to carry.
3. `refreshNow` (`:279`) maps `expired → 'token-expired'` and *everything else* to
   `'unavailable'` — the bucket that also holds a failed fetch, the endpoint's own 429, a
   thrown error and a bad payload.
4. `Header.tsx:23` renders a hint for `'token-expired'` only. On `'unavailable'` it falls
   through to `UsageBars`, whose `if (!usage) return null` (`:44`) renders nothing at all
   — no element, no label, no empty state.

No step is wrong on its own terms: `missing` was designed to mean "there is nothing to
read", `unavailable` to mean "fail open, don't explain". The defect is that the one state
which is both diagnosable *and* fixable by the user in one command — credentials present,
values blank, i.e. signed out — lands in the bucket reserved for causes the user can do
nothing about, and inherits its silence.

## Fix

Give the blank-credential state an identity of its own, all the way from the parse to the
header: `TokenState` gains `signed-out`, `UsageStatus` gains `signed-out`, and the header
renders a hint naming the command that fixes it. Six edits.

**Server — `server/lib/usage.ts`**

1. `TokenState` (`:32-35`) gains `{ state: 'signed-out' }`.
2. `tokenFromCredsBlob` (`:116-129`): after the `typeof` check, treat a string that is
   empty or whitespace-only as `signed-out`. **This test must come before the `expiresAt`
   comparison**, not after: the observed logout blob carries `expiresAt: 0`, which is
   `<= now`, so a blank token classified expiry-first would report `expired` and fire a
   `claude -p` renewal turn at a credential that has no refresh token to renew. Only a
   `claudeAiOauth` with no `accessToken` key, a non-string one, a missing
   `claudeAiOauth`, or unparseable JSON stay `missing`.
3. `readToken` (`:72-108`): its three stores can now disagree in more ways than one
   boolean can express, so replace the `sawExpired` flag with a collected array of the
   non-`ok` states each store returned, resolved by a new **exported pure** function
   `pickTokenState(seen: TokenState[]): TokenState`. Priority, highest first:
   `ok` > `expired` > `signed-out` > `missing`. `expired` outranks `signed-out` on
   purpose — an expired token in *any* store is renewable without the user doing
   anything, and `autoRenew`'s own credential re-probe is what decides whether that
   worked; a blank blob in another store must not suppress a self-healing state. Empty
   array → `missing`. Keep `readToken`'s early return on the first `ok` so a keychain hit
   still skips the file read.
4. `refreshNow` (`:277-296`): replace the inline ternary with a new **exported pure**
   `statusForToken(state: TokenState['state']): UsageStatus` — `ok → 'ok'`,
   `expired → 'token-expired'`, `signed-out → 'signed-out'`,
   `missing → 'unavailable'`. Leave the `autoRenew` gate at the literal
   `t.state === 'expired'` and extend its comment: `signed-out` is now excluded by name
   for the same reason `missing` always was, and widening it would spend a turn on a
   credential that cannot be renewed.

**Contract — `shared/types.ts`**

5. `UsageStatus` (`:318`) gains `'signed-out'`, and the `usageStatus` doc comment
   (`:1118-1126`) gains its line: stored credential is present but blank (signed out) →
   header shows a hint naming `claude auth login`. `api.ts:167` passes the status through
   verbatim and needs no change.

**Client — `client/src/components/Header.tsx`**

6. The `usageStatus === 'token-expired'` ternary (`:23`) becomes a lookup — a
   `Partial<Record<UsageStatus, string>>` message map consulted before falling through to
   `UsageBars` — so a third status doesn't nest a second ternary. Messages:
   `token-expired → "token expired"` (unchanged text), `signed-out → "signed out — run
   claude auth login"`. Rename `UsageExpired` to a message component that takes the text.
   The command must be **visible text**, never a `title` attribute: this UI is used from a
   phone, where `title` never fires. Wrapping `claude auth login` in a `<code>` is
   optional polish; if you do, style it in `styles.css` with theme tokens only
   (`var(--mono)`, `var(--ink2)`) — no literal color, or the light theme breaks.

**Docs**

`docs/subsystems/usage-limits.md:44-47` states the three-member union and what the client
renders for each; it must list the fourth. (`docs/guides/tutor/usage/usage-1-pace.html`
also mentions `usageStatus` — guides are refreshed by `/tutor`, not by this fix.)

### The two open questions, answered

- **`missing` stays folded into `unavailable`, silent.** Unlike a blank credential, that
  bucket is mostly *not* user-fixable and not even distinguishable from inside the
  process: a Linux container without `CLAUDE_CREDENTIALS_JSON`, a non-macOS host with no
  `security` binary, and a keychain read the user denied all arrive as one `catch`. A
  "sign in" hint would be wrong for most of them, and telling them apart means parsing
  `security` exit codes. *What would change this:* if `missing` is ever observed on a
  plain macOS host that is genuinely just never-logged-in, split it then — the mechanism
  this fix adds is the one to extend.
- **Plain text, no action button.** The dashboard cannot log the user in: OAuth login is
  an interactive terminal + browser flow, so a spawned `claude auth login` would hang
  with nothing to answer it. This is exactly unlike `token-expired`, where a headless
  `claude -p` turn really can renew. Naming the command is the whole remedy.

### Test cases (`test/usage.test.ts`, alongside the existing `tokenFromCredsBlob` block)

- `{ claudeAiOauth: { accessToken: '', expiresAt: 0 } }` → `{ state: 'signed-out' }` —
  the exact blob observed after `claude auth logout`. Asserting it is *not* `expired`
  is the point: `0 <= NOW`.
- `{ claudeAiOauth: { accessToken: '', expiresAt: NOW + 60_000 } }` → `signed-out`.
- `{ claudeAiOauth: { accessToken: '   ' } }` → `signed-out` (whitespace-only).
- The existing `missing` case must stay green *and* gain the complement: `'not json'`,
  `'{}'`, `{ claudeAiOauth: {} }`, and `{ claudeAiOauth: { accessToken: 42 } }` all stay
  `{ state: 'missing' }`. A split that swallowed `missing` into `signed-out` would pass
  every new case above and fail here.
- The existing `ok` and `expired` cases must stay green unchanged (a non-blank token with
  a future `expiresAt`; a non-blank token with a past one).
- `pickTokenState`: `[missing, signed-out] → signed-out`; `[signed-out, missing] →
  signed-out`; `[signed-out, expired] → expired`; `[expired, signed-out] → expired`;
  `[signed-out, { ok, token }] → { ok, token }`; `[missing] → missing`; `[] → missing`.
- `statusForToken`: all four members, exhaustively — `ok → 'ok'`,
  `expired → 'token-expired'`, `signed-out → 'signed-out'`, `missing → 'unavailable'`.
  The `signed-out → 'signed-out'` assertion is what fails if someone later folds it back
  into `token-expired` and thereby re-arms `autoRenew` on it.

**Not covered by a test, on purpose:** that a `signed-out` cycle spawns no renewal.
`autoRenew` is imported directly by `usage.ts` rather than injected, so proving the
negative would mean refactoring `refreshNow` for a case the `statusForToken` assertion
above already pins from the other side. The named comment on the gate is the guard.

In the browser (playwright MCP tools): open `http://localhost:5174/`, then in
`browser_evaluate` wrap `window.fetch` so that responses for `/api/sessions` are returned
with `usageStatus` forced to `'signed-out'` and `usage` to `null` (the board re-polls
every 3s via `fetch` in `client/src/hooks/useSessions.ts`, so the next tick re-renders
from the patched payload — no source edit and no real logout needed). Within one poll the
header must show, under the summary line, the text `signed out` together with the literal
command `claude auth login`, and no usage bar element (`.usage .u-bar`) may be present.
Reload to drop the patch and confirm the bars come back.

Related, unconfirmed: `~/.claude/policy-limits.json` simultaneously read
`allow_remote_control: { allowed: false }`, contradicting a previously verified state.
May be another consequence of being signed out, may be unrelated. Still unchecked — this
grooming session was blocked from reading both `~/.claude/policy-limits.json` and the
credential file by the sandbox, so it stays a note, not a claim, and it is not part of
this fix.
