import { mock, type MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement, RenderInput, RenderNode, SessionStartInput } from 'claude-code'

export const NAME = 'claude-agents-dashboard'
export const PANE_ID = 'kaizen-stats'
export const SESSION_ID = 'sess-183'
export const CAVEAT = 'subagent rows count what each returned, not what it spent — the transcript figures below have the full total'

export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PANE_ID,
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: {
    title: 'Kaizen stats',
    isFocused: false,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 44 },
    view: {},
  },
}

export const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

export const measure = (tokens: number, usd?: number) => ({
  context: { tokens, window: 200_000 },
  rateLimits: [],
  ...(usd !== undefined && { cost: { usd } }),
  changed: ['context' as const],
})

export const turnDone = (agentId?: string) => ({
  answer: 'ok',
  durationMs: 10,
  isAborted: false,
  turnId: `t-${Math.random()}`,
  reason: 'answer' as const,
  ...(agentId !== undefined && { agentId }),
})

const MESSAGES = [{ role: 'user' as const, text: 'summary so far', toolUses: [] }]

/** A compaction as the engine raises it; `agentId` makes it a subagent's. */
export const compaction = (trigger: 'manual' | 'auto' | 'plugin' | 'precompute', agentId?: string) =>
  ({ trigger, messages: MESSAGES, ...(agentId !== undefined && { agentId }) }) as never

/** The analyzer JSON the plan names: 1,234,567 billable, 3 subagents over 450k, one compaction, 87 turns. */
export const ANALYSIS = {
  totals: { billableApprox: 1_234_567 },
  subagentTotals: { count: 3, tokens: 450_000 },
  compactions: { count: 1 },
  perTurn: { count: 87 },
}

/**
 * The world beneath the plugin, in memory: a record of everything it asked the engine to do, and a `process.run` the test answers. `answer` defaults to
 * the analyzer printing ANALYSIS; a test swaps it to fail, throw or hang.
 */
export type World = {
  /** The engine clock: every `$.clock.now()` the meter makes around a tool call reads it. */
  clock: MockClock
  statuses: (string | undefined)[]
  toasts: string[]
  commands: string[]
  opened: string[]
  closed: string[]
  fills: string[]
  submits: number
  invalidations: number
  runs: (readonly string[])[]
  answer: (argv: readonly string[]) => Promise<ProcessRunResult>
  /** What the engine answers a compaction with; a test sets `{ skip }` to have it declined. */
  compacted: { messages: typeof MESSAGES } | { skip: string }
}

export function worldOf(on: On): World {
  const world: World = {
    clock: mock.clock(on),
    statuses: [],
    toasts: [],
    commands: [],
    opened: [],
    closed: [],
    fills: [],
    submits: 0,
    invalidations: 0,
    runs: [],
    answer: async () => ({ exitCode: 0, stdout: JSON.stringify(ANALYSIS), stderr: '' }),
    compacted: { messages: MESSAGES },
  }

  on('session.id', () => ({ value: SESSION_ID }))
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    world.invalidations += 1
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    world.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', () => {
    world.submits += 1
    return {} as never
  })
  on('process.run', async ($, e) => {
    world.runs.push(e.argv)
    return { value: await world.answer(e.argv) }
  })
  on('command.run', { command: ['clear', 'resume'] }, () => ({ text: '' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: [...e.changed] }))
  on('session.compact', () => world.compacted as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return world
}

/** Every string in a drawn tree, one per line, so a test can check order as well as presence. */
export function textOf(node: RenderNode | RenderElement | null | undefined): string {
  return stringsOf(node).join('\n')
}

function stringsOf(node: RenderNode | RenderElement | null | undefined): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(child => stringsOf(child as RenderNode))
  const element = node as { props?: { label?: unknown }; children?: readonly RenderNode[] }
  const label = typeof element.props?.label === 'string' ? [element.props.label] : []
  const own = (element.children ?? []).flatMap(child => stringsOf(child))
  // A Text's string children are one line; join them before they reach the outer list.
  return (node as { type?: string }).type === 'Text' ? [[...label, ...own].join('')] : [...label, ...own]
}

/** The lines of one section of the pane: from its heading up to the next blank-led heading. */
export function sectionOf(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => !line.startsWith(' '))
  return end < 0 ? rest : rest.slice(0, end)
}
