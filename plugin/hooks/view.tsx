import type { Elements, RenderElement } from 'claude-code'

import { formatMs, formatTokens, topBy, type Figure, type Ledger, type Row, type Transcript } from './meter'

export const CAVEAT = '↳ returned size only, full below'

const TOP = 5

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** The number columns, right-aligned at a fixed width so a long name is the cell that gives way. */
const COLUMNS = [
  { title: 'tokens', width: 7, of: (row: Row) => row.tokens, show: (row: Row) => formatTokens(row.tokens) },
  { title: 'time', width: 6, of: (row: Row) => row.wallMs, show: (row: Row) => formatMs(row.wallMs) },
  { title: 'calls', width: 6, of: (row: Row) => row.calls, show: (row: Row) => String(row.calls) },
] as const

/** The row holding a column's sole maximum, or undefined on a tie or a table of one row. An all-zero column is a tie. */
function leaderOf(rows: readonly Row[], of: (row: Row) => number): Row | undefined {
  if (rows.length < 2) return undefined
  const best = Math.max(...rows.map(of))
  const leaders = rows.filter(row => of(row) === best)
  return leaders.length === 1 ? leaders[0] : undefined
}

/** One ranked table, by tokens: a header row carrying the title, the top five rows, a `+N more` line past that, `none yet` when empty. */
function table(kit: Kit, title: string, rows: ReadonlyMap<string, Row>, footer?: string): RenderElement {
  const { Box, Text } = kit
  const shown = topBy(rows, 'tokens', TOP)
  const leaders = COLUMNS.map(column => leaderOf(shown, column.of))
  const cell = (width: number, text: string, style: { bold?: boolean; dimColor?: boolean } = {}) => (
    <Box width={width} flexShrink={0} justifyContent="flex-end">
      <Text {...style}>{text}</Text>
    </Box>
  )
  const name = (text: string, style: { bold?: boolean } = {}) => (
    <Box flexGrow={1} flexShrink={1} minWidth={0}>
      <Text {...style} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        {name(title, { bold: true })}
        {COLUMNS.map(column => cell(column.width, column.title, { dimColor: true }))}
      </Box>
      {shown.map(row => (
        <Box flexDirection="row">
          {name(row.name)}
          {COLUMNS.map((column, i) => cell(column.width, column.show(row), leaders[i] === row ? { bold: true } : {}))}
        </Box>
      ))}
      {shown.length === 0 ? <Text dimColor>none yet</Text> : null}
      {rows.size > TOP ? <Text dimColor>{`+${rows.size - TOP} more`}</Text> : null}
      {footer !== undefined ? <Text dimColor>{footer}</Text> : null}
    </Box>
  )
}

/** The transcript's figures as label / value rows, or the one line that stands in for them. */
function transcriptBody(kit: Kit, transcript: Transcript): RenderElement[] {
  const { Box, Text } = kit
  switch (transcript.kind) {
    case 'idle':
      return []
    case 'reading':
      return [<Text dimColor>reading transcript…</Text>]
    case 'done':
      return transcript.figures.map(([label, value]: Figure) => (
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Text>{label}</Text>
          </Box>
          <Text>{value}</Text>
        </Box>
      ))
    case 'failed':
      return [<Text dimColor>{`kaizen failed: ${transcript.reason}`}</Text>]
  }
}

/** The `/kaizen-stats` pane: live tables from this session's tool calls, then the transcript's own figures and a button that fills `/kaizen`. */
export function paneView(kit: Kit, ledger: Ledger, transcript: Transcript, runKaizen: () => void): RenderElement {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column">
      {table(kit, 'TOOLS', ledger.tools)}
      {table(kit, 'SUBAGENTS', ledger.agents, CAVEAT)}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>TRANSCRIPT</Text>
        {transcriptBody(kit, transcript)}
      </Box>
      <Button key="run-kaizen" onPress={runKaizen}>
        Run /kaizen
      </Button>
    </Box>
  )
}
