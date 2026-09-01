# Why local whisper at all

[← back to contents](../README.md)

**What it does.** The server runs `whisper.cpp` — a C++ port of OpenAI's Whisper
speech-to-text model — as a command-line binary on your own machine, against a ~141MB
model file you downloaded yourself. Nothing about the audio touches the network.

**Why it exists.** Because the obvious alternative is disqualified by an architectural
promise this app has already made everywhere else.

## The bad alternative

`webkitSpeechRecognition` is sitting right there in every browser, free. Three lines of
JavaScript, no install step, no `ffmpeg`, no model file — and it streams *interim
results*, so words appear on screen as you speak them. On every axis a demo cares about
it wins.

It also uploads your audio to Apple or Google to do that.

That is disqualifying **here specifically**, and the reason is structural rather than
ideological. From [`.claude/CLAUDE.md`](../../../../../.claude/CLAUDE.md):

> Backend is zero-runtime-dep by design (only Node built-ins). Keep new deps out of
> `server/`. It reads from disk and makes exactly **one** kind of outbound call: the ntfy
> push in `lib/notify.ts`. Adding a second needs a reason.

The whole pitch of this dashboard is that it reads your Claude Code transcripts — your
code, your prompts, your project names, your branch names — off disk and never ships them
anywhere. A dictation feature that routed spoken follow-ups through a third party would
instantly become the *loudest* thing the app does, on the single axis it advertises. It
would not be a small exception; it would be the exception that makes the rule
unstateable.

## The trade-off, stated plainly

| | Browser speech API | Local whisper |
|---|---|---|
| Setup | none | `brew install whisper-cpp` plus a ~141MB model |
| Interim text while you talk | yes, live | no — whisper is batch, hence the `…` spinner |
| Audio leaves the machine | **yes** | no |
| Works offline | no | yes |
| Backend complexity | zero | two spawned binaries, temp files, timeouts, a concurrency guard |
| Accuracy on code identifiers | good | `base.en` mangles them (see below) |

The right way to read that table is as a **cost sheet**, not a scoreboard. Local whisper
loses four of six rows. It wins the one row that this app cannot lose, and everything in
the backend — the scratch directory, the `run()` wrapper, the 30-second spawn timeouts,
the single-flight flag — is the invoice for that single win.

Two consequences worth naming, because they show up later as design pressure elsewhere in
the guide:

- **No interim text** means the UI has a *transcribing* phase with nothing to show. That
  is why `MicButton` renders a bare `…` rather than a partial transcript, and why the
  phase exists in the state machine at all
  ([the render gate](./render-gate.md)).
- **`base.en` mangles code identifiers** often enough that unreviewed dictated text
  reaching the model is a worse outcome than typing it wrong yourself — a misheard
  identifier that gets *executed* costs more than one that merely gets *read*. That is the
  first of the two reasons the mic never touches **send**; the transcript is appended to
  the textarea as editable text and you tap send yourself. A bigger model
  (`WHISPER_MODEL` is a `.env` swap to `small.en` or larger) narrows the accuracy gap, and
  narrows nothing about the argument.

## What this is not

It is not a claim that local inference is always right. It is expensive here: two
external binaries neither bundled nor present on a stock Mac, an install step in the
README, and a feature that silently does not exist on a machine that skipped it. On an
app with no privacy story to protect, `webkitSpeechRecognition` would be the correct call
and this whole chapter would be over-engineering. The lesson is that **the constraint came
first and the architecture followed** — not that the architecture is universally better.

---

Next: [The render gate](./render-gate.md) — what the button does before a single byte of
audio exists.
