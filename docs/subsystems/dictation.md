---
docs-sync:
  sources:
    - server/lib/transcribe.ts
    - server/api.ts
    - server/index.ts
    - client/src/hooks/useDictation.ts
    - client/src/hooks/useTranscribeAvailable.ts
    - client/src/components/MicButton.tsx
    - client/src/lib/dictation.ts
    - client/src/components/MessagePanel.tsx
  kind: subsystem
  verified: 3e1d51fd26c72d6c21bd9d6b8921ee3bb498518b
---

# Dictation in the reply composer (local whisper)

A mic button in the [reply composer](remote-message.md)'s action row lets you speak a
follow-up instead of typing it. The browser records with `MediaRecorder`, POSTs the clip to
`POST /api/transcribe`, and the server transcodes it with `ffmpeg` to 16kHz mono WAV and
runs a locally-installed `whisper-cli` over it. The transcript lands in the textarea as
**editable text** — you still tap **send**.

## Why local whisper, not the browser's own speech API

`webkitSpeechRecognition` is free, needs no install, and streams interim results as you
talk. It also ships your audio to Apple or Google to do it. This dashboard reads your
session transcripts off disk and makes exactly one outbound call by design — the ntfy push
in `lib/notify.ts` (see [push-notify](push-notify.md)) — and routing dictated follow-ups
through a third party would be the loudest thing it does, on an app whose whole pitch is
that your transcripts never leave the machine. Local whisper keeps the audio on the same
box that already holds them. The cost is real: an install step (`brew install whisper-cpp`
plus a ~141MB model), and no interim text while you talk — whisper is batch, so the
composer shows a `transcribing…` spinner rather than words appearing live.

## HTTPS is load-bearing, not a nicety

`getUserMedia` — the API `MediaRecorder` is built on — refuses to run outside a [secure
context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): HTTPS, or
`localhost`. That makes dictation impossible over a plain-http tailnet URL or a LAN IP,
which is exactly the shape of a phone visit to this dashboard. Before this feature, `pnpm
tunnel` ([remote-access](remote-access.md#optional-https-pnpm-tunnel)) was a nicety — no
port number in the bookmark, no cert warning. Now it's the only route that lets a phone
dictate at all.

`MicButton` renders one of three ways, and the middle one is the deliberate part:

| Condition | Renders as |
|---|---|
| No engine (`transcribe: false` from `/api/health`) | **Nothing.** An explanation would be noise on every panel that will never have a mic. |
| Engine present, `window.isSecureContext` is false | **A disabled button**, labelled `🎙 https only`, titled "needs HTTPS — run `pnpm tunnel`" |
| Engine present, secure context | The working mic: idle → recording (pulsing dot + elapsed timer) → transcribing |

The middle row is the one worth defending. A button that just isn't there would be less
code, but a phone user who never sees it has no way to learn dictation exists, or why it
doesn't work *here*. A visibly dead button that names the fix is the honest failure mode —
the alternative is a support question that starts with "the mic never showed up."

## The pipeline

```
tap → MediaRecorder → POST /api/transcribe → ffmpeg (→ 16kHz mono wav) → whisper-cli -nt → parseOutput → textarea
```

- **Recording.** `useDictation` picks a mime type with `pickMimeType` before constructing
  the `MediaRecorder`: iOS Safari records `audio/mp4` natively, while Chrome and Android
  favor `audio/webm;codecs=opus`, so mp4 is tried first and the rest follow as fallbacks
  (`client/src/lib/dictation.ts`). A **hard 120s cap**, timed off the same interval that
  drives the visible `0:07` elapsed counter, calls the same stop path a tap would — a
  forgotten recording cannot run until the tab dies.
- **Upload.** The raw `Blob` is POSTed as the request body with the recorder's own
  `Content-Type` — no multipart wrapper, no base64. The server reads it with
  `readBinaryBody`, a sibling to the existing JSON body reader that exists solely because
  that one is JSON-only.
- **Transcode.** A scratch directory (`fs.mkdtemp`, removed in a `finally` on every exit
  path) holds the upload and the wav ffmpeg produces from it: `ffmpeg -hide_banner
  -loglevel error -y -i <in> -ar 16000 -ac 1 <out>`. Real files, not a pipe, because
  whisper.cpp wants a seekable wav and a phone's recording is whatever codec and rate the
  browser chose.
- **Transcribe.** `whisper-cli -m <model> -f <wav> -nt`. Measured on this machine: a 3.2s
  clip finished in **1.275s wall clock** (whisper's own reported total was 977ms; the rest
  is process spawn and model load for `ggml-base.en.bin`, 147,964,211 bytes, kept at
  `~/.whisper/`).
- **Parse.** `-nt` is supposed to suppress timestamps, but `parseOutput` strips
  `[HH:MM:SS.mmm --> …]` brackets and blank lines anyway, and maps whisper's own
  `[BLANK_AUDIO]` / `(silence)` markers to `''`. This isn't padding for a case that can't
  happen: measured stdout from a real `-nt` run was a **leading newline, a leading space,
  the sentence, and no trailing newline** — `trim()` is doing real work on every response.
  All model/system diagnostics go to stderr, which is why the client never sees them.

## Append, never send: the transcript is a draft, not an instruction

`onText` hands the transcript to `MessagePanel`, which folds it in with
`appendTranscript` — space-joined onto whatever is already typed, truncated to the
textarea's 4000-char cap rather than silently overflowing it. It never touches **send**.

Two reasons, and either alone would be enough. First, `base.en` mangles code identifiers
often enough that unreviewed dictated text reaching the model is a worse outcome than
typing it wrong yourself — a misheard identifier that gets *executed* costs more than one
that merely gets *read*. Second, "append" means a second take extends a thought instead of
destroying the first one, so pausing mid-recording to think doesn't cost you your opening
line. A bigger model (`.env` swap to `small.en` or larger) narrows the first reason; neither
one is a reason to ever wire the mic straight to send.

## Endpoint

`POST /api/transcribe`, raw binary body, `Content-Type` set by the recorder:

| Code | When |
|---|---|
| 200 | `{text: string}` — possibly `''` when nothing was heard; the client shows "nothing heard" inline, not an error |
| 400 | empty body; upload aborted mid-read; or a `Content-Type` outside the mime allowlist (echoed back in the error message) |
| 403 | bad or missing token — `tokenOk`, the same check as the other three write paths |
| 404 | feature off: `remoteAnswer` is false, or `probeTranscribe` is false (no model configured, or no working binary) |
| 405 | non-`POST` |
| 413 | body over `AUDIO_CAP` (8MB) — caught from an honest `Content-Length` before a byte is read, or from the running byte count otherwise |
| 429 | another transcription is already in flight |
| 500 | `ffmpeg` (`transcode`) or `whisper-cli` (`engine`) exited non-zero |
| 504 | either spawn ran past its 30s timeout |

⚠️ `/api/transcribe` is a plain `pathname` match in `index.ts`, sitting beside
`/api/notify/test` — well above the `/api/sessions/:id` detail regex. None of that regex's
route-ordering traps apply here.

## The engine probe: cached, and what `transcribe` on `/api/health` means

`probeTranscribe` runs once — after confirming `WHISPER_MODEL` points at a real file, a
single `spawnSync(whisperBin, ['-h'], {timeout: 2000, stdio: 'ignore'})` — and caches the
boolean for the process's lifetime. `/api/health` itself is polled every 15s by
`useRemoteAnswer` (`POLL_MS` in `useRemoteAnswer.ts`) for the remote-answer toggle;
`useTranscribeAvailable`, the hook that actually reads this field, does not poll at all — it
fetches `/api/health` once per page load and memoizes the promise, since a *completed*
answer cannot change without a server restart. Either way, re-running the probe on every
request would spawn a process for no new information, which is exactly what the cache above
prevents.

**`transcribe` reports engine availability only — it does not fold in `remoteAnswer`**,
even though the endpoint 404s on both. That's deliberate, not a missed AND: a
`MessagePanel` cannot be on screen with remote answers off in the first place (the toggle
calls `dismissAllMessages()`, and the panel goes `gone`), so the mic has no surface to
render on regardless of what this flag says. Folding `remoteAnswer` in here would just
create a second, worse copy of state `useRemoteAnswer` already owns.

**Why `/api/health` publishes this to callers with no token at all.** `serveHealth` needs
no `Authorization` header — it never did, since `origin`, `idleSecs`, and `answerSecs`
already ride on the same unauthenticated payload for the hooks and the toolbar badge to
read. Gating `transcribe` behind the token would not make the capability more private; it
would just break the mic for exactly the people who bothered to set `ANSWER_TOKEN`, because
`useRemoteAnswer` and `useTranscribeAvailable` both fetch `/api/health` with no
`Authorization` header — a token-configured browser would probe, get refused, and never
render the button at all. The bit sits beside three other booleans that already leak
nothing more sensitive than "a feature is turned on"; it doesn't leak anything new in kind.

What the token *does* gate is a spawn per request. `serveTranscribe` checks `remoteAnswer` →
`tokenOk` → `probeTranscribe` → `isTranscribing()` → mime → body, in that order, so an
unauthenticated caller is refused at 403 before any audio is read or any per-request
process spawns. That is not the
same as "no spawn is reachable without a token": the capability probe itself (previous
section) is cached for the process's lifetime and also runs behind the unauthenticated
`GET /api/health`, so it alone can be triggered with no token at all — a one-time
`whisper-cli -h`, never `ffmpeg` or a per-clip `whisper-cli` run. That ordering is about
keeping the auth boundary exactly where the other write paths keep it — not about hiding
whether the capability exists.

## The in-flight guard: a CPU- and memory-amplification defence

**One transcription at a time.** A module-level flag; a second concurrent request gets a
429 rather than queuing. Whisper saturates CPU cores, and this endpoint is reachable by
anything that can authenticate to it — an unbounded fan-out would turn one request into a
CPU amplifier against the host machine.

The check runs twice, for two different reasons — and they don't cover the same window.
`serveTranscribe` calls the exported `isTranscribing()` first, **before `readBinaryBody`**,
but `inFlight` only flips `true` inside `transcribe()`, which runs after `readBinaryBody`
has already buffered the whole body — so the window in which `isTranscribing()` still reads
`false` spans an entire upload's wall-clock duration, not a single tick, and is open to
however many callers arrive during it, not just two. What the early check buys is the
sequential case: a caller arriving while an earlier upload's transcription is already
running is turned back before it uploads a byte; a burst of N genuinely simultaneous
uploads will each still buffer up to 8MB before any of them sets the flag. `transcribe()`'s
own `inFlight` check is still the one that counts — CPU amplification stays fully bounded
either way, since only one whisper process ever runs — so the early check is an
optimisation for the sequential case, not a memory bound on a simultaneous burst.

The guard is cheap, and the app is single-user, so this is all it needs; see [accepted
limits](#accepted-limits) for where it can wedge.

## Security posture

⚠️ **Read this as an operator warning, not a reassurance.** `ANSWER_TOKEN` gates
`/api/transcribe` exactly as it gates the three existing write paths — and it defaults to
**empty, which means open**. With `WHISPER_MODEL` configured and no token set, **any peer
that can reach the dashboard on any interface it's bound to can cause `ffmpeg` and
`whisper-cli` to run on this machine.** That is real, and it is bounded by exactly four
things: the single-flight guard above (one clip at a time, 429 otherwise), a 30-second
timeout on each spawn, the 8MB body cap, and the mime allowlist. The feature is off
entirely when `WHISPER_MODEL` is unset — the route still matches, but `probeTranscribe`
fails and the handler answers 404 before anything spawns.

This was a deliberate choice, not an oversight: singling this one route out for mandatory
auth would break the common case of a desk-only setup with no token configured, and it
would make `/api/transcribe` behave differently from every other write path in an app that
otherwise applies one consistent rule (`ANSWER_TOKEN` empty = open, matching the LAN-trust
posture documented in [remote-access](remote-access.md)). Set a token if you share the
network this dashboard is reachable on — over a tailnet, device identity is already a
stronger perimeter than the token; behind a public tunnel, treat it as the minimum. The
mitigations above are what stand in the token's place if you choose not to set one.

## Accepted limits

- **`base.en` mangles code identifiers.** Exactly why the transcript is editable and send
  stays manual (see [above](#append-never-send-the-transcript-is-a-draft-not-an-instruction)).
  `small.en` is a `.env` swap (`WHISPER_MODEL`) if it grates.
- **Backgrounding Safari loses the clip.** iOS suspends the tab mid-recording; the panel
  returns to idle with an inline error. Not worked around — there is no API to resume a
  suspended `MediaRecorder`.
- **The probe doesn't check `ffmpeg`.** `probeTranscribe` looks for the model file and a
  runnable `whisper-cli` only. A machine with whisper installed and no `ffmpeg` advertises
  `transcribe: true`, renders the mic, and then fails every real request as `transcode` —
  diagnosable from the 500, but not caught up front.
- **No rate limit beyond one-at-a-time.** The in-flight guard bounds concurrency, not
  frequency; accepted for a single-user app.
- **A wrapper-script binary could wedge the guard.** If `WHISPER_BIN` pointed at a wrapper
  that doesn't forward signals cleanly, a clip near the 120s recording cap could leave a
  30s-timeout promise unsettled and the single-flight flag stuck `true` — a permanent 429
  until restart. Not reachable with the plain `whisper-cli` binary this doc assumes.
- **Empty transcript is a success.** A clip that produces `''` still returns 200; the
  client shows "nothing heard" inline. Making silence an error would force the UI to guess
  "you didn't speak" from a status code that also means "whisper broke."
- **The backend's spawn surface grows by two external binaries** (`ffmpeg`, `whisper-cli`),
  neither bundled and neither present on a stock Mac — a real widening of the existing
  `lsof`/`ps`/`ioreg`/`open` spawn surface, accepted for what the feature buys.
