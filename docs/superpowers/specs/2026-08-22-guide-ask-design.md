# Ask-Claude guide companion — design

An **Ask Claude** panel in the Guides tab's deck viewer: type (or dictate) a question
about the lesson on screen, get a grounded answer. The server answers it by running a
one-shot headless `claude -p` in this repo — so the answer comes from the code as it is
*today*, not as the deck's snapshot remembers it — and returns the captured output.

The panel lives in the dashboard chrome **around** the deck iframe, never inside the
deck HTML. The deck contract stays network-free; the GitHub Pages copy of the same deck
simply has no panel, which is the correct offline/public degradation for free.

Status: **on hold 2026-08-22** — deliberately not approved with the other two; revisit
after the Guides tab ships. Depends on the Guides tab
(`2026-08-22-guides-tab-design.md`); independent of the Q&A cards spec.

## Why `claude -p` and not the Anthropic API

Confirmed at brainstorm: no API key to manage, no new runtime dependency, no second
outbound-call class in a backend that deliberately has one (`lib/notify.ts`), and — the
real reason — grounding. A `claude -p` run with this repo as cwd can open the files the
deck cites and answer from current source. An API call answers only from whatever
context the server hand-assembles. Cost: answers take ~15–60s and spend the user's
Claude plan; a spinner and a single-flight guard make that acceptable for study pace.

## Existing machinery this leans on

| Fact | Where |
|---|---|
| Argv building for headless runs, prompt passed on **stdin** (never argv) | `buildSpawnArgs` at server/lib/spawn.ts:210, stdin write at spawn.ts:458 |
| Run-to-completion child runner with timeout, captured stdout, never-rejects | `run` at server/lib/transcribe.ts:112 |
| Single-flight guard + typed failure union | `inFlight` at server/lib/transcribe.ts:134, `TranscribeFail` at :104 |
| Write-endpoint guards: remote-answer gate + token check + JSON body cap | `serveSpawnStop` at server/api.ts:933 (gate order), `tokenOk` at api.ts:381, `readJsonBody` at api.ts:266 |
| Deck metadata for prompt grounding | provenance stamp: deck-wide `sources`, per-section `sources` + `title` |
| Dictation input in a composer | MicButton + hooks/useDictation (docs/subsystems/dictation.md) |
| Markdown rendering without `dangerouslySetInnerHTML` | components/Markdown.tsx + lib/markdown.ts |

## Design

### Server — `server/lib/ask.ts` (new)

Pure core + one impure runner, transcribe.ts's split:

- **`buildAskPrompt(deck, question, sectionId?)`** (pure): parses the deck's provenance
  stamp and `<title>`, and produces the prompt:
  - role: study companion for lesson "<title>"; the learner is reading section
    "<section title>" (when `sectionId` given, else the whole lesson);
  - grounding: the section's `sources` list (else deck-wide `sources`) as the files to
    consult; instruction to read them before answering and to cite `file:line`;
  - discipline: answer ≤200 words, plain prose, no file dumps, no refactoring advice
    (mirrors the tutor skill's framing rule);
  - the learner's question appended last, verbatim.
  The whole prompt goes to the child's **stdin** (spawn.ts precedent — a question
  starting with `--` must never be argv).
- **`ask(config, input)`** (impure): single-flight (`busy` when a run is live), spawns
  `config.claudeBin` with `['-p', '--permission-mode', 'plan']`, cwd = repo root, env
  minus `CLAUDE_CODE_ENTRYPOINT` (spawn.ts:437's measured reason), 120s timeout,
  captures stdout. Outcome union: `{ok:true, answer}` |
  `{ok:false, reason: 'busy'|'timeout'|'engine'|'bad-deck'}`. Never a raw stderr dump to
  the client (transcribe.ts rule).
  - `--permission-mode plan`: the companion must read, never write. A denied write in a
    headless run has nowhere to prompt; plan mode makes the refusal silent and safe.
  - The run writes an ordinary transcript, so a short-lived session row appears in the
    Sessions tab with the `dashboard` surface pill. Documented behavior, not hidden —
    it is honest cost accounting.
- **`probeAsk(config)`**: cached `claudeBin` existence probe (probeTranscribe pattern),
  surfaced on `/api/health` as `guideAsk: boolean` so the client renders the panel only
  when the capability is real.

### Server — endpoint

`POST /api/guides/ask`, body `{deck: <relPath>, question, sectionId?}`:

1. Remote-answer gate + `tokenOk` — same order and same 404/403 responses as
   `serveSpawnStop`. Rationale: this endpoint spends real money and executes an agent;
   it gets the strictest posture the app has. (Open decision 1 below.)
2. `deck` resolves under `guidesDir` (the Guides tab's traversal guard, reused) and the
   file carries a tutor-deck marker → else `bad-deck`.
3. `question` non-empty after trim, capped at 2 000 chars; body via `readJsonBody`.
4. Run `ask`, map the outcome: 200 `{answer}`, 409 `busy`, 504 `timeout`, 502 `engine`,
   400 `bad-deck`.

### Client

- `AskPanel` inside the deck viewer (the slot the Guides spec reserved): a one-line
  composer (textarea + MicButton when dictation is available) above the iframe footer,
  plus an optional section picker fed by the deck's `sections` (`{id, title}[]`) from
  `GET /api/guides` (defaults to "whole lesson").
- Send → disable composer, elapsed-seconds spinner ("Claude is reading the code…") →
  render the answer through `Markdown` in a collapsible answer block that stacks (a
  small per-visit history, in-memory only). Errors map to short human strings; `busy`
  offers retry.
- Rendered only when `/api/health` reports `guideAsk: true` **and** the remote-answer
  switch is on — mirroring how SpawnPanel gates. On GitHub Pages none of this code even
  ships: the panel is dashboard chrome, not deck content.

## Non-goals

- **No multi-turn chat in v1.** Each ask is an independent one-shot; a follow-up is a
  new question. (Resume-based continuity is the obvious v2 — the transcript id exists.)
- **No streaming.** One captured answer; the 15–60s wait is shown honestly.
- **No asking from inside the deck HTML**, ever — contract stays network-free.
- **No model/effort knobs in the panel.** Defaults only; knobs are SpawnPanel territory.
- **No answer persistence** beyond the open viewer.

## Testing

- `buildAskPrompt`: stamped deck fixture → prompt contains title, section title,
  section-scoped sources, the verbatim question last; sectionId omitted → deck-wide
  sources; unstamped legacy deck → `bad-deck`.
- `ask`: injected spawner seam (spawn.ts precedent) — success, non-zero exit → `engine`,
  timeout kill → `timeout`, second concurrent call → `busy`.
- Endpoint: gate off → 404 before any work; bad token → 403; traversal `deck` → 400;
  oversize body → cap behavior; happy path 200.
- Not verified without a human: a real end-to-end `claude -p` answer's latency/quality,
  and iOS Safari behavior of the composer next to an iframe.

## Open decisions (flagged at approval)

1. Gate: behind the remote-answer switch like spawn (recommended — one switch means
   "browsers may cause spend"), vs always-on for local origin only.
2. Section picker in v1 (recommended, it is one `<select>`) vs whole-lesson-only.
3. Spend rail: accept unbounded single runs (recommended; single-flight + 120s timeout
   already bound it) vs pass `--max-budget-usd` (spawn spec deliberately skipped it).
