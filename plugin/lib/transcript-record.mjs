/**
 * transcript-record.ts — the record filter every transcript reader shares, in a leaf that imports nothing, so `pnpm plugin:gen` generates it into
 * `plugin/lib/transcript-record.mjs` for `/kaizen` (#580). `transcript.ts` re-exports it.
 */
/**
 * False for a record that carries a `message` but is not a turn of the conversation. Claude Code 2.1.302 writes `type: "api-request-blob"` records that
 * replay each API request's turns — the same role and content as the real `user`/`assistant` records, with no uuid or timestamp — so a reader keyed on
 * `message.role` alone sees every turn twice. Fixtures and old transcripts without a `type` still count.
 */
export function isConversationRecord(rec) {
    return typeof rec?.type !== 'string' || rec.type === 'user' || rec.type === 'assistant';
}
