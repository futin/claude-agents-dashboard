/**
 * dictation.ts — the parts of the mic flow that are just data.
 *
 * Kept out of the hook so they can be tested: the client suite is node-assert
 * over pure libs, with no DOM. Everything MediaRecorder-shaped lives in
 * hooks/useDictation.ts instead.
 */

/**
 * Recorder types worth asking for, best first: iOS Safari records `audio/mp4`
 * natively, while Chrome/Android favor webm/opus, so mp4 is tried first.
 */
const PREFERRED = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];

/**
 * The first supported recorder mime, or '' to let the browser choose its own
 * default (Safari and Chrome disagree, and both defaults are acceptable to the
 * server's allowlist).
 */
export function pickMimeType(supported: (t: string) => boolean): string {
  return PREFERRED.find(t => supported(t)) ?? '';
}

/**
 * Turn a `getUserMedia` rejection into copy that names the actual fix.
 *
 * One string for every failure was the original shape, and it cost a debugging
 * session: "microphone unavailable" reads as "this machine has no mic" when the
 * real cause is almost always a permission the browser already decided about
 * without asking. The three named cases below are the ones a user can act on;
 * anything else keeps the generic wording but appends the `DOMException.name`,
 * so an unmapped failure still arrives with the one word needed to look it up.
 */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  switch (typeof name === 'string' ? name : '') {
    // No prompt appeared: the permission was already denied — for the site, or
    // for the browser app itself at the OS level.
    case 'NotAllowedError':
    case 'SecurityError':
      return 'mic blocked — allow it in browser + OS settings';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no microphone found';
    // Held by another app, or the OS took it away mid-request.
    case 'NotReadableError':
    case 'AbortError':
      return 'mic busy in another app';
    case '':
      return 'microphone unavailable';
    default:
      return `microphone unavailable (${name as string})`;
  }
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
