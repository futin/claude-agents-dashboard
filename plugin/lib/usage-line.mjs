/**
 * usage-line.ts — the one reading of an assistant usage line: a transcript record's `message.usage` as four token counts, with the turn's id, model and
 * timestamp beside them.
 *
 * Six readers share it — the usage ledger, the rates audit (`scripts/lib/transcript-audit.ts`), subagent spend, session spend, the session analysis and
 * the token-weight check (`scripts/check-token-weights.ts`) — and each keeps its own gate on what it does with the result (model or timestamp required,
 * how a turn id is remembered, whether a zero-token copy spends the id). Those gates differ on purpose and are pinned side by side in
 * `test/usage/usage-line-callers.test.ts`; only the parse lives here.
 */
/** A token count as every reader takes it: a finite number, else 0 — a numeric string is not a count. */
export function tokenCount(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
/** The usage an assistant record carries, or null unless `rec.message` is an object with `role: 'assistant'` and an object `usage`. Never throws. */
export function assistantUsage(rec) {
    if (!rec || typeof rec !== 'object')
        return null;
    const r = rec;
    const msg = r.message;
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant')
        return null;
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object')
        return null;
    return {
        id: typeof msg.id === 'string' && msg.id ? msg.id : null,
        model: typeof msg.model === 'string' ? msg.model : '',
        ts: typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN,
        tok: {
            in: tokenCount(usage.input_tokens),
            out: tokenCount(usage.output_tokens),
            cc: tokenCount(usage.cache_creation_input_tokens),
            cr: tokenCount(usage.cache_read_input_tokens)
        },
        usage
    };
}
