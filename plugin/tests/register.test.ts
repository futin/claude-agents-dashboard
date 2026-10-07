import { describe, expect, test } from 'claude-code/testing'

import { ANALYSIS, boldOf, CAVEAT, command, compaction, measure, NAME, PANE, PANE_ID, rowOf, sectionOf, SESSION, SESSION_ID, textOf, turnDone, worldOf } from './fixtures'

/** The names of a section's rows, in drawn order; `+N more` lines included as they read. */
const namesOf = (rows: string[]) => rows.map(row => row.split(' | ')[0])

const paneTree = async ($: { ui: { render: (e: typeof PANE) => Promise<unknown> } }) => (await $.ui.render(PANE)) as never

const paneText = async ($: { ui: { render: (e: typeof PANE) => Promise<unknown> } }) => textOf(await paneTree($))

/** The bold cells of a pane, section titles left out. */
const boldCells = (tree: never) => boldOf(tree).filter(text => !['TOOLS', 'SUBAGENTS', 'TRANSCRIPT'].includes(text))

const lastStatus = (statuses: (string | undefined)[]) => statuses[statuses.length - 1] ?? ''

describe('start', () => {
  test('registers exactly the kaizen-stats command and opens no pane', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)

    expect(world.commands).toEqual(['kaizen-stats'])
    expect(world.opened).toEqual([])
  })
})

describe('status line', () => {
  test('a measure draws context and cost, labelled live and never billable', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.session.measure(measure(42_000, 1.23))

    const line = lastStatus(world.statuses)
    expect(line).toContain('ctx 42k')
    expect(line).toContain('$1.23')
    expect(line).toContain('live')
    expect(line).not.toContain('billable')
  })

  test('main-thread turns and compactions are counted', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.turn.complete(turnDone())
    await $.turn.complete(turnDone())
    await $.session.compact(compaction('manual'))

    const line = lastStatus(world.statuses)
    expect(line).toContain('2 turns')
    expect(line).toContain('1 compaction')
  })

  test('a subagent turn passes through uncounted', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.turn.complete(turnDone())
    await $.turn.complete(turnDone('agent-1'))

    expect(lastStatus(world.statuses)).toContain('1 turn ')
  })

  // Each of these leaves the count alone and the nudge disarmed: after a toast at 150k, a drop and a climb past the threshold raise no second one.
  for (const [label, raise] of [
    ['a subagent compaction', (world: ReturnType<typeof worldOf>) => compaction('auto', 'agent-1')],
    [
      'a compaction the engine declined',
      (world: ReturnType<typeof worldOf>) => {
        world.compacted = { skip: 'declined' }
        return compaction('manual')
      },
    ],
    ['a precompute that completed', (world: ReturnType<typeof worldOf>) => compaction('precompute')],
  ] as const) {
    test(`${label} is not counted and does not re-arm the nudge`, async ($, on) => {
      const world = worldOf(on)

      await $.session.start(SESSION)
      await $.session.measure(measure(150_000))
      await $.session.compact(raise(world))
      await $.session.measure(measure(60_000))
      await $.session.measure(measure(155_000))

      expect(lastStatus(world.statuses)).toContain('0 compactions')
      expect(world.toasts.length).toBe(1)
    })
  }
})

describe('nudge', () => {
  test('one toast naming /compact at the threshold, none again until a compaction re-arms it', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.session.measure(measure(149_999))
    expect(world.toasts).toEqual([])

    await $.session.measure(measure(150_000))
    expect(world.toasts.length).toBe(1)
    expect(world.toasts[0]).toContain('/compact')

    await $.session.measure(measure(170_000))
    expect(world.toasts.length).toBe(1)

    await $.session.compact(compaction('manual'))
    await $.session.measure(measure(60_000))
    await $.session.measure(measure(155_000))
    expect(world.toasts.length).toBe(2)
  })

  test('a measure with no context figure after a compaction neither toasts on the stale figure nor shows it', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.session.measure(measure(150_000))
    await $.session.compact(compaction('manual'))
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 2 }, changed: ['cost'] } as never)

    expect(world.toasts.length).toBe(1)
    expect(lastStatus(world.statuses)).not.toContain('ctx 150k')
  })
})

describe('tool ledger', () => {
  test('one table of tokens, wall time and calls per tool, timed on the engine clock around the call', async ($, on) => {
    const { clock } = worldOf(on)
    const sizes: Record<string, { ms: number; chars: number }[]> = {
      Read: [
        { ms: 100, chars: 4000 },
        { ms: 50, chars: 8000 },
      ],
      Bash: [{ ms: 2000, chars: 400 }],
    }
    on('tool.call', async ($, e) => {
      const next = sizes[e.tool]?.shift() ?? { ms: 0, chars: 0 }
      await clock.sleep(next.ms)
      return { result: 'x', text: 'x'.repeat(next.chars) }
    })

    await $.session.start(SESSION)
    for (const [tool, ms] of [
      ['Read', 100],
      ['Bash', 2000],
      ['Read', 50],
    ] as const) {
      const call = $.tool.call({ tool, tool_use_id: `${tool}-${ms}` } as never)
      await clock.advance(ms)
      await call
    }

    await $.command.run(command('kaizen-stats'))
    const tree = await paneTree($)
    const text = textOf(tree)

    expect(text.split('\n')).toContain('TOOLS | tokens | time | calls')
    expect(sectionOf(text, 'TOOLS')).toEqual(['Read | 3k | 150ms | 2', 'Bash | 100 | 2s | 1'])
    // Each number column's sole leader is bold: Read leads tokens and calls, Bash leads wall time.
    expect(boldCells(tree)).toEqual(['3k', '2', '2s'])
    expect(boldOf(tree).filter(text => ['TOOLS', 'SUBAGENTS', 'TRANSCRIPT'].includes(text))).toEqual(['TOOLS', 'SUBAGENTS', 'TRANSCRIPT'])
  })

  test('a tie for a column leaves that column unbolded, and so does a table of one row', async ($, on) => {
    worldOf(on)
    on('tool.call', ($, e) => ({ result: 'x', text: 'x'.repeat(e.tool === 'Bash' ? 400 : 800) }))

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read' } as never)
    await $.command.run(command('kaizen-stats'))
    expect(boldCells(await paneTree($)), 'one row').toEqual([])

    await $.tool.call({ tool: 'Bash' } as never)
    await $.tool.call({ tool: 'Bash' } as never)
    // Read 200 tokens in 1 call, Bash 200 in 2: tokens and wall time tie, calls has a sole leader.
    expect(boldCells(await paneTree($))).toEqual(['2'])
  })

  test('a long name is the cell that gives way: the number columns keep a fixed width', async ($, on) => {
    worldOf(on)
    on('tool.call', () => ({ result: 'x', text: 'x'.repeat(400) }))

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__codegraph__codegraph_explore' } as never)
    await $.command.run(command('kaizen-stats'))

    const row = rowOf(await paneTree($), 'mcp__codegraph__codegraph_explore | 100 | 0ms | 1') as unknown as {
      children: { props: { flexGrow?: number; flexShrink?: number; width?: number }; children: { props: { wrap?: string } }[] }[]
    }
    expect(row).toBeDefined()
    const [name, ...figures] = row.children
    expect(name?.props.flexGrow).toBe(1)
    expect(name?.children[0]?.props.wrap).toBe('truncate-end')
    expect(figures.length).toBe(3)
    for (const cell of figures) {
      expect(cell.props.flexShrink).toBe(0)
      expect(typeof cell.props.width).toBe('number')
    }
  })

  test('seven tools show five rows and a +2 more line', async ($, on) => {
    worldOf(on)
    on('tool.call', ($, e) => ({ result: 'x', text: 'x'.repeat(4 * (e.tool.length + 1)) }))

    await $.session.start(SESSION)
    for (const tool of ['A', 'BB', 'CCC', 'DDDD', 'EEEEE', 'FFFFFF', 'GGGGGGG']) {
      await $.tool.call({ tool } as never)
    }
    await $.command.run(command('kaizen-stats'))

    const rows = sectionOf(await paneText($), 'TOOLS')
    expect(namesOf(rows)).toEqual(['GGGGGGG', 'FFFFFF', 'EEEEE', 'DDDD', 'CCC', '+2 more'])
  })

  test('a denied call is returned as is and not recorded', async ($, on) => {
    worldOf(on)
    on('tool.call', () => ({ deny: 'no' }))

    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Bash' } as never)
    await $.command.run(command('kaizen-stats'))

    expect(result).toEqual({ deny: 'no' })
    expect(sectionOf(await paneText($), 'TOOLS')).toEqual(['none yet'])
  })

  test('a call that throws is rethrown and leaves the ledger unchanged', async ($, on) => {
    worldOf(on)
    on('tool.call', () => {
      throw new Error('boom')
    })

    await $.session.start(SESSION)
    let caught: unknown
    try {
      await $.tool.call({ tool: 'Bash' } as never)
    } catch (error) {
      caught = error
    }
    await $.command.run(command('kaizen-stats'))

    // The engine reports a beneath hook's throw as a skip and rejects the call; what matters is that the rejection reaches the caller.
    expect(caught).toBeDefined()
    expect(sectionOf(await paneText($), 'TOOLS')).toEqual(['none yet'])
  })

  test('a normal result comes back exactly as the engine produced it', async ($, on) => {
    worldOf(on)
    const produced = { result: { lines: 3 }, text: 'abc' }
    on('tool.call', () => produced)

    await $.session.start(SESSION)

    expect(await $.tool.call({ tool: 'Read' } as never)).toEqual(produced)
  })

  test('an isError call is still recorded', async ($, on) => {
    worldOf(on)
    on('tool.call', () => ({ isError: true as const, result: 'x', text: 'x'.repeat(400) }))

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash' } as never)
    await $.command.run(command('kaizen-stats'))

    expect(sectionOf(await paneText($), 'TOOLS')).toEqual(['Bash | 100 | 0ms | 1'])
  })

  test('Agent calls fill the subagent table only, under the caveat; a subagent own tool calls are not counted', async ($, on) => {
    worldOf(on)
    on('tool.call', () => ({ result: 'x', text: 'x'.repeat(2000) }))

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'find' } as never)
    await $.tool.call({ tool: 'Agent', description: 'audit docs' } as never)
    await $.tool.call({ tool: 'Read', agentId: 'agent-1' } as never)
    await $.command.run(command('kaizen-stats'))
    const text = await paneText($)

    expect(sectionOf(text, 'SUBAGENTS')).toEqual(['Explore | 500 | 0ms | 1', 'audit docs | 500 | 0ms | 1', CAVEAT])
    expect(sectionOf(text, 'TOOLS')).toEqual(['none yet'])
  })
})

describe('pane', () => {
  test('/kaizen-stats toggles the pane open and closed', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.command.run(command('kaizen-stats'))
    expect(world.opened).toEqual([PANE_ID])

    await $.command.run(command('kaizen-stats'))
    expect(world.closed).toEqual([PANE_ID])

    await $.command.run(command('kaizen-stats'))
    expect(world.opened).toEqual([PANE_ID, PANE_ID])
  })

  // The kit's engine raises no `ui.close` of its own, so a plugin above stands in for whoever closes the pane from outside: the meter has to hear it
  // through its `ui.close` hook, or the next /kaizen-stats would close an already-closed pane instead of opening it.
  test(
    'after the pane is closed from outside, the next /kaizen-stats opens it again',
    {
      plugins: [
        {
          name: 'closer',
          tier: 'prepend',
          register(on) {
            on('command.run', { command: 'shut' }, async $ => {
              await $.ui.close({ id: 'kaizen-stats' })
              return {}
            })
          },
        },
      ],
    },
    async ($, on) => {
      const world = worldOf(on)

      await $.session.start(SESSION)
      await $.command.run(command('kaizen-stats'))
      await $.command.run(command('shut'))
      await $.command.run(command('kaizen-stats'))

      expect(world.closed).toEqual([PANE_ID])
      expect(world.opened).toEqual([PANE_ID, PANE_ID])
    },
  )

  test('a recorded call or a measure redraws the pane only while it is open', async ($, on) => {
    const world = worldOf(on)
    on('tool.call', () => ({ result: 'x', text: 'x' }))

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Read' } as never)
    await $.session.measure(measure(1000))
    expect(world.invalidations).toBe(0)

    await $.command.run(command('kaizen-stats'))
    // Let the transcript read land first: its own redraw is not what this test counts.
    await world.clock.settle()
    const opened = world.invalidations
    await $.tool.call({ tool: 'Read' } as never)
    expect(world.invalidations).toBe(opened + 1)
    await $.session.measure(measure(2000))
    expect(world.invalidations).toBe(opened + 2)

    await $.command.run(command('kaizen-stats'))
    const closed = world.invalidations
    await $.tool.call({ tool: 'Read' } as never)
    expect(world.invalidations).toBe(closed)
  })

  test('opening runs kaizen.mjs on this session and draws its summary, reading transcript… until it answers', async ($, on) => {
    const world = worldOf(on)
    const { clock } = world
    const answer = world.answer
    world.answer = async argv => {
      await clock.sleep(1000)
      return answer(argv)
    }

    await $.session.start(SESSION)
    await $.command.run(command('kaizen-stats'))
    await clock.settle()
    expect(sectionOf(await paneText($), 'TRANSCRIPT')).toEqual(['reading transcript…'])

    await clock.advance(1000)
    expect(sectionOf(await paneText($), 'TRANSCRIPT')).toEqual(['billable | ≈ 1.2M', 'subagents | 3 · 450k', 'compactions | 1', 'turns | 87'])

    const argv = world.runs[0] ?? []
    expect(argv.length).toBe(3)
    expect(argv[0]).toBe('node')
    expect(String(argv[1]).endsWith('skills/kaizen/kaizen.mjs')).toBe(true)
    expect(argv[2]).toBe(SESSION_ID)
  })

  for (const [label, answer] of [
    ['a non-zero exit', async () => ({ exitCode: 1, stdout: '', stderr: 'unknown session' })],
    ['output that is not JSON', async () => ({ exitCode: 0, stdout: 'not json', stderr: '' })],
    ['JSON that is not the analyzer shape', async () => ({ exitCode: 0, stdout: '{"totals":{}}', stderr: '' })],
    ['truncated output', async () => ({ exitCode: 0, stdout: JSON.stringify({ totals: {} }), stderr: '', isStdoutTruncated: true })],
    [
      'a run that rejects',
      async () => {
        throw new Error('spawn node ENOENT')
      },
    ],
  ] as const) {
    test(`${label} draws one error line and throws nothing`, async ($, on) => {
      const world = worldOf(on)
      world.answer = answer as never

      await $.session.start(SESSION)
      await $.command.run(command('kaizen-stats'))
      await world.clock.settle()
      const rows = sectionOf(await paneText($), 'TRANSCRIPT')

      expect(rows.length).toBe(1)
      expect(rows[0]).toContain('kaizen failed')
    })
  }

  test('Run /kaizen fills the prompt and never submits it', async ($, on) => {
    const world = worldOf(on)

    await $.session.start(SESSION)
    await $.command.run(command('kaizen-stats'))
    await $.ui.render(PANE)
    await $.ui.press({ plugin: NAME, key: 'run-kaizen' })

    expect(world.fills).toEqual(['/kaizen'])
    expect(world.submits).toBe(0)
  })
})

describe('reset', () => {
  for (const name of ['clear', 'resume']) {
    test(`/${name} resets the meter and the ledger`, async ($, on) => {
      const world = worldOf(on)
      on('tool.call', () => ({ result: 'x', text: 'x'.repeat(400) }))

      await $.session.start(SESSION)
      await $.turn.complete(turnDone())
      await $.session.compact(compaction('manual'))
      // After the compaction, so it is the reset alone that can re-arm the nudge this toast disarms.
      await $.session.measure(measure(160_000))
      await $.session.measure(measure(42_000, 1.23))
      await $.tool.call({ tool: 'Bash' } as never)
      await $.command.run(command(name))
      await $.command.run(command('kaizen-stats'))

      const line = lastStatus(world.statuses)
      expect(line).toContain('ctx –')
      expect(line).toContain('0 turns')
      expect(line).toContain('0 compactions')
      expect(line).not.toContain('$')
      expect(sectionOf(await paneText($), 'TOOLS')).toEqual(['none yet'])

      await $.session.measure(measure(160_000))
      expect(world.toasts.length, 'the reset re-armed the nudge').toBe(2)
    })

    test(`/${name} with the pane open re-reads the transcript rather than keep the old session's`, async ($, on) => {
      const world = worldOf(on)

      await $.session.start(SESSION)
      await $.command.run(command('kaizen-stats'))
      await world.clock.settle()
      expect(sectionOf(await paneText($), 'TRANSCRIPT')).toContain('turns | 87')

      world.answer = async () => ({ exitCode: 0, stdout: JSON.stringify({ ...ANALYSIS, perTurn: { count: 2 } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
      await $.command.run(command(name))
      await world.clock.settle()

      const transcript = sectionOf(await paneText($), 'TRANSCRIPT')
      expect(transcript).toContain('turns | 2')
      expect(transcript).not.toContain('turns | 87')
      expect(world.runs.length).toBe(2)
    })
  }
})
