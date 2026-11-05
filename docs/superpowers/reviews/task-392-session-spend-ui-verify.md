# Task 392: session spend card, UI verify

**Verdict: PASS.** No defects. Two deviations, both justified below.

Served from the branch: API on 4273, Vite on 5273. `/api/sessions/:id/spend` was mocked with `page.route` for every state but `live`.

## Inventory

| View | Mock | How opened | Data | States |
|---|---|---|---|---|
| Chat drawer, `.chat-side`, card under Context | `session-spend-mock.html` option A (published at https://claude.ai/artifact/8HdKNgaxZ5h3mhzdirjrQd) | `/?session=<id>` | the shape in `shared/types.ts` `SessionSpend` | live; `≥` with split; exact with no split; longest figures (`≥ 1111.10M`, `main 123.45M · subagents 987.65M`) |

Viewports: 1440×1000, 667×900 (100 px under `useNarrow`'s 767.98), 375×812, in the default theme and the midnight tokens (the mock's own look).

## Geometry

The overflow probe printed no element inside the spend card at any width or state. What it did print:

- `.f.wide b` at 1440: the `Now` row's deliberate ellipsis, not new.
- `.cmsg-tool` at each width: the chat's tool lines, deliberately clipped, not new.
- No `page scrolls sideways` line.

Card at 1440: x 202, width 245, the same as Context, 18 px below it. Split line right edge 431, inside the 470 column. Longest figures keep the card at 101 px, so neither line wraps.
At 375, longest figures: split line right edge 350 of 375.

## Region by region, 1440 against option A

| Region | Result |
|---|---|
| Card placement: directly under Context, above the facts | match |
| Label `Tokens spent` | match |
| Total, 24 px bold, `≥ ` prefix, no track | match |
| Split line `main … · subagents …`, one quiet line | deviation: 11 px against the mock's 12 px, from the app's existing `.sessions .cap` rule; `styles.css` is unchanged |
| No split when there are no subagents | match; card falls from 101 px to 75 px |

## Phone, 375 against option A

Deviation: the mock draws a full card at 375, but below `md` the app folds every `.chat-side .kv`, Context included, into a compact strip (`styles.css:2107`). The spend figure follows that rule, so it
reads as one row under Context: label, total, split. Drawing it as a card would make it the one boxed item in the strip, so the existing rule wins.

## Not checked here

macOS pixel baselines: `pnpm test:visual` is macOS only. The new fixture changes the drawer shots, so they need `pnpm test:visual --update-snapshots` there.
