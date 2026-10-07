import type { Elements, RenderElement } from 'claude-code'

import { formatMs, formatTokens, plural, topBy, type Ledger, type Row, type Transcript } from './meter'

export const CAVEAT = 'subagent rows count what each returned, not what it spent — the transcript figures below have the full total'

const TOP = 5

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** One ranked table as indented lines: the top five, a `+N more` line past that, `none yet` when empty. */
function rowsOf(table: ReadonlyMap<string, Row>, key: 'tokens' | 'wallMs'): string[] {
  if (table.size === 0) return ['  none yet']
  const figure = (row: Row) => (key === 'tokens' ? formatTokens(row.tokens) : formatMs(row.wallMs))
  const lines = topBy(table, key, TOP).map(row => `  ${row.name} · ${figure(row)} · ${plural(row.calls, 'call')}`)
  return table.size > TOP ? [...lines, `  +${table.size - TOP} more`] : lines
}

function transcriptLines(transcript: Transcript): string[] {
  switch (transcript.kind) {
    case 'idle':
      return []
    case 'reading':
      return ['  reading transcript…']
    case 'done':
      return transcript.lines.map(line => `  ${line}`)
    case 'failed':
      return [`  kaizen failed: ${transcript.reason}`]
  }
}

/** The `/kaizen-stats` pane: live tables from this session's tool calls, then the transcript's own figures and a button that fills `/kaizen`. */
export function paneView(kit: Kit, ledger: Ledger, transcript: Transcript, runKaizen: () => void): RenderElement {
  const { Box, Text, Button } = kit
  const lines = [
    'Tools by tokens',
    ...rowsOf(ledger.tools, 'tokens'),
    'Tools by wall time',
    ...rowsOf(ledger.tools, 'wallMs'),
    'Subagents by tokens',
    ...rowsOf(ledger.agents, 'tokens'),
    'Subagents by wall time',
    ...rowsOf(ledger.agents, 'wallMs'),
    CAVEAT,
    'Transcript',
    ...transcriptLines(transcript),
  ]
  return (
    <Box flexDirection="column">
      {lines.map(line => (
        <Text>{line}</Text>
      ))}
      <Button key="run-kaizen" onPress={runKaizen}>
        Run /kaizen
      </Button>
    </Box>
  )
}
