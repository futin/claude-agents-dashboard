---
id: bug-5
title: Dead links in docs/guides from hardcoded relative hop counts
created: 2026-08-27
tags: docs, tooling
updated: 2026-09-01T16:09:33Z
started: 2026-09-01T16:01:48Z
execute-elapsed: 465
---

## Symptom

14 links across the learning guides and two spec docs resolve to paths that do not exist,
because each hardcodes a `../` hop count that no longer matches the doc's depth. Every one
resolves into `docs/…` instead of the repo root (e.g. `docs/server/lib/pending.ts`), or
doubles the prefix (`docs/docs/workflows`).

An audit sampled 36 flagged docs and reported 14 within its output cap — there are likely
more than these.

## Repro

Open any guide below and follow its cited link; the target 404s. Or re-run the census:

```bash
node ~/.claude/skills/audit/census.mjs . | python3 -c "import json,sys; [print(e['path'], e['deadLinks']) for e in json.load(sys.stdin)['docs']['docs'] if e['deadLinks']]"
```

## Affects

- docs/guides/learning/dictation/README.md:84
- docs/guides/learning/dictation/guide/recorder-lifecycle.md:210
- docs/guides/learning/dictation/guide/render-gate.md:47
- docs/guides/learning/dictation/guide/why-local-whisper.md:22
- docs/guides/learning/hooks/README.md:201, :215
- docs/guides/learning/hooks/guide/answer-channel.md:25, :82
- docs/guides/learning/hooks/guide/config.md:97
- docs/guides/learning/hooks/guide/fail-open.md:198
- docs/guides/learning/hooks/guide/held-socket.md:61
- docs/guides/learning/hooks/guide/lifecycle.md:139
- docs/guides/learning/hooks/guide/stop-loop.md:153
- docs/superpowers/specs/2026-08-16-dictation-design.md:25
- docs/superpowers/specs/2026-08-16-remote-message-design.md:108

## Cause

Fixed `../` counts written for one directory depth, kept when the guide moved. This is the
same class the project rule already warns about for guide tooling: a guide's `tools/*.mjs`
must find the repo root by walking up for `package.json`, never a fixed hop count. The rule
was applied to the tooling but the prose links carry the same defect.

## Fix

Repointing the 14 links one at a time invites identical drift on the next move. Prefer
root-relative links (or a link-check step that walks up for `package.json` to resolve them)
so depth changes cannot silently break citations again. Fix the 14 as part of that change,
and re-run the census afterwards to catch the ~22 flagged docs the audit did not report.

**Decision (orchestrator pre-flight, 2026-09-01):** take the guarded-relative option, not
the literal root-relative one — a leading-slash link renders as site-absolute on GitHub and
would break in a second way. So: repoint the dead links as correct *relative* paths, and add
a link-check test that resolves every markdown link in `docs/` by walking up for
`package.json`, so a future move fails the suite instead of rotting silently.

Scope is **every dead link the census reports**, not only the 14 enumerated above — run
`node ~/.claude/skills/audit/census.mjs .` and fix what it flags across `docs/`, then re-run
it as the evidence.

## Outcome

**2026-09-01 — fixed.** The census reported **61** dead links across 15 docs (not the 14 the
audit's output cap showed). 59 were the diagnosed defect: a relative link exactly one `../`
short of the repo root, written for a shallower depth and kept when the guide moved. Each was
repointed to the canonical shortest relative path (`path.posix.relative` from the doc's own
dir), so the two that had over-corrected back down into `docs/` — `docs/docs/subsystems/…`
and `docs/docs/workflows` — collapsed to plain `../…/subsystems/…` rather than gaining a
fourth hop. Per the pre-flight decision no link was made root-relative: a leading slash renders
site-absolute on GitHub.

The guard is `test/docs-links.test.ts`, wired into `test/run-all.ts`. It finds the repo root by
**walking up for `package.json`** — never a fixed hop count from its own location — then resolves
every relative markdown link under `docs/` against the real tree. It strips fenced blocks and
inline code spans first, which the audit's census does not.

The 2 links the census still reports are that difference, and both are false positives, not
residue:

- `docs/subsystems/chat.md:98` — `` `[api.ts](server/api.ts)` `` inside backticks, prose *about*
  how the chat renderer displays a link.
- `docs/superpowers/plans/2026-08-16-dictation.md:356` — `/^[([](?:blank_audio|silence|inaudible)[)\]]$/i`,
  a JS regex in a code fence that matches the markdown-link shape.

Editing either to satisfy the census would corrupt the sample it is quoting.

### Verification

Census before → after (same command as the Repro section):

```
$ node ~/.claude/skills/audit/census.mjs . | python3 -c "import json,sys; [print(e['path'], e['deadLinks']) for e in json.load(sys.stdin)['docs']['docs'] if e['deadLinks']]"
# before — 61 dead links across 15 files
docs/guides/learning/dictation/README.md ['docs/guides/subsystems/dictation.md', 'docs/guides/subsystems/dictation.md', 'docs/client/src/components/MicButton.tsx', 'docs/client/src/hooks/useDictation.ts', 'docs/client/src/lib/dictation.ts', 'docs/client/src/hooks/useTranscribeAvailable.ts', 'docs/server/lib/transcribe.ts', 'docs/server/api.ts', 'docs/guides/subsystems/dictation.md']
docs/guides/learning/dictation/guide/recorder-lifecycle.md ['docs/guides/subsystems/remote-message.md', 'docs/client/src/lib/dictation.ts', 'docs/guides/subsystems/dictation.md']
docs/guides/learning/dictation/guide/render-gate.md ['docs/guides/subsystems/remote-access.md']
docs/guides/learning/dictation/guide/why-local-whisper.md ['docs/.claude/CLAUDE.md']
docs/guides/learning/hooks/README.md ['docs/scripts', 'docs/scripts/remote-decision-hook.sh', 'docs/scripts/ask-remote-hook.sh', 'docs/scripts/plan-remote-hook.sh', 'docs/scripts/permission-notify-hook.sh', 'docs/scripts/stop-notify-hook.sh', 'docs/scripts', 'docs/scripts/ask-remote-hook.sh', 'docs/scripts/plan-remote-hook.sh', 'docs/scripts/stop-notify-hook.sh', 'docs/scripts/permission-notify-hook.sh', 'docs/scripts/remote-decision-hook.sh', 'docs/server/lib/pending.ts', 'docs/server/lib/plans.ts', 'docs/server/lib/messages.ts', 'docs/server/lib/permissions.ts', 'docs/server/lib/remoteState.ts', 'docs/server/lib/settings.ts', 'docs/server/lib/notify.ts', 'docs/server/api.ts', 'docs/docs/subsystems/remote-answer.md']
docs/guides/learning/hooks/guide/answer-channel.md ['docs/scripts/stop-notify-hook.sh']
docs/guides/learning/hooks/guide/config.md ['docs/server/lib/remoteState.ts', 'docs/server/lib/notify.ts', 'docs/server/lib/settings.ts', 'docs/server/lib/pending.ts', 'docs/server/lib/permissions.ts', 'docs/server/lib/messages.ts']
docs/guides/learning/hooks/guide/fail-open.md ['docs/scripts/ask-remote-hook.sh', 'docs/scripts', 'docs/docs/workflows']
docs/guides/learning/hooks/guide/held-socket.md ['docs/server/lib/pending.ts', 'docs/server/lib/plans.ts', 'docs/server/lib/messages.ts', 'docs/server/lib/pending.ts', 'docs/server/lib/plans.ts', 'docs/server/lib/messages.ts', 'docs/server/lib/permissions.ts']
docs/guides/learning/hooks/guide/lifecycle.md ['docs/server/lib/messages.ts']
docs/guides/learning/hooks/guide/stop-loop.md ['docs/server/lib/chat.ts', 'docs/server/lib/chat.ts']
docs/subsystems/chat.md ['docs/subsystems/server/api.ts']
docs/superpowers/plans/2026-08-16-dictation.md ['docs/superpowers/plans/?:blank_audio|silence|inaudible']
docs/superpowers/specs/2026-08-16-dictation-design.md ['docs/shared/types.ts', 'docs/server/api.ts', 'docs/server/api.ts']
docs/superpowers/specs/2026-08-16-remote-message-design.md ['docs/server/lib/notify.ts']

# after — only the two code-span false positives remain
docs/subsystems/chat.md ['docs/subsystems/server/api.ts']
docs/superpowers/plans/2026-08-16-dictation.md ['docs/superpowers/plans/?:blank_audio|silence|inaudible']
```

The new guard, red then green. Red (before the links were repointed), truncated to its tail —
it listed all 59:

```
+   'docs/guides/learning/hooks/README.md:215 -> ../../../docs/subsystems/remote-answer.md (resolves to docs/docs/subsystems/remote-answer.md)',
+   'docs/superpowers/specs/2026-08-16-remote-message-design.md:108 -> ../../server/lib/notify.ts (resolves to docs/server/lib/notify.ts)'
+ ]
- []

  3 passed, 1 failed
```

Green:

```
=== docs links ===

  ✓ repo root is found by walking up for package.json
  ✓ code fences and inline code are not scanned for links
  ✓ URL, mailto and anchor-only links are skipped
  ✓ every relative link under docs/ resolves to a real path

  4 passed, 0 failed
```

Mutation-proved — the guard fails when the defect is reintroduced. Reverting
`docs/guides/learning/hooks/guide/lifecycle.md:139` to a 3-hop link:

```
+ [
+   'docs/guides/learning/hooks/guide/lifecycle.md:139 -> ../../../server/lib/messages.ts (resolves to docs/guides/server/lib/messages.ts)'
+ ]
- []

  3 passed, 1 failed
```

Whole suite and typecheck:

```
$ pnpm test
...
=== docs links ===

  ✓ repo root is found by walking up for package.json
  ✓ code fences and inline code are not scanned for links
  ✓ URL, mailto and anchor-only links are skipped
  ✓ every relative link under docs/ resolves to a real path

  4 passed, 0 failed
ALL PASS
```

1013 assertions pass, 0 fail.

```
$ pnpm typecheck
> claude-agents-dashboard@0.1.0 typecheck
> tsc --noEmit
```

Exit 0, no output.

**Not verified:** no link was opened in a browser — resolution is proved against the filesystem,
not against GitHub's renderer. Anchor fragments (`#section`) are stripped and not checked; only
the path half of each link is verified. `pnpm test` needs `client/dist` present — on a fresh
worktree `api-usage-rates` fails its SPA-fallthrough case until `pnpm build` has run once, which
is pre-existing and unrelated to this fix.

### Files changed

- `test/docs-links.test.ts` (new), `test/run-all.ts` (registered)
- 13 docs repointed: `docs/guides/learning/dictation/{README.md,guide/{recorder-lifecycle,render-gate,why-local-whisper}.md}`,
  `docs/guides/learning/hooks/{README.md,guide/{answer-channel,config,fail-open,held-socket,lifecycle,stop-loop}.md}`,
  `docs/superpowers/specs/2026-08-16-{dictation-design,remote-message-design}.md`
