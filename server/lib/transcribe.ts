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
