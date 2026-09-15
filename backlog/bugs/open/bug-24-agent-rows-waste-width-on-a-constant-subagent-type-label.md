---
id: bug-24
title: Agent rows waste width on a constant subagent-type label, truncating the description
created: 2026-09-15
tags: sessions, session-detail, agents, layout
---

## Symptom

Every agent row in a session card prints `general-purpose` in magenta before the
description. Because the controller dispatches almost everything as
`subagent_type: "general-purpose"`, the label is identical on every row — it is a
constant column carrying no signal, while the field that *does* carry signal (the
agent's description, e.g. `Implement Task 2: shell inversion`) is the one that
ellipsizes.

Observed on a card with 10+ agents: the type label is repeated verbatim on every row
and the row content extends past the card's right edge.

## Why it happens

`client/src/components/SessionDetail.tsx:80`

    <span className="ag-type">{a.type || 'agent'}</span>

`client/src/styles.css:662-666`

    .agent{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink2);min-width:0}
    .ag-type{flex-shrink:0;...}
    .ag-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .ag-dur{margin-left:auto;flex-shrink:0;...}

`.ag-type` and `.ag-dur` are both `flex-shrink:0`, so `.ag-desc` is the only element
that yields. A 15-character constant plus a 9px gap is taken off the description's
budget on every row, permanently.

## Fix — hide it only when it is the default, do not delete it outright

The obvious change is to drop the span. Don't: `a.type` is the real `subagent_type`
(`shared/types.ts:537`, populated at `server/lib/agents.ts:155`) and **is** meaningful
when it is not the default — `Explore`, `Plan`, `claude-code-guide`, or any project
agent. Deleting the label would lose that.

Render `.ag-type` only when `a.type` is present **and** not `general-purpose`.
`general-purpose` is the documented catch-all, so its name tells the reader nothing the
absence of a label would not. This keeps the signal in the rare informative case and
returns the width in the common one.

Decide where the default name lives — a bare string literal in the component is the
cheapest form, but the same value is already special-cased conceptually in
`server/lib/agents.ts`; a shared constant may be tidier. Implementer's call.

Note the existing `{a.type || 'agent'}` fallback renders the word `agent` when the
record omits the field. Under the new rule that fallback becomes dead — decide whether
an unknown type should show nothing (consistent with hiding the default) or keep a
marker, and say which in the PR.

## Also check while in here

- **`analytics/atoms.tsx:133`** has the same `{g.type || 'agent'}` shape on
  `.an-line-name`. Same constant-label problem, likely the same fix; confirm whether the
  Analytics surface wants it too rather than assuming.
- **The overflow past the card edge** is claimed to be fixed by the label removal. Verify
  that, do not assume it: `.ag-desc` already has `min-width:0` and ellipsis, so
  truncation — not overflow — is what the CSS predicts. If content still escapes the
  card after the label is gone, something else is overflowing and the label was only
  masking how early it started. Measure with `scrollWidth > clientWidth` on `.agent`
  and on its container before and after.

## Done when

- A `general-purpose` agent row shows no type label; an `Explore` (or other non-default)
  row still does.
- The description gets the reclaimed width and truncates later.
- The overflow question above is answered with a measurement in the PR — either "fixed
  by this" with numbers, or a separate item filed for the real cause.
- `pnpm test` and `pnpm typecheck` green, with the command output in the PR.
