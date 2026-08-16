# Dictation in the reply composer (local whisper) — design

Speak your follow-up instead of typing it. A mic button in `MessagePanel` records on the
phone, uploads the clip, and a locally-installed `whisper-cli` transcribes it on the Mac.
The transcript lands in the textarea as editable text; you still tap **send**.

Approved 2026-08-16 (engine, record UX, model, send flow, and the approach all confirmed
via dashboard remote answers).

## Why local whisper and not the browser's own speech API

`webkitSpeechRecognition` is free, streams interim results, and needs no install — but it
ships your audio to Apple/Google. This dashboard reads your transcripts off disk and makes
exactly one outbound call by design; routing dictated instructions through a third party
would be the loudest thing it does. Local whisper keeps the audio on the machine that
already has the transcripts. The cost is an install step and no interim text.

## Verified on this machine

| Fact | Evidence |
|---|---|
| **No whisper binary of any kind was installed (at design time)** | `command -v whisper whisper-cli whisper-cpp mlx_whisper` → all empty. The install step is part of this feature, not a precondition. Stale as of the "Confirmed" section below: `whisper-cli` is now installed at `/opt/homebrew/bin/whisper-cli` via `brew install whisper-cpp`, per Section A. |
| `ffmpeg` **is** installed | `/opt/homebrew/bin/ffmpeg` (brew formula `ffmpeg`) |
| Apple Silicon | `uname -m` → `arm64`, so whisper.cpp gets Metal acceleration |
| `HealthResponse` is the right capability carrier | [shared/types.ts:306](../../shared/types.ts) — already optional-field-shaped, already polled by the client for `origin` |
| A body reader exists but is JSON-only | `readJsonBody` / `BODY_CAP = 64 * 1024` in [server/api.ts:206](../../server/api.ts) — binary needs a sibling, not a parameter |
| Token gate helper | `tokenOk` in [server/api.ts:241](../../server/api.ts) — reused verbatim |

## Confirmed on 2026-08-16

These were read off the platform specs; each is now measured against the installed
engine and this machine's browser. Each still keeps its stated fallback, since a real
phone or a different origin could yet read differently:

1. **`getUserMedia`'s secure-context gate, measured true**: `window.isSecureContext` →
   `true` on `http://localhost:5174` (this repo's own dev server — port 5173 on this
   machine turned out to be an unrelated app, exactly the collision `WEB_PORT=5174` in
   `.env` already works around). LAN IPs and the plain-HTTP tailnet URL were not
   re-measured; `isSecureContext` is a spec-defined same-origin check, not app state, so
   the fallback stands unless a phone shows otherwise. → Section C's disabled-with-reason
   state exists for this; if it turns out Safari is laxer, that state simply never renders.
2. **`MediaRecorder` mime support, measured on desktop Chromium**:
   `MediaRecorder.isTypeSupported('audio/mp4')` → `true` and
   `('audio/webm;codecs=opus')` → `true`, both measured on this machine's Electron/Chrome
   148 browser via `localhost:5174` — not on iOS Safari or Android Chrome hardware, so the
   mp4-vs-webm split by OS is still unconfirmed on a real phone. → The mime allowlist in
   section B covers both plus wav/ogg/mpeg regardless; an unlisted type is a 400 with the
   type echoed, so a surprise codec is diagnosable in one round-trip rather than silent.
3. **`whisper-cli -nt` stdout shape and timing, measured end to end**: `say` → `ffmpeg`
   16kHz mono wav → `whisper-cli -m ggml-base.en.bin -f s.wav -nt` on a 3.2s synthesized
   clip. stdout (58 bytes) was a leading newline, a leading space, the sentence, and a
   trailing period — `This is a test of local dictation in the reply composer.` — with
   **no** trailing newline and **no** `[HH:MM:SS.mmm --> …]` timestamp brackets; all
   model/system diagnostics went to stderr, confirming the assumed split. Wall clock
   (zsh `time`): **1.275s total** (0.14s user, 0.17s system, 24% cpu — whisper's internal
   `total time` was 977.78ms, the rest being process spawn and model load). →
   `parseOutput` still defensively trims and strips timestamp brackets, since a build that
   ignores `-nt` should still yield clean text, and the leading newline/space here shows
   the trim is load-bearing, not just defensive.

## Non-goals

- **No waveform or level meter.** A pulsing dot and an elapsed timer say "recording".
- **No silence auto-stop.** It cuts you off mid-pause and needs a WebAudio analyser.
- **No streaming/partial transcript.** Whisper is batch; the UI owns a `transcribing…` state.
- **No language picker.** `base.en` is English-only; a multilingual model is a `.env` swap.
- **No dictation in `PlanPanel` / `QuestionPanel`.** `MicButton` is built reusable, but this
  spec wires it in exactly one place.
- **No model auto-download.** 148MB fetched by a documented command, never by the server.
- **No `whisper-server` residency.** Model load for `base.en` is ~100ms, so a resident
  process buys nothing at this size and costs a second long-running service plus a second
  outbound call. Revisit only if the model grows.

## A. Install (documented, not automated)

```bash
brew install whisper-cpp
curl -L -o ~/.whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

`.env`:

```
WHISPER_MODEL=/Users/<you>/.whisper/ggml-base.en.bin
```

**`WHISPER_MODEL` empty (the default) disables the feature outright**, exactly the way
`NTFY_TOPIC` empty disables pushes — one consistent "unset means off" rule rather than a
separate boolean. `WHISPER_BIN` (default `whisper-cli`) and `FFMPEG_BIN` (default `ffmpeg`)
exist for non-PATH installs.

## B. Server

### `server/lib/transcribe.ts` — new module

Pure core, thin shell, so the tests never touch audio:

| Export | Kind | Contract |
|---|---|---|
| `extForMime(mime)` | pure | `audio/mp4→m4a`, `audio/webm→webm`, `audio/ogg→ogg`, `audio/wav`\|`audio/wave`→`wav`, `audio/mpeg→mp3`; `null` for anything else |
| `buildFfmpegArgs(inPath, outPath)` | pure | `-hide_banner -loglevel error -y -i <in> -ar 16000 -ac 1 <out>` |
| `buildWhisperArgs(model, wavPath)` | pure | `-m <model> -f <wav> -nt` |
| `parseOutput(stdout)` | pure | trims, strips `[HH:MM:SS.mmm --> …]` brackets and blank lines, maps whisper's `[BLANK_AUDIO]` / `(silence)` markers to `''` |
| `probeTranscribe(config)` | cached | `false` when `WHISPER_MODEL` is unset or the file is missing; otherwise one `spawnSync(bin, ['-h'], {timeout: 2000})` whose exit code decides. Result cached for the process lifetime — **one spawn per server run, never per request** |
| `transcribe(config, bytes, mime)` | async | the orchestration below |

`transcribe` makes an `fs.mkdtemp(os.tmpdir() + '/cad-dictate-')` directory, writes the
upload under the allowlisted extension, spawns ffmpeg then whisper-cli (30s timeout each),
and removes the directory in a `finally`. Returns `{text}` or a typed failure
(`'transcode'` | `'engine'` | `'timeout'`) — never a raw stderr dump to the
client, since that would leak absolute paths.

**Heard-nothing is a success, not a failure.** A clip whose `parseOutput` yields `''`
returns 200 with `text: ''`; the client says "nothing heard" inline and leaves the composer
untouched. Making it an error would force the UI to tell "whisper broke" from "you didn't
speak" off a status code, when only one of those deserves a red state.

**One transcription at a time.** A module-level in-flight flag; a second concurrent request
gets `429`. Whisper saturates cores, and this endpoint is reachable by anything holding the
token — an unbounded fan-out would be a CPU amplifier. Cheap guard, single-user app.

### Endpoint

`POST /api/transcribe`, raw binary body, `Content-Type` set by the recorder.

| Code | When |
|---|---|
| 200 | `{text: string}` (possibly `''` when nothing was heard — the client says so inline) |
| 400 | empty body, or a mime outside the allowlist (type echoed back) |
| 403 | bad token — `tokenOk`, same as every other write path |
| 404 | feature off: `remoteAnswer` false, or `probeTranscribe` false |
| 405 | non-POST |
| 413 | body over `AUDIO_CAP = 8 * 1024 * 1024` |
| 429 | another transcription in flight |
| 500 / 504 | transcode or engine failure / spawn timeout |

**Gated by `ANSWER_TOKEN` *and* `REMOTE_ANSWER`**, like the three existing write paths. It
writes no session state, but it writes files and spawns processes on your Mac — that is
firmly on the write side of the line this codebase draws.

New `readBinaryBody(req, cap)` in `api.ts`, sibling to `readJsonBody`: same
chunk-and-destroy shape, but it must **distinguish overflow from abort** (`readJsonBody`
collapses both to `null`) so the handler can answer 413 rather than 400.

⚠️ Route `/api/transcribe` is a plain `pathname` match alongside `/api/notify/test`, well
above the `/api/sessions` prefix — no `:id` regex ordering trap here.

### `serveHealth`

Gains `transcribe: probeTranscribe(config)`. No new poll, no new endpoint: the client is
already reading this response every `refreshMs` for `origin`.

⚠️ **`transcribe` reports engine availability only — it does not fold in `remoteAnswer`**,
even though the endpoint 404s on both. That is not an oversight: a `MessagePanel` cannot be
on screen with remote answers off (the toggle calls `dismissAllMessages()`, and the panel
goes `gone`), so the mic has no surface to appear on. Keeping the flag to one meaning stops
it drifting into a second, worse copy of the remote-answer state.

### `shared/types.ts` (edited first — it is the contract)

- `HealthResponse.transcribe?: boolean`
- `TranscribeResponse { text: string }`

## C. Client

### `hooks/useDictation.ts`

Owns `MediaRecorder` and nothing else. Phases:

```
idle ──tap──→ requesting ──granted──→ recording ──tap / 120s cap──→ transcribing ──→ idle
                   │                      │                              │
                 denied                 error                          error
                   └──────────────→ error ←──────────────────────────────┘
```

- Hard **120s cap** via a timer that calls the same stop path a tap does, so a forgotten
  recording cannot run until the tab dies.
- 1s elapsed tick, mirroring `MessagePanel`'s existing `expiresAt` countdown.
- Stops the `MediaStream`'s tracks on every exit path — a live mic indicator after you
  stopped recording reads as a bug, and on iOS it is one.
- Returns `{phase, elapsed, error, start, stop}`. It does **not** know about textareas:
  the transcript comes back through an `onText(text)` callback the panel supplies.

### `components/MicButton.tsx`

Square button rendered inside `.qp-actions`, before **send**. Three visible states: idle
mic, recording (pulsing dot + `0:07`), transcribing (spinner, disabled).

Two suppressed states, and the distinction matters:

- `transcribe === false` from health → **not rendered at all**. Nothing is installed; an
  explanation would be noise on every panel.
- `window.isSecureContext === false` → **rendered but disabled**, titled
  *"needs HTTPS — run `pnpm tunnel`"*. This is precisely the phone-over-tailnet case the
  feature exists for, and a silently dead mic button is the worst possible outcome there.

### `MessagePanel` wiring

The only change to the panel: render `<MicButton>` and append its text.

**Append, never replace** — space-joined onto whatever is already in the textarea. A second
take should extend a thought, not destroy the first one. `maxLength={4000}` still applies;
the append truncates to fit rather than overflowing.

### CSS

New `.qp-mic` / `.qp-mic.rec` in `styles.css`, **theme tokens only** (`var(--amber)` when
recording, `var(--hairline)`/`var(--ink)` at rest) — a literal colour breaks the light
theme. Reuses the existing pill pulse keyframes rather than adding new ones. The mobile
rule at `styles.css:494` makes `.qp-send`/`.qp-term` `flex: 1`; `.qp-mic` is deliberately
excluded so it stays a fixed square instead of stretching to a third of the row.

## D. Tests, docs, risks

**Tests** (`test/transcribe.test.ts`, node-assert, no audio, no spawned whisper):

- `extForMime` allowlist including the rejection case
- `buildFfmpegArgs` / `buildWhisperArgs` exact argv
- `parseOutput`: timestamped output, `[BLANK_AUDIO]`, whitespace-only, multi-line joins
- `probeTranscribe`: unset model → false; missing file → false; tmpdir fixture + a stub
  binary → true; **result cached** (probe twice, assert one spawn)
- handler codes: 403 no token, 404 feature off, 400 bad mime, 413 oversize, 429 in-flight
- `readBinaryBody` distinguishes overflow from abort

**Docs**: new `docs/subsystems/dictation.md` and `docs/workflows/dictation-setup.md`
(brew + model + the HTTPS requirement); update `docs/subsystems/remote-message.md` (the
composer gains a mic), `docs/subsystems/remote-access.md` (HTTPS is now *functional*, not
just tidier), `docs/overview.md`, and the `CLAUDE.md` tree.

**Risks / accepted limits**

- **HTTPS is now load-bearing.** Dictation over plain-http tailnet or LAN is impossible;
  `pnpm tunnel` moves from optional convenience to a requirement for this one feature. The
  disabled button says so on the device where it bites.
- **The backend's spawn surface grows to two more binaries** (`ffmpeg`, `whisper-cli`),
  both external, neither bundled. Consistent with the existing `lsof`/`ps`/`ioreg`/`open`
  spawns and with "zero *npm* runtime deps", but it is a real widening — and unlike those,
  these are not present on a stock Mac.
- **A token holder can pin your CPU.** The 429 in-flight guard bounds it to one
  transcription; no rate limit beyond that, accepted for a single-user tailnet app.
- **`base.en` mangles code identifiers.** Exactly why the transcript is editable and the
  send stays manual. `small.en` is a `.env` swap if it grates.
- **Backgrounding Safari kills the recording.** iOS suspends the tab; the clip is lost, the
  panel returns to `idle` with an inline error. Not worked around.
- **Nothing is installed today**, so the feature ships dark: `transcribe:false`, no mic
  button, zero change to the current UI until you run section A.
