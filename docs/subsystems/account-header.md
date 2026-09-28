# Account header

The shell carries one account chip above every section: who the CLI is signed in as, both
rate windows as micro-meters, and a popover with the full gauges. It replaced the
**Account card** in the sessions aside.

## Why it moved

The sessions aside is for what is true of *this board* — the clock, the counts, the
remote-answers switch, **New session**. The two rate windows are not: they are true of the
account wherever you are standing, and reading them meant being on Sessions. So they came
out of the aside and into the shell, where Usage, Management, Analytics and Settings can
see them too.

The card's contents did not change. The popover draws the same bars, time strips, pace
ticks and wall/lasts verdicts, from the same `paceView` — see
[usage limits](usage-limits.md). What is new is the identity above them.

## The two homes

One chip, rendered once, in whichever home the measure has. `App.tsx` picks with
`useShellNarrow()` (639.98 — the shell's `sm` tier, *not* `useNarrow`'s 767.98 density
tier); the loser is not rendered at all rather than hidden in CSS, because a
`display:none` button is still a tab stop and its popover is still reachable by script.

| Measure | Home | Shape |
|---|---|---|
| from `sm` (640) | the header band (`.topstrip`, `--main-gap` tall) | avatar · name · `5H`/`WK` meters · caret |
| below `sm` | the phone nav bar (`SideRail`'s `accountSlot`) | avatar · meters · caret — the name comes off, the bar already holds a wordmark and a 44px burger |

**The band is not new space.** It *is* the white gap that used to be `.main`'s
`margin-top` — `--main-gap`, raised from 24px to 50px and now drawn rather than left
empty. The two must stay one token: `.wrap.wide`'s pinned height subtracts it to work out
what is left of the viewport.

Two consequences of the extra wrapper (`.maincol`) are load-bearing:

- It is `display:contents` below `sm`, so the board stays the flex child of `.shell` it
  has always been there.
- The phone strip's ride-along selector had to become `.nav.hid~.maincol .s-strip.stuck`.
  Selectors read the DOM tree, not the box tree, so `~.main` stopped matching the moment
  the board gained a parent — `display:contents` does not put it back.

On a phone the popover hangs off the **bar**, not off the chip (`.mnav .acct-anchor`
goes `position:static`, so the sticky `.nav` is the containing block): anchored to a chip
sitting left of the burger, a 320px sheet ran past the left edge of a 375px screen.

## States

Four `UsageStatus` values, folded to what the reader can do about them.

| Status | Chip | Popover |
|---|---|---|
| `ok` | avatar, name, both meters | identity block, both gauges, **Usage detail** / **Settings** |
| `signed-out` | dashed ring, *Signed out*, amber pip | the sentence, then **`claude auth login`** as a visible command block |
| `token-expired` | dashed ring, *Token expired*, amber pip | says it renews itself on a later poll; no command to run |
| `unavailable` | nothing, unless a profile still names someone | — |

The remedy is **visible text, never a `title`**: this board is read on a phone, where
`title` never fires, and the dashboard cannot sign anyone in — OAuth login is an
interactive terminal + browser flow, so naming the command is the whole of what it can
offer. Same rule the aside card followed.

## Where the identity comes from

`~/.claude.json` → `oauthAccount`, the profile Claude Code caches after a login. Local
disk, no network: the usage endpoint answers with percentages and reset times and nothing
about the person. `server/lib/account.ts` reads it, memoised against the file's
**mtime + size**, so a poll re-parses only after a write — a login or a logout moves both.

Every field crosses the boundary as a **display string the server already resolved**
(`AccountProfile` in `shared/types.ts`), because the raw record is internal tier codes:

| Record field | Becomes | Rule |
|---|---|---|
| `fullName` ?? `displayName` | `name` | |
| `emailAddress` | `email` | |
| `organizationName` | `organization` | `''` on a personal account |
| `userRateLimitTier` | `plan` | a **table** — `default_claude_max_5x` → `Max 5×`. An unrecognised tier gets no label, because mechanically title-casing one would put internal codenames (`default_raven`) on screen |
| `seatTier` | `seat` | prettified — `team_tier_1` → `Team tier 1`. These are descriptive words already, so spacing them is a faithful reading |
| `hasExtraUsageEnabled` | `extraUsage` | `true` only for a literal `true` |

A record with neither a name nor an email is `null`, not a profile of blanks: `signed-out`
already draws that state and two drawings of it is one too many. A missing file, a torn
write, or JSON that is not an object all fail open to `null` the same way.

## The endpoint

`GET /api/account` → `AccountResponse` — deliberately *not* folded into
`SessionsResponse`:

- that snapshot is a full transcript scan, polled every **3s** and only while the Sessions
  section is mounted, and the chip is above every section;
- this body is two cached reads (the memoised profile, the same 60s usage cache
  `serveSessions` attaches), so it is cheap to poll slowly.

`useAccount` polls it every **30s**, owned by `App` so the chip's two homes cannot both
poll. A failed poll keeps the last good snapshot: the endpoint fails open, so a *thrown*
fetch means the server is gone, which is not a statement about the account —
`useSessions` already owns saying the link is down.

`usage` / `usageStatus` are gated on `SHOW_USAGE` and **absent** when it is off, exactly as
on `/api/sessions`. The profile is not gated: a name is not a usage number, and hiding it
would leave the chip nameless for a reason the reader could not guess.

## No detector-made links

Phone browsers linkify text that looks like data. The identity block is a bare first name,
a single-letter avatar and plan tags such as `Max 5x` — enough for iOS data detectors (or
an accessibility "button shapes" setting, a translate or password-manager overlay) to
underline them, which reads as clickable in a popover where nothing is a link. Two guards,
both deliberate:

- `client/index.html` — `<meta name="format-detection" content="telephone=no,date=no,
  address=no,email=no">`, which turns the detection off at the source.
- `client/src/styles.css` — `.acct,.acct *,.acct-pop,.acct-pop *{text-decoration:none}`,
  which strips the underline even when the decoration comes from somewhere the meta cannot
  reach.

## Tests

- `test/account.test.ts` — the mapping rules against the pure
  `shapeProfile`/`planLabel`/`seatLabel`, then the disk behaviour (missing, torn, no key,
  re-read after a write) against `readAccountProfile` over a tmpdir home.
- `test/api-account.test.ts` — the route over a real socket: body shape, the `SHOW_USAGE`
  gate, and that an absent or torn profile is a 200 with `profile: null` rather than a 404
  or a 500. `SHOW_USAGE` stays false except in the case about it, so no run depends on
  whether the developer's own token happens to be valid.
- `test/breakpoints.test.ts` — `useShellNarrow` mirrors the `sm` tier (639.98), which is
  what keeps the chip out of a phone bar that is already `display:none` in the 640–767
  band.

<!-- docs-sync:
  sources:
    - shared/types.ts
    - server/lib/account.ts
    - server/api.ts
    - server/index.ts
    - client/src/App.tsx
    - client/src/components/HeaderAccount.tsx
    - client/src/components/SideRail.tsx
    - client/src/hooks/useAccount.ts
    - client/src/hooks/useNarrow.ts
    - client/src/styles.css
  kind: subsystem
-->
