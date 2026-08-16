---
docs-sync:
  sources:
    - server/lib/config.ts
    - server/lib/transcribe.ts
    - server/api.ts
  kind: workflow
  verified: 3e1d51fd26c72d6c21bd9d6b8921ee3bb498518b
---

# Dictation — setup

Installs the engine behind [dictation](../subsystems/dictation.md): a mic button that
records in the browser and transcribes locally with whisper.cpp. Off by default —
`WHISPER_MODEL` unset disables the feature outright, the same "unset means off" rule
[push-notify](../subsystems/push-notify.md) uses for `NTFY_TOPIC`. About five minutes and
150MB of disk; no phone-side app to install, unlike [push notifications](push-notify-setup.md).

## Steps

**1. Install whisper.cpp.**

```bash
brew install whisper-cpp
```

This installs `whisper-cli` onto your `PATH` (override the lookup with `WHISPER_BIN` if
you built it elsewhere). `ffmpeg` is also required and is **not** installed by this
formula — check with `which ffmpeg` and `brew install ffmpeg` if it comes up empty.

**2. Download a model.**

```bash
mkdir -p ~/.whisper
curl -L -o ~/.whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

`base.en` is ~141MB and English-only — the smallest model still usable for dictation. It
mangles code identifiers often enough that the transcript stays editable rather than
auto-sending (see [dictation](../subsystems/dictation.md)); if that grates, `small.en` or a
multilingual model is a straight file swap — see [Choosing a different
model](#choosing-a-different-model) below.

**3. Point the dashboard at it.** In `.env` at the repo root:

```
WHISPER_MODEL=/Users/<you>/.whisper/ggml-base.en.bin
```

`WHISPER_BIN` (default `whisper-cli`) and `FFMPEG_BIN` (default `ffmpeg`) exist for a
non-PATH install of either binary — point them at an absolute path if `brew`'s symlink
isn't what you want resolved. **Restart the server** — like every other `.env`-only flag
here, this is read once at startup, not polled from Settings.

⚠️ Before turning this on somewhere other devices can reach: this endpoint has no auth
beyond the same `ANSWER_TOKEN` every other write path uses, and it defaults to empty
(open). Read [dictation's security posture](../subsystems/dictation.md#security-posture)
before configuring a model on a machine other people's devices can reach.

**4. Confirm it's live.** Open a reply window (or wait for one to appear) — the mic button
should show up in the composer's action row, before **send**. If it doesn't, see
[Troubleshooting](#troubleshooting) below.

**5. For phone use, you also need the HTTPS tunnel.**

```bash
pnpm tunnel
```

`getUserMedia` — what `MediaRecorder` is built on — refuses to run outside a secure
context, so a plain-http tailnet URL or LAN IP can never record, full stop. This step used
to be a nicety (no port number in the bookmark, no cert warning); dictation is the first
feature that makes it load-bearing. Full setup:
[remote-access](../subsystems/remote-access.md#optional-https-pnpm-tunnel).

## Choosing a different model

Any `ggml-*.bin` file from the [whisper.cpp model
list](https://huggingface.co/ggerganov/whisper.cpp/tree/main) works — download it
alongside (or instead of) `base.en` and point `WHISPER_MODEL` at it. Bigger models are
slower and more accurate; there's no code-side ceiling on size, only wall-clock (each spawn
gets 30s before the request fails as a timeout). Multiple models can coexist on disk — only
the one path `WHISPER_MODEL` names is ever loaded, and the choice takes effect after a
server restart.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No mic button at all | `GET /api/health` reports `transcribe: false` | Check `WHISPER_MODEL` points at a file that exists, and that the binary named by `WHISPER_BIN` (default `whisper-cli`) actually runs. Restart the server after fixing `.env` — `probeTranscribe` memoizes on its first call and never re-checks, so a running server won't notice the fix |
| Mic button renders but disabled, labelled `https only` | The page loaded over plain HTTP — a LAN IP, or the plain-port tailnet URL | Run `pnpm tunnel` (step 5) and load the `https://` hostname it fronts instead |
| Recording works, then "another clip is transcribing" (`429`) | Only one transcription runs at a time, by design | Wait a few seconds and try again — expected under back-to-back taps, not a bug |
| "nothing heard" after a take | The clip's transcript parsed to `''` | Not an error — speak louder or closer to the mic, or check the phone didn't mute mid-take |
| Transcription always fails (`500`, reason `transcode`) | The capability probe checks the model and `whisper-cli`, but never `ffmpeg` — so a missing `ffmpeg` still shows a working mic | `which ffmpeg`; install it if empty, or point `FFMPEG_BIN` at an absolute path |
| Transcription always fails (`500`, reason `engine`) | `whisper-cli` exited non-zero — often a model file that doesn't match what the installed binary expects | Re-download the model; confirm `whisper-cli -m <model> -f <any.wav> -nt` runs cleanly by hand |
| Every request times out (`504`) | A spawn ran past its 30s ceiling — a very slow machine, or an oversized model | Try a smaller model, or confirm nothing else is pinning the CPU |
| `403` on every attempt | `ANSWER_TOKEN` is set and the browser's saved token doesn't match | Re-enter the token in the composer's token prompt, same as the other remote-answer surfaces |
