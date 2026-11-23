/**
 * The composers' length caps, each the server's own cap on the text it receives. Duplicated rather than imported: the only thing crossing the FE/BE
 * boundary is the typed JSON in `shared/types.ts`, and one integer is not worth a runtime import. Pinned to the server values by
 * `test/guards/client-server-caps.test.ts`, so a server cap that moves turns that suite red instead of leaving a box that accepts text the server slices.
 */

/** `server/lib/messages.ts` `TEXT_CAP`: the turn-end follow-up the server slices to this length. */
export const MESSAGE_TEXT_CAP = 4000;
/** `server/lib/plans.ts` `FEEDBACK_CAP`: the plan feedback the server slices to this length. */
export const PLAN_FEEDBACK_CAP = 2000;
/** `server/lib/pending.ts` `SELECTED_CAP`: a question's free-text "Other" answer longer than this is refused as malformed. */
export const QUESTION_OTHER_CAP = 500;

/** `server/lib/chat.ts` `TEXT_CAP`: where a Truncated chat drawer cuts a message's text. A different cap from `messages.ts`'s, despite the shared name. */
export const CHAT_TEXT_CAP = 2000;
/** `server/lib/chat.ts` `TOOL_BODY_CAP`: where a Truncated chat drawer cuts a tool body. */
export const CHAT_TOOL_BODY_CAP = 20_000;
/** `server/lib/chat.ts` `CHAT_WINDOW_BYTES` in KB: the slice of the transcript one chat page reads. */
export const CHAT_WINDOW_KB = 512;
/** `server/lib/chat.ts` `CHAT_MAX_WINDOW_BYTES` in MB: how far that slice widens when it holds no message, and the live tail's per-read ceiling. */
export const CHAT_MAX_WINDOW_MB = 8;

/** The Settings › Chat messages hint, built from the four chat constants above so it cannot restate a cap the server has moved off. */
export const CHAT_MESSAGES_HINT = `Truncated cuts a message at ${CHAT_TEXT_CAP.toLocaleString('en-US')} characters and a tool body at `
  + `${CHAT_TOOL_BODY_CAP.toLocaleString('en-US')} — enough to see what a session is doing. Full sends the whole thing; a page still reads a bounded `
  + `slice of the transcript (${CHAT_WINDOW_KB} KB, widened up to ${CHAT_MAX_WINDOW_MB} MB only when that much shows no message). Changing this re-tails `
  + 'an open drawer.';
