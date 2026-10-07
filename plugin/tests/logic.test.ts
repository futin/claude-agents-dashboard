import { describe, expect, test } from 'claude-code/testing'

import {
  agentLabelOf,
  formatMs,
  formatTokens,
  formatUsd,
  kaizenSummary,
  newLedger,
  newNudge,
  nudgeDue,
  recordCall,
  statusLine,
  thresholdOf,
  topBy,
} from '../hooks/meter'

describe('formatting', () => {
  test('formatTokens prints integers, k and M with one decimal and no trailing .0', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(180000)).toBe('180k')
    expect(formatTokens(999999)).toBe('1M')
    expect(formatTokens(2100000)).toBe('2.1M')
  })

  test('formatUsd rounds to cents, and a sliver above zero reads <$0.01', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0.005)).toBe('$0.01')
    expect(formatUsd(0.0099)).toBe('$0.01')
  })

  test('formatMs prints whole milliseconds under a second, else seconds with one decimal', () => {
    expect(formatMs(150)).toBe('150ms')
    expect(formatMs(999)).toBe('999ms')
    expect(formatMs(1000)).toBe('1s')
    expect(formatMs(2050)).toBe('2.1s')
  })
})

describe('status line', () => {
  test('carries context, cost, turns and compactions, labelled live and never billable', () => {
    const line = statusLine({ contextTokens: 42000, usd: 1.23, turns: 1, compactions: 0 })

    expect(line).toContain('ctx 42k')
    expect(line).toContain('$1.23')
    expect(line).toContain('live')
    expect(line).toContain('1 turn')
    expect(line).toContain('0 compactions')
    expect(line).not.toContain('billable')
  })

  test('a meter with no reading yet says so rather than printing zero', () => {
    const line = statusLine({ turns: 0, compactions: 1 })

    expect(line).toContain('ctx –')
    expect(line).toContain('0 turns')
    expect(line).toContain('1 compaction')
    expect(line).not.toContain('$')
  })
})

describe('nudge', () => {
  test('fires once at the threshold, not below it, and not again until re-armed', () => {
    const nudge = newNudge()

    expect(nudgeDue(nudge, 149_999, 150_000)).toBe(false)
    expect(nudgeDue(nudge, 150_000, 150_000)).toBe(true)
    expect(nudgeDue(nudge, 170_000, 150_000)).toBe(false)
    nudge.isArmed = true
    expect(nudgeDue(nudge, 155_000, 150_000)).toBe(true)
  })

  test('a threshold of 0 never fires', () => {
    expect(nudgeDue(newNudge(), 500_000, 0)).toBe(false)
  })

  test('thresholdOf reads nudgeAtTokens, defaulting to 150000 when it is absent or not a usable number', () => {
    expect(thresholdOf({})).toBe(150_000)
    expect(thresholdOf({ nudgeAtTokens: 0 })).toBe(0)
    expect(thresholdOf({ nudgeAtTokens: 90_000 })).toBe(90_000)
    expect(thresholdOf({ nudgeAtTokens: '90000' })).toBe(90_000)
    expect(thresholdOf({ nudgeAtTokens: -5 })).toBe(150_000)
    expect(thresholdOf({ nudgeAtTokens: 'lots' })).toBe(150_000)
  })
})

describe('tool ledger', () => {
  test('tokens are text length / 4, summed per tool; ranked by tokens and by wall time', () => {
    const ledger = newLedger()

    recordCall(ledger, { tool: 'Read', durationMs: 100, resultText: 'x'.repeat(4000) })
    recordCall(ledger, { tool: 'Bash', durationMs: 2000, resultText: 'x'.repeat(400) })
    recordCall(ledger, { tool: 'Read', durationMs: 50, resultText: 'x'.repeat(8000) })

    expect(topBy(ledger.tools, 'tokens', 5)).toEqual([
      { name: 'Read', calls: 2, tokens: 3000, wallMs: 150 },
      { name: 'Bash', calls: 1, tokens: 100, wallMs: 2000 },
    ])
    expect(topBy(ledger.tools, 'wallMs', 5).map(row => row.name)).toEqual(['Bash', 'Read'])
  })

  test('ties sort by name, ascending, and n caps the list', () => {
    const ledger = newLedger()

    for (const tool of ['Grep', 'Bash', 'Edit']) {
      recordCall(ledger, { tool, durationMs: 10, resultText: 'abcd' })
    }

    expect(topBy(ledger.tools, 'tokens', 2).map(row => row.name)).toEqual(['Bash', 'Edit'])
  })

  test('a call with an agent label goes to the subagent table only', () => {
    const ledger = newLedger()

    recordCall(ledger, { tool: 'Agent', agentLabel: 'Explore', durationMs: 5, resultText: 'x'.repeat(2000) })

    expect(topBy(ledger.agents, 'tokens', 5)).toEqual([{ name: 'Explore', calls: 1, tokens: 500, wallMs: 5 }])
    expect(ledger.tools.size).toBe(0)
  })

  test('agentLabelOf labels Agent and Task calls by subagent_type, else description, and nothing else', () => {
    expect(agentLabelOf('Agent', { subagent_type: 'Explore', description: 'find it' })).toBe('Explore')
    expect(agentLabelOf('Task', { description: 'find it' })).toBe('find it')
    expect(agentLabelOf('Agent', {})).toBe('subagent')
    expect(agentLabelOf('Read', { subagent_type: 'Explore' })).toBeUndefined()
  })
})

describe('kaizen summary', () => {
  test('picks the four figures out of the analyzer JSON, in order', () => {
    expect(
      kaizenSummary({
        totals: { billableApprox: 1_234_567 },
        subagentTotals: { count: 3, tokens: 450_000 },
        compactions: { count: 1 },
        perTurn: { count: 87 },
      }),
    ).toEqual(['billable ≈ 1.2M', '3 subagents · 450k', '1 compaction', '87 turns'])
  })

  test('JSON that is not the analyzer shape answers null', () => {
    expect(kaizenSummary({ totals: {} })).toBeNull()
    expect(kaizenSummary(null)).toBeNull()
    expect(kaizenSummary([1, 2])).toBeNull()
  })
})
