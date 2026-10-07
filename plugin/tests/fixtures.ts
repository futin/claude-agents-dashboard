import { mock, type MockClock } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement, RenderInput, RenderNode, SessionStartInput } from 'claude-code'

export const NAME = 'claude-agents-dashboard'
export const PANE_ID = 'kaizen-stats'
export const SESSION_ID = 'sess-183'
export const CAVEAT = '↳ returned size only, full below'

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
    answer: async () => ({ exitCode: 0, stdout: JSON.stringify(ANALYSIS), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
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
  const element = node as { props?: { label?: unknown; flexDirection?: unknown }; children?: readonly RenderNode[] }
  const label = typeof element.props?.label === 'string' ? [element.props.label] : []
  const own = (element.children ?? []).flatMap(child => stringsOf(child))
  // A row Box is one table row: its cells read as one line, `a | b | c`.
  if ((node as { type?: string }).type === 'Box' && element.props?.flexDirection === 'row') return [own.join(' | ')]
  // A Text's string children are one line; join them before they reach the outer list.
  return (node as { type?: string }).type === 'Text' ? [[...label, ...own].join('')] : [...label, ...own]
}

/** A section title as the pane draws it: alone on its line, or first cell of its table's header row. */
const isTitle = (line: string, title: string) => line === title || line.startsWith(`${title} | `)

/** The lines of one section of the pane: after its title line, up to the next section title or the button. */
export function sectionOf(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => isTitle(line, heading))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => ['TOOLS', 'SUBAGENTS', 'TRANSCRIPT'].some(title => isTitle(line, title)) || line === 'Run /kaizen')
  return end < 0 ? rest : rest.slice(0, end)
}

/** Every bold string in a drawn tree, in drawn order. */
export function boldOf(node: RenderNode | RenderElement | null | undefined): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => boldOf(child as RenderNode))
  const element = node as { type?: string; props?: { bold?: unknown }; children?: readonly RenderNode[] }
  if (element.type === 'Text' && element.props?.bold === true) return [textOf(node)]
  return (element.children ?? []).flatMap(child => boldOf(child))
}

/** The first row Box in a drawn tree whose cells read as `line`. */
export function rowOf(node: RenderNode | RenderElement | null | undefined, line: string): RenderElement | undefined {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = rowOf(child as RenderNode, line)
      if (found !== undefined) return found
    }
    return undefined
  }
  const element = node as { type?: string; props?: { flexDirection?: unknown }; children?: readonly RenderNode[] }
  if (element.type === 'Box' && element.props?.flexDirection === 'row' && textOf(node) === line) return node as RenderElement
  for (const child of element.children ?? []) {
    const found = rowOf(child, line)
    if (found !== undefined) return found
  }
  return undefined
}
