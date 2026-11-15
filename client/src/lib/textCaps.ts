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
