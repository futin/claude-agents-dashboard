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
