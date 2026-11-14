/**
 * usage-line.ts — the one reading of an assistant usage line: a transcript record's `message.usage` as four token counts, with the turn's id, model and
 * timestamp beside them.
 *
 * Five readers share it — the usage ledger, the rates audit (`scripts/lib/transcript-audit.ts`), subagent spend, session spend and the session analysis —
 * and each keeps its own gate on what it does with the result (model or timestamp required, how a turn id is remembered, whether a zero-token copy spends
 * the id). Those gates differ on purpose and are pinned side by side in `test/usage/usage-line-callers.test.ts`; only the parse lives here.
 */

/** One bucket of tokens. Names are the ledger's on-disk keys, kept short. */
export interface TokenCounts {
  /** `input_tokens` */
  in: number;
  /** `output_tokens` */
  out: number;
  /** `cache_creation_input_tokens` — a cache *write*. */
  cc: number;
  /** `cache_read_input_tokens` */
  cr: number;
}

export interface AssistantUsage {
  /** `message.id` when it is a non-empty string, else null — the caller decides what an id-less record means. */
  id: string | null;
  /** `message.model` when it is a non-empty string, else `''`. */
  model: string;
  /** `Date.parse(timestamp)` when the record's `timestamp` is a string, else NaN; an unparseable string is NaN too. */
  ts: number;
  tok: TokenCounts;
  /** The raw `message.usage` object, for the fields only some readers want (`speed`, `service_tier`, `server_tool_use`). */
  usage: Record<string, any>;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The usage an assistant record carries, or null unless `rec.message` is an object with `role: 'assistant'` and an object `usage`. Never throws. */
export function assistantUsage(rec: unknown): AssistantUsage | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, any>;
  const msg = r.message;
  if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
  const usage = msg.usage;
  if (!usage || typeof usage !== 'object') return null;
  return {
    id: typeof msg.id === 'string' && msg.id ? msg.id : null,
    model: typeof msg.model === 'string' ? msg.model : '',
    ts: typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN,
    tok: {
      in: count(usage.input_tokens),
      out: count(usage.output_tokens),
      cc: count(usage.cache_creation_input_tokens),
      cr: count(usage.cache_read_input_tokens)
    },
    usage
  };
}
