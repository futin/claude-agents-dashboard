/**
 * The live kaizen meter: a status line from the engine's own running figures, one nudge toward `/compact` per arming, and a `/kaizen-stats` pane that
 * ranks this session's tool and subagent calls beside what `kaizen.mjs` reads off the transcript. Every `$` call is spelled out here, in this file,
 * because the engine reads them off the module's source.
 */
import type { Hook, Register } from 'claude-code'

import { kaizenScriptPath } from './kaizen-path'
import { agentLabelOf, newLedger, newMeter, newNudge, nudgeDue, recordCall, statusLine, thresholdOf, transcriptOf, type Transcript } from './meter'
import { paneView } from './view'

const PANE_ID = 'kaizen-stats'
const PANE_TITLE = 'Kaizen stats'
const KAIZEN_TIMEOUT_MS = 60_000
const NUDGE_TIMEOUT_MS = 10_000

/** One `kaizen.mjs` run over this session, as the pane's transcript block; never throws. */
async function readKaizen($: Parameters<Hook<'command.run'>>[0]): Promise<Transcript> {
  try {
    const sessionId = await $.session.id()
    return transcriptOf(await $.process.run(['node', kaizenScriptPath(), sessionId], { timeoutMs: KAIZEN_TIMEOUT_MS }))
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

export const register: Register = (on, options) => {
  const threshold = thresholdOf(options)
  let meter = newMeter()
  let nudge = newNudge()
  let ledger = newLedger()
  let transcript: Transcript = { kind: 'idle' }
  let isPaneOpen = false
  // A newer read supersedes an older one still in flight; only the latest may land.
  let readSeq = 0

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({ name: PANE_ID, description: 'Show or hide live tool, subagent and transcript token figures for this session', immediate: true })
      .catch(() => undefined)
    await $.ui.status(statusLine(meter))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.context.tokens !== undefined) meter.contextTokens = e.context.tokens
    if (e.cost !== undefined) meter.usd = e.cost.usd
    // Only a figure this event carries can trip the nudge — a compaction re-arms it while the held figure is still the pre-compaction one.
    if (e.context.tokens !== undefined && nudgeDue(nudge, e.context.tokens, threshold)) {
      await $.ui.toast(`Context is at ${statusLine(meter).split(' · ')[1]} — a /compact now keeps the next turns cheap`, { timeoutMs: NUDGE_TIMEOUT_MS })
    }
    await $.ui.status(statusLine(meter))
    if (isPaneOpen) await $.ui.invalidate('ui.render')
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || 'skip' in result) return result
    meter.compactions += 1
    if ('tokensAfter' in result && result.tokensAfter !== undefined) meter.contextTokens = result.tokensAfter
    else delete meter.contextTokens
    nudge.isArmed = true
    await $.ui.status(statusLine(meter))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    meter.turns += 1
    await $.ui.status(statusLine(meter))
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const startMs = await $.clock.now()
    const result = await next(e)
    if (result.deny !== undefined) return result
    const endMs = await $.clock.now()
    const resultText = typeof result.text === 'string' ? result.text : typeof result.result === 'string' ? result.result : ''
    const label = agentLabelOf(e.tool, e as unknown as Readonly<Record<string, unknown>>)
    recordCall(ledger, { tool: e.tool, ...(label !== undefined && { agentLabel: label }), durationMs: endMs - startMs, resultText })
    if (isPaneOpen) await $.ui.invalidate('ui.render')
    return result
  })

  /** Marks a fresh read in flight; its number is how the read later knows whether a newer one superseded it. */
  const beginRead = (): number => {
    transcript = { kind: 'reading' }
    return ++readSeq
  }

  /** Lands a read unless a newer one started since; true when the open pane should redraw. */
  const landRead = (seq: number, read: Transcript): boolean => {
    if (seq !== readSeq) return false
    transcript = read
    return isPaneOpen
  }

  on('command.run', { command: PANE_ID }, async ($, e, next) => {
    if (isPaneOpen) {
      await $.ui.close({ id: PANE_ID })
      isPaneOpen = false
      return {}
    }
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    isPaneOpen = true
    const seq = beginRead()
    // Not awaited: the pane draws `reading transcript…` while the analyzer runs, and the command answers at once.
    void readKaizen($).then(async read => {
      if (landRead(seq, read)) await $.ui.invalidate('ui.render')
    })
    return {}
  })

  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    const result = await next(e)
    meter = newMeter()
    nudge = newNudge()
    ledger = newLedger()
    // The transcript block names a session too: re-read it for the one now live, or forget it until the pane next opens.
    if (isPaneOpen) {
      const seq = beginRead()
      void readKaizen($).then(async read => {
        if (landRead(seq, read)) await $.ui.invalidate('ui.render')
      })
    } else {
      readSeq += 1
      transcript = { kind: 'idle' }
    }
    await $.ui.status(statusLine(meter))
    if (isPaneOpen) await $.ui.invalidate('ui.render')
    return result
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE_ID) isPaneOpen = false
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    return paneView($.ui.resolve(e), ledger, transcript, () => {
      void $.prompt.fill({ text: '/kaizen' }).catch(() => undefined)
    })
  })
}
