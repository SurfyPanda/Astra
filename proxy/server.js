import http from 'node:http'
import crypto from 'node:crypto'
import { config, modelLabel } from './config.js'
import { OpenCodeRuntime } from './runtime.js'
import { SessionStore } from './sessions.js'
import { ActivityBus } from './activity.js'
import { runTurn } from './turn.js'

const runtime = new OpenCodeRuntime()
const sessions = new SessionStore(runtime)
const activity = new ActivityBus()

/** One agent turn at a time per chat session keeps streams deterministic. */
const turnLocks = new Map()

runtime.on('log', (line) => {
  if (line) console.log(`[opencode] ${line}`)
})

// ---------------------------------------------------------------- helpers

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendError(response, status, message, type = 'astra_proxy_error') {
  sendJson(response, status, { error: { message, type, code: status } })
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
  }
  return ''
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      const text = textOf(messages[i].content).trim()
      if (text) return text
    }
  }
  return ''
}

/**
 * Real AbortSignal for a turn: fires when the client hangs up mid-request.
 * (A raw IncomingMessage has no addEventListener, so it can't be used directly.)
 */
function clientAbortSignal(response) {
  const controller = new AbortController()
  response.once?.('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  return controller.signal
}

function chunkPayload(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function withTurnLock(sessionId, task) {
  const previous = turnLocks.get(sessionId) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  turnLocks.set(sessionId, previous.then(() => current))
  await previous
  try {
    return await task()
  } finally {
    release()
    if (turnLocks.get(sessionId) === current) turnLocks.delete(sessionId)
  }
}

// ---------------------------------------------------------------- endpoints

async function handleChatCompletions(request, response) {
  let body
  try {
    body = await readJson(request)
  } catch (error) {
    return sendError(response, 400, error.message, 'invalid_request_error')
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  const userText = lastUserText(messages)
  const sessionId = String(body.user || body.metadata?.session_id || 'default').slice(0, 128)
  const model = body.model || modelLabel

  if (!userText) {
    return sendError(response, 400, 'No user message supplied', 'invalid_request_error')
  }
  if (!runtime.ready) {
    return sendError(response, 503, `Local agent runtime unavailable: ${runtime.lastError ?? 'starting up'}`)
  }

  const stream = body.stream !== false
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

  return withTurnLock(sessionId, async () => {
    if (!stream) {
      let full = ''
      try {
        const result = await runTurn({
          runtime,
          sessions,
          activity,
          astraSessionId: sessionId,
          text: userText,
          onDelta: (delta) => { full += delta },
          signal: clientAbortSignal(response),
        })
        return sendJson(response, 200, {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: full || `Agent stopped (${result.reason}).` },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      } catch (error) {
        return sendError(response, 502, `Agent turn failed: ${error.message}`)
      }
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    })
    response.flushHeaders?.()

    const write = (payload) => {
      if (response.writableEnded) return
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    write(chunkPayload(completionId, model, { role: 'assistant' }))

    let emitted = 0
    try {
      const result = await runTurn({
        runtime,
        sessions,
        activity,
        astraSessionId: sessionId,
        text: userText,
        onDelta: (delta) => {
          emitted += 1
          write(chunkPayload(completionId, model, { content: delta }))
        },
        signal: clientAbortSignal(response),
      })

      if (emitted === 0 && result.reason !== 'aborted') {
        write(chunkPayload(completionId, model, {
          content: result.reason === 'timeout'
            ? 'The agent run timed out before producing a reply. Try a shorter request.'
            : 'The agent finished without emitting text. Check the activity feed for what it did.',
        }))
      }

      write(chunkPayload(completionId, model, {}, result.reason === 'aborted' ? 'stop' : 'stop'))
    } catch (error) {
      write(chunkPayload(completionId, model, { content: `\n[agent error] ${error.message}` }))
    } finally {
      if (!response.writableEnded) {
        response.write('data: [DONE]\n\n')
        response.end()
      }
    }
  })
}

async function handleModels(request, response) {
  let data = []
  try {
    const payload = await runtime.request('GET', '/api/model')
    data = payload?.data ?? payload ?? []
  } catch (error) {
    activity.publish({ kind: 'error', text: `model list failed: ${error.message}` })
  }

  const models = data
    .filter((entry) => entry?.providerID === config.model.providerID)
    .map((entry) => ({
      id: `${entry.providerID}/${entry.id ?? entry.modelID}`,
      object: 'model',
      created: 0,
      owned_by: entry.providerID,
    }))

  sendJson(response, 200, {
    object: 'list',
    data: models.length ? models : [{ id: modelLabel, object: 'model', created: 0, owned_by: 'local' }],
  })
}

function handleActivity(request, response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  })
  response.write(': connected\n\n')
  const unsubscribe = activity.subscribe(response)
  const keepAlive = setInterval(() => {
    try { response.write(': ping\n\n') } catch { /* client left */ }
  }, 15_000)

  request.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

async function handleReset(request, response) {
  const body = await readJson(request).catch(() => ({}))
  const sessionId = String(body.sessionId || body.session_id || '').trim()
  if (!sessionId) return sendError(response, 400, 'sessionId is required', 'invalid_request_error')
  const dropped = await sessions.reset(sessionId)
  activity.publish({ kind: 'reset', sessionId, text: 'conversation memory cleared' })
  return sendJson(response, 200, { ok: true, dropped })
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    })
    return response.end()
  }

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, {
        ok: runtime.ready,
        runtime: runtime.status(),
        sessions: sessions.size(),
        project: config.projectDir,
        activity: activity.recent(),
      })
    }

    if (request.method === 'GET' && url.pathname === '/activity') return handleActivity(request, response)
    if (request.method === 'GET' && url.pathname === '/v1/models') return handleModels(request, response)

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return await handleChatCompletions(request, response)
    }

    if (request.method === 'POST' && url.pathname === '/v1/session/reset') {
      return await handleReset(request, response)
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return sendJson(response, 200, {
        service: 'astra-opencode-proxy',
        endpoints: ['/health', '/activity', '/v1/models', '/v1/chat/completions', '/v1/session/reset'],
        model: modelLabel,
      })
    }

    return sendError(response, 404, `No route for ${request.method} ${url.pathname}`, 'not_found')
  } catch (error) {
    return sendError(response, 500, error.message)
  }
})

async function main() {
  console.log(`[astra] opencode cli: ${config.cliPath}`)
  console.log(`[astra] project dir : ${config.projectDir}`)
  console.log(`[astra] model       : ${modelLabel} (free tier)`)

  try {
    await runtime.start()
    console.log(`[astra] agent runtime ready on ${runtime.baseUrl}`)
  } catch (error) {
    console.error(`[astra] agent runtime failed to start: ${error.message}`)
    console.error('[astra] chat requests will report 503 until it recovers')
  }

  server.listen(config.port, config.host, () => {
    console.log(`[astra] proxy listening on http://${config.host}:${config.port}`)
    console.log(`[astra] openai-compatible endpoint: http://${config.host}:${config.port}/v1/chat/completions`)
  })
}

const shutdown = () => {
  console.log('\n[astra] shutting down')
  runtime.stop()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((error) => {
  console.error('[astra] fatal:', error)
  process.exit(1)
})
