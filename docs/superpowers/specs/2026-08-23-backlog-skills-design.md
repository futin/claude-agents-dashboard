# Backlog skills — design

Four global Claude Code skills that turn "internal work" into files on disk with a
lifecycle: capture anything, groom it into something executable or reject it with a
reason, execute it, archive the outcome. The store is a `backlog/` directory in the repo
the work belongs to; the skills are global, so every repo gets the same grammar.

Status: **approved 2026-08-23** (via dashboard remote answer; every recommendation taken).

**The artifacts land outside this repo.** The four skill directories and the shared tool
go to `~/.claude/skills/`; this spec and its implementation plan live here because this is
where the design conversation happened and where `docs/superpowers/` already is. Nothing
in `server/`, `client/` or `shared/` changes. The only files this work adds or edits
inside this repo are this spec, its implementation plan, and one line in
`.claude/CLAUDE.md` saying which convention is which.

## Why files in the repo, not a tracker

The store is repo-local and committed. Items therefore travel with the branch, show up in
a PR diff, and survive a machine change — and the most valuable artifact in the whole
system, *why we decided not to do that*, sits next to the code it was rejected for. A
global cross-repo store was considered and cut: it divorces an item from the code that
explains it, and the only thing it buys is a view nobody asked for yet.

`backlog/` rather than `.internal-plans/`: visible to `ls`, one word, universally
understood, and `backlog/bugs/open/` needs no explanation.

## Existing machinery this leans on

| Fact | Where |
|---|---|
| Global skills are flat one-dir-one-`SKILL.md` under `~/.claude/skills/` | 6 already there: `docs-sync`, `kaizen`, `study`, `tutor`, `find-skills`, `learned` |
| A skill may ship a zero-dep `.mjs` tool with its own unit test | `~/.claude/skills/docs-sync/tools/provenance.mjs` + `provenance.test.mjs` |
| Planning, execution, debugging and verification workflows already exist | `superpowers:brainstorming`, `writing-plans`, `executing-plans`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `verification-before-completion` |
| A vendored second copy of a tool script drifts from its original | the `kaizen.mjs` lockstep requirement in `.claude/CLAUDE.md`, and `docs/bugs/analyze-double-counts-split-turns.md` where the same loop had to be fixed in three places |
| A tool that finds the repo root by a fixed `../..` hop count silently repoints when it moves | the "bitten twice" rule in `.claude/CLAUDE.md` |

That fourth row is why the tool exists exactly once, in the `backlog` skill dir, called by
the other three at an absolute path. Four copies of the same script is the failure mode
this repo has already paid for twice.

## Design

### Store layout

```
backlog/
  bugs/
    open/   bug-7-scroll-chaining.md
    done/   bug-3-idle-sweep-leak.md
  ideas/
    open/   idea-5-per-turn-tokens.md
    done/   idea-3-agent-cache.md
  tasks/
    open/   task-12-panel-minimise.md
    done/   task-9-guides-tab.md
  out-of-scope/
    oos-2-daemon-mode.md
```

**The directory is the truth for state.** Frontmatter carries identity and metadata only —
never a `status:` field, because two sources of state drift and this repo has the scars
(`docs/bugs/…` records status in a body line today, which is exactly the thing that goes
stale).

**A rejected item keeps its original id and filename.** `bug-7-scroll-chaining.md` moves
into `out-of-scope/` still called that, because `bug-7` may already be cited by a `from:`
line or a commit message, and renaming it would break the reference. An `oos-N` id is
minted only by a capture that goes *straight* to out-of-scope, having never been anything
else. So the directory holds both shapes, and that is correct: the prefix records what the
item was when it was filed.

`out-of-scope/` has no `open/`/`done/` split: rejection is terminal. Reopening something
means capturing it fresh, which is honest — the analysis that rejected it is now old.

`ideas/done/` needs a definition, since an idea never *completes*: **done means promoted**.
The file gets `promoted-to: task-12` and stays as the record of where the task came from.
Rejection is not done; it moves to `out-of-scope/`.

### Item file schema

```yaml
---
id: bug-7
title: Deck scroll chains out of the phone overlay
created: 2026-08-23
tags: guides, mobile
from: idea-3
promoted-to: task-12
---
```

`id` and `title` and `created` are required. `tags` is an optional comma-separated **scalar**, deliberately not a YAML array, so the
frontmatter reader stays a trivial `key: value` line splitter rather than a YAML subset. `from` is
present only on a task promoted from an idea. `promoted-to` is present only on an idea in
`done/`. Out-of-scope items additionally carry `rejected: 2026-08-23`.

Body headings, by section:

| Section | Headings |
|---|---|
| bug | `## Symptom`, `## Repro`, `## Affects` (file:line list), `## Cause`, `## Fix` |
| idea | `## Problem`, `## Rough shape`, `## Open questions` |
| task | `## Goal`, `## Plan`, `## Test cases`, `## Done when` |
| out-of-scope | `## What was proposed`, `## Why rejected`, `## What would change the answer` |

`## Cause` and `## Fix` on a fresh bug may say "unknown" — that is what makes it ungroomed.
An item moved to `done/` gets one appended section: `## Outcome`, holding the date, what
actually happened, and a commit SHA or PR link when there is one.

### The four skills

#### `backlog` — the board

Read-only. Runs `backlog.mjs board` and prints open items grouped by section: id, title,
age in days. `--section bugs` narrows it. Never writes.

Triggers: `/backlog`, "what's open", "show my backlog", "what's on the board".

This exists as its own skill because looking at the board is the most frequent action and
should not require entering a flow that might change something — and on a phone, a printed
board is how you pick the next item.

#### `backlog-capture` — anything in, one file out

Takes free text, or "capture what we just found" meaning the current conversation.
Classifies into exactly one section:

| Input shape | Section |
|---|---|
| something in shipped code behaves wrong | bug |
| future work whose shape is not settled | idea |
| future work whose plan is already known (e.g. just designed in this session) | task |
| something already analysed and decided against | out-of-scope |

Two rules keep the sections meaningful. A capture straight to `tasks/open/` must write a
real `## Plan` — if the plan is not known, it is an idea, not a task. A capture to
`out-of-scope/` must carry a rejection reason; without one the skill refuses and asks.
Anything genuinely ambiguous is asked, not guessed.

Capture only ever creates. It never moves or converts an existing item.

Triggers: `/backlog-capture`, "log a bug", "note this idea", "add to backlog",
"capture that".

#### `backlog-groom` — make it executable, or kill it

Three verdicts on an open item:

**Promote** (idea → task). Invokes `superpowers:brainstorming` to settle the open
questions, then `superpowers:writing-plans` to produce the plan. The plan is written into
a *new* task file with `from: idea-N`; the idea moves to `ideas/done/` with
`promoted-to: task-N`.

**Plan the fix** (bug). The plan is written into the **bug file itself**, filling `## Cause`
and `## Fix`. A bug stays a bug from capture through to done — no promotion, no second
file, no id churn, and one place to read the whole story of a defect.

**Reject** (any section). Moves the item to `out-of-scope/`, and requires both `## Why
rejected` and `## What would change the answer`. The second heading is not decoration: a
rejection without it is unreviewable a month later, and re-litigating a decision you
cannot reconstruct is the waste this whole store exists to prevent.

Triggers: `/backlog-groom`, "groom the backlog", "plan idea 3", "reject task 5",
"this is out of scope".

#### `backlog-execute` — do the work

**Refuses any item whose plan is missing and sends you to groom.** This refusal is the
entire reason `tasks/` differs from `ideas/`; without it the two directories are one
directory with two names. Concretely: a task with an empty or absent `## Plan`, or a bug
whose `## Fix` still says unknown, is refused with the exact groom invocation to run.

Dispatch by section:

- **bug** → `superpowers:systematic-debugging` to confirm the cause against the running
  code, then `superpowers:test-driven-development` for the fix.
- **task** → `superpowers:executing-plans`, or `superpowers:subagent-driven-development`
  when the plan's steps are independent enough to parallelise.

Before anything moves, `superpowers:verification-before-completion` runs — the outcome
note records command output, not a claim. Then the file gains `## Outcome` and moves to
`done/`.

`backlog-execute` **does not commit and does not push.** Staging is left to the user,
because a targeted `git add` in this repo reliably sweeps in-flight work from a dirty
tree. It never touches `ideas/` or `out-of-scope/`.

Triggers: `/backlog-execute`, "execute task 12", "fix bug 7", "work the backlog".

### `backlog.mjs`

Lives at `~/.claude/skills/backlog/tools/backlog.mjs`. Zero dependencies, Node built-ins
only. The other three skills call it by that absolute path.

| Command | Behaviour |
|---|---|
| `init` | creates the seven directories and a short `backlog/README.md` explaining the grammar |
| `root` | prints the resolved backlog root |
| `board [--section S] [--json]` | lists open items: id, title, created, age |
| `new <section> <slug> [--from <id>]` | allocates the next id and prints the path to write |
| `move <id> done` | resolves the id, moves `open/` → `done/`, prints the new path |
| `move <id> out-of-scope` | same, into the terminal directory |
| `show <id>` | prints the item's path and parsed frontmatter |

`new` prints a path and **does not write the file**. Mechanics belong to the script;
the item's prose belongs to the skill. That split is also what keeps the script testable —
every command is a pure function of the filesystem.

`backlog-capture` runs `init` itself when the store is absent, because the first capture in
a repo should not fail on a missing directory. `board`, `groom` and `execute` do the
opposite: they exit non-zero naming `init`, since an empty store means there is nothing to
read, groom or execute and silently creating one would hide a wrong-directory mistake.

`groom` and `execute` rewrite the item's body **before** calling `move`, so a failed write
leaves the item where it was. A moved file with a half-written outcome is the one state
that cannot be recovered by re-running the skill.

Root resolution walks up from `cwd` looking for `.git`, and **exits non-zero with a clear
message when it finds none** rather than falling back to `cwd`. A fixed hop count or a
silent fallback is the failure this repo has already hit twice, both times silently.

Id allocation is `max + 1` across `open/` *and* `done/` for that section, so ids are
monotonic and never reused. Gaps stay gaps — an id is a permanent handle, and reusing one
would make an old `from:` or `promoted-to:` reference point at the wrong item.

`--json` on `board` is the one speculative flag kept, because a Guides-style dashboard tab
over the backlog is plausible and the flag costs a branch.

### Superpowers wiring

Superpowers is not modified. All routing lives in the four skills:

| Moment | Skill invoked |
|---|---|
| groom an idea | `brainstorming` → `writing-plans` |
| groom a bug | `brainstorming` (only when the fix needs design) |
| execute a bug | `systematic-debugging` → `test-driven-development` |
| execute a task | `executing-plans`, or `subagent-driven-development` |
| before any move to `done/` | `verification-before-completion` |

## Non-goals

Cut deliberately, all recoverable later:

- **Cross-repo global index.** Repo-local only. No `~/.claude` aggregate.
- **Priorities, assignees, due dates, estimates.** A single-user backlog does not need a
  scheduler.
- **Dependency graphs and sub-items.** `from:` and `promoted-to:` are the only links.
- **A dashboard tab and push notifications.** `--json` leaves the door open; nothing more.
- **Migrating this repo's `docs/bugs`, `docs/ideas`, `docs/plans`.** They stay as they are.
  `.claude/CLAUDE.md` gains one line saying which convention is which.
- **Reopening a rejected item.** Capture it fresh instead.
- **A plugin.** Four skill dirs under `~/.claude/skills/` need no marketplace, and the
  shared tool at an absolute path removes the only real cost of splitting.

## Testing

`~/.claude/skills/backlog/tools/backlog.test.mjs`, same shape as
`docs-sync/tools/provenance.test.mjs` — plain `node:assert` over tmpdir fixtures, run
directly with `node`.

| Case | Expected |
|---|---|
| next id, section with `bug-1` in `open/` and `bug-3` in `done/` | `bug-4` — max across both dirs, gap preserved |
| next id, empty section | `1` |
| `move` on an id living in `open/` | moved to `done/`, new path printed |
| `move` on an id already in `done/` | non-zero exit, message naming the current state |
| `move` on an unknown id | non-zero exit, message naming the id |
| `move <oos-id> done` | refused — out-of-scope is terminal |
| root walk from a nested subdirectory | finds the `.git` ancestor |
| root walk with no `.git` anywhere above | non-zero exit, explicit message, **no cwd fallback** |
| slug `"Deck Scroll Chains!"` | `deck-scroll-chains` — lowercased, spaces to dashes, other characters dropped |
| `new` twice with the same slug | two distinct ids, two distinct paths, neither file written |
| `board --json` | parses as JSON, one object per open item, `done/` and `out-of-scope/` absent |
| `board` on a repo with no `backlog/` | non-zero exit suggesting `init` |
| `move bug-7 out-of-scope` | lands at `out-of-scope/bug-7-scroll-chaining.md` — id and filename unchanged |
| `new out-of-scope <slug>` on a store whose highest is `oos-2` | `oos-3`, unaffected by any `bug-`/`idea-`/`task-` ids sitting in the same directory |
| frontmatter `tags: guides, mobile` | parses to two trimmed tags without a YAML library |

Each guard test must be mutation-proven: delete the guard, confirm the test goes red. A
guard test that stays green with the guard removed proves nothing.

The skills themselves are verified by walking one item end to end in a scratch repo:
capture an idea, groom it to a task, execute it, confirm it lands in `tasks/done/` with an
`## Outcome`; then capture a second idea and reject it, confirming it lands in
`out-of-scope/` with both required headings.

## Open decisions (flagged at approval)

None. All four rounds of choices were settled before this spec: repo-local store,
`backlog/` as the name, committed to git, four verb-shaped skills plus one shared tool,
full-execute semantics without an automatic commit, installed directly to
`~/.claude/skills/`, and no migration of this repo's existing `docs/` convention.
