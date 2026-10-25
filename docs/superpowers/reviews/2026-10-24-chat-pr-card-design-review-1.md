# Review 1 — Chat PR card design spec

Document: `docs/superpowers/specs/2026-10-24-chat-pr-card-design.md` (spec) · `docs/superpowers/specs/2026-10-24-chat-pr-card-mockups.html` (mock)
Reviewer: Fable 5.1, fresh session, 2026-10-24. Every code claim below was read in the worktree; transcript counts were recomputed with a scan over
`~/.claude/projects/-Users-andrejajevtic-Documents-custom-projects-claude-agents-dashboard/*.jsonl` and every `*/subagents/*.jsonl` on the machine.

## Verdict: APPROVE WITH FIXES

No Critical. The architecture (transcript detection → `gh pr view` behind a per-URL cache → `/api/sessions/:id/pr` → sidecar card) matches the code it
cites, respects the zero-deps rule (`test/outbound.test.ts:42-58` scans only net-module imports and `fetch`; a `child_process` launch is invisible to it,
so "stays green unchanged" at spec:43 is true) and follows the `/plan` / `/question` envelope (`server/api.ts:1152-1158`, `1219-1225`). The Important
findings are copy that two sections state differently, a check-state mapping too thin to write the promised exact-value tests from, two launch edge
cases, one unstated endpoint timing decision, and one visual-suite fact the builder would otherwise discover by a red run.

## Verified true (no finding)

| Claim | Where | Evidence |
|---|---|---|
| Sidecar order Context → Stop → Tasks → facts; card goes after `TasksCard` | spec:17, 123, 169 | `client/src/components/ChatDrawer.tsx:246-271` |
| `TasksCard` renders nothing without tasks; one DOM + `.folded` for both widths | spec:116, 123-124 | `TasksCard.tsx:13-16, 37` |
| `md` = 768px; desktop tasks rules sit under `@media (min-width:768px)` | spec:22 | `client/src/styles.css:2137, 2160-2170` |
| `readSessionTasks` is incremental by byte offset, cached per file | spec:72 | `server/lib/tasks.ts:58, 73, 163-180, 208-235` |
| `git-fetch.ts`: detached spawn, group kill on timeout, `overrideFetchRunner` seam; `codegraph.ts` has `overrideCodegraphRunner` | spec:92-93 | `server/lib/git-fetch.ts:45-78, 98`; `server/lib/codegraph.ts:84` |
| `/plan`, `/question`: 400 `{id, pending:null, error:true}` on malformed id, 200 otherwise; `ID_RE` | spec:98-99 | `server/api.ts:93, 1152-1158, 1219-1225`; `shared/types.ts:1194-1198, 1248-1252` |
| Hook polls at the modal's `refreshMs`; `error` keeps the last snapshot | spec:97-100 | `client/src/hooks/usePendingPlan.ts:59-86`; `ChatDrawer.tsx:141` |
| Tokens `--green`, `--green-tint`, `--mustard`, `--red`, `--magenta` exist; no `--red-tint` / `--magenta-tint` | spec:45-46 | `styles.css:20-25, 52, 61, 129-137` |
| `gitOperation.pr` = `{number, url, action}` on the Bash tool-result record; `action` is `created` (89) or `edited` (4) | spec:58-60 | scan, sample record from PR #57 |
| `pr-link` record = `{type, sessionId, prNumber, prUrl, prRepository, timestamp}` | spec:65 | scan sample |
| Subagent transcripts live at `<id>/subagents/agent-*.jsonl` | spec:68 | `ls ~/.claude/projects/<proj>/<id>/subagents` |
| `gh pr view --json` accepts every named field | spec:80 | `gh pr view … --json zzz` field list |
| `request-guard.ts`, `test/api-harness.ts`, `test/tasks.test.ts`, `test/visual/fixtures/session-chat.ts`, `docs/subsystems/chat.md` sidecar text, `docs/overview.md` API table (`:83-87`) and `lib/` map (`:205, 237`), DESIGN §8.6 all exist | spec:118, 136-137, 142-150 | `ls`; `.claude/DESIGN.md:394` |
| `formatAgo` is the client's relative-time helper (`5s, 3m, 2h, 1d`) | spec:129 | `client/src/lib/format.ts:40-43` |

## Important

**[I] spec:19 vs spec:89 — Merge row copy for `mergeable: UNKNOWN` is "unknown" in Goals and `checking…` in How status is read.** The mockup draws
neither state. → Pick one string (the `checking…` wording says what is happening; "unknown" reads as a failure) and use it in both sections and in a
"States of A" cell.

**[I] spec:19, 22 (mock lines 56, 76, 210) — the Checks row and the phone band have no copy rule.** The mock shows two orderings for the same row:
`3 of 4 passed · 1 running` (open card) and `1 failed · 3 passed` (draft cell); the band shows `3/4 checks · review required` (lowercase, abbreviated)
only for the open state. Nothing says what the band reads when checks are failing, when `checks` is `null` (spec:107), when the PR is draft, merged,
closed or `unavailable`. Copy must be exact (checklist 4) and the visual baseline will freeze whatever the builder picks. → Give one rule for the row
(e.g. `<passed> of <total> passed` + ` · <failed> failed` + ` · <running> running`, in that order, omitting zero parts; `No checks` when null) and the
band for every state (open/draft: `<passed>/<total> checks · <review lowercase>`; merged: `into <base> · <ago>`; closed: `not merged · <ago>`;
unavailable: `status unavailable`), and reconcile the draft cell in the mock.

**[I] spec:86-87 — the check fold names only `status` + `conclusion` / `state` and the SUCCESS / NEUTRAL / SKIPPED cases; the rest of both enums is
unmapped.** `CheckRun.conclusion` also takes `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`; `CheckRun.status`
takes `QUEUED`, `IN_PROGRESS`, `WAITING`, `PENDING`, `REQUESTED`, `COMPLETED`; `StatusContext.state` takes `EXPECTED`, `ERROR`, `FAILURE`, `PENDING`,
`SUCCESS`. A superseded run's `CANCELLED` is the most common value on this repo's PRs after a force-push, and the spec:146 test ("checks mix … exact
values") cannot be written without the table. → Add the full mapping: not `COMPLETED` → running; `SUCCESS` → passed; `NEUTRAL` / `SKIPPED` → skipped
(excluded); every other conclusion → failed; `StatusContext` `SUCCESS` → passed, `PENDING` / `EXPECTED` → running, `ERROR` / `FAILURE` → failed.

**[I] spec:80-81, 90 — cwd `projectPath` may be `null` or a deleted directory, and Node reports a missing cwd as the same `spawn gh ENOENT` as a
missing binary, so the card would say `gh not installed` on a machine that has `gh`.** Sessions in `.worktrees/*` (this one included) lose their
`projectPath` after the worktree is pruned, which is routine here. → Before spawning, `statSync` the cwd and fall back to no `cwd` (or `os.homedir()`)
when it is null or gone; the spec already notes the URL form does not need it.

**[I] spec:80 — the URL handed to `gh pr view <url>` is not validated before it becomes an argv item.** The primary signal (spec:58) takes
`gitOperation.pr.url` as written; only the fallback (spec:61) is regex-shaped. `gh` parses argv flags positionally, so a value shaped `--web` or `-R …`
would be honoured (`--web` opens a browser on the server host). Spec:24 and :32 already want a github.com check. → State that a PR URL launches only when
it matches `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$` (the same test decides "not github.com → transcript-only"), and that `owner/repo` and
`number` are read from that match.

**[I] spec:97-100, 83 — whether `GET /api/sessions/:id/pr` awaits the first `gh` launch (≤ 10 s) or answers at once is unstated, and the second
option has no vocabulary.** With "a second caller shares the promise" the natural reading is await, which means the hook's first three 3 s polls stack
on one promise and the card appears after up to 10 s; if the endpoint instead returns immediately, `live: null` needs a reason that is not a failure
(`unavailable` at spec:111 is documented as "the fallback reason", and the reason list at spec:90 has no in-flight value). → Decide: either "the handler
awaits the shared promise; the hook's overlapping polls all resolve together" or add a `'checking'` value to the payload and the band/row copy for it.

**[I] spec:99 — the status code for a transcript read failure is not given.** "`error: true` also when the transcript read fails" names the body only.
The sibling the spec points at (`/plan`) has no such path; the sibling that does, `/chat`, answers 500 with `error: true` (`server/api.ts:296-299`) and
404 for an unknown id, which spec:99 explicitly does *not* want. → State `500 { id, pr: null, error: true }` on a read failure and add it to the
api-harness cases at spec:148.

**[I] spec:150-151 — the visual harness fails every case in which any `/api/*` GET had no fixture (`test/visual/harness.ts:2`,
`test/visual/mock-api.ts:95-99`), so a `/api/sessions/:id/pr` fixture is a precondition for the suite to pass, not an optional re-baseline step.**
Once `usePullRequest` polls inside `ChatDrawer`, every chat-opening case (`session-chat`, `session-plan`, `session-question`, `session-message`)
records a refusal until a fixture answers for each `SESSION_IDS` entry. `pnpm test:visual` is on-demand and macOS-only, so a builder who skips it ships
a red suite. → Say so: add a `session-pr.ts` fixture answering `pr: null` for every fixture session and a populated card for one, then re-baseline.

## Minor

- spec:45-46 — "add it to every theme block": tints are defined once on `:root` as `color-mix(… var(--green) …)` (`styles.css:52, 56, 61`) and only
  Daylight overrides them (`:132-137`); a `--red-tint` / `--magenta-tint` needs the root line plus, at most, a Daylight line. The ui-kit block already
  derives a red tint that way (`:3201`).
- spec:58-59 — recomputed today over the same transcripts: 99 Bash calls with `gh pr create`, 89 with `action: "created"` (plus 4 `edited`), 7 without
  a URL. The dataset moved during the day; the dated figures are fine as written.
- spec:68-69 — "One subagent on this machine has ever created a PR": the scan found 0 `gitOperation.pr` records across 3,047 `subagents/*.jsonl`
  files on the machine (2026-10-24). Either the author counted a `gh pr create` command rather than the record, or the measure differs; the decision
  (parent transcript only) does not depend on it.
- spec:75-76 — the condition "if those appear in real transcripts" is already met: `mcp__ccd_pr__*` tool calls occur 43 times in this project's
  top-level transcripts (2026-10-24). The spec can say so and still leave the shape to the builder.
- spec:84, 89 — `mergeable: UNKNOWN` resolves within seconds on GitHub's side, but a settled-open PR sits in the 60 s window, so `checking…` can stay
  for a minute. Treat `UNKNOWN` like a pending check (short window).
- spec:106 — `state` precedence is unstated: `isDraft: true` can accompany `state: CLOSED`. Map `MERGED` → merged, `CLOSED` → closed, then `isDraft`
  → draft, else open.
- spec:107 — a PR whose every check is skipped gives `total = 0`; say whether that is `checks: null` or `{0,0,0,0}` (the band copy differs).
- spec:126 — the mock also uses `.pr-top` and `.pr-glyph` (mock lines 52, 210); add them to the proposed list or drop them from the mock.
- spec:128 — repo links use `rel="noopener noreferrer"` (`client/src/components/Markdown.tsx:17`, `management/GitBranches.tsx:70`); match it.
- spec:137 — the file is `.claude/DESIGN.md`, not a root `DESIGN.md`.
- spec:167 — "three per-session polls": `useSessionChat` also polls `/chat?after=` (`ChatDrawer.tsx:133`), so the modal already runs four and this is
  a fifth; the "of the same shape" qualifier still holds for the three named.
- Mock line 210 — the "Draft, checks failing" cell has no Merge row while spec:19/23 say open and draft carry all three; not called out.
- Mock lines 222, 227 — `2h ago` / `yesterday` versus `formatAgo`'s `2h` / `1d` (`format.ts:40-43`); spec:158 leaves the wording to the builder, but
  the mock difference is not called out, and a builder who copies the mock will add a second helper, which spec:129 forbids.
- spec:80-81 — consider `GH_NO_UPDATE_NOTIFIER=1` and `GH_PROMPT_DISABLED=1` in the child env, the way `lib/codegraph.ts` silences its tool's update
  check; `gh`'s notice goes to stderr, which the spec:90 classifier reads.
- spec:70 — `--title=<…>`, single-quoted and heredoc-carried titles are common in this repo's transcripts; the parser rule names only the two-token
  forms. Best-effort is fine; say which forms are in scope so the spec:144 test has a fixed list.

## Checklist coverage

1. Facts — all code claims read; two numeric claims recomputed (Minor notes above); `gh` field names confirmed against the installed `gh`.
2. Consistency — one contradiction (Merge unknown copy); cache windows (spec:83-85, 91, 168) agree; envelope (spec:98-99, 148, 165) agrees.
3. Edge cases — missing/deleted cwd, flag-shaped URL, in-flight first call, read-failure status, all-skipped checks, draft+closed precedence.
4. Copy — Checks/band rules missing; mock differences listed.
5. Scope — non-goals named; nothing in scope depends on a non-goal (the transcript-only card for non-github hosts is explicitly "at most").
6. CLAUDE.md — zero-deps rule respected (local launch, `outbound.test.ts` unaffected), API field order stated, no colour literals, class names
   declared stable, docs/overview + chat.md updates named, `main` PR-only honoured by the no-writes anti-goal.
