/**
 * tool-output-replay.ts — "what would a tool-output cap have saved", replayed over transcripts already on disk. Pure, zero runtime deps.
 *
 * Built to pick thresholds for two hooks before they exist (and to re-run after they ship, to prove the saving):
 *  - read-guard: a PreToolUse hook that denies a whole-file Read (no offset/limit) whose output is over N bytes, and names the ranged read to do instead;
 *  - bash-trim: a PostToolUse hook that swaps a Bash result over N bytes for its head and tail lines plus one pointer line to the full output on disk.
 * The idea comes from context-mode's `bench/replay.mjs` (github.com/mksglu/context-mode): its own replay found that hints and denies on small output cost
 * more than they save, so the threshold has to come from our own transcripts, not from a default.
 *
 * Bytes are what the model saw: the tool_result text in UTF-8 bytes (images not counted). A byte count alone undersells the cost, because a result stays
 * in the context and every later turn re-reads it from the prompt cache until a compaction drops it. So each row also carries `turnsAfter` — the main-chain
 * turns that started after the result, up to the next compact boundary — and `byteTurns` = bytes × turnsAfter is the replay-weighted figure.
 *
 * Record rules match analyze.ts: one turn is one `message.id` (Claude Code writes one record per content block), a compaction can replay earlier records
 * verbatim so each tool_use / tool_result id counts once, `compactMetadata` marks a boundary, `isCompactSummary` is skipped. A subagent's own transcript
 * (`<sid>/subagents/agent-*.jsonl`) has `isSidechain: true` on every record, so sidechain records are skipped only in a main transcript.
 */

import { isConversationRecord } from './transcript.js';

/** Bytes of the deny reason read-guard would return instead of the file — the one-line message naming the ranged read to run. An estimate. */
export const DENY_MESSAGE_BYTES = 200;
/** Bytes of bash-trim's pointer line ("… N lines, B bytes cut — full output: ~/.claude/tool-output/<sid>/<id>.txt, grep it"). An estimate. */
export const TRIM_POINTER_BYTES = 160;
/** Lines bash-trim keeps from each end. */
export const TRIM_LINES = 40;
/** Byte cap on each kept end, so one huge line (minified JSON) cannot defeat the trim. */
export const TRIM_SIDE_MAX_BYTES = 2048;

export type Scope = 'main' | 'subagent';

/**
 * What a Bash command was for, judged by its text. First match wins and deliberate file reads come first, so a chained `grep …; sed -n …` counts as a
 * read — a rough split, good enough to tell "the model asked for this file" from "a tool happened to print a lot".
 */
export const BASH_KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['read: range (sed -n, awk NR)', /\bsed\s+-n\b|\bawk\s+['"]?NR/],
  ['read: head/tail', /\b(head|tail)\s+(-n\s*)?-?\d|\b(head|tail)\s+-n\b/],
  ['read: cat', /(^|[;&|(]\s*)cat\s+(?!<<|>)[^|<>]/],
  ['git diff/show', /\bgit\s+(-C\s+\S+\s+)?(diff|show)\b/],
  ['git log', /\bgit\s+(-C\s+\S+\s+)?log\b/],
  ['tests', /\b(pnpm|npm|yarn)\s+(run\s+)?test|node\s+--test|\bvitest\b|\bjest\b|\bpytest\b|playwright\s+test/],
  ['build/typecheck/lint', /\btsc\b|typecheck|(pnpm|npm|yarn)\s+(run\s+)?(build|lint)|\beslint\b/],
  ['gh', /\bgh\s+/],
  ['curl', /\bcurl\b|\bwget\b/],
  ['grep/rg', /\b(grep|rg)\b/],
  ['find/ls', /\b(find|ls|tree|du)\b/],
  ['script (node/python/tsx)', /\b(node|python3?|tsx|npx|pnpm\s+exec)\b/],
  ['git other', /\bgit\b/],
];

export function bashKind(command: string): string {
  for (const [kind, re] of BASH_KINDS) if (re.test(command)) return kind;
  return 'other';
}

/** One tool call and the result the model saw. */
export interface ResultRow {
  tool: string;
  /** Bash only: `bashKind` of its command; empty for every other tool. */
  kind: string;
  bytes: number;
  /** Read only: the call carried offset or limit, so read-guard lets it through. */
  ranged: boolean;
  isError: boolean;
  /** Main-chain turns that started after this result, up to the next compact boundary — how many times it was replayed. */
  turnsAfter: number;
  /** Bytes bash-trim would return for this result (equals `bytes` when there is nothing to cut). */
  trimmedBytes: number;
  scope: Scope;
}

export interface ToolTotals {
  tool: string;
  calls: number;
  bytes: number;
  byteTurns: number;
  /** Per threshold: the calls whose result is over it, and their bytes. */
  over: Record<number, { calls: number; bytes: number }>;
}

export interface ReadGuardRow {
  threshold: number;
  calls: number;
  /** Result bytes minus the deny message. */
  savedBytes: number;
  /** savedBytes minus a ranged re-read of up to `threshold` bytes per denied call — the conservative figure. */
  savedBytesNet: number;
  /** savedBytesNet × turnsAfter, summed. */
  savedByteTurns: number;
}

export interface BashTrimRow {
  threshold: number;
  calls: number;
  savedBytes: number;
  savedByteTurns: number;
}

/** Bash results of one `bashKind`, and the byte-turns bash-trim would remove from them per threshold. */
export interface BashKindRow {
  kind: string;
  calls: number;
  bytes: number;
  byteTurns: number;
  trimSavedByteTurns: Record<number, number>;
}

export interface ReplaySummary {
  totals: { calls: number; bytes: number; byteTurns: number };
  /** Sorted by byteTurns, largest first. */
  byTool: ToolTotals[];
  readGuard: ReadGuardRow[];
  bashTrim: BashTrimRow[];
  /** Sorted by byteTurns, largest first. */
  bashByKind: BashKindRow[];
}

/** Flatten a tool_result block's content to its text (content is string | block[]); image and other non-text blocks add nothing. */
function resultText(b: any): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map((x: any) => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('');
  return '';
}

/** Take up to `lines` lines from one end of `text`, then cap that slice at `maxBytes` UTF-8 bytes. Returns its byte length. */
function sideBytes(lines: string[], maxBytes: number): number {
  return Math.min(Buffer.byteLength(lines.join('\n')), maxBytes);
}

/**
 * Bytes bash-trim would hand the model for `text`: the first and last TRIM_LINES lines (each end capped at TRIM_SIDE_MAX_BYTES) plus the pointer line.
 * Output that would not shrink stays whole.
 */
export function trimmedSize(text: string): number {
  const whole = Buffer.byteLength(text);
  const lines = text.split('\n');
  if (lines.length <= 2 * TRIM_LINES && whole <= 2 * TRIM_SIDE_MAX_BYTES) return whole;
  const head = sideBytes(lines.slice(0, TRIM_LINES), TRIM_SIDE_MAX_BYTES);
  // Up to TRIM_LINES lines, the head already holds every line; the tail is then the last bytes of the text, not the same lines twice.
  const tail = lines.length > TRIM_LINES ? sideBytes(lines.slice(-TRIM_LINES), TRIM_SIDE_MAX_BYTES) : Math.min(TRIM_SIDE_MAX_BYTES, whole - head);
  return Math.min(whole, head + tail + TRIM_POINTER_BYTES);
}

/** Every tool call in one transcript's text with the result the model saw. Never throws; bad lines are skipped. */
export function extractResults(text: string, opts: { scope: Scope }): ResultRow[] {
  const rows: ResultRow[] = [];
  const pending = new Map<string, { tool: string; kind: string; ranged: boolean }>();
  const seenUse = new Set<string>(), seenResult = new Set<string>();
  const seenTurn = new Set<string>();
  // Rows of the current segment (since the last boundary) with the turn count at the time they landed; settled at each boundary and at the end.
  let segment: Array<{ row: ResultRow; turnAt: number }> = [];
  let turns = 0, anon = 0;

  const settle = (): void => {
    for (const { row, turnAt } of segment) row.turnsAfter = turns - turnAt;
    segment = [];
    turns = 0;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (opts.scope === 'main' && rec.isSidechain === true) continue;
    if (rec.compactMetadata && typeof rec.compactMetadata === 'object') { settle(); continue; }
    if (rec.isCompactSummary === true) continue;
    if (!isConversationRecord(rec)) continue;
    const msg = rec.message;
    if (!msg) continue;
    if (msg.role === 'assistant') {
      // Records of one turn share a message.id; without one, each record is its own turn (the `#` prefix cannot collide with a real `msg_…` id).
      const key = typeof msg.id === 'string' && msg.id ? msg.id : `#anon${anon++}`;
      if (!seenTurn.has(key)) { seenTurn.add(key); turns++; }
    }
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'assistant') {
      for (const b of msg.content) {
        if (!b || b.type !== 'tool_use' || typeof b.name !== 'string' || typeof b.id !== 'string') continue;
        if (seenUse.has(b.id)) continue;
        seenUse.add(b.id);
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const kind = b.name === 'Bash' ? bashKind(typeof input.command === 'string' ? input.command : '') : '';
        pending.set(b.id, { tool: b.name, kind, ranged: input.offset !== undefined || input.limit !== undefined });
      }
    } else if (msg.role === 'user') {
      for (const b of msg.content) {
        if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        if (seenResult.has(b.tool_use_id)) continue;
        seenResult.add(b.tool_use_id);
        const p = pending.get(b.tool_use_id);
        if (!p) continue;
        pending.delete(b.tool_use_id);
        const textOut = resultText(b);
        const row: ResultRow = {
          tool: p.tool,
          kind: p.kind,
          bytes: Buffer.byteLength(textOut),
          ranged: p.ranged,
          isError: b.is_error === true || /<tool_use_error>/i.test(textOut),
          turnsAfter: 0,
          trimmedBytes: trimmedSize(textOut),
          scope: opts.scope
        };
        rows.push(row);
        segment.push({ row, turnAt: turns });
      }
    }
  }
  settle();
  return rows;
}

/** What each tool poured into context, and what read-guard and bash-trim would have removed at each threshold. */
export function simulate(rows: ResultRow[], thresholds: number[]): ReplaySummary {
  const totals = { calls: 0, bytes: 0, byteTurns: 0 };
  const tools = new Map<string, ToolTotals>();
  const readGuard: ReadGuardRow[] = thresholds.map(threshold => ({ threshold, calls: 0, savedBytes: 0, savedBytesNet: 0, savedByteTurns: 0 }));
  const bashTrim: BashTrimRow[] = thresholds.map(threshold => ({ threshold, calls: 0, savedBytes: 0, savedByteTurns: 0 }));
  const kinds = new Map<string, BashKindRow>();

  for (const r of rows) {
    const weight = r.bytes * r.turnsAfter;
    totals.calls++; totals.bytes += r.bytes; totals.byteTurns += weight;
    let t = tools.get(r.tool);
    if (!t) {
      t = { tool: r.tool, calls: 0, bytes: 0, byteTurns: 0, over: Object.fromEntries(thresholds.map(n => [n, { calls: 0, bytes: 0 }])) };
      tools.set(r.tool, t);
    }
    t.calls++; t.bytes += r.bytes; t.byteTurns += weight;
    let k: BashKindRow | undefined;
    if (r.tool === 'Bash') {
      k = kinds.get(r.kind);
      if (!k) {
        k = { kind: r.kind, calls: 0, bytes: 0, byteTurns: 0, trimSavedByteTurns: Object.fromEntries(thresholds.map(n => [n, 0])) };
        kinds.set(r.kind, k);
      }
      k.calls++; k.bytes += r.bytes; k.byteTurns += weight;
    }

    thresholds.forEach((n, i) => {
      if (r.bytes <= n) return;
      t!.over[n].calls++; t!.over[n].bytes += r.bytes;
      // An errored Read is the host's own short refusal (too large, missing file) — nothing to deny.
      if (r.tool === 'Read' && !r.ranged && !r.isError) {
        const g = readGuard[i];
        const saved = r.bytes - DENY_MESSAGE_BYTES;
        const net = Math.max(0, saved - n);
        g.calls++; g.savedBytes += saved; g.savedBytesNet += net; g.savedByteTurns += net * r.turnsAfter;
      }
      if (r.tool === 'Bash' && r.trimmedBytes < r.bytes) {
        const g = bashTrim[i];
        const saved = r.bytes - r.trimmedBytes;
        g.calls++; g.savedBytes += saved; g.savedByteTurns += saved * r.turnsAfter;
        k!.trimSavedByteTurns[n] += saved * r.turnsAfter;
      }
    });
  }

  const byTool = [...tools.values()].sort((a, b) => b.byteTurns - a.byteTurns || b.bytes - a.bytes);
  const bashByKind = [...kinds.values()].sort((a, b) => b.byteTurns - a.byteTurns || b.bytes - a.bytes);
  return { totals, byTool, readGuard, bashTrim, bashByKind };
}
