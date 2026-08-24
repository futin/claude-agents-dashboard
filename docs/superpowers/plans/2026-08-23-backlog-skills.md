# Backlog skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four global Claude Code skills — a read-only board, capture, groom, execute — over a repo-local `backlog/` store of bugs, ideas, tasks and rejected work.

**Architecture:** One zero-dep Node module, `~/.claude/skills/backlog/tools/backlog.mjs`, owns every mechanical operation (root resolution, id allocation, frontmatter, listing, moving) as pure exported functions plus a thin `main(argv)` CLI tail. The four `SKILL.md` files own only prose and judgement, and call that module at its absolute path — exactly one copy exists. Item state is the directory the file sits in; nothing else records it.

**Tech Stack:** Node built-ins only (`node:fs`, `node:path`, `node:url`, `node:test`, `node:assert/strict`). ESM `.mjs`. No YAML library, no package.json, no install step.

**Spec:** `docs/superpowers/specs/2026-08-23-backlog-skills-design.md` (commit `01538db` on `main`)

## Deviation from the writing-plans template

`.claude/CLAUDE.md` in this repo forbids plans that hand over literal implementation code:
a plan's code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch
with nobody positioned to catch it, and test scaffolding is the worst offender because it
reads as boilerplate. So every task below gives **exact signatures, exact CLI contracts,
exact inputs and exact expected values** — and the implementer writes the code and is
expected to disagree with anything here that is wrong.

Where a code block appears, it is a *contract* (a signature, a stdout sample, a shell
command), never an implementation body.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- Zero dependencies. Node built-ins only. No `package.json` anywhere under `~/.claude/skills/backlog*/`.
- `~/.claude/skills/backlog/tools/backlog.mjs` is the **only** copy of the tool. `backlog-capture`, `backlog-groom` and `backlog-execute` call it at that absolute path. A second copy is the `kaizen.mjs` drift this repo has already paid for twice.
- **The directory is the truth for state.** Frontmatter never carries a `status:` field.
- `tags` is a comma-separated **scalar**, not a YAML array, so the reader stays a `key: value` line splitter.
- Ids are per-section, `max + 1` across `open/` **and** `done/`, never reused. Gaps stay gaps.
- **A rejected item keeps its original id and filename.** `oos-N` is minted only by a capture that goes straight to out-of-scope.
- `out-of-scope/` has no `open/`/`done/` and is terminal.
- `new` prints what to write and **never writes a file**.
- Root resolution walks up for `.git` and exits non-zero when there is none. **Never falls back to `cwd`** — a silent fallback is the failure this repo hit twice.
- `backlog-capture` runs `init` itself. `board`, `groom` and `execute` exit non-zero naming `init`.
- `groom` and `execute` rewrite the item body **before** calling `move`.
- No skill commits or pushes. Staging is the user's.
- **Every guard test must be mutation-proven:** delete the guard, watch the test go red, restore it. A guard test that stays green with the guard removed proves nothing.
- File style matches `~/.claude/skills/docs-sync/tools/provenance.mjs`: `#!/usr/bin/env node` shebang, inline `export const` / `export function`, a `main(argv)` returning an exit code, and this tail:
  ```
  if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)))
  }
  ```
- Tests use `node:test` + `node:assert/strict` over `os.tmpdir()` fixtures, run with `node --test`, matching `provenance.test.mjs`.

### Fixed vocabulary

| Section directory | Id prefix | Has open/done |
|---|---|---|
| `bugs` | `bug` | yes |
| `ideas` | `idea` | yes |
| `tasks` | `task` | yes |
| `out-of-scope` | `oos` | no — terminal |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | usage error, unknown id, or a refused operation |
| 2 | no `.git` ancestor above the start directory |
| 3 | no `backlog/` store — the message must name `init` |

### Module API

Every name below is fixed. Later tasks depend on these exact spellings.

```
export const SECTIONS          // { bugs: 'bug', ideas: 'idea', tasks: 'task', 'out-of-scope': 'oos' }
export class BacklogError extends Error   // carries .code (1 | 2 | 3)

export function resolveRoot(startDir)      -> { root, backlog }   throws BacklogError(2)
export function slugify(title)             -> string              throws BacklogError(1) when empty
export function init(backlogDir)           -> string[]            paths created, idempotent
export function nextId(backlogDir, section) -> number
export function parseFrontmatter(text)      -> { data, body }     throws BacklogError(1) on `status:`
export function renderFrontmatter(data)     -> string
export function readItem(backlogDir, id)    -> Item               throws BacklogError(1) when unknown
export function listOpen(backlogDir, section) -> Item[]           section optional
export function moveItem(backlogDir, id, dest) -> string          dest: 'done' | 'out-of-scope'
export function main(argv)                  -> number
```

`Item` is `{ id, section, state, path, title, created, tags, data, body }` where `state` is
`'open' | 'done' | 'terminal'`, `tags` is `string[]`, and `path` is absolute.

## File Structure

| File | Responsibility |
|---|---|
| Create `~/.claude/skills/backlog/tools/backlog.mjs` | every mechanical operation; pure functions + CLI tail |
| Create `~/.claude/skills/backlog/tools/backlog.test.mjs` | unit + CLI tests over tmpdir fixtures |
| Create `~/.claude/skills/backlog/SKILL.md` | the read-only board |
| Create `~/.claude/skills/backlog-capture/SKILL.md` | classify free text into one new item |
| Create `~/.claude/skills/backlog-groom/SKILL.md` | promote / plan-the-fix / reject |
| Create `~/.claude/skills/backlog-execute/SKILL.md` | refuse unplanned, dispatch, verify, archive |
| Modify `.claude/CLAUDE.md` (this repo) | one line: `docs/{bugs,ideas,plans}` is the old convention, `backlog/` is not used here |

Tasks 1–4 build the tool bottom-up, each with its own test cycle. Tasks 5–8 are one
`SKILL.md` each. Task 9 walks a real item end to end.

**Review seats:** Tasks 1–4 are logic-heavy — concurrency-free but full of path and
boundary judgement — and get a per-task review agent. Tasks 5–8 are prose authoring
against a settled contract; they get self-review plus the final whole-branch review, per
`.claude/CLAUDE.md`. Task 9 is verification and needs no separate reviewer.

---

### Task 1: Tool foundations — root resolution, slugify, init

**Files:**
- Create: `~/.claude/skills/backlog/tools/backlog.mjs`
- Test: `~/.claude/skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `SECTIONS`, `BacklogError`, `resolveRoot`, `slugify`, `init`, `main` (handling `init` and `root` only).

**Slug rules.** Lowercase; Unicode-normalise to NFD and strip diacritics so `Émigré café`
becomes `emigre-cafe`; replace any run of characters outside `[a-z0-9]` with a single `-`;
trim leading and trailing `-`. A title that yields an empty slug is a `BacklogError` with
code 1 and a message naming the offending title.

**`init` creates exactly seven leaf directories** — `bugs/open`, `bugs/done`,
`ideas/open`, `ideas/done`, `tasks/open`, `tasks/done`, `out-of-scope` — plus
`backlog/README.md` describing the grammar in a short paragraph and a table. Running it
twice creates nothing new and must **not** truncate an existing README.

- [ ] **Step 1: Write the failing tests**

Eleven cases. Exact inputs, exact expected values:

| Case | Expected |
|---|---|
| `resolveRoot('<tmp>/repo/a/b')` with `<tmp>/repo/.git` present | `{ root: '<tmp>/repo', backlog: '<tmp>/repo/backlog' }` |
| `resolveRoot` from a tmpdir with no `.git` at any ancestor | throws `BacklogError`, `.code === 2` |
| CLI `root` run in that no-`.git` dir | exit `2`; stderr mentions `.git`; stdout empty; **no directory created anywhere** |
| CLI `root` run in `<tmp>/repo/a/b` | exit `0`; stdout is exactly `<tmp>/repo/backlog` plus a newline |
| `slugify('Deck Scroll Chains!')` | `'deck-scroll-chains'` |
| `slugify('  Trailing  spaces  ')` | `'trailing-spaces'` |
| `slugify('Émigré café')` | `'emigre-cafe'` |
| `slugify('a --- b')` | `'a-b'` |
| `slugify('#$%')` | throws `BacklogError`, `.code === 1` |
| `init` on a fresh backlog dir | returns 8 paths; all seven leaf dirs exist; `README.md` non-empty |
| `init` run twice, README hand-edited between runs | second run returns `[]`; the hand-edited README is byte-for-byte unchanged |

Build one fixture helper that makes a tmpdir, `git init`s it, and returns
`{ dir, backlog }` — every later task reuses it, so give it a stable name and export
nothing from the test file.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: every case fails — the module does not exist yet, so the import itself throws.

- [ ] **Step 3: Implement `SECTIONS`, `BacklogError`, `resolveRoot`, `slugify`, `init`, and a `main` handling only `init` and `root`**

Unknown subcommands exit 1 with a usage line listing all seven commands. Do not stub the
other five yet — an unimplemented command must not silently exit 0.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 11 pass, 0 fail.

- [ ] **Step 5: Mutation-prove the two guards**

Delete the no-`.git` throw so `resolveRoot` falls back to `cwd`; confirm the code-2 case
and the "no directory created" case both go red. Restore. Then delete the empty-slug
throw; confirm the `'#$%'` case goes red. Restore. Re-run: 11 pass.

If a guard's test stays green while the guard is gone, the test asserts the wrong thing —
fix the test, not the guard.

- [ ] **Step 6: Commit**

The tool lives under `~/.claude`, which is **outside this repo** — this plan and the spec
are already committed here, and tasks 1–8 add nothing to this repo at all. So:

- If `~/.claude` is a git repo, commit there: `feat(backlog): tool foundations`.
- If it is not, there is nothing to commit for tasks 1–8. Do **not** invent a commit, and
  do not copy the tool into this repo to have something to stage — a second copy is the
  drift the Global Constraints forbid. Say so in the task report instead.

The same applies to the commit step of every task up to Task 8. Task 9 is the only one that
touches this repo.

---

### Task 2: Frontmatter and id allocation

**Files:**
- Modify: `~/.claude/skills/backlog/tools/backlog.mjs`
- Test: `~/.claude/skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: `SECTIONS`, `BacklogError`, `resolveRoot`, `slugify`, `init` from Task 1.
- Produces: `parseFrontmatter`, `renderFrontmatter`, `nextId`, and `main` handling `new`.

**Frontmatter grammar.** A leading `---` line, then `key: value` lines, then `---`. Values
are trimmed strings. `tags` alone splits on `,` into trimmed non-empty strings. Unknown
keys are preserved verbatim so a hand-added field survives a move. A `status:` key is a
`BacklogError` code 1 whose message says the directory is the state.

**`new <section> <title> [--from <id>]` stdout contract.** Line 1 is the absolute path to
write. The remaining lines are the frontmatter block to put at the top of that file:

```
/abs/path/backlog/tasks/open/task-1-panel-minimise.md
---
id: task-1
title: Panel minimise
created: 2026-08-23
from: idea-3
---
```

`from:` appears only when `--from` was passed. `tags` is never emitted by `new` — the
skill adds it. **`new` writes nothing to disk**; that is what keeps prose in the skill.

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| `nextId(backlog, 'bugs')` on an empty store | `1` |
| `bugs/open/bug-1-a.md` + `bugs/done/bug-3-b.md` present | `nextId(...,'bugs')` is `4` — max across both dirs, gap preserved |
| `out-of-scope/` holding `bug-7-x.md` and `oos-2-y.md` | `nextId(...,'out-of-scope')` is `3` — only `oos-` ids counted |
| `nextId(backlog, 'nope')` | throws `BacklogError`, `.code === 1` |
| CLI `new bugs 'Deck Scroll Chains!'` on an empty store | exit 0; line 1 ends `backlog/bugs/open/bug-1-deck-scroll-chains.md`; **that file does not exist afterwards** |
| the same command's remaining stdout | exactly `---`, `id: bug-1`, `title: Deck Scroll Chains!`, `created: <today ISO date>`, `---` — no `from:`, no `tags:` |
| CLI `new bugs 'Same Title'` run twice | ids `bug-1` then `bug-2`; two distinct paths; neither file written |
| CLI `new tasks 'Panel minimise' --from idea-3` | stdout carries `from: idea-3` |
| CLI `new` with no section | exit 1, usage line naming the four sections |
| `parseFrontmatter` on a doc with `tags: guides, mobile` | `data.tags` deep-equals `['guides','mobile']` |
| `parseFrontmatter` on a doc with no `tags` line | `data.tags` deep-equals `[]` |
| `parseFrontmatter` on a doc carrying `status: open` | throws `BacklogError`, `.code === 1` |
| `parseFrontmatter` on a doc with an unknown key `owner: me` | `data.owner === 'me'` |
| `renderFrontmatter(parseFrontmatter(doc).data)` | round-trips: re-parsing gives deep-equal `data` |
| `parseFrontmatter` on a doc with no `---` fence at all | throws `BacklogError`, `.code === 1` |

The `created` date comes from the system clock; pin it in the test by asserting it matches
`/^\d{4}-\d{2}-\d{2}$/` and equals today's date computed the same way in the test, rather
than hardcoding a date that will rot.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: Task 1's 11 still pass; the 15 new cases fail.

- [ ] **Step 3: Implement `parseFrontmatter`, `renderFrontmatter`, `nextId`, and `new` in `main`**

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 26 pass, 0 fail.

- [ ] **Step 5: Mutation-prove the three guards**

Delete the `status:` rejection → the `status: open` case must go red. Delete the
prefix filter in `nextId` so it counts every id in the directory → the `out-of-scope`
case must go red (it would return 8). Make `new` write the file it prints → the two
"file does not exist afterwards" assertions must go red. Restore each, re-run: 26 pass.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(backlog): frontmatter parsing and per-section id allocation"
```

In `~/.claude` if it is a repo; otherwise nothing to commit — see Task 1's note. Never
`--allow-empty`, and never copy the tool here to have something to stage.

---

### Task 3: Reading — `board` and `show`

**Files:**
- Modify: `~/.claude/skills/backlog/tools/backlog.mjs`
- Test: `~/.claude/skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `readItem`, `listOpen`, and `main` handling `board` and `show`.

**`board` stdout contract.** Sections in fixed order — bugs, ideas, tasks — each with a
header line and one indented line per open item, ids left-aligned and padded to a common
width. That width is computed across whatever is being printed, not per section, so a
short id in one section still lines up under a longer one elsewhere on the same board;
under `--section` the two are the same thing, since that slice is all there is to print:

```
bugs (1 open)
  bug-7   3d   Deck scroll chains out of the phone overlay
ideas (2 open)
  idea-3  12d  Per-turn token usage
  idea-5  1d   Backlog dashboard tab
tasks (0 open)
```

`out-of-scope/` never appears — it is not a queue. A section with no open items still
prints its header with `(0 open)`, so an empty board is legible rather than blank.
`--section bugs` prints that section alone. `--json` prints one array of
`{ id, section, title, created, ageDays, path }` and nothing else.

`ageDays` is whole days from `created` to today, floor, minimum 0.

**`show <id>` stdout contract.** Line 1 is the absolute path; the rest is the file's
frontmatter block verbatim. It resolves ids in `open/`, `done/` and `out-of-scope/` alike,
because "where is this item" is exactly the question you ask about a finished one.

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| store with 1 open bug, 1 done bug, 1 oos item; CLI `board` | stdout names the open bug; does **not** contain the done bug's id or the oos id |
| the same store, CLI `board` | contains the lines `bugs (1 open)` and `tasks (0 open)` |
| CLI `board --section bugs` | contains `bugs`; does not contain `ideas` or `tasks` |
| CLI `board --json` | `JSON.parse` succeeds; array length equals the open count; every object has all six keys |
| an item with `created` seven days ago; `board --json` | that object's `ageDays` is `7` |
| an item created today | `ageDays` is `0` |
| CLI `board` in a repo with **no** `backlog/` directory | exit `3`; stderr contains `init` |
| CLI `board` in a directory with no `.git` ancestor | exit `2` (root resolution runs first) |
| CLI `show bug-7` for an item in `open/` | line 1 is its absolute path; body includes `title:` |
| CLI `show bug-3` for an item in `done/` | resolves and prints — done items are findable |
| CLI `show oos-2` | resolves and prints |
| CLI `show bug-99` | exit `1`; stderr names `bug-99` |
| `listOpen(backlog)` with two sections populated | returns items sorted by section in the fixed order, then by numeric id ascending |
| `readItem(backlog, 'bug-7').state` | `'open'`; a done item gives `'done'`; an oos item gives `'terminal'` |

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 26 pass, 14 new fail.

- [ ] **Step 3: Implement `readItem`, `listOpen`, `board`, `show`**

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 40 pass, 0 fail.

- [ ] **Step 5: Mutation-prove the two guards**

Make `board` auto-`init` a missing store instead of exiting 3 → the exit-3 case must go
red. Make `listOpen` read `done/` as well → the "does not contain the done bug's id" case
must go red. Restore, re-run: 40 pass.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(backlog): board and show"
```

---

### Task 4: Writing — `move`

**Files:**
- Modify: `~/.claude/skills/backlog/tools/backlog.mjs`
- Test: `~/.claude/skills/backlog/tools/backlog.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `moveItem`, and `main` handling `move`. This completes the module — after this
  task all seven commands work.

**`move <id> done|out-of-scope`** renames the file into the destination directory and
prints the new absolute path. **The filename never changes** — a rejected `bug-7` stays
`bug-7-<slug>.md` inside `out-of-scope/`, because `bug-7` may already be cited by a
`from:` line or a commit message. File content is not touched: the skills write the body
first, then call `move`.

Three refusals, each exit 1 with a message that says why:
- an id already in `done/` moved to `done` again;
- an id in `out-of-scope/` moved anywhere — rejection is terminal;
- an unknown id.

- [ ] **Step 1: Write the failing tests**

| Case | Expected |
|---|---|
| `move bug-7 done` where `bug-7` is open | file now at `bugs/done/bug-7-<slug>.md`; stdout is that path; the old path is gone |
| the same move | file content byte-for-byte identical before and after |
| `move bug-7 out-of-scope` where `bug-7` is open | file at `out-of-scope/bug-7-<slug>.md` — **id and filename unchanged**, no `oos-` rename |
| `move idea-5 out-of-scope` | works — rejection is available from any section |
| `move task-2 done` then `move task-2 done` again | second call exits `1`; stderr says it is already done; file untouched |
| `move oos-2 done` | exit `1`; stderr says out-of-scope is terminal; file untouched |
| `move bug-99 done` | exit `1`; stderr names `bug-99` |
| `move bug-7 nowhere` | exit `1`; usage line naming the two valid destinations |
| `move bug-7 done` where `bugs/done/` was deleted from the store | directory recreated, move succeeds — a partially-scaffolded store is repaired, not fatal |
| after `move bug-7 out-of-scope`, `show bug-7` | resolves to the new path |
| after `move bug-7 out-of-scope`, `board` | `bug-7` absent |

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 40 pass, 11 new fail.

- [ ] **Step 3: Implement `moveItem` and the `move` command**

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 51 pass, 0 fail.

- [ ] **Step 5: Mutation-prove the three refusals and the rename guard**

Delete the already-done refusal → that case goes red. Delete the terminal refusal → the
`move oos-2 done` case goes red. Make `move` rename a rejected item to a fresh `oos-` id →
the "id and filename unchanged" case goes red. Delete the unknown-id check → the `bug-99`
case goes red. Restore each, re-run: 51 pass.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(backlog): move items between open, done and out-of-scope"
```

---

### Task 5: The `backlog` skill — the board

**Files:**
- Create: `~/.claude/skills/backlog/SKILL.md`

**Interfaces:**
- Consumes: the finished tool. This skill's whole job is one command:
  ```bash
  node ~/.claude/skills/backlog/tools/backlog.mjs board
  ```
- Produces: nothing other skills consume. It is read-only by design.

**Frontmatter**, matching the house style of `~/.claude/skills/docs-sync/SKILL.md` — a
`name`, a folded `description:  >` block, and a `trigger`:

```
name: backlog
trigger: /backlog
```

The description must name the triggers in prose so auto-invocation works: `/backlog`,
"what's open", "show my backlog", "what's on the board", "what am I working on next".

**Body contract:**
- State plainly that this skill never writes. No moves, no captures, no edits.
- Give the command, and the `--section` and `--json` variants.
- Say what exit 3 means and what to do: the store does not exist yet, so run
  `backlog-capture` (which creates it) rather than `init` by hand.
- Say what exit 2 means: you are not inside a git repository, so there is no backlog to
  read — `cd` to the project first.
- Print the board as returned. Do not re-summarise, re-sort, or editorialise it — the tool's
  ordering is the contract, and a reworded board is a board you cannot trust to be complete.
- Point at the next skills: groom an idea to make it executable, execute a planned item.

- [ ] **Step 1: Write the skill file**

- [ ] **Step 2: Verify the wiring by hand**

Build a scratch store and run the exact command the skill tells Claude to run:

```bash
cd $(mktemp -d) && git init -q . && node ~/.claude/skills/backlog/tools/backlog.mjs init && node ~/.claude/skills/backlog/tools/backlog.mjs board
```
Expected: `init` prints its created paths; `board` prints three headers, all `(0 open)`, exit 0.

- [ ] **Step 3: Verify the failure paths read well**

```bash
cd $(mktemp -d) && git init -q . && node ~/.claude/skills/backlog/tools/backlog.mjs board; echo "exit=$?"
```
Expected: `exit=3`, and a message that names `init` and reads as an instruction rather than a stack trace.

- [ ] **Step 4: Self-review against the contract above**

Every bullet present? No instruction to write anything? Both exit codes explained? Fix inline.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(backlog): the board skill"
```

---

### Task 6: The `backlog-capture` skill

**Files:**
- Create: `~/.claude/skills/backlog-capture/SKILL.md`

**Interfaces:**
- Consumes: `init`, `new` from the tool, at the absolute path
  `~/.claude/skills/backlog/tools/backlog.mjs`.
- Produces: item files that `backlog-groom` and `backlog-execute` read.

**Frontmatter:** `name: backlog-capture`, `trigger: /backlog-capture`. The description must
carry the phrases "log a bug", "note this idea", "add to the backlog", "capture that",
"remember this for later".

**Body contract — the classification table, stated as rules the skill must apply:**

| Input shape | Section |
|---|---|
| something in shipped code behaves wrong | `bugs` |
| future work whose shape is not settled | `ideas` |
| future work whose plan is already known — e.g. just designed in this session | `tasks` |
| something already analysed and decided against | `out-of-scope` |

**Two refusals the skill must make, and they are what keep the sections meaningful:**
- A capture to `tasks` must write a real `## Plan`. If the plan is not known, it is an
  **idea**, not a task. Downgrade it and say so.
- A capture to `out-of-scope` must carry a rejection reason. Without one, ask for it —
  do not file a rejection nobody can review later.

Anything genuinely ambiguous is **asked**, not guessed. Capture only ever creates: it never
moves, converts or reclassifies an existing item — that is groom's job.

**Procedure the body must spell out:**
1. Run `new <section> "<title>"` (add `--from <id>` only when promoting, which capture never does).
2. Write the file at the printed path: the printed frontmatter block, plus `tags:` if any, then the section's headings.
3. Print the id and path back so the user can cite it.

**Section headings, verbatim** — the same list as the spec:

| Section | Headings |
|---|---|
| bug | `## Symptom`, `## Repro`, `## Affects`, `## Cause`, `## Fix` |
| idea | `## Problem`, `## Rough shape`, `## Open questions` |
| task | `## Goal`, `## Plan`, `## Test cases`, `## Done when` |
| out-of-scope | `## What was proposed`, `## Why rejected`, `## What would change the answer` |

`## Affects` holds a `file:line` list. On a fresh bug, `## Cause` and `## Fix` may both say
`unknown` — that is precisely what makes the bug ungroomed, and `backlog-execute` will
refuse it until groom fills them.

**Store creation:** this skill runs `init` itself, unconditionally, before `new`. It is the
only one of the four that may create the store, because the first capture in a repo should
not fail on a missing directory. Unconditional rather than triggered by a failing `new`:
`new` never checks for the store — it needs only a resolvable root, so on a store-less repo
it prints a path and exits 0, having created nothing — and there is no exit code to react
to. `init` is idempotent (it returns only what it actually created, and never touches an
existing README), so running it every time costs one no-op call and removes a branch.

- [ ] **Step 1: Write the skill file**

- [ ] **Step 2: Verify the create-on-first-capture path**

```bash
cd $(mktemp -d) && git init -q . && node ~/.claude/skills/backlog/tools/backlog.mjs new ideas 'Backlog dashboard tab'; echo "exit=$?"
```
Expected: `exit=0`, a path printed under `backlog/ideas/open/`, and **no `backlog/` directory created** — confirming the skill genuinely needs its own `init` step (nothing else will scaffold the store) and that `new` does not scaffold silently.

- [ ] **Step 3: Verify the happy path end to end by hand**

In the same directory: run `init`, run `new ideas 'Backlog dashboard tab'`, write the file
at the printed path using the printed frontmatter plus the three idea headings, then run
`board`.
Expected: `ideas (1 open)` with `idea-1` and that title; the file's frontmatter has no `status:` field.

- [ ] **Step 4: Self-review**

Both refusals present and unambiguous? All four heading sets verbatim? The
"capture never moves anything" rule stated? The `init`-on-exit-3 step present? Fix inline.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(backlog): the capture skill"
```

---

### Task 7: The `backlog-groom` skill

**Files:**
- Create: `~/.claude/skills/backlog-groom/SKILL.md`

**Interfaces:**
- Consumes: `show`, `new`, `move` from the tool; `superpowers:brainstorming` and
  `superpowers:writing-plans`.
- Produces: task files with a real `## Plan`, which is the only thing
  `backlog-execute` will accept.

**Frontmatter:** `name: backlog-groom`, `trigger: /backlog-groom`. Description phrases:
"groom the backlog", "plan idea 3", "reject task 5", "this is out of scope",
"make this executable".

**Body contract — three verdicts, and the body must present them as a choice made with the
user, not inferred:**

**Promote** (idea → task). Invoke `superpowers:brainstorming` to settle the
`## Open questions`, then `superpowers:writing-plans` for the plan. Write the plan into a
**new** task file created with `new tasks "<title>" --from idea-N`. Then add
`promoted-to: task-N` to the idea's frontmatter and `move idea-N done`.

**Plan the fix** (bug). Fill `## Cause` and `## Fix` **in the bug file itself**. No new
file, no promotion, no id churn — a bug stays a bug from capture through to done, so the
whole story of a defect is in one place. Invoke `superpowers:brainstorming` only when the
fix needs design; a diagnosed one-line fix does not.

**Reject** (any section, any state except terminal). Rewrite the body under
`## What was proposed`, `## Why rejected`, `## What would change the answer`, add
`rejected: <today>` to the frontmatter, then `move <id> out-of-scope`. The third heading is
required: a rejection you cannot reconstruct in a month gets re-litigated, which is the
waste this store exists to prevent. The item keeps its id and filename.

**Ordering rule, stated explicitly in the body:** write the file, *then* call `move`. A
failed write leaves the item where it was; a moved file with a half-written body is the one
state re-running the skill cannot repair.

**Refusals:** an unknown id (report the tool's message); an item already in
`out-of-scope/` (terminal — capture a fresh item instead); a `done` idea (it was already
promoted — point at its `promoted-to:`).

- [ ] **Step 1: Write the skill file**

- [ ] **Step 2: Verify the promote path's tool calls by hand**

In a scratch store holding `idea-1`: run `new tasks 'Panel minimise' --from idea-1`, write
the task file with a real `## Plan`, add `promoted-to: task-1` to the idea, run
`move idea-1 done`, then `board`.
Expected: `ideas (0 open)`, `tasks (1 open)` with `task-1`; the idea sits in `ideas/done/` carrying `promoted-to: task-1`; the task carries `from: idea-1`.

- [ ] **Step 3: Verify the reject path keeps the id**

In the same store: rewrite `bug-1`'s body with the three rejection headings, add
`rejected:`, run `move bug-1 out-of-scope`, then `show bug-1`.
Expected: path is `out-of-scope/bug-1-<slug>.md` — id and filename unchanged; `board` no longer lists it.

- [ ] **Step 4: Verify the terminal refusal**

```bash
node ~/.claude/skills/backlog/tools/backlog.mjs move bug-1 out-of-scope; echo "exit=$?"
```
Expected: `exit=1` with the terminal message, confirming the skill's refusal is enforced by the tool and not only by prose.

- [ ] **Step 5: Self-review**

Three verdicts distinct and complete? Bug-stays-a-bug rule stated? Write-then-move ordering
stated? All three rejection headings required? `promoted-to:` and `from:` both specified?
Fix inline.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(backlog): the groom skill"
```

---

### Task 8: The `backlog-execute` skill

**Files:**
- Create: `~/.claude/skills/backlog-execute/SKILL.md`

**Interfaces:**
- Consumes: `show`, `move` from the tool; `superpowers:systematic-debugging`,
  `test-driven-development`, `executing-plans`, `subagent-driven-development`,
  `verification-before-completion`.
- Produces: items in `done/` carrying an `## Outcome`.

**Frontmatter:** `name: backlog-execute`, `trigger: /backlog-execute`. Description phrases:
"execute task 12", "fix bug 7", "work the backlog", "do the next thing".

**The refusal gate — the load-bearing rule of the whole system.** Refuse any item whose
plan is missing, and name the groom command to run. Concretely: a task whose `## Plan` is
absent or empty, or a bug whose `## Fix` still says `unknown`. Without this refusal,
`tasks/` and `ideas/` are one directory with two names. State that reasoning in the body so
a future editor does not "helpfully" soften it.

**Dispatch:**
- **bug** → `superpowers:systematic-debugging` to confirm the cause against the running
  code before changing anything, then `superpowers:test-driven-development` for the fix.
- **task** → `superpowers:executing-plans`, or `superpowers:subagent-driven-development`
  when the plan's steps are independent enough to parallelise.

**Archiving:** run `superpowers:verification-before-completion` first. Then append
`## Outcome` — the date, what actually happened, and **the command output that proves it**,
not a claim that it passed. Then `move <id> done`. Write before moving, as in Task 7.

**Hard limits, stated in the body:**
- **Does not commit and does not push.** Staging is the user's, because a targeted
  `git add` in a dirty tree sweeps in unrelated in-flight work.
- Never touches `ideas/` or `out-of-scope/`. An idea is not executable by definition; a
  rejected item is closed.
- If verification fails, **nothing moves**. The item stays open and the failure goes in the
  body under `## Outcome` as a record of the attempt.

- [ ] **Step 1: Write the skill file**

- [ ] **Step 2: Verify the refusal gate is checkable**

In a scratch store, create a task whose `## Plan` section is empty, then run
`show task-1`.
Expected: the printed frontmatter and path let the skill read the body and see the empty `## Plan` — confirming the gate needs no new tool command.

- [ ] **Step 3: Verify the archive path**

Fill that task's `## Plan`, append an `## Outcome`, run `move task-1 done`, then `board`.
Expected: `tasks (0 open)`; the file is in `tasks/done/` with both sections intact.

- [ ] **Step 4: Self-review**

Refusal gate stated *with its reasoning*? Both dispatch branches named with the exact
superpowers skill names? Verification-before-move ordering explicit? All three hard limits
present? "Nothing moves on failure" stated? Fix inline.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(backlog): the execute skill"
```

---

### Task 9: End-to-end walk and the CLAUDE.md note

**Files:**
- Modify: `.claude/CLAUDE.md` (this repo)
- No new files.

**Interfaces:**
- Consumes: all four skills and the finished tool.
- Produces: the proof that the four skills compose, and a note so the two conventions in
  this repo do not get confused.

This task is verification, not construction. Run it in a **scratch git repo**, not in this
one — the point is to confirm the skills work in a repo that has never seen them.

- [ ] **Step 1: Full test suite green**

```bash
node --test ~/.claude/skills/backlog/tools/backlog.test.mjs
```
Expected: 51 pass, 0 fail. Paste the real output into the PR — never claim green without it.

- [ ] **Step 2: Walk an item from idea to done**

In a fresh scratch repo: capture an idea, groom it into a task (a trivially small one — a
one-line change is enough), execute it, and confirm the result.
Expected: the task file sits in `tasks/done/` carrying `from: idea-1` and an `## Outcome` with real command output; the idea sits in `ideas/done/` carrying `promoted-to: task-1`; `board` shows both sections at `(0 open)`.

- [ ] **Step 3: Walk a rejection**

Capture a second idea, then reject it.
Expected: the file is in `out-of-scope/` under its **original** `idea-2-<slug>.md` name, carrying `rejected:` and all three rejection headings; `board` does not list it; `show idea-2` still resolves it.

- [ ] **Step 4: Prove the refusal gate**

Capture a third idea and try to execute it directly.
Expected: refused, with the groom command named. Then capture a task with an empty `## Plan` and try again — also refused. Both refusals are the reason `tasks/` differs from `ideas/`, so if either one passes, the system is broken and the task is not done.

- [ ] **Step 5: Add the note to `.claude/CLAUDE.md`**

One line in the "Where study guides and lesson decks go" neighbourhood, saying that
`docs/bugs/`, `docs/ideas/` and `docs/plans/` are this repo's own hand-maintained
convention, that the global `backlog-*` skills use a `backlog/` store instead, and that
this repo deliberately does not use one — so nobody migrates the old files by accident.

- [ ] **Step 6: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: note the backlog skills alongside this repo's docs/ convention"
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: store layout → Task 1 (`init`); item
schema → Task 2 (frontmatter) and Task 6 (headings); the four skills → Tasks 5–8; the tool's
seven commands → Tasks 1–4; superpowers wiring → Tasks 7–8; the testing table → Tasks 1–4
plus Task 9's end-to-end walk; the non-goals → nothing, correctly, except the "one line in
`.claude/CLAUDE.md`" which is Task 9 Step 5.

Three spec details are refined here rather than merely restated, and each is a deliberate
change the executor should not undo:
1. `new` prints **the path and the frontmatter block** — the spec said only "the path",
   which left `--from` with no way to reach the file, since `new` writes nothing.
2. `board` prints a `(0 open)` header for empty sections, so an empty board is legible.
3. `move` recreates a missing destination directory rather than failing, so a
   half-scaffolded store repairs itself.

**Placeholders.** None. Every step has either an exact command, an exact expected value
table, or a named contract. No "add error handling", no "similar to Task N", no "write tests
for the above".

**Type consistency.** `SECTIONS`, `BacklogError`, `resolveRoot`, `slugify`, `init`,
`nextId`, `parseFrontmatter`, `renderFrontmatter`, `readItem`, `listOpen`, `moveItem`,
`main` are spelled identically in the Module API block and in every task that consumes
them. `Item.state` is `'open' | 'done' | 'terminal'` throughout. Exit codes 1/2/3 mean the
same thing in every task. The four id prefixes are `bug`/`idea`/`task`/`oos` everywhere.
Test counts accumulate consistently: 11 → 26 → 40 → 51.
