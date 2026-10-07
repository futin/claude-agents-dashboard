/**
 * The live meter's pure half: formatting, the status line, the nudge, the tool ledger and the kaizen summary. Nothing here takes `$`, so every rule is
 * testable without the engine; `register.ts` wires these to the hooks.
 */

export const DEFAULT_NUDGE_AT = 150_000

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** One decimal, a trailing `.0` dropped: `999`, `1.5k`, `180k`, `2.1M`. A value that rounds to `1000k` reads `1M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = Math.round(n / 100) / 10
  if (k < 1000) return `${k}k`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Cents; a cost above zero that would round to `$0.00` reads `<$0.01`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01'
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`
}

export type Meter = { contextTokens?: number; usd?: number; turns: number; compactions: number }

export const newMeter = (): Meter => ({ turns: 0, compactions: 0 })

/**
 * The status line. `live`, never `billable`: the engine's running figures drift from kaizen's transcript sum around a compaction, and `/kaizen-stats`
 * carries the billable one.
 */
export function statusLine(meter: Meter): string {
  return [
    'live',
    `ctx ${meter.contextTokens !== undefined ? formatTokens(meter.contextTokens) : '–'}`,
    ...(meter.usd !== undefined ? [formatUsd(meter.usd)] : []),
    plural(meter.turns, 'turn'),
    plural(meter.compactions, 'compaction'),
  ].join(' · ')
}

export type Nudge = { isArmed: boolean }

export const newNudge = (): Nudge => ({ isArmed: true })

/** True once per arming, the first time context reaches `threshold`; disarms itself. A threshold of 0 turns the nudge off. */
export function nudgeDue(nudge: Nudge, contextTokens: number, threshold: number): boolean {
  if (threshold <= 0 || !nudge.isArmed || contextTokens < threshold) return false
  nudge.isArmed = false
  return true
}

/** The `nudgeAtTokens` userConfig value; anything that is not a non-negative number falls back to the default. */
export function thresholdOf(options: Readonly<Record<string, unknown>>): number {
  const raw = options.nudgeAtTokens
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_NUDGE_AT
}

export type Row = { name: string; calls: number; tokens: number; wallMs: number }

/** Main-thread calls only: `tools` by tool name, `agents` (Agent / Task calls) by subagent label. */
export type Ledger = { tools: Map<string, Row>; agents: Map<string, Row> }

export const newLedger = (): Ledger => ({ tools: new Map(), agents: new Map() })

/** Same rule as `approxTokens` in skills/kaizen/kaizen.mjs, so live and transcript figures stay comparable. */
const approxTokens = (text: string): number => text.length / 4

export function recordCall(ledger: Ledger, call: { tool: string; agentLabel?: string; durationMs: number; resultText: string }): void {
  const table = call.agentLabel !== undefined ? ledger.agents : ledger.tools
  const name = call.agentLabel ?? call.tool
  const row = table.get(name) ?? { name, calls: 0, tokens: 0, wallMs: 0 }
  row.calls += 1
  row.tokens += approxTokens(call.resultText)
  row.wallMs += call.durationMs
  table.set(name, row)
}

/** The top `n` rows by `key`, descending; ties by name, ascending. */
export function topBy(table: ReadonlyMap<string, Row>, key: 'tokens' | 'wallMs', n: number): Row[] {
  return [...table.values()]
    .sort((a, b) => b[key] - a[key] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, n)
    .map(row => ({ ...row }))
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/** The subagent-table label of an Agent / Task call: its `subagent_type`, else its `description`; undefined for any other tool. */
export function agentLabelOf(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (!SUBAGENT_TOOLS.has(tool)) return undefined
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  return pick(input.subagent_type) ?? pick(input.description) ?? 'subagent'
}

const num = (obj: unknown, key: string): number | undefined => {
  const v = typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>)[key] : undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The four lines the pane draws from `kaizen.mjs <session-id>`'s JSON, or null when the JSON is not that shape. */
export function kaizenSummary(analysis: unknown): string[] | null {
  if (typeof analysis !== 'object' || analysis === null || Array.isArray(analysis)) return null
  const a = analysis as Record<string, unknown>
  const billable = num(a.totals, 'billableApprox')
  const subCount = num(a.subagentTotals, 'count')
  const subTokens = num(a.subagentTotals, 'tokens')
  const compactions = num(a.compactions, 'count')
  const turns = num(a.perTurn, 'count')
  if (billable === undefined || subCount === undefined || subTokens === undefined || compactions === undefined || turns === undefined) return null
  return [
    `billable ≈ ${formatTokens(billable)}`,
    `${plural(subCount, 'subagent')} · ${formatTokens(subTokens)}`,
    plural(compactions, 'compaction'),
    plural(turns, 'turn'),
  ]
}

/** Wall time: whole milliseconds under a second, else seconds with one decimal and no trailing `.0`. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`
}

/** The pane's transcript block: idle before the first open, reading while `kaizen.mjs` runs, then its summary or one failure. */
export type Transcript = { kind: 'idle' } | { kind: 'reading' } | { kind: 'done'; lines: string[] } | { kind: 'failed'; reason: string }

/**
 * What one `kaizen.mjs` run comes to. `isStdoutTruncated` is read defensively: 2.1.280's `ProcessRunResult` does not declare it, and a cut-off JSON
 * fails the parse below anyway.
 */
export function transcriptOf(run: { exitCode: number; stdout: string; stderr: string }): Transcript {
  if ((run as { isStdoutTruncated?: unknown }).isStdoutTruncated === true) return { kind: 'failed', reason: 'output was cut short' }
  if (run.exitCode !== 0) {
    const why = run.stderr.trim().split('\n')[0] ?? ''
    return { kind: 'failed', reason: `exit ${run.exitCode}${why !== '' ? ` — ${why}` : ''}` }
  }
  let analysis: unknown
  try {
    analysis = JSON.parse(run.stdout)
  } catch {
    return { kind: 'failed', reason: 'output was not JSON' }
  }
  const lines = kaizenSummary(analysis)
  return lines === null ? { kind: 'failed', reason: 'output was not the analyzer JSON' } : { kind: 'done', lines }
}
