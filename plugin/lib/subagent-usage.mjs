/**
 * subagent-usage.ts — what each subagent of a session actually spent, read from
 * its own transcript.
 *
 * The CLI writes every subagent to `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * (plus an `agent-<agentId>.meta.json` sidecar naming the launching `toolUseId`) and
 * never replays those turns into the parent transcript. The parent carries only
 * the harness's one-number summary — `toolUseResult.totalTokens` or
 * `<subagent_tokens>` — and that number is the subagent's FINAL context size:
 * measured 2026-09-23 it matches the last turn's four-class sum to within a few
 * hundred tokens, on subagents whose summed turns were 5–130x larger (bug-27).
 * So spend is summed from the transcript, once per `message.id` — the same
 * de-duplication `analyze.ts` applies, because every record of one turn carries
 * a full copy of that turn's usage. The reader is `readSubagentUsage` in
 * `session-spend.ts`, behind the cache the drawer's spend poll shares; this file
 * keeps the path and the totals helpers both sides use.
 */
import path from 'node:path';
/** The per-session directory the CLI writes subagent transcripts into. */
export const SUBAGENT_DIR = 'subagents';
export function emptyTotals() {
    return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, combined: 0, billableApprox: 0 };
}
/** Add `b` into `a` in place. */
export function addTotals(a, b) {
    a.input += b.input;
    a.output += b.output;
    a.cacheCreation += b.cacheCreation;
    a.cacheRead += b.cacheRead;
    a.combined += b.combined;
    a.billableApprox += b.billableApprox;
}
/** The `subagents/` dir beside the session transcript at `mainPath`: `<transcript without .jsonl>/subagents`. */
export function subagentDirOf(mainPath) {
    return path.join(mainPath.replace(/\.jsonl$/, ''), SUBAGENT_DIR);
}
