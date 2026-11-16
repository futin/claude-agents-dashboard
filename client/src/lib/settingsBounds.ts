/**
 * settingsBounds.ts — the client's copies of the server's bounds for Settings › Shared's number fields (`server/lib/settings.ts`). Only types cross
 * `shared/`, so each bound is mirrored here and pinned to its server value by `test/guards/client-server-caps.test.ts`.
 */

/** `MIN_ANSWER_SECS`: the shortest Answer window the server keeps. */
export const ANSWER_SECS_MIN = 5;
/** `MAX_ANSWER_SECS`: the longest Answer window the server keeps. */
export const ANSWER_SECS_MAX = 1800;
/** `MAX_IDLE_SECS`: the longest idle threshold the server keeps. */
export const IDLE_SECS_MAX = 3600;
