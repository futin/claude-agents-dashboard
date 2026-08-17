# The answer channel: `deny` + reason

The keystone. Everything else in this subsystem is scaffolding around one idea.

> Mental model: **there is no Claude Code API for "here is the answer to that tool call."**
> A `PreToolUse` hook can allow, deny, or stay silent — nothing more. So the project sends
> the answer through the only channel that exists: a denial whose *reason* states the choice.

## 1. The trick

```bash
# scripts/ask-remote-hook.sh:108-114
jq -cn --arg r "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
```

The reason is written to be read as an answer, not as a refusal:

```ts
// server/lib/pending.ts:150-151
return `The user answered via the dashboard (not the terminal dialog) — ${lines[0]}. `
  + 'Treat this as the user\'s selection and continue; do not ask again.';
```

**What it does:** the tool call fails, and the failure message tells the model what you
picked. The model reads denial reasons and adapts — that behaviour already existed — so a
denial whose reason names your choice is functionally an answer.

**Why this way:** it rides a documented, supported hook output. No part of it depends on
undocumented internals.

**The bad alternative**, and the one most people reach for first, is to get the answer in
from the outside: write to the session's stdin, or patch the transcript JSONL on disk.

| | `deny` + reason (chosen) | write stdin / patch transcript |
|---|---|---|
| Supported surface | Yes — documented hook output | No; breaks on any CLI update |
| Model actually sees it | Guaranteed, it is a tool result | Racy — the CLI owns the file and its read offsets |
| Cost | One wasted tool call per answer, plus prose that must suppress a re-ask | None, when it works |
| Failure mode | Model re-asks (annoying, recoverable) | Corrupted transcript / desynced session |

The cost is visible in the code rather than hidden: `composeReason` **has** to end with *"do
not ask again"*, because a denied `AskUserQuestion` is otherwise an open invitation to retry.
That sentence is load-bearing. Deleting it would produce a loop where every remote answer
triggers the same question again.

## 2. Three events, three JSON shapes

Nothing unifies the output formats. Each event wants its own:

```bash
# scripts/ask-remote-hook.sh:110-113  (PreToolUse — flat string)
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
```

```bash
# scripts/plan-remote-hook.sh:117-119  (PermissionRequest — nested object)
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: $r }
  }
```

```bash
# scripts/stop-notify-hook.sh:111  (Stop — top level, no hookSpecificOutput at all)
jq -cn --arg r "$REASON" '{decision: "block", reason: $r}'
```

`PreToolUse` takes a flat `permissionDecision` string plus a sibling reason field.
`PermissionRequest` takes a nested `decision` object with `behavior` and `message`. `Stop`
takes neither wrapper — `decision` and `reason` at the top level.

**Why the scripts hard-code these rather than sharing a helper:** they were each verified
against a specific CLI build, and the comments say so —
[`stop-notify-hook.sh:11-12`](../../../../scripts/stop-notify-hook.sh) records *"the ONLY output
shape the CLI accepts for a Stop block (verified against 2.1.233)"*. A shared emitter would
hide which shape was confirmed where, and the shapes have no common structure to factor out
anyway. Three call sites, three literals, three provenance notes.

## 3. The reason is always composed server-side

Every one of the three scripts pulls `.reason` out of the HTTP response and prints it
verbatim. None of them writes prose. From `ask-remote-hook.sh`:

```bash
# scripts/ask-remote-hook.sh:105-107
# 4. Inject. This block is the only mechanism-specific part of the feature —
#    swap it if a native "answer the tool call" path ever lands. The reason is
#    composed server-side (pending.ts composeReason), never here.
```

**Why prose lives in TypeScript and not in the shell:** it is testable there. `composeReason`
is a pure function over questions and answers, and it has real logic — a single question gets
one sentence, several get a bulleted list:

```ts
// server/lib/pending.ts:143-156
export function composeReason(questions: PendingQuestionItem[], answers: QuestionAnswer[]): string {
  const byIndex = new Map(answers.map(a => [a.index, a.selected]));
  const lines = questions.map((q, i) => {
    const label = q.header || q.question;
    return `${label}: ${(byIndex.get(i) ?? []).join(', ')}`;
  });
  if (lines.length === 1) {
    return `The user answered via the dashboard (not the terminal dialog) — ${lines[0]}. `
      + 'Treat this as the user\'s selection and continue; do not ask again.';
  }
  return 'The user answered via the dashboard (not the terminal dialog). Their selections:\n'
    + lines.map(l => `- ${l}`).join('\n')
    + '\nTreat these as the user\'s answers and continue; do not ask again.';
}
```

**The bad alternative** is composing it in the hook with `jq` string interpolation. Compare:

| | compose in TypeScript (chosen) | compose in the shell |
|---|---|---|
| Unit-tested | Yes, plain function calls | Needs a shell harness, or goes untested |
| Multi-question formatting | A branch, readable | Nested `jq` interpolation |
| Swap the injection mechanism | One `jq` block per script changes | Prose is entangled with the emitter |
| Trade | The hook must trust the server's prose | Prose lives next to where it is used |

The script keeps exactly one job: translate an HTTP result into the event's JSON shape. The
comment marks that block as the single mechanism-specific part of the whole feature — the
thing to replace if a native path ever lands.

## 4. Why plans can only be *rejected*

Not a design choice. A wall:

```bash
# scripts/plan-remote-hook.sh:11-14
# ⚠️ REJECT ONLY, and not by choice: the CLI discards a hook `allow` for any tool
# whose requiresUserInteraction() is true ("the tool's approval card IS the
# user-interaction surface"), and ExitPlanMode is one. So a plan can be sent back
# from your phone but never approved from it.
```

The comment continues: *"Do not try to route around that by returning `updatedInput` — the
guard is deliberate."* Someone tried, found the workaround, and documented why not to take
it. That note is worth more than the code around it.

And this single constraint is **why a fifth hook exists at all.** If plans cannot be approved
remotely, the fix is not to keep trying — it is to stop the model from proposing plans that
way:

```bash
# scripts/remote-decision-hook.sh:69-72  (heredoc body — no comment prefixes here)
2. Do not enter plan mode and do not call ExitPlanMode — its approval card can
   only be answered at the terminal. Present a plan as a concise summary (or a
   file) and then ask via AskUserQuestion: proceed, or revise (with an option to
   say what).
```

`remote-decision-hook.sh` exists to route around a limitation in `plan-remote-hook.sh`. A
plan presented *through* `AskUserQuestion` is answerable from anywhere, because
`AskUserQuestion` is the one surface that accepts a hook decision.

**Why keep the reject path at all**, given it is half a feature? Because rejection is the
half that carries information. Approving a plan is one bit; sending it back needs a
paragraph of feedback, and that paragraph is exactly what the phone is good for. The
trade-off they accepted: an asymmetric feature that does the expensive direction well.

## 5. `AskUserQuestion` is the pivot, and it is a deliberate choice

Trace the dependency: the phone can only answer `AskUserQuestion` → so plans get re-routed
into `AskUserQuestion` → so the `UserPromptSubmit` hook tells the model to put *everything*
through `AskUserQuestion` → so `pending.ts` gets `sanitizeQuestions` and `validateAnswer`
while the other two stores need neither.

One tool's hook-decidability propagates through all five scripts. This is the highest-leverage
thing to understand about the subsystem: it is not five independent features, it is one
capability plus four adaptations to its edges.

---

**Next:** [The held socket](./held-socket.md) — the server half that makes the wait possible.

[↑ back to contents](../README.md)
