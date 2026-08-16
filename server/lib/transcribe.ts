/**
 * transcribe.ts — local speech-to-text for the reply composer.
 *
 * Browser audio in, plain text out: ffmpeg normalises whatever the recorder
 * produced into the 16kHz mono WAV whisper.cpp insists on, then `whisper-cli`
 * transcribes it. Everything here that can be pure is pure, so the suite never
 * spawns a real engine — see docs/subsystems/dictation.md.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.js';

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
 * run, never one per request. `/api/health` — which carries this flag — is
 * polled every 15s by `useRemoteAnswer` (`POLL_MS` in `useRemoteAnswer.ts`) for
 * the remote-answer toggle; `useTranscribeAvailable`, the hook that actually
 * reads this field, does not poll at all — it fetches once per page load and
 * memoises the result. Either way, re-running the probe on every request would
 * spawn a process for no new information, which is exactly what this cache
 * prevents.
 */
export function probeTranscribe(config: Config): boolean {
  if (probed === null) probed = computeProbe(config);
  return probed;
}

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
 * Cheap peek at the flag above, so `serveTranscribe` can refuse a second
 * caller before it buffers any audio — not just before it spawns a process.
 * Not authoritative: two callers can both read `false` here in the same tick,
 * before either has set the flag, so the `inFlight` check inside `transcribe`
 * below is still what actually enforces single-flight.
 */
export function isTranscribing(): boolean {
  return inFlight;
}

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
