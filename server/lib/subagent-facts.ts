/**
 * subagent-facts.ts — the liveness facts `GET /api/sessions/:id` adds to each subagent row from the subagent's OWN files (#588): its meta file
 * (`agent-<id>.meta.json`) for `background` and `model`, and its transcript (`agent-<id>.jsonl`) for `lastWriteAt`, `lastTool` and `blockedReason`. The
 * parent-transcript facts come from the reducer in `agents.ts`; `session-detail.ts` overlays these on them. The field contracts are on `AgentJob` in
 * `shared/types.ts`.
 *
 * Polled every 3s while a session is selected, so each answer is memoized on the two files' (`size`, `mtimeMs`): a finished subagent's files never change,
 * and a repeat poll then costs two `stat`s and no read.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AgentJob } from '../../shared/types.js';
import { subagentDirOf } from './subagent-usage.js';
import { describeTool, readTail } from './transcript.js';

export interface SubagentFacts {
  /** From meta `requestShape`; null when it says neither `background` nor `foreground`, so the caller keeps the reducer's value. */
  background: boolean | null;
  model: string | null;
  lastWriteAt: string | null;
  lastTool: string | null;
  blockedReason: NonNullable<AgentJob['blockedReason']> | null;
}

const TAIL_BYTES = 64 * 1024;
const LABEL_MAX = 80;
const MEMO_MAX = 512;

interface Memo {
  size: number;
  mtimeMs: number;
  metaMtimeMs: number;
  /** blockedReason as classified, before the `running` mask is applied. */
  facts: SubagentFacts;
}

const memo = new Map<string, Memo>();

/** Test hook. */
export function _resetSubagentFactsMemo(): void { memo.clear(); }

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function readMeta(metaPath: string): { background: boolean | null; model: string | null } {
  let meta: any;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return { background: null, model: null }; }
  if (!meta || typeof meta !== 'object') return { background: null, model: null };
  const background = meta.requestShape === 'background' ? true : meta.requestShape === 'foreground' ? false : null;
  const model = typeof meta.model === 'string' ? meta.model
    : typeof meta.pickedEffortModel === 'string' ? meta.pickedEffortModel : null;
  return { background, model };
}

/** Plain text of a message's content: a string, or its text blocks and tool_result texts joined. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
    else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') out += b.content;
      else if (Array.isArray(b.content)) for (const x of b.content) if (x && typeof x.text === 'string') out += x.text;
    }
  }
  return out;
}

function isAssistant(rec: any): boolean {
  return rec.type === 'assistant' || (!rec.type && rec.message?.role === 'assistant');
}
function isUser(rec: any): boolean {
  return rec.type === 'user' || (!rec.type && rec.message?.role === 'user');
}

function formatTool(block: any): string {
  const name = typeof block.name === 'string' ? block.name : '';
  // One line: a free-form input (a handback's report, a heredoc) keeps its newlines in `describeTool`, and a list row cannot show them.
  const label = describeTool(block).replace(/\s+/g, ' ').trim();
  if (!label) return name;
  const cut = label.length > LABEL_MAX ? label.slice(0, LABEL_MAX - 1) + '…' : label;
  return `${name}(${cut})`;
}

/**
 * Classify the last `user`/`assistant` record (#588 D1). The rate-limit text test only ever applies to an API-error record: an ordinary reply that
 * mentions "rate limit" is not one, and an API error of another kind (`server_error`, `authentication_failed`) has no class here.
 */
function classify(rec: any): SubagentFacts['blockedReason'] {
  const text = messageText(rec.message?.content);
  if (rec.isApiErrorMessage === true) {
    return rec.error === 'rate_limit' || /429|rate limit|usage limit/i.test(text) ? 'rate-limit' : null;
  }
  if (!isUser(rec)) return null;
  const content = rec.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b && b.type === 'tool_result' && messageText([b]).includes('The tool use was rejected'))) {
    return 'rejected';
  }
  if (text.trimStart().startsWith('[Request interrupted')) return 'interrupted';
  return null;
}

function readTailFacts(transcript: string): { lastTool: string | null; blockedReason: SubagentFacts['blockedReason'] } {
  const tail = readTail(transcript, TAIL_BYTES);
  if (!tail) return { lastTool: null, blockedReason: null };
  const recs: any[] = [];
  for (const line of tail.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object') recs.push(r);
    } catch { /* a cut first line, or a torn last one */ }
  }
  let lastTool: string | null = null;
  let blockedReason: SubagentFacts['blockedReason'] = null;
  let classified = false;
  for (let i = recs.length - 1; i >= 0 && (lastTool === null || !classified); i--) {
    const rec = recs[i];
    if (!classified && (isUser(rec) || isAssistant(rec))) {
      blockedReason = classify(rec);
      classified = true;
    }
    if (lastTool === null && isAssistant(rec) && Array.isArray(rec.message?.content)) {
      const blocks = rec.message.content;
      for (let j = blocks.length - 1; j >= 0; j--) {
        if (blocks[j] && blocks[j].type === 'tool_use') { lastTool = formatTool(blocks[j]); break; }
      }
    }
  }
  return { lastTool, blockedReason };
}

/**
 * The facts for subagent `agentId` of the session whose transcript is `mainPath`. `blockedReason` is null unless `running`. Never throws: whatever cannot
 * be read reads as that field's null.
 */
export function readSubagentFacts(mainPath: string, agentId: string, running: boolean): SubagentFacts {
  try {
    const dir = subagentDirOf(mainPath);
    const transcript = path.join(dir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
    const st = statOrNull(transcript);
    const metaSt = statOrNull(metaPath);
    const size = st ? st.size : -1;
    const mtimeMs = st ? st.mtimeMs : -1;
    const metaMtimeMs = metaSt ? metaSt.mtimeMs : -1;

    let hit = memo.get(transcript);
    if (!hit || hit.size !== size || hit.mtimeMs !== mtimeMs || hit.metaMtimeMs !== metaMtimeMs) {
      const meta = metaSt ? readMeta(metaPath) : { background: null, model: null };
      const tail = st ? readTailFacts(transcript) : { lastTool: null, blockedReason: null };
      hit = {
        size, mtimeMs, metaMtimeMs,
        facts: { ...meta, lastWriteAt: st ? new Date(st.mtimeMs).toISOString() : null, ...tail }
      };
      memo.delete(transcript);
      memo.set(transcript, hit);
      if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
    }
    return { ...hit.facts, blockedReason: running ? hit.facts.blockedReason : null };
  } catch {
    return { background: null, model: null, lastWriteAt: null, lastTool: null, blockedReason: null };
  }
}
