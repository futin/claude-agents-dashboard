# Claude Agents Dashboard — working rules

Live monitor for parallel Claude Code sessions: reads `~/.claude/projects/*/*.jsonl`
transcripts off disk (no daemon, no hooks) and shows project, git branch, model, context
usage and current tool activity per session. Polls every 3s.

## Orientation

Monolith, three domains. The **only** thing crossing the FE/BE boundary is the typed JSON
in `shared/types.ts`.

- `server/` — Node + TypeScript, run via `tsx`, **zero runtime deps** (Node built-ins only).
- `client/` — Vite + React + TypeScript; side rail Sessions | Management | Analytics |
  Usage | Settings, all lazy but Sessions.
- `shared/types.ts` — the API contract, and the single source of truth for it.
- `test/` — node-assert tests over backend + client domain logic, tmpdir JSONL fixtures.

**The file-by-file map is `docs/overview.md`, not this file.** It is not auto-loaded —
read it (plus the relevant `docs/subsystems/*.md`) *before* changing an area. `docs/overview.md`
§Map lists every subsystem and workflow doc, one line each.

## Commands

- `pnpm dev` — API + Vite together → http://localhost:5174 (HMR, proxies `/api`).
- `pnpm build` — bundles client → `client/dist`.
- `pnpm start` — prod: built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `pnpm test` — `test/run-all.ts` via tsx; prints the case count.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm hooks:install` — symlinks the five hook scripts into `~/.claude/hooks`, merges the
  six `settings.json` entries. Idempotent; `-- --dry-run` / `-- --uninstall` / `-- --force`.
  Registration is user-global **on purpose** — project-scoped hooks would answer only
  sessions started in this repo (`docs/workflows/hooks-setup.md`).
- `pnpm tunnel` — optional HTTPS over the tailnet (`tailscale serve --bg 5174`); keep the
  port matching what you actually serve.

Both servers bind all interfaces, so localhost / LAN / Tailscale / any tunnel work with zero
config — see `docs/subsystems/remote-access.md` before touching any of it.

## Code rules

- **ESM everywhere** (`"type": "module"`). Server imports use the `.js` suffix (resolves to
  `.ts` under Bundler resolution + tsx). Cross-boundary imports use `import type` — no
  runtime coupling.
- **Server is never compiled.** `tsx` in dev *and* prod. No `dist/` for the server.
- **Dev vs prod page:** in dev Vite serves the HTML and Node answers API only; in prod Node
  static-serves `client/dist` and auto-opens the browser.
- **Adding an API field:** `shared/types.ts` first, then the server producer (`scan.ts` etc),
  then the client consumer.
- **Keep CSS class names stable.** `client/src/styles.css` is a verbatim port of the original
  inline `renderPage()`. React auto-escapes — no `esc()`.
- **Never hardcode a color or shadow in `styles.css`** below the theme-token block. The 5
  themes are pure `[data-theme]` token overrides; one literal breaks the light one.
- **Keep new deps out of `server/`.** It reads disk and makes exactly one kind of outbound
  call — the ntfy push in `lib/notify.ts`. A second needs a reason.
- `client/dist/` and `.env` are gitignored.
- Keep the vendored `/kaizen` skill (`.claude/skills/kaizen/`) in lockstep with the
  session-analytics log format (`docs/subsystems/analytics.md`).

## Subagent rules

- **Subagents return terse findings, not prose.** Instruct every Explore/Plan/Task subagent
  to answer with compact `file:line` tables + short conclusions, capped at **~15 lines, no
  closing recap/summary section** — the table *is* the answer, and a restated summary doubles
  what replays through parent context every turn. For pure locate-code work prefer
  `caveman:cavecrew-investigator` (~60% smaller output than vanilla `Explore`).
- **Review subagents file their report and return only the verdict.** The plugin template
  says "your final message IS the report" — right for the reviewer, wrong for the controller.
  Whichever text sits in front of you while writing the dispatch is the one that wins, so
  **paste this into every review dispatch**:
  ```
  Write your full report to <path>. Then reply with ONLY: the spec-compliance verdict,
  the Critical and Important findings (file:line each), and the task-quality verdict.
  No Minor findings inline, no strengths section, no restated summary.
  ```
  Ignoring this cost one run ~1.89M tokens of replayed reviewer prose (48% of its subagent spend).
- **Reserve per-task review agents for logic-heavy tasks** — concurrency, subprocess handling,
  security surfaces, real design judgement. Pure transcription of a fully-specified brief gets
  self-review plus the final whole-branch review instead.
- **Implementation plans specify behaviour and exact test *cases*, never literal code.** Handed
  code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch with nobody
  positioned to catch it. Test scaffolding is the worst offender — it reads as boilerplate.
  Give signatures, exact expected values and edge cases; let the implementer disagree with you.

## PR rules

Bodies follow `.github/pull_request_template.md`: Conventional Commits title
(`feat(spawn):`, `fix(api):`, `docs:`), a lead in user terms, then *Why this shape* /
*What changed* grouped by boundary (Server / Client / Hook / Docs) / *Verification*.
Two rules are load-bearing:

- **State what you did NOT verify.** Every merged PR here carries a "not verified, needs a
  human" line or an explicit *Unproven* row.
- **Never claim green without the command output.**

Optional template sections are commented out — delete the ones that don't apply rather than
filling them with nothing.

## Where things go

- **Bugs, ideas, tasks → `backlog/`**, filed with `/backlog-capture`. Never a hand-written doc
  under `docs/`.
- **Study guides and tutor decks → `docs/guides/`.** `/study` and `/tutor` ask for an output
  path (they default to `learning-docs/…`) — answer with `docs/guides/`. A guide only appears
  on the sibling **guide-manager** board once its `bin/register.js` has registered it; nothing
  in this repo indexes `docs/guides/`.
- A guide's `tools/*.mjs` must find the repo root by **walking up for `package.json`**, never a
  fixed `../..` hop count — a fixed count silently repoints the next time a guide moves and
  every citation reports as `gone`. This has bitten twice.
- Reference docs → `docs/subsystems/` + `docs/overview.md`. Records of a moment →
  `docs/superpowers/`. Raw study notes → `docs/learning-notes/`.

<!-- docs-sync:
  sources:
    - server/
    - client/src/
    - shared/types.ts
    - package.json
  kind: index
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
