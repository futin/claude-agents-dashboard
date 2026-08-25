---
id: idea-3
title: Multi-agent collaboration dashboard (FE+BE agents on Jira issues)
created: 2026-08-25
---

## Problem

Humans are the middle-men between specialised coding agents. When an FE dev and a BE dev
each drive their own agent (Claude, Grok, Gemini, …), every cross-cutting Jira issue
forces the humans to relay context between agents by hand: the BE agent designs an API,
the human pastes it to the FE agent, and so on. Wanted instead: a place where multiple
Jira issues (FE and BE) are posted, agents communicate directly with each other, propose
solutions, negotiate contracts, and execute tasks in collaboration — while humans review
the work and provide instructions instead of relaying.

## Rough shape

Feasibility verdict from the 2026-08-25 brainstorm: buildable, and this dashboard already
holds several of the pieces.

Already exists:
- Agent runner: dashboard spawns + resumes headless `claude -p` sessions
  (docs/subsystems/spawn.md).
- Human steering layer: remote-answer / remote-plan / remote-message write paths — the
  "humans review, don't middle-man" surface is largely built.
- Jira in/out: Atlassian MCP (issue read, comment, transition) already connected.
- Claude↔Claude messaging exists natively in Claude Code (SendMessage between sessions,
  agent teams) — a Claude-only v1 is near-term.

Decomposition (each would get its own spec):
1. **Task board** — Jira issues in (Atlassian MCP), assignment to agent roles, status
   back to Jira.
2. **Collaboration hub** — the core new piece: a vendor-neutral per-issue shared thread
   (proposals, contract agreements, task claims, statuses) exposed as an MCP server, since
   MCP is the one protocol claude/gemini-cli/opencode all speak. Structured
   proposal → agreement → execution flow, not free chat, plus loop/budget guards so
   agents don't ping-pong forever.
3. **Agent runners** — Claude first (exists), Gemini/Grok adapters later.
4. **Review surface** — dashboard UI over threads/diffs/approvals; human gates at plan,
   diff, and merge stages.

Claude-only v1 is roughly 20% of the work of a multi-vendor v1; designing the hub
protocol vendor-neutral from day one keeps the Grok/Gemini door open.

## Open questions

- Extend this repo or build as a separate project? (Hub may outgrow the dashboard's
  read-mostly charter and zero-dep backend rule.)
- Where exactly do the human review gates sit — plan approval, PR review, merge, all
  three?
- Contract negotiation format between FE/BE agents: freeform thread vs typed artifacts
  (e.g. OpenAPI spec as the agreed contract).
- Budget/loop guards: per-issue token caps? turn limits? human ping on stall?
- Multi-vendor auth + process management: who launches/owns gemini-cli / grok processes,
  and on which machine?
