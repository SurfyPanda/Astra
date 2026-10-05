import { config } from './config.js'
import { describeTool } from './activity.js'

const FINISH_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
])

/**
 * Runs one agent turn against an OpenCode session and streams it back as callbacks.
 *
 * Verified event contract (opencode 2.0.x):
 *   session.text.delta        -> streamed assistant text ({ delta })
 *   session.tool.called       -> tool started ({ name, input })
 *   session.tool.success      -> tool finished ({ name, content })
 *   permission.asked          -> must be answered or the turn stalls forever
 *   session.execution.*       -> turn finished
 */
export async function runTurn({ runtime, sessions, activity, astraSessionId, text, onDelta, signal }) {
  const openCodeSessionId = await sessions.ensure(astraSessionId)
  const startedAt = Date.now()
  const toolStarts = new Map()

  let settled = false
  let finishReason = 'stop'
  let resolveTurn
  const turnFinished = new Promise((resolve) => { resolveTurn = resolve })

  const matches = (event) => event?.data?.sessionID === openCodeSessionId

  // Tool names are announced on session.tool.input.started ({ id, name });
  // session.tool.called/ success only carry the call id + input.
  const toolNames = new Map()

  const nameOf = (event) => event.data.name ?? toolNames.get(event.data.id) ?? 'tool'

  const onEvent = async (event) => {
    if (!event?.data) return

    switch (event.type) {
      case 'session.step.started':
        if (matches(event)) {
          activity.publish({ kind: 'step', sessionId: astraSessionId, text: `reasoning · ${event.data.model?.id ?? 'model'}` })
        }
        break

      case 'session.tool.input.started': {
        if (!matches(event)) break
        if (event.data.id && event.data.name) toolNames.set(event.data.id, event.data.name)
        break
      }

      case 'session.tool.called': {
        if (!matches(event)) break
        const name = nameOf(event)
        if (process.env.ASTRA_DEBUG_EVENTS) {
          activity.publish({ kind: 'debug', sessionId: astraSessionId, text: `CALLED ${JSON.stringify(event.data).slice(0, 500)}` })
        }
        const summary = describeTool(name, event.data.input)
        toolStarts.set(event.data.id, summary)
        activity.publish({ kind: 'tool', sessionId: astraSessionId, name, text: summary })
        break
      }

      case 'session.tool.success':
      case 'session.tool.failed': {
        if (!matches(event)) break
        const name = nameOf(event)
        const outcome = event.type === 'session.tool.success' ? 'ok' : 'failed'
        const started = toolStarts.get(event.data.id)
        activity.publish({
          kind: 'tool-result',
          sessionId: astraSessionId,
          name,
          text: started ? `${started} → ${outcome}` : `${name} ${outcome}`,
        })
        toolStarts.delete(event.data.id)
        break
      }

      case 'permission.asked': {
        if (!matches(event)) break
        if (process.env.ASTRA_DEBUG_EVENTS) {
          activity.publish({ kind: 'debug', sessionId: astraSessionId, text: `PERM ${JSON.stringify(event.data).slice(0, 500)}` })
        }
        const permissionId = event.data.id ?? event.data.requestID
        activity.publish({
          kind: 'permission',
          sessionId: astraSessionId,
          text: `allowed · ${event.data.action ?? event.data.type ?? 'tool'} ${JSON.stringify(event.data.resources ?? []).slice(0, 70)}`,
        })
        // The headless runtime has no interactive client to click "allow", so the
        // proxy grants one-shot approval. Every request still lands in the activity feed.
        try {
          await runtime.request('POST', `/api/session/${openCodeSessionId}/permission/${permissionId}/reply`, {
            decision: 'once',
          })
        } catch (error) {
          activity.publish({ kind: 'error', sessionId: astraSessionId, text: `permission reply failed: ${error.message}` })
        }
        break
      }

      case 'session.text.delta': {
        if (!matches(event) || !event.data.delta) break
        onDelta?.(event.data.delta)
        break
      }

      default:
        if (FINISH_EVENTS.has(event.type) && matches(event) && !settled) {
          settled = true
          finishReason = event.type.endsWith('succeeded') ? 'stop'
            : event.type.endsWith('interrupted') ? 'length' : 'error'
          resolveTurn(finishReason)
        }
    }
  }

  runtime.on('event', onEvent)

  const cleanup = () => {
    runtime.off('event', onEvent)
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }

  const onAbort = () => {
    if (settled) return
    settled = true
    finishReason = 'aborted'
    resolveTurn('aborted')
    runtime.request('POST', `/api/session/${openCodeSessionId}/interrupt`).catch(() => { /* best effort */ })
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    finishReason = 'timeout'
    activity.publish({ kind: 'error', sessionId: astraSessionId, text: 'turn timed out' })
    runtime.request('POST', `/api/session/${openCodeSessionId}/interrupt`).catch(() => { /* best effort */ })
    resolveTurn('timeout')
  }, config.turnTimeoutMs)

  activity.publish({ kind: 'turn-start', sessionId: astraSessionId, text: text.slice(0, 120) })

  try {
    await runtime.request('POST', `/api/session/${openCodeSessionId}/prompt`, { text })
  } catch (error) {
    cleanup()
    activity.publish({ kind: 'error', sessionId: astraSessionId, text: `prompt rejected: ${error.message}` })
    throw error
  }

  const reason = await turnFinished
  cleanup()

  activity.publish({
    kind: 'turn-end',
    sessionId: astraSessionId,
    reason,
    text: `turn ${reason} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  })

  return { reason, openCodeSessionId, elapsedMs: Date.now() - startedAt }
}
