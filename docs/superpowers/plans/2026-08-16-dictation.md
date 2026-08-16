# Dictation in the Reply Composer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a microphone button in `MessagePanel` so a turn-end follow-up can be spoken from the phone, transcribed locally by `whisper-cli` on the Mac, and dropped into the textarea as editable text.

**Architecture:** The browser records with `MediaRecorder` and POSTs the raw clip to a new `POST /api/transcribe`. The server writes it to a temp dir, runs `ffmpeg` to make a 16kHz mono WAV, runs `whisper-cli` on that WAV, and returns `{text}`. Everything whisper-specific lives in one new module, `server/lib/transcribe.ts`, whose argv-building and output-parsing are pure functions so the test suite never spawns the real engine. The client learns whether the engine exists from a new `transcribe` flag on the health payload it already fetches.

**Tech Stack:** Node built-ins only on the server (`node:child_process`, `node:fs`, `node:os`) run through `tsx`; React + TypeScript on the client; `node:assert` tests run by `test/run-all.ts`. External binaries: `ffmpeg` (installed) and `whisper-cli` from `brew install whisper-cpp` (not installed — Task 1).

**Spec:** [docs/superpowers/specs/2026-08-16-dictation-design.md](../specs/2026-08-16-dictation-design.md)

## Global Constraints

- **ESM everywhere.** Server imports carry a `.js` suffix that resolves to `.ts` (`import { x } from './lib/transcribe.js'`).
- **Zero npm runtime dependencies in `server/`.** Node built-ins only. Spawning external binaries is allowed and established (`lsof`, `ps`, `ioreg`, `open`).
- **`shared/types.ts` is edited first.** It is the single source of truth for the FE/BE contract; producer and consumer follow it.
- **Cross-boundary imports use `import type`** — no runtime coupling between client and server.
- **Never hardcode a colour or a shadow in `styles.css`** below the theme-token block. Use `var(--amber)`, `var(--ink)`, `var(--hairline)` etc., or all five themes break.
- **Config precedence is `process.env` > `.env` > defaults**, via `loadConfig()` in `server/lib/config.ts`.
- **`WHISPER_MODEL` empty means the feature is off** — the same "unset means off" rule `NTFY_TOPIC` already uses. No separate boolean.
- **Caps, copied verbatim from the spec:** `AUDIO_CAP = 8 * 1024 * 1024` bytes; recording hard cap `120` seconds; spawn timeout `30_000` ms per binary; probe spawn timeout `2_000` ms; textarea `maxLength` stays `4000`.
- **Every server test runs offline and spawns no real whisper.** Stub binaries in a tmpdir stand in for `ffmpeg`/`whisper-cli`.
- **Run `pnpm test` and `pnpm typecheck` before every commit.**

---

### Task 1: Install the engine and confirm the three platform assumptions

The spec records three assumptions read off platform docs rather than measured here. Confirm them before any code depends on them. This task writes no application code; its deliverable is a working command line, three recorded answers, and a `.env` entry.

**Files:**
- Modify: `.env` (gitignored — never commit it)

- [ ] **Step 1: Install whisper-cpp and the base.en model**

```bash
brew install whisper-cpp
mkdir -p ~/.whisper
curl -L -o ~/.whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Expected: `~/.whisper/ggml-base.en.bin` is roughly 148MB. Verify with `ls -lh ~/.whisper/`.

- [ ] **Step 2: Confirm the binary name and that `-h` exits without an error**

```bash
command -v whisper-cli && whisper-cli -h >/dev/null 2>&1; echo "exit=$?"
```

Expected: a path is printed. Record the exit code. If `whisper-cli` does not exist, list what brew installed with `ls $(brew --prefix)/bin | grep -i whisper` and use that name everywhere below.

- [ ] **Step 3: Transcribe a real clip end to end, and time it**

`say` and `ffmpeg` are both already on this machine, so this needs no browser and no microphone:

```bash
cd $(mktemp -d) && say -o s.aiff "This is a test of local dictation in the reply composer" \
  && ffmpeg -hide_banner -loglevel error -y -i s.aiff -ar 16000 -ac 1 s.wav \
  && time whisper-cli -m ~/.whisper/ggml-base.en.bin -f s.wav -nt
```

Expected: the sentence on stdout. **Record two things: the exact stdout shape (does `-nt` really suppress `[00:00:00.000 --> …]` brackets?) and the wall-clock time.** Both feed Task 4's parser tests and the docs.

- [ ] **Step 4: Confirm the browser assumptions**

Open the dev server (`pnpm dev`, then http://localhost:5173) and run in the browser console:

```js
[window.isSecureContext,
 MediaRecorder.isTypeSupported('audio/mp4'),
 MediaRecorder.isTypeSupported('audio/webm;codecs=opus')]
```

Expected: `isSecureContext` is `true` on localhost. Record which mime types report supported — this fixes the preference order in Task 7's `pickMimeType`. Repeat on the phone later; localhost is enough to proceed.

- [ ] **Step 5: Point `.env` at the model**

Append to `.env` (create it if absent), using your real home path:

```
WHISPER_MODEL=/Users/<you>/.whisper/ggml-base.en.bin
```

- [ ] **Step 6: Record the findings in the spec's assumptions section**

Edit `docs/superpowers/specs/2026-08-16-dictation-design.md`: change the heading "Assumed — confirm in implementation step 1, before building on them" to "Confirmed on 2026-08-16" and replace each numbered assumption's wording with what you measured (secure-context result, the actual mime types, the real stdout shape, the timing).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-dictation-design.md
git commit -m "docs: confirm dictation platform assumptions against the installed engine"
```

---

### Task 2: Config keys and the shared contract

**Files:**
- Modify: `shared/types.ts` (add `transcribe` to `HealthResponse`, add `TranscribeResponse`)
- Modify: `server/lib/config.ts` (three keys)
- Create: `test/transcribe.test.ts`
- Modify: `test/run-all.ts` (register the new suite)

**Interfaces:**
- Consumes: nothing.
- Produces: `Config.whisperBin: string`, `Config.whisperModel: string`, `Config.ffmpegBin: string`; `HealthResponse.transcribe?: boolean`; `TranscribeResponse { text: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/transcribe.test.ts`:

```ts
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../server/lib/config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Write a throwaway .env and load config from it. */
function withEnvFile(body: string, fn: (cfg: ReturnType<typeof loadConfig>) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tr-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, body);
  try { fn(loadConfig({ envPath })); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function run(): number {
  console.log('\n=== transcribe.ts ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('config defaults leave the feature off', () => {
    withEnvFile('', cfg => {
      assert.equal(cfg.whisperModel, '');
      assert.equal(cfg.whisperBin, 'whisper-cli');
      assert.equal(cfg.ffmpegBin, 'ffmpeg');
    });
  }));

  check(test('config reads all three keys from .env', () => {
    withEnvFile('WHISPER_MODEL=/m/base.bin\nWHISPER_BIN=/opt/w\nFFMPEG_BIN=/opt/ff\n', cfg => {
      assert.equal(cfg.whisperModel, '/m/base.bin');
      assert.equal(cfg.whisperBin, '/opt/w');
      assert.equal(cfg.ffmpegBin, '/opt/ff');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
```

- [ ] **Step 2: Register the suite and run it to verify it fails**

In `test/run-all.ts`, add the import alongside the others and the `failed +=` call in the same relative position:

```ts
import { run as runTranscribe } from './transcribe.test.js';
```
```ts
failed += runTranscribe();
```

Run: `pnpm test`
Expected: FAIL — `whisperModel` is `undefined`, not `''`.

- [ ] **Step 3: Add the config keys**

In `server/lib/config.ts`, add to the `Config` interface:

```ts
  /**
   * Path to a GGML whisper model. Empty (the default) disables dictation
   * outright, the same way an empty `NTFY_TOPIC` disables pushes — one
   * "unset means off" rule rather than a separate boolean.
   */
  whisperModel: string;
  /** whisper.cpp CLI. Override for a non-PATH install. */
  whisperBin: string;
  /** ffmpeg, used to make whisper-readable 16kHz mono WAV from browser audio. */
  ffmpegBin: string;
```

to `DEFAULTS`:

```ts
  WHISPER_MODEL: '',
  WHISPER_BIN: 'whisper-cli',
  FFMPEG_BIN: 'ffmpeg',
```

and to the object `loadConfig` returns:

```ts
    whisperModel: (src('WHISPER_MODEL') || DEFAULTS.WHISPER_MODEL).trim(),
    whisperBin: (src('WHISPER_BIN') || DEFAULTS.WHISPER_BIN).trim(),
    ffmpegBin: (src('FFMPEG_BIN') || DEFAULTS.FFMPEG_BIN).trim(),
```

- [ ] **Step 4: Add the shared types**

In `shared/types.ts`, add to `HealthResponse`:

```ts
  /**
   * True when a whisper model and CLI are both present. Engine availability
   * only — it deliberately does not fold in `remoteAnswer`, even though the
   * endpoint 404s on both, because a MessagePanel cannot be on screen with
   * remote answers off. One flag, one meaning.
   */
  transcribe?: boolean;
```

and after it:

```ts
/** `POST /api/transcribe` — text may be '' when the clip held no speech. */
export interface TranscribeResponse {
  text: string;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS, and the printed case count is two higher.

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts server/lib/config.ts test/transcribe.test.ts test/run-all.ts
git commit -m "feat(transcribe): add whisper config keys and the health/response contract"
```

---

### Task 3: Pure argv builders and output parser

**Files:**
- Create: `server/lib/transcribe.ts`
- Modify: `test/transcribe.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 2.
- Produces: `extForMime(mime: string): string | null`, `buildFfmpegArgs(inPath: string, outPath: string): string[]`, `buildWhisperArgs(model: string, wavPath: string): string[]`, `parseOutput(stdout: string): string`.

- [ ] **Step 1: Write the failing tests**

Add the import to `test/transcribe.test.ts`:

```ts
import {
  buildFfmpegArgs, buildWhisperArgs, extForMime, parseOutput
} from '../server/lib/transcribe.js';
```

and these checks inside `run()`, before the summary:

```ts
  check(test('extForMime maps the recorder types, codecs suffix and all', () => {
    assert.equal(extForMime('audio/mp4'), 'm4a');
    assert.equal(extForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extForMime('AUDIO/WAV'), 'wav');
    assert.equal(extForMime('audio/ogg'), 'ogg');
    assert.equal(extForMime('audio/mpeg'), 'mp3');
  }));

  check(test('extForMime rejects anything unlisted', () => {
    assert.equal(extForMime('video/mp4'), null);
    assert.equal(extForMime('application/json'), null);
    assert.equal(extForMime(''), null);
  }));

  check(test('buildFfmpegArgs downmixes to 16kHz mono, overwriting', () => {
    assert.deepEqual(buildFfmpegArgs('/t/in.m4a', '/t/out.wav'), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', '/t/in.m4a', '-ar', '16000', '-ac', '1', '/t/out.wav'
    ]);
  }));

  check(test('buildWhisperArgs asks for untimestamped text', () => {
    assert.deepEqual(buildWhisperArgs('/m/base.bin', '/t/out.wav'),
      ['-m', '/m/base.bin', '-f', '/t/out.wav', '-nt']);
  }));

  check(test('parseOutput strips timestamps and joins lines', () => {
    const raw = '[00:00:00.000 --> 00:00:02.400]   Hello there\n'
              + '[00:00:02.400 --> 00:00:04.000]   second line\n';
    assert.equal(parseOutput(raw), 'Hello there second line');
  }));

  check(test('parseOutput treats blank-audio markers as no speech', () => {
    assert.equal(parseOutput('[BLANK_AUDIO]\n'), '');
    assert.equal(parseOutput('  \n\n'), '');
    assert.equal(parseOutput('(silence)'), '');
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../server/lib/transcribe.js`.

- [ ] **Step 3: Write the module**

Create `server/lib/transcribe.ts`:

```ts
/**
 * transcribe.ts — local speech-to-text for the reply composer.
 *
 * Browser audio in, plain text out: ffmpeg normalises whatever the recorder
 * produced into the 16kHz mono WAV whisper.cpp insists on, then `whisper-cli`
 * transcribes it. Everything here that can be pure is pure, so the suite never
 * spawns a real engine — see docs/subsystems/dictation.md.
 */

/** Recorder mime → temp-file extension. The allowlist bounds what we accept. */
const MIME_EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3'
};

/** The extension for a Content-Type, or null when it is not one we accept. */
export function extForMime(mime: string): string | null {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[base] ?? null;
}

export function buildFfmpegArgs(inPath: string, outPath: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', outPath];
}

export function buildWhisperArgs(model: string, wavPath: string): string[] {
  return ['-m', model, '-f', wavPath, '-nt'];
}

/** `[00:00:01.000 --> 00:00:02.000]` line prefixes, stripped defensively. */
const TS_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/;
/** whisper's own "nothing here" markers, in the shapes it prints them. */
const BLANK_RE = /^[([](?:blank_audio|silence|inaudible)[)\]]$/i;

/**
 * whisper stdout → one line of text. `-nt` should already suppress timestamps,
 * but stripping them here means a build that ignores the flag still yields
 * clean text rather than bracketed noise in the composer.
 */
export function parseOutput(stdout: string): string {
  return String(stdout || '')
    .split('\n')
    .map(line => line.replace(TS_RE, '').trim())
    .filter(line => line !== '' && !BLANK_RE.test(line))
    .join(' ')
    .trim();
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/transcribe.ts test/transcribe.test.ts
git commit -m "feat(transcribe): pure argv builders and whisper output parser"
```

---

### Task 4: The cached capability probe

**Files:**
- Modify: `server/lib/transcribe.ts`
- Modify: `test/transcribe.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2).
- Produces: `probeTranscribe(config: Config): boolean`, `resetProbe(): void` (tests only).

- [ ] **Step 1: Write the failing tests**

Extend the import in `test/transcribe.test.ts` with `probeTranscribe, resetProbe`, and add this helper above `run()`:

```ts
/** A throwaway executable that exits 0 and prints nothing. */
function stubBin(dir: string, name: string, body = '#!/bin/bash\nexit 0\n'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}
```

and these checks:

```ts
  check(test('probe is false with no model configured', () => {
    resetProbe();
    withEnvFile('', cfg => assert.equal(probeTranscribe(cfg), false));
  }));

  check(test('probe is false when the model file is missing', () => {
    resetProbe();
    withEnvFile('WHISPER_MODEL=/nope/missing.bin\n', cfg =>
      assert.equal(probeTranscribe(cfg), false));
  }));

  check(test('probe is true with a real model file and a runnable binary', () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'whisper-stub');
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), true));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(test('probe is false when the binary does not exist', () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe2-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${path.join(dir, 'nothing-here')}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), false));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(test('probe caches — a later config change is not re-read', () => {
    resetProbe();
    withEnvFile('', cfg => assert.equal(probeTranscribe(cfg), false));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-probe3-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'whisper-stub');
      // Same process, no resetProbe(): the cached `false` must win.
      withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg =>
        assert.equal(probeTranscribe(cfg), false));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    resetProbe();
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `probeTranscribe` is not exported.

- [ ] **Step 3: Implement the probe**

Add to the top of `server/lib/transcribe.ts`:

```ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import type { Config } from './config.js';
```

and at the end of the file:

```ts
/** Probe result for this process. `null` = not probed yet. */
let probed: boolean | null = null;

/** Drop the cached probe. Tests only — a running server never changes engines. */
export function resetProbe(): void {
  probed = null;
}

function computeProbe(config: Config): boolean {
  if (!config.whisperModel) return false;
  try {
    if (!fs.statSync(config.whisperModel).isFile()) return false;
  } catch {
    return false;
  }
  // `!error` rather than `status === 0`: this asks "is the binary there and
  // executable", not "does this build agree about -h". Version-proof, and
  // ENOENT/timeout both land in `error`.
  try {
    return !spawnSync(config.whisperBin, ['-h'], { timeout: 2_000, stdio: 'ignore' }).error;
  } catch {
    return false;
  }
}

/**
 * Is dictation available? Cached for the process lifetime: one spawn per server
 * run, never one per request, and the health endpoint is polled every few
 * seconds by every open tab.
 */
export function probeTranscribe(config: Config): boolean {
  if (probed === null) probed = computeProbe(config);
  return probed;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/transcribe.ts test/transcribe.test.ts
git commit -m "feat(transcribe): cached engine-availability probe"
```

---

### Task 5: The orchestration — temp dir, two spawns, one in flight

**Files:**
- Modify: `server/lib/transcribe.ts`
- Modify: `test/transcribe.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3 and 4.
- Produces: `type TranscribeFail = 'transcode' | 'engine' | 'timeout' | 'busy'`; `type TranscribeOutcome = { ok: true; text: string } | { ok: false; reason: TranscribeFail }`; `transcribe(config: Config, bytes: Buffer, ext: string): Promise<TranscribeOutcome>`.

> **Spec refinement:** the spec's failure union omits `'busy'` while its endpoint table lists a 429. `'busy'` belongs in the union — it is how the in-flight guard reports, and the handler maps it to 429.

- [ ] **Step 1: Write the failing tests**

Extend the import with `transcribe`, and add:

```ts
async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}
```

`run()` must become `async` and return `Promise<number>`; update its call in `test/run-all.ts` to `failed += await runTranscribe();`. Then add:

```ts
  check(await testAsync('transcribe returns parsed text from the stubbed engine', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      // ffmpeg stub: create the output file (always the last argument).
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\nexit 0\n');
      const wh = stubBin(dir, 'wh-stub',
        '#!/bin/bash\necho "[00:00:00.000 --> 00:00:01.500]   spoken words"\nexit 0\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake-audio'), 'm4a').then(out => {
            assert.deepEqual(out, { ok: true, text: 'spoken words' });
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a failing ffmpeg reports transcode, not engine', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run2-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-bad', '#!/bin/bash\nexit 1\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho hi\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake'), 'm4a').then(out => {
            assert.deepEqual(out, { ok: false, reason: 'transcode' });
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('a second concurrent call is refused as busy', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run3-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-slow', '#!/bin/bash\nsleep 0.4\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "first"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          const a = transcribe(cfg, Buffer.from('fake'), 'm4a');
          const b = transcribe(cfg, Buffer.from('fake'), 'm4a');
          void Promise.all([a, b]).then(([first, second]) => {
            assert.deepEqual(second, { ok: false, reason: 'busy' });
            assert.equal(first.ok, true);
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('the temp directory is removed afterwards', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-run4-'));
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const ff = stubBin(dir, 'ff-stub', '#!/bin/bash\nout="${@: -1}"\n: > "$out"\n');
      const wh = stubBin(dir, 'wh-stub', '#!/bin/bash\necho "words"\n');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${wh}\nFFMPEG_BIN=${ff}\n`, cfg => {
          void transcribe(cfg, Buffer.from('fake'), 'm4a').then(() => {
            const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('cad-dictate-')).length;
            assert.equal(after, before);
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `transcribe` is not exported.

- [ ] **Step 3: Implement the orchestration**

Extend the imports at the top of `server/lib/transcribe.ts`:

```ts
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

and append:

```ts
/** Per-spawn wall-clock ceiling. A 120s clip transcribes in seconds. */
const SPAWN_TIMEOUT_MS = 30_000;

export type TranscribeFail = 'transcode' | 'engine' | 'timeout' | 'busy';
export type TranscribeOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: TranscribeFail };

interface SpawnOutcome { code: number | null; stdout: string; timedOut: boolean }

/** Run a binary to completion, capturing stdout. Never rejects. */
function run(bin: string, args: string[]): Promise<SpawnOutcome> {
  return new Promise(resolve => {
    let stdout = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve({ code: null, stdout: '', timedOut: false });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, SPAWN_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout: '', timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, timedOut }); });
  });
}

/**
 * One transcription at a time. Whisper saturates cores, and this endpoint is
 * reachable by anything holding the token — unbounded fan-out would turn it
 * into a CPU amplifier. A single-user app needs no cleverer limiter than this.
 */
let inFlight = false;

/**
 * Browser audio → text. Writes the clip to a private temp directory, normalises
 * it with ffmpeg, transcribes the WAV, and removes the directory on every path.
 * Failures are typed, never raw stderr: that would leak absolute paths.
 */
export async function transcribe(
  config: Config, bytes: Buffer, ext: string
): Promise<TranscribeOutcome> {
  if (inFlight) return { ok: false, reason: 'busy' };
  inFlight = true;
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-dictate-'));
    const inPath = path.join(dir, `clip.${ext}`);
    const wavPath = path.join(dir, 'clip.wav');
    fs.writeFileSync(inPath, bytes);

    const ff = await run(config.ffmpegBin, buildFfmpegArgs(inPath, wavPath));
    if (ff.timedOut) return { ok: false, reason: 'timeout' };
    if (ff.code !== 0) return { ok: false, reason: 'transcode' };

    const wh = await run(config.whisperBin, buildWhisperArgs(config.whisperModel, wavPath));
    if (wh.timedOut) return { ok: false, reason: 'timeout' };
    if (wh.code !== 0) return { ok: false, reason: 'engine' };

    // '' is a legitimate result: you tapped the mic and said nothing. The
    // caller answers 200 with empty text; only a broken engine is an error.
    return { ok: true, text: parseOutput(wh.stdout) };
  } catch {
    return { ok: false, reason: 'engine' };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
    inFlight = false;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/transcribe.ts test/transcribe.test.ts test/run-all.ts
git commit -m "feat(transcribe): temp-dir orchestration with an in-flight guard"
```

---

### Task 6: The endpoint, the binary body reader, and the health flag

**Files:**
- Modify: `server/api.ts` (add `readBinaryBody`, `serveTranscribe`; extend `serveHealth`)
- Modify: `server/index.ts` (route)
- Modify: `test/transcribe.test.ts`

**Interfaces:**
- Consumes: `transcribe`, `probeTranscribe`, `extForMime` (Tasks 3–5).
- Produces: `readBinaryBody(req, cap): Promise<{ok: true; bytes: Buffer} | {ok: false; reason: 'overflow' | 'aborted'}>`; `serveTranscribe(config, req, res): Promise<void>`; `HealthResponse.transcribe` populated.

- [ ] **Step 1: Write the failing tests**

Add to `test/transcribe.test.ts`:

```ts
import http from 'node:http';
import { readBinaryBody, serveTranscribe } from '../server/api.js';
```

and a helper above `run()`:

```ts
/** POST a body to a one-shot server wrapping `serveTranscribe`, return the reply. */
function post(cfg: ReturnType<typeof loadConfig>, contentType: string, body: Buffer, token?: string):
  Promise<{ status: number; json: any }> {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => void serveTranscribe(cfg, req, res));
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      const headers: Record<string, string> = { 'Content-Type': contentType };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = http.request({ port, method: 'POST', path: '/api/transcribe', headers }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          srv.close();
          resolve({ status: res.statusCode || 0, json: (() => { try { return JSON.parse(raw); } catch { return null; } })() });
        });
      });
      req.end(body);
    });
  });
}
```

and these checks:

```ts
  check(await testAsync('404 when no engine is configured', async () => {
    resetProbe();
    await new Promise<void>(done => {
      withEnvFile('', cfg => {
        void post(cfg, 'audio/mp4', Buffer.from('x')).then(r => {
          assert.equal(r.status, 404); done();
        });
      });
    });
  }));

  check(await testAsync('403 when the token is wrong', async () => {
    resetProbe();
    await new Promise<void>(done => {
      withEnvFile('ANSWER_TOKEN=secret\n', cfg => {
        void post(cfg, 'audio/mp4', Buffer.from('x'), 'wrong').then(r => {
          assert.equal(r.status, 403); done();
        });
      });
    });
  }));

  // ⚠️ `getState()` overlays the gitignored .remote-answer.json in the CWD on
  // top of the env gate. If this test proves flaky against a repo where that
  // file exists, wrap it in a tmpdir chdir the way test/messages.test.ts does
  // with its `inTmpCwd` helper — do not weaken the assertion.
  check(await testAsync('404 when remote answers are disabled', async () => {
    resetProbe();
    await new Promise<void>(done => {
      withEnvFile('REMOTE_ANSWER=false\n', cfg => {
        void post(cfg, 'audio/mp4', Buffer.from('x')).then(r => {
          assert.equal(r.status, 404); done();
        });
      });
    });
  }));

  check(await testAsync('400 names the unsupported content type', async () => {
    resetProbe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ep-'));
    try {
      const model = path.join(dir, 'ggml.bin');
      fs.writeFileSync(model, 'x');
      const bin = stubBin(dir, 'wh-stub');
      await new Promise<void>(done => {
        withEnvFile(`WHISPER_MODEL=${model}\nWHISPER_BIN=${bin}\n`, cfg => {
          void post(cfg, 'video/mp4', Buffer.from('x')).then(r => {
            assert.equal(r.status, 400);
            assert.match(String(r.json?.error), /video\/mp4/);
            done();
          });
        });
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }));

  check(await testAsync('readBinaryBody reports overflow distinctly from abort', async () => {
    const srv = http.createServer((req, res) => {
      void readBinaryBody(req, 8).then(out => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.ok ? { ok: true, n: out.bytes.length } : out));
      });
    });
    await new Promise<void>(done => {
      srv.listen(0, () => {
        const port = (srv.address() as { port: number }).port;
        const req = http.request({ port, method: 'POST', path: '/' }, res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            srv.close();
            assert.deepEqual(JSON.parse(raw), { ok: false, reason: 'overflow' });
            done();
          });
        });
        req.end(Buffer.alloc(64, 1));
      });
    });
  }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `readBinaryBody` / `serveTranscribe` are not exported from `server/api.ts`.

- [ ] **Step 3: Implement the reader, the handler, and the health flag**

In `server/api.ts`, add to the imports:

```ts
import { extForMime, probeTranscribe, transcribe } from './lib/transcribe.js';
```

Below `readJsonBody`, add:

```ts
/** Audio-body cap. A 120s AAC clip is ~2MB; 8MB leaves room for verbose codecs. */
const AUDIO_CAP = 8 * 1024 * 1024;

export type BinaryBody =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'overflow' | 'aborted' };

/**
 * Buffer a raw request body. Sibling to `readJsonBody`, but it keeps overflow
 * and abort apart — `readJsonBody` collapses both to null, and this caller has
 * to answer 413 for one and 400 for the other.
 */
export function readBinaryBody(req: IncomingMessage, cap = AUDIO_CAP): Promise<BinaryBody> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: BinaryBody): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        finish({ ok: false, reason: 'overflow' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, reason: 'aborted' }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
  });
}

/**
 * `POST /api/transcribe` — a recorded clip in, one line of text out.
 *
 * Gated like the three write paths even though it writes no session state: it
 * spawns processes and writes files on this machine, which is firmly the write
 * side of the line this codebase draws. See docs/subsystems/dictation.md.
 */
export async function serveTranscribe(
  config: Config, req: IncomingMessage, res: ServerResponse
): Promise<void> {
  if (!getState(config).remoteAnswer) return sendJson(res, 404, { error: 'remote answers disabled' });
  if (!tokenOk(config, req)) return sendJson(res, 403, { error: 'bad token' });
  if (!probeTranscribe(config)) return sendJson(res, 404, { error: 'no transcription engine' });

  const mime = String(req.headers['content-type'] || '');
  const ext = extForMime(mime);
  if (!ext) return sendJson(res, 400, { error: `unsupported audio type: ${mime}` });

  const body = await readBinaryBody(req, AUDIO_CAP);
  if (!body.ok) {
    return body.reason === 'overflow'
      ? sendJson(res, 413, { error: 'clip too large' })
      : sendJson(res, 400, { error: 'upload aborted' });
  }
  if (body.bytes.length === 0) return sendJson(res, 400, { error: 'empty body' });

  const out = await transcribe(config, body.bytes, ext);
  if (out.ok) return sendJson(res, 200, { text: out.text });
  const code = out.reason === 'busy' ? 429 : out.reason === 'timeout' ? 504 : 500;
  return sendJson(res, code, { error: out.reason });
}
```

Then extend `serveHealth` (around `server/api.ts:262`) with one field:

```ts
    origin: classifyOrigin(req?.socket?.remoteAddress, req?.headers),
    transcribe: probeTranscribe(config)
```

- [ ] **Step 4: Add the route**

In `server/index.ts`, add `serveTranscribe` to the import list from `./api.js`, and put the route beside `/api/notify/test` (a plain pathname match — no `:id` ordering trap):

```ts
  // Dictation: a recorded clip in, text out (see docs/subsystems/dictation.md).
  if (u.pathname === '/api/transcribe') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return void serveTranscribe(config, req, res);
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 6: Verify the live endpoint refuses politely**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4173/api/transcribe -H 'Content-Type: video/mp4' --data-binary 'x'
```

Expected: `400` with a real engine installed, `404` without one. Start the server first if it is not running.

- [ ] **Step 7: Commit**

```bash
git add server/api.ts server/index.ts test/transcribe.test.ts
git commit -m "feat(transcribe): POST /api/transcribe, binary body reader, health flag"
```

---

### Task 7: Pure client helpers

The client has no DOM test harness — its tested code is pure libs (`lib/markdown.ts`, `lib/chatFilter.ts`, `lib/deepLink.ts`). So the logic worth testing comes out of the hook and into a lib, and Task 8's hook stays thin enough to verify in a browser.

**Files:**
- Create: `client/src/lib/dictation.ts`
- Create: `test/dictation.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `appendTranscript(existing: string, incoming: string, cap?: number): string`, `fmtElapsed(secs: number): string`, `pickMimeType(supported: (t: string) => boolean): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/dictation.test.ts`:

```ts
import assert from 'node:assert';

import { appendTranscript, fmtElapsed, pickMimeType } from '../client/src/lib/dictation.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== dictation.ts (client) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(test('appends to existing text with a single space', () => {
    assert.equal(appendTranscript('first thought', 'second thought'), 'first thought second thought');
  }));

  check(test('an empty composer takes the transcript verbatim', () => {
    assert.equal(appendTranscript('', 'hello'), 'hello');
    assert.equal(appendTranscript('   ', 'hello'), 'hello');
  }));

  check(test('an empty transcript leaves the composer untouched', () => {
    assert.equal(appendTranscript('keep me', ''), 'keep me');
    assert.equal(appendTranscript('keep me', '   '), 'keep me');
  }));

  check(test('truncates to the cap rather than overflowing maxLength', () => {
    assert.equal(appendTranscript('abcd', 'efgh', 6), 'abcd e');
    assert.equal(appendTranscript('abcdef', 'ghi', 6), 'abcdef');
  }));

  check(test('fmtElapsed reads as a stopwatch', () => {
    assert.equal(fmtElapsed(0), '0:00');
    assert.equal(fmtElapsed(7), '0:07');
    assert.equal(fmtElapsed(83), '1:23');
    assert.equal(fmtElapsed(120), '2:00');
  }));

  check(test('pickMimeType prefers mp4, falls back to webm, then to nothing', () => {
    assert.equal(pickMimeType(t => t === 'audio/mp4'), 'audio/mp4');
    assert.equal(pickMimeType(t => t === 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
    assert.equal(pickMimeType(() => false), '');
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
```

Register it in `test/run-all.ts` the same way as the others:

```ts
import { run as runDictation } from './dictation.test.js';
```
```ts
failed += runDictation();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../client/src/lib/dictation.js`.

- [ ] **Step 3: Write the lib**

Create `client/src/lib/dictation.ts`:

```ts
/**
 * dictation.ts — the parts of the mic flow that are just data.
 *
 * Kept out of the hook so they can be tested: the client suite is node-assert
 * over pure libs, with no DOM. Everything MediaRecorder-shaped lives in
 * hooks/useDictation.ts instead.
 */

/** Recorder types worth asking for, best first. Order set by Task 1's probe. */
const PREFERRED = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];

/**
 * The first supported recorder mime, or '' to let the browser choose its own
 * default (Safari and Chrome disagree, and both defaults are acceptable to the
 * server's allowlist).
 */
export function pickMimeType(supported: (t: string) => boolean): string {
  return PREFERRED.find(t => supported(t)) ?? '';
}

/** `0:07`, `1:23` — a stopwatch, not a duration. */
export function fmtElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Fold a transcript into whatever is already typed.
 *
 * Append, never replace: a second take should extend a thought, not destroy the
 * first one. Truncates to `cap` so the result still fits the textarea's
 * maxLength instead of being silently clipped by the DOM.
 */
export function appendTranscript(existing: string, incoming: string, cap = 4000): string {
  const head = existing.trim();
  const tail = incoming.trim();
  if (!tail) return existing;
  if (!head) return tail.slice(0, cap);
  return `${head} ${tail}`.slice(0, cap);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/dictation.ts test/dictation.test.ts test/run-all.ts
git commit -m "feat(dictation): pure client helpers for transcript append and timing"
```

---

### Task 8: The hook, the button, the styles, and the wiring

**Files:**
- Create: `client/src/hooks/useTranscribeAvailable.ts`
- Create: `client/src/hooks/useDictation.ts`
- Create: `client/src/components/MicButton.tsx`
- Modify: `client/src/components/MessagePanel.tsx`
- Modify: `client/src/styles.css` (after the `.qp-term` rule, around line 473)

**Interfaces:**
- Consumes: `appendTranscript`, `fmtElapsed`, `pickMimeType` (Task 7); `POST /api/transcribe` and `HealthResponse.transcribe` (Tasks 2, 6).
- Produces: `<MicButton onText={(t: string) => void} disabled={boolean} />`.

- [ ] **Step 1: Write the capability hook**

Create `client/src/hooks/useTranscribeAvailable.ts`:

```ts
import { useEffect, useState } from 'react';

import type { HealthResponse } from '../../../shared/types';

/**
 * Is dictation available on the server?
 *
 * Fetched once per page load and memoised at module scope, not polled: the
 * server's own probe is cached for its process lifetime, so the answer cannot
 * change without a restart. Same read-once-then-share shape as lib/deepLink.ts.
 */
let cached: Promise<boolean> | null = null;

function read(): Promise<boolean> {
  if (!cached) {
    cached = fetch('/api/health')
      .then(res => res.json())
      .then((body: HealthResponse) => body?.transcribe === true)
      .catch(() => false);
  }
  return cached;
}

export function useTranscribeAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void read().then(v => { if (live) setAvailable(v); });
    return () => { live = false; };
  }, []);
  return available;
}
```

- [ ] **Step 2: Write the recorder hook**

Create `client/src/hooks/useDictation.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import { pickMimeType } from '../lib/dictation';
import { usePersistedState } from './usePersistedState';
import type { TranscribeResponse } from '../../../shared/types';

/** Hard ceiling on one take, so a forgotten recording cannot run to tab death. */
const MAX_SECS = 120;

export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing';

export interface DictationState {
  phase: DictationPhase;
  elapsed: number;
  error: string;
  toggle: () => void;
}

/**
 * Tap to record, tap to stop, upload, hand the text back.
 *
 * Owns MediaRecorder and nothing else — the transcript leaves through
 * `onText`, so the hook never knows a textarea exists. Every exit path stops
 * the MediaStream's tracks: a mic indicator still lit after you stopped reads
 * as a bug, and on iOS it is one.
 */
export function useDictation(onText: (text: string) => void): DictationState {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [token] = usePersistedState<string>('dashboard.answerToken', '');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // Elapsed tick + the 120s cap, both driven off one interval.
  useEffect(() => {
    if (phase !== 'recording') return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      setElapsed(secs);
      if (secs >= MAX_SECS) recorderRef.current?.stop();
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // A drawer that closes mid-take must not leave the mic open.
  useEffect(() => stopTracks, [stopTracks]);

  const upload = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    const headers: Record<string, string> = { 'Content-Type': blob.type || 'audio/mp4' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', headers, body: blob });
      if (!res.ok) {
        setError(res.status === 429 ? 'another clip is transcribing' : 'transcription failed');
        return;
      }
      const body = (await res.json()) as TranscribeResponse;
      if (!body.text) setError('nothing heard');
      else onText(body.text);
    } catch {
      setError('transcription failed');
    } finally {
      setPhase('idle');
    }
  }, [token, onText]);

  const start = useCallback(async () => {
    setError('');
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stopTracks();
        void upload(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/mp4' }));
      };
      recorderRef.current = rec;
      rec.start();
      setPhase('recording');
    } catch {
      stopTracks();
      setError('microphone unavailable');
      setPhase('idle');
    }
  }, [stopTracks, upload]);

  const toggle = useCallback(() => {
    if (phase === 'recording') recorderRef.current?.stop();
    else if (phase === 'idle') void start();
  }, [phase, start]);

  return { phase, elapsed, error, toggle };
}
```

- [ ] **Step 3: Write the button**

Create `client/src/components/MicButton.tsx`:

```tsx
import { useDictation } from '../hooks/useDictation';
import { useTranscribeAvailable } from '../hooks/useTranscribeAvailable';
import { fmtElapsed } from '../lib/dictation';

/**
 * Tap-to-record mic for a text composer. Hands transcribed text to `onText`;
 * knows nothing about what the text is for.
 *
 * Two suppressed states, and the difference matters. No engine installed → not
 * rendered at all, because an explanation would be noise on every panel. No
 * secure context → rendered but disabled and labelled, because that is the
 * phone-over-plain-http case this feature exists for, and a silently dead
 * button is the worst outcome there.
 */
export default function MicButton(
  { onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }
) {
  const available = useTranscribeAvailable();
  const { phase, elapsed, error, toggle } = useDictation(onText);

  if (!available) return null;

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (!secure) {
    return (
      <button type="button" className="qp-mic" disabled title="needs HTTPS — run `pnpm tunnel`">
        🎙 https only
      </button>
    );
  }

  const busy = phase === 'requesting' || phase === 'transcribing';
  const label =
    phase === 'recording' ? fmtElapsed(elapsed)
    : phase === 'transcribing' ? '…'
    : '🎙';

  return (
    <>
      <button
        type="button"
        className={`qp-mic${phase === 'recording' ? ' rec' : ''}`}
        aria-pressed={phase === 'recording'}
        aria-label={phase === 'recording' ? 'stop recording' : 'record a spoken reply'}
        disabled={disabled || busy}
        onClick={toggle}
      >
        {label}
      </button>
      {error && <span className="qp-note">{error}</span>}
    </>
  );
}
```

- [ ] **Step 4: Wire it into the panel**

In `client/src/components/MessagePanel.tsx`, add the imports:

```ts
import MicButton from './MicButton';
import { appendTranscript } from '../lib/dictation';
```

and add the button as the first child of the existing `.qp-actions` div, before the send button:

```tsx
      <div className="qp-actions">
        <MicButton disabled={busy} onText={t => setText(cur => appendTranscript(cur, t))} />
        <button
```

- [ ] **Step 5: Add the styles**

In `client/src/styles.css`, immediately after the `.qp-term:hover` rule (around line 473), add — **theme tokens only, no literal colours**:

```css
/* dictation mic — fixed square in the actions row. Deliberately excluded from
   the mobile flex:1 rule below, so it never stretches to a third of the row. */
.qp-mic{font-family:var(--font);font-size:12px;color:var(--ink2);background:var(--strip);border:1px solid var(--hairline);border-radius:2px;padding:7px 11px;min-width:44px;cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.qp-mic:hover:not(:disabled){color:var(--ink);border-color:var(--hairline2)}
.qp-mic:disabled{cursor:default;opacity:.45}
.qp-mic.rec{color:var(--on-accent);background:var(--amber);border-color:var(--amber);animation:pulse 1.4s ease-in-out infinite}
```

Then confirm the mobile rule at the bottom of the panel block still reads `.qp-send,.qp-term{flex:1;…}` and does **not** mention `.qp-mic`.

⚠️ `animation: pulse` assumes a `@keyframes pulse` already exists for the row pills. Verify with `grep -n '@keyframes' client/src/styles.css`; if the name differs, use the real one rather than adding a second set of keyframes.

- [ ] **Step 6: Verify in the browser**

Start the preview and check the rendered states:

```bash
pnpm dev
```

Then, in the Browser pane at http://localhost:5173 — a secure context, so the mic is enabled:

1. `read_console_messages` — expect no errors on load.
2. `javascript_tool`: `fetch('/api/health').then(r=>r.json()).then(b=>b.transcribe)` — expect `true` after Task 1's install.
3. The mic only renders inside an open `MessagePanel`, which needs a live reply window. If none is open, confirm the component in isolation instead: `javascript_tool` with `[window.isSecureContext, typeof MediaRecorder]`.
4. Check both themes: `resize_window` with `colorScheme: 'dark'` then `'light'`, and confirm the mic button is legible in each. This is the rule that literal colours break.

- [ ] **Step 7: Verify on the phone**

This is the case the feature exists for and the only one that exercises the real recorder:

```bash
pnpm tunnel
```

Open the HTTPS tailnet URL on the phone, open a session with a live reply window, tap the mic, speak a sentence, tap again. Expected: elapsed timer counts up, `…` appears, the sentence lands in the textarea. Then load the **plain-http** URL (`http://<host>.<tailnet>.ts.net:4173`) and confirm the button renders disabled and reads `https only`.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add client/src/hooks/useDictation.ts client/src/hooks/useTranscribeAvailable.ts \
        client/src/components/MicButton.tsx client/src/components/MessagePanel.tsx \
        client/src/styles.css
git commit -m "feat(dictation): mic button in the reply composer"
```

⚠️ `git status` before staging — this repo carries unrelated in-flight work in `client/src/`. Stage the listed paths explicitly; never `git add -A`.

---

### Task 9: Documentation

**Files:**
- Create: `docs/subsystems/dictation.md`
- Create: `docs/workflows/dictation-setup.md`
- Modify: `docs/overview.md`, `docs/subsystems/remote-message.md`, `docs/subsystems/remote-access.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: Write the subsystem doc**

Create `docs/subsystems/dictation.md`, opening with the provenance frontmatter every subsystem doc here carries (copy the shape from `docs/subsystems/remote-message.md` and set `verified` to the current HEAD sha):

```yaml
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
  kind: subsystem
  verified: <HEAD sha>
---
```

Cover, in this order: what the feature is; **the HTTPS requirement and why the disabled state exists**; the pipeline (record → POST → ffmpeg → whisper-cli → text); why the transcript is appended and never auto-sent; the endpoint's status-code table copied from the spec; why the probe is cached and why `transcribe` reports engine availability only; the in-flight guard as CPU-amplification defence; and the accepted limits (backgrounding kills a take, `base.en` mangles identifiers, no rate limit beyond one-at-a-time).

- [ ] **Step 2: Write the setup doc**

Create `docs/workflows/dictation-setup.md`: Task 1's brew + curl + `.env` steps, the `pnpm tunnel` requirement for phone use, and a short troubleshooting list — no mic button at all means `transcribe:false` (check the model path), a disabled `https only` button means a plain-http origin, and `429` means a clip is already transcribing.

- [ ] **Step 3: Update the neighbouring docs**

- `docs/overview.md` — add dictation to the subsystem map.
- `docs/subsystems/remote-message.md` — note that the composer now carries a mic, linking to `dictation.md`.
- `docs/subsystems/remote-access.md` — HTTPS is now *functional*, not merely tidier: `pnpm tunnel` is required for phone dictation.
- `.claude/CLAUDE.md` — add `server/lib/transcribe.ts`, `client/src/hooks/useDictation.ts`, `client/src/hooks/useTranscribeAvailable.ts`, `client/src/components/MicButton.tsx`, and `client/src/lib/dictation.ts` to the architecture tree, each with its one-line description.

- [ ] **Step 4: Check every new link resolves**

```bash
grep -o '](\.\./[^)]*)' docs/subsystems/dictation.md docs/workflows/dictation-setup.md
```

Expected: every path exists relative to its file. Fix any that do not.

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/dictation.md docs/workflows/dictation-setup.md \
        docs/overview.md docs/subsystems/remote-message.md \
        docs/subsystems/remote-access.md .claude/CLAUDE.md
git commit -m "docs: dictation subsystem and setup guide"
```

---

## Done when

- `pnpm test` and `pnpm typecheck` both pass, with the case count up by roughly 22.
- With no model configured, the app is byte-for-byte as it was: no mic, `transcribe:false`, `/api/transcribe` 404s.
- With the model configured, speaking into the phone over the HTTPS tunnel puts editable text in the composer.
- Over plain http, the mic renders disabled and says why.
