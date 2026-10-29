<!--
Title: Conventional Commits — feat(scope): / fix(scope): / docs: / chore:
Lowercase, imperative, no trailing period. Scope is the subsystem (spawn, api, dev, origin…).

House rules for the body:
  • Lead in user terms first — what someone using the dashboard can now do.
  • State what you did NOT verify. Every section below assumes an honest gap list.
  • Link the subsystem doc you touched; run /docs-sync if you changed one.
  • Delete every optional section that does not apply. A docs-only PR is three lines.
-->

<!-- LEAD (required, unlabelled): 1–3 sentences. What this does, in user terms.
     Then one line on where it sits in the system if that isn't obvious. -->

<!-- Optional, when the work has committed design artefacts: -->
Spec: `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md` · Plan: `docs/superpowers/plans/YYYY-MM-DD-<name>.md` · Subsystem doc: `docs/subsystems/<name>.md`

## What's new

<!-- Required on feat / fix / perf, and `ci / pr-title` fails while it is empty: these lines become the release notes in the What's new drawer.
     Nothing user-visible on a feat / fix / perf? Write `None` (or `None — <reason>`) on its own line; it is never shown. Other types may delete this section.
     The reader is the maintainer catching up a day or a week later: "what changed in my tool since I last looked?". A whole version should scan in
     about ten seconds.
       • One bullet per user-visible change, at feature level, recognisable without opening the PR.
       • The change first, in plain words.
       • No area prefix: the drawer already groups by the title's scope, so "Routines:" would repeat its own heading.
       • No file paths, flags, field names or function names.
     Good: - A run that times out now shows how long it ran before it was stopped.
     Bad:  - `--compare` prints JSON with median, values and missing per side. -->

## Why this shape

<!-- The constraint that forced this design, and the alternative you rejected.
     For a fix, retitle this "## The bug" and give the symptom, the mechanism,
     and how it was found. -->

## What changed

<!-- Group by boundary — the reader navigates by domain, not by diff order.
     Drop the groups you didn't touch. Or use a `| Piece | Role |` table for a
     new subsystem. -->

**Server**
-

**Client**
-

**Hook / scripts**
-

**Docs**
-

## Verification

<!-- Required. Commands with their actual result, then what a human did by hand,
     then the honest gap. Never claim green without the output. -->

`pnpm test` → `ALL PASS` (N cases, M new) · `pnpm typecheck` clean · `pnpm build` clean

New coverage:
-

Verified by hand (this repo has no HTTP harness and no component renderer, so endpoints and UI are checked live):
-

**Not verified, and it needs a human:**
-

<!-- ─── OPTIONAL BELOW — delete what doesn't apply ─────────────────────── -->

<!--
## Verified against CLI <version>, not assumed

For work that depends on external behaviour (the `claude` binary, hook contracts,
a library's guard). One row per fact, with how you proved it. Mark unproven ones
**Unproven:** and say how the system degrades if the assumption is wrong.

| Fact | How |
|---|---|
|  |  |
-->

<!--
## Security posture

Required whenever the change widens what a LAN/tailnet peer can do, adds a write
path, or spawns a process. State: what gates it, what the default is, and what an
unauthenticated peer on the network can cause.

- **Off by default.** <env var> empty disables the feature outright — the house
  "unset means off" rule.
- **The write gate (`refuseWrite`) covers the POST**, as it covers every other POST route: this machine, a trusted tailnet peer, or `ANSWER_TOKEN`.
- Bounded by:
-->

<!--
## ⚠️ Reaches beyond the feature, deliberately

For scope you knowingly took on outside the stated task — a pre-existing bug in
the same class, a helper applied at sites the feature never touches. Say why
leaving the rest was not a defensible boundary, and confirm valid-input behaviour
is unchanged.
-->

<!--
## Known limits

What this does not do, and how it degrades rather than wedges. Include the
deferred-by-design list.

-
-->

<!--
## Process

For subagent-driven runs: task count, review model, and the notable finds. Cite
the conventions in `.claude/CLAUDE.md` if the run earned a new one.
-->

<!--
## After merge

Prerequisites the reader must action themselves — a `~/.claude/settings.json`
edit, a `/docs-sync` re-baseline of touched neighbour docs, a rebuild.
-->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
