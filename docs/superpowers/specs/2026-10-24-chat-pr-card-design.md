# Chat PR card — design

Date: 2026-10-24 · Branch: `feat/chat-pr-card` · Mockups: [`2026-10-24-chat-pr-card-mockups.html`](2026-10-24-chat-pr-card-mockups.html) (variant **A**, plus the
"States of A" strip).

## Intent

When a session opens a pull request, the chat modal should show that PR the way Claude Code Desktop does: its number and title as a link, whether it is
open / draft / merged / closed, and how its CI checks, review and merge state stand — live, without leaving the dashboard. Today the PR exists only as a
`Bash gh pr create …` tool line and a bare URL in the assistant's reply; scroll past it and it is gone, and its CI state never appears at all.

The reader is the user watching a session from the dashboard (often a phone, over the tailnet) who wants to know "did it open the PR, and is CI green yet?"
without opening GitHub or the terminal.

## Goals

- A **Pull request card in the chat modal's sidecar** (`.chat-side`), between the Tasks card and the facts list — always in view while the modal is open.
- It shows the session's **newest** PR: `#<number>` + title (a link to the PR), a state pill (Open / Draft / Merged / Closed), `head → base`, and three
  rows: **Checks** (passed / failed / running counts plus a segmented bar), **Review** (Approved / Changes requested / Required / Not requested), **Merge**
  (No conflicts / Conflicts with `<base>` / Checking…). Exact row and band copy per state: §Copy.
- **Live status** comes from `gh pr view --json …`, launched by the server, cached, and refreshed while a modal showing it is open.
- **Below `md` (768px)** the card folds to one band line, like the Tasks fold: `PR #304 [Open] 3/4 checks · review required ▾`; tapping unfolds the rows.
- **Merged / Closed** drop the three rows and show `into <base> · <relative time>` / `not merged · <relative time>` instead.
- **Degrades to transcript-only** when `gh` is missing, signed out, times out, or the URL is not github.com: the card still shows `#<number>`, the title if
  the transcript gave one, the `owner/repo`, the link, and one row `Status · unavailable · <short reason>`.

## Non-goals

- Inline cards in the transcript (variant B) and a head chip (variant C) — drawn and not picked.
- More than one PR per session. A session that opened several shows only the newest; the others stay reachable through their URLs in the transcript.
  (User's pick: "Newest only".)
- PRs on hosts other than github.com (GitLab MRs, GHE) get no live status — the transcript-only card at most. The builder may skip detecting them at all.
- The card on the session **row** or the board. Modal only.
- A PR the session did not create (e.g. it ran `gh pr view 123` on someone else's PR, or a URL pasted by the user).

## Anti-goals (a failure even if it works)

- **No writes to GitHub.** No Merge, Re-run checks, Ready for review or Close buttons (variant D, dropped as YAGNI). The dashboard stays read-only toward
  GitHub; `main` is PR-only and the session that opened a PR is the one that merges it.
- **No `gh` launch per session per list poll.** `gh` runs only for a session whose chat modal is open, and at most once per PR per cache window — never for
  every row on the 3s board poll.
- **No new outbound kind.** The server must not call `api.github.com` itself (no `fetch`, no `https`); it launches the local `gh` program, which is the
  "launching a local program" exception in `.claude/CLAUDE.md`'s zero-deps rule. `test/outbound.test.ts` must stay green unchanged.
- **The card never pushes or reflows the transcript.** It lives in the sidecar; the transcript column is untouched.
- **No hardcoded colours in `styles.css`.** State pills and check bars use existing tokens (`--green`, `--green-tint`, `--magenta`, `--red`, `--mustard`, …);
  a missing `--red-tint` / `--magenta-tint` is defined on `:root` as `color-mix(… var(--red) …)` like the existing tints, plus a Daylight line only if
  Daylight overrides its siblings — never a literal.

## Decided by the user

- Live status via `gh` (not transcript-only).
- Placement: sidecar card, variant A of the mockups.
- Multiple PRs: newest only.

## How a PR is found

The PR a session **created** is the newest one of these, in transcript order:

1. **Primary — Claude Code's own record.** A `Bash` tool result whose record carries `toolUseResult.gitOperation.pr` with `action: "created"` and
   `{ number, url }`. Measured 2026-10-24 over this project's top-level transcripts: 98 Bash calls contained `gh pr create`, 89 carried this record, and
   the other 9 had no PR URL in their output (failed creates). The field is undocumented, so it can change between Claude Code versions — hence:
2. **Fallback — command parse.** A `Bash` tool call whose command contains `gh pr create` and whose result text contains a
   `https://github.com/<owner>/<repo>/pull/<n>` URL. Commands are usually compound (`cat > body <<EOF … && gh pr create …`, `git push && gh pr create … |
   tail -3`, `cd x && gh pr create -R other/repo`), so match the URL anywhere in the result text, not "on its own line"; take the last one in that result.
   Used only for a call that has no `gitOperation` record.
3. **Never** the top-level `{"type":"pr-link", prNumber, prUrl, prRepository}` record. Claude Code writes it for any PR URL that appears in output — on
   this machine (2026-10-24) it marked 11 PRs that sessions did not create, including PR URLs printed by a `grep`.

- **Subagents don't count** (author's call). A subagent writes its own `<id>/subagents/agent-*.jsonl`; only the parent transcript is scanned. No `gitOperation.pr` record appears in any of this
  machine's 3,047 `subagents/*.jsonl` files (2026-10-24).
- The title comes from the same tool call's title argument when present (best-effort; for the transcript-only fallback). In scope: `--title "<…>"`,
  `--title '<…>'`, `--title=<…>` (quoted or not), and `-t` in the same forms; a heredoc-carried title is out of scope and yields `title: null`. `gh` gives
  the authoritative title when available.
- Detection reads the transcript server-side, like `readSessionTasks` (`server/lib/tasks.ts`) folds tasks — incremental by byte offset, cached per file, so a
  re-read only scans what was appended.
- A `gh pr create` that failed (non-zero exit, or no URL in its output) contributes nothing.
- **Builder may widen** detection to the Desktop app's own PR tools: `mcp__ccd_pr__*` calls occur 43 times in this project's top-level transcripts
  (2026-10-24). Read their real record shape from those transcripts before deciding; do not guess it.

## How status is read

`gh pr view <url> --json number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable,mergedAt,closedAt`, launched
with the session's `projectPath` as cwd (not required for a full URL, but keeps `gh`'s host config consistent), a timeout (≈10s), no shell, and
`GH_NO_UPDATE_NOTIFIER=1` + `GH_PROMPT_DISABLED=1` in the child env (as `lib/codegraph.ts` silences its tool), so no update notice reaches the stderr the
failure classifier reads.

- **cwd must exist.** `projectPath` can be null or a pruned worktree, and Node reports a missing cwd as the same `spawn gh ENOENT` as a missing binary
  (checked 2026-10-24: `spawn('ls', [], { cwd: '/nonexistent' })` → `ENOENT spawn ls ENOENT`), which would read `gh not installed`. `statSync` the
  cwd first; when it is null or not a directory, launch from `os.homedir()`.
- **Only a validated URL reaches argv.** Launch `gh` only for a URL matching `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$`; derive `repo`
  (`owner/repo`) and `number` from that match. The same test decides "not github.com → transcript-only, `unavailable: 'not a GitHub PR'`". This guards the
  primary signal's `gitOperation.pr.url` too: a flag-shaped value (`--web`, `-R …`) must never be passed to `gh`.

- **Cache per PR URL**, with one launch in flight per URL (a second caller shares the promise). Suggested windows — builder may tune: **20s** while
  open/draft with any check running or `mergeable: UNKNOWN`, **60s** while open and settled, **indefinitely** once merged or closed (state can't change back in a way the card
  cares about; a reopen is rare enough to need a modal reopen at most).
- **Checks** fold `statusCheckRollup` into passed / failed / running counts plus excluded; `total` = passed + failed + running (excluded never counts).
  An empty or missing rollup, or one whose every item is excluded (`total = 0`) → `checks: null`.
- **State** precedence: `state: MERGED` → merged, `CLOSED` → closed (even with `isDraft: true`), then `isDraft` → draft, else open.

  | Item | Value | Counts as |
  |---|---|---|
  | `CheckRun` | `status` ≠ `COMPLETED` (`QUEUED`, `IN_PROGRESS`, `WAITING`, `PENDING`, `REQUESTED`) | running |
  | `CheckRun` | `COMPLETED` + `conclusion` `SUCCESS` | passed |
  | `CheckRun` | `COMPLETED` + `conclusion` `NEUTRAL` or `SKIPPED` | excluded |
  | `CheckRun` | `COMPLETED` + any other `conclusion` (`FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE`, unknown) | failed |
  | `StatusContext` | `state` `SUCCESS` | passed |
  | `StatusContext` | `state` `PENDING` or `EXPECTED` | running |
  | `StatusContext` | `state` `FAILURE`, `ERROR`, or unknown | failed |
- **Review** maps `reviewDecision`: `APPROVED` → Approved, `CHANGES_REQUESTED` → Changes requested, `REVIEW_REQUIRED` → Required, empty → Not requested.
- **Merge** maps `mergeable`: `MERGEABLE` → No conflicts, `CONFLICTING` → Conflicts with `<base>`, `UNKNOWN` → `Checking…` (GitHub computes it lazily).
- **Failure** (ENOENT, non-zero exit, timeout, unparsable JSON) yields a reason string for the fallback row: `gh not installed`, `gh not signed in` (stderr
  mentions auth / `gh auth login`), `timed out`, else `gh failed`. Failures cache for the short window too, so a missing `gh` isn't relaunched every poll.
- Launching goes through the same child-process helper style as `server/lib/git-fetch.ts` (spawn, kill the group on timeout) with an injectable runner
  for tests, as `git-fetch.ts` and `codegraph-store.ts` do.

## API

A new `GET /api/sessions/:id/pr`, next to `/plan` and `/question` in `server/api.ts`, fetched by the chat modal only (a `usePullRequest(id)` hook, polling
at the modal's `refreshMs`; the server cache absorbs the frequency). It follows the siblings' envelope (`server/api.ts` `/question`, `/plan`): a malformed
id → 400 `{ id, pr: null, error: true }`; any well-formed id, known or not → 200 `{ id, pr }`; a transcript read that throws → 500
`{ id, pr: null, error: true }`, as `/chat` does (`server/api.ts` `serveSessionChat`'s `fail(500)`). So the hook tells "no PR" (`pr: null`, no `error`)
from "fetch failed" (`error: true`, keep the last card).

**The handler awaits the `gh` read** (the shared in-flight promise, bounded by the ≈10s timeout) rather than answering before it lands, so there is no
in-flight value in the payload. A cache hit answers at once. The hook skips a poll tick while its previous request is still pending, so a slow `gh` never
stacks requests. Payload, added to `shared/types.ts` first:

```
SessionPrResponse = { id: string; pr: SessionPr; error?: boolean }
SessionPr = null | {
  url, number, repo ("owner/repo"), title: string | null,
  live: null | { state: 'open'|'draft'|'merged'|'closed', title, head, base,
                 checks: { passed, failed, running, total } | null,   // null = no checks configured
                 review: 'approved'|'changes'|'required'|'none',
                 merge: 'clean'|'conflicts'|'unknown',
                 endedAt: string | null },                            // mergedAt ?? closedAt
  unavailable: string | null                                          // the fallback reason when live is null
}
```

Exact field names are the builder's; the shape is: transcript facts always, live facts when `gh` answered, a reason when it didn't. `null` = this session
created no PR, and the card renders nothing (no empty card, no gap — like `TasksCard` with no tasks).

Read-only GET: no answer token, and the remote-access guard (`server/lib/request-guard.ts`) applies as to every other route. The data it exposes (PR title,
branch) is already visible in the chat transcript the same viewer can read.

## Client

- `client/src/components/PrCard.tsx`, rendered by `ChatDrawer` in `.chat-side` after `TasksCard`. One DOM for both widths with a `.folded` class, the
  pattern `TasksCard` documents: desktop shows the head row + title + ref + rows; below `md` the sidecar is a band and the card is one fold button
  (`.pr-band`) that toggles the rows.
- Class names from the mockup are proposals (`pr-kv`, `pr-top`, `pr-glyph`, `pr-state`, `pr-title`, `pr-ref`, `pr-rows`, `pr-row`, `pr-checks`,
  `pr-band`); once shipped they are stable (visual suite and docs address them).
- The title link opens the PR in a new tab (`target="_blank" rel="noopener noreferrer"`, as `Markdown.tsx` and `GitBranches.tsx` do).
- Relative time for Merged / Closed uses the client's existing `formatAgo` (`client/src/lib/format.ts`), so it reads `2h` / `1d`, not the mock's
  `2h ago` / `yesterday`. No new helper.
- Open and Draft both carry all three rows (the mock's draft cell omits Merge; the spec wins).

## Copy

**Checks row** (desktop), first matching rule:

| Condition | Text | Tone |
|---|---|---|
| `checks: null` | `None` | dim |
| `failed > 0` | `<failed> failed · <passed> passed`, plus ` · <running> running` when running > 0 | bad |
| `running > 0` | `<passed> of <total> passed · <running> running` | running |
| otherwise | `<total> of <total> passed` | ok |

The segmented bar has one segment per counted check (failed first, then running, then passed) and is absent when `checks` is null.

**Review row:** Approved (ok) · Changes requested (bad) · Required (dim) · Not requested (dim). **Merge row:** No conflicts (ok) · Conflicts with `<base>`
(bad) · Checking… (dim).

**Phone band** (`PR #<n> [pill] <line> ▾`), `<line>` by state:

| State | `<line>` |
|---|---|
| Open / Draft | `<checks short> · <review short>`; checks short: `no checks` / `<failed> failed` / `<passed>/<total> checks`, same precedence as the row; review short: `approved` / `changes requested` / `review required` / `no review` |
| Merged | `into <base> · <relative time>` |
| Closed | `not merged · <relative time>` |
| live null (unavailable) | `status unavailable` — no pill |

The mockup's "Draft, checks failing" cell already follows the row rule; the `Checking…` merge value is drawn in its own States cell.

## Constraints

- `.claude/CLAUDE.md`: API field order is `shared/types.ts` → server producer → client consumer; ESM with `.js` suffixes in server imports; never hardcode a
  colour below the theme-token block; keep class names stable.
- Add `lib/<file>.ts launches gh pr view` to the launched-programs sentence in `.claude/CLAUDE.md`'s zero-deps rule, and to `docs/overview.md`'s `lib/` map.
- Docs: a new paragraph in `docs/subsystems/chat.md` (the sidecar section — where the card sits, what it reads, the fold) and the new route in
  `docs/overview.md`'s API table; `.claude/DESIGN.md` §8.6 gets one line pointing at the mockup.
- Five themes: check the card in at least Daylight and one dark theme.

## Verification the builder owns

- Unit tests (node-assert, tmpdir JSONL fixtures, as `test/tasks.test.ts`): detection picks the newest created PR across both signals; prefers
  `gitOperation.pr` over the parse for the same call; the parse finds the URL in a compound command's result (heredoc body, `| tail -3`, `-R other/repo`);
  ignores a failed create, a `gh pr view` of another PR, a `pr-link` record, and a URL only in user/assistant prose; title parsed from `--title` and `-t`;
  incremental re-read after an append. Fixtures copy the record shapes from a real transcript on this machine, not from memory.
- Unit tests for the `gh` JSON fold with an injected runner: each state, draft, checks mix (CheckRun + StatusContext, skipped excluded), each
  `reviewDecision` and `mergeable` value, each failure reason, and the cache windows (a second call inside the window does not launch; merged never relaunches).
- An API test through `test/api-harness.ts`: malformed id → 400 `error: true`; unknown or PR-less session → 200 `pr: null`; a transcript read that
  throws → 500 `error: true`.
- A visual check in the dev server at desktop and 375px, light and dark, against a real session on this machine that ran `gh pr create`.
- `pnpm typecheck`; the touched test files.
- **Visual suite precondition.** The harness fails any case in which a `/api/*` GET had no fixture (`test/visual/harness.ts` header, `test/visual/mock-api.ts`
  "no fixture"), so once `usePullRequest` polls inside `ChatDrawer`, every chat-opening case fails until `/api/sessions/:id/pr` answers. Add a
  `test/visual/fixtures/session-pr.ts` answering `{ id, pr: null }` for every fixture session and a populated PR for one, then run `pnpm test:visual` and
  re-baseline. The suite is on-demand and macOS-only, so it is not in CI — it must be run here, not skipped.

## Left to the builder

- Exact cache windows and timeout, file and hook names, the exact `SessionPr` field names.
- Whether detection lives in its own `server/lib/` module or inside the chat reader — own module preferred, as `tasks.ts` is.
- Whether the `—` fallback title is the `--title` arg or `#<n>` alone when neither the arg nor `gh` gave one.
- The relative-time wording on Merged / Closed.

## Calls the author made (not discussed with the user)

- **Only a created PR counts** as "the session's PR"; a PR the session merely viewed or was told about doesn't show.
- **Detection: `gitOperation.pr` first, command parse as fallback, `pr-link` never** (from the builder check's transcript counts).
- **Subagent-created PRs don't show** on the parent's card.
- **Endpoint envelope matches `/plan` / `/question`** (400 malformed, 200 otherwise, `error` flag), not a bare body.
- **Endpoint per modal, not a field on `Session`.** Putting it on the list poll would either launch `gh` for every row or need a second cache layer; the
  modal already runs per-session polls of this shape (`/question`, `/plan`, `/message`, beside the `/chat` tail) and this is one more.
- **Merged / closed is cached for the life of the server process.**
- **Order in the sidecar**: Context → Stop control → Tasks → Pull request → facts.
