---
id: bug-5
title: Dead links in docs/guides from hardcoded relative hop counts
created: 2026-08-27
tags: docs, tooling
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
