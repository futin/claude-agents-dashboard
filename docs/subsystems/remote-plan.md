---
docs-sync:
  sources:
    - server/lib/plans.ts
    - server/api.ts
    - server/index.ts
    - server/lib/scan.ts
    - scripts/plan-remote-hook.sh
    - scripts/remote-decision-hook.sh
    - client/src/components/PlanPanel.tsx
    - client/src/hooks/usePendingPlan.ts
    - client/src/components/SessionRow.tsx
  kind: subsystem
  verified: 9af535e56b1ce8ae4fc8b5a551fe106bf0244736
---

# Remote plan verdicts (the `plan?` tab)

When a session calls `ExitPlanMode`, the [chat drawer](chat.md) can render the proposed
plan and let you **send it back with feedback** from your phone. The model reads the
feedback, revises, and proposes again — all without you at the desk.

Mechanically this is [remote-answer](remote-answer.md) with a different payload: a hook
holds the tool call open, the browser resolves it, the hook denies with a reason. Read
that doc first; only the differences are below.

## ⚠️ You cannot approve a plan from here

Not a policy choice, not a missing feature — the CLI refuses it. `ExitPlanMode` declares
`requiresUserInteraction()`, and the hook-decision path drops a plain `allow` for any such
tool:

```js
if (g.behavior === "allow") {
  let y = g.updatedInput ?? f ?? t;
  if (!g.updatedInput && e.requiresUserInteraction?.()) return null;   // allow discarded
```

The engine states the rule outright in its control-protocol schema: `requires_user_interaction`
is "True when one-tap Approve/Deny must not be offered: the tool's approval card IS the
user-interaction surface". So approval stays on the card, and this subsystem is
**reject-only** by construction.

There is an `updatedInput` branch that skips the guard. Do not route an approval through
it — the guard is the point, and a smuggled approval would break the moment upstream
tightens it. If a native remote-approval path ever lands, that is the moment to revisit.

## Why `PermissionRequest`, not `PreToolUse`

`PermissionRequest` (matcher = tool name) fires **only when a permission decision is
actually needed**. `PreToolUse` fires on every call and cannot tell a prompting call from
an auto-approved one — so it would hold plans that were never going to prompt. Its output
shape differs too:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
                          "decision": { "behavior": "deny", "message": "…" } } }
```

Note `decision: {behavior}` — **not** `PreToolUse`'s flat `permissionDecision` string.
Getting this wrong fails silently: the hook's output is ignored and the card just appears.

## The pieces

| Piece | What it does |
|---|---|
| `scripts/plan-remote-hook.sh` | `PermissionRequest[ExitPlanMode]` hook. Same three gates as `ask-remote-hook.sh`, plus its own `tool_name` re-check (a matcher is config; never trust it alone). Its POST body also carries `permissionMode`, unused here and read only by the [push notifier](push-notify.md)'s auto-mode layer |
| `POST /api/plans/wait` | `servePlanWait` — held open until a verdict, deadline, or supersede |
| `GET /api/sessions/:id/plan` | `serveSessionPlan` — what the browser polls, at the configured refresh rate (`usePendingPlan` reads `refreshMs` from `useSettings`, exactly as `usePendingQuestion` does) |
| `POST /api/sessions/:id/plan-answer` | `serveSessionPlanAnswer` — `{verdict: 'reject', feedback}` or `'dismiss'`. Token-gated |
| `server/lib/plans.ts` | RAM-only store; same state machine as `pending.ts` with an injected `resolve` |
| `scan.ts` `ScanOptions.planIds` | sets `Session.remotePlan` and forces `status: 'question'` |
| `SessionRow` tab + `PlanPanel` | the row's chat tab labelled `plan?` and the pinned drawer panel |

## Why a separate store from `pending.ts`

Same state machine, different payload and different verdicts — a question resolves to
structured picks, a plan resolves to prose or nothing. Merging them would mean a
discriminated union threaded through every function of a module whose whole value is that
it is small and exhaustively tested. They stay parallel instead, and the one place they
join is the toggle: `POST /api/remote-answer` off calls **every** store's `dismissAll()` —
`dismissAll() + dismissAllPlans() + dismissAllMessages()`, once
[remote-message](remote-message.md) added a third — because a held plan is exactly as
remote as a held question.

## Invariants

- **Feedback is required for a reject.** A bare "no" gives the model nothing to revise
  against, and it is better said on the card. `answer()` returns `malformed` without it.
- **`accept` is not a verdict.** The store rejects it rather than silently mapping it to
  something else — see the guard above.
- **Supersede is the revise loop.** A rejected plan comes straight back as a new
  `ExitPlanMode` call; `register` supersedes the old entry and the panel resets on the new
  `planId`.
- **⚠️ Route order:** `/plan` and `/plan-answer` are `$`-anchored and must stay above the
  `:id` detail regex in `index.ts` — same trap as chat and question.
- **The plan text is also on disk**, unlike a permission dialog. So even with no hook
  installed, a trailing `ExitPlanMode` tool_use turns the row blue via
  `transcript.ts`'s `WAIT_TOOLS` — the hook only adds the panel and the lead time.

## The away-mode alternative: skip plan mode entirely

Reject-only is a ceiling on *plan cards*, not on remote-approving work. `AskUserQuestion`
**is** answerable from the phone — so a plan presented as a question ("proceed / revise…")
instead of an `ExitPlanMode` call is fully steerable remotely. The CLI's tool prompt tells
the model not to use `AskUserQuestion` for plan approval, which is right at the desk and
wrong when you're away.

`scripts/remote-decision-hook.sh` (a `UserPromptSubmit` hook) flips that default exactly
when it's wrong. On every user prompt it checks two conditions and otherwise stays silent:

1. `permission_mode` (on every hook's stdin) is auto-ish — default set
   `auto bypassPermissions dontAsk`, override with `CLAUDE_DASHBOARD_DECISION_MODES`;
2. `GET /api/health` reports `remoteAnswer: true` — the same field, and so the same
   env-switch-AND-toggle, that gates `ask-remote-hook.sh`.

When both hold it injects an instruction for that turn: put every decision through
`AskUserQuestion` (including skill-driven asks like the brainstorming skill's mode pick),
never end a turn on a prose question, don't enter plan mode — summarize the plan and ask
proceed/revise instead — and prefer already-allowed tools, since a permission dialog would
park the session.

Approving work this way in auto mode grants nothing new — the session already edits and
runs without asking; the POST only picks *which* pre-authorized path it takes. The
perimeter question is the same one `remote-answer.md` documents (tailnet fine, public
tunnel needs `ANSWER_TOKEN`). It is an **instruction, not a gate**: the model follows it
like any context, and the hard gates (the plan card, permission dialogs) sit exactly where
they did.

## Install

```bash
ln -s "$PWD/scripts/plan-remote-hook.sh" ~/.claude/hooks/plan-remote.sh
```

then add to `~/.claude/settings.json` under a `PermissionRequest` matcher `ExitPlanMode`:

```json
{ "type": "command", "command": "bash \"$HOME/.claude/hooks/plan-remote.sh\"", "timeout": 630 }
```

The `timeout` must exceed the wait window (Settings → **Answer window**, or
`CLAUDE_DASHBOARD_ANSWER_TIMEOUT`; default 600s) or the CLI kills the hook first — same rule,
same failure mode, and the same one setting as
[remote-answer-setup](../workflows/remote-answer-setup.md).
