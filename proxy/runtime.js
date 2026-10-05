import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { config, modelLabel } from './config.js'

/**
 * OpenCodeRuntime supervises a private headless `opencode serve` instance and exposes:
 *   - request(method, path, body)  : authenticated JSON calls against its HTTP API
 *   - events                       : EventEmitter broadcasting every bus event from /api/event
 *
 * It owns the child process lifecycle: start, health wait, event-stream reconnect and
 * backoff restart if the runtime dies.
 */
export class OpenCodeRuntime extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.ready = false
    this.lastError = null
    this.stopped = false
    this.restartDelayMs = 1000
    this.streamAbort = null
    this.baseUrl = `http://127.0.0.1:${config.opencodePort}`
    this.authorization =
      'Basic ' + Buffer.from(`opencode:${config.password}`).toString('base64')
  }

  async start() {
    this.stopped = false
    this.spawnChild()
    await this.waitForHealth()
    this.attachEventStream()
  }

  spawnChild() {
    const child = spawn(config.cliPath, ['serve', '--port', String(config.opencodePort), '--hostname', '127.0.0.1'], {
      cwd: config.projectDir,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: config.password,
        // Never inherit desktop-app transport flags into a headless runtime.
        OPENCODE_CLIENT: undefined,
        OPENCODE_TERMINAL: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (buffer) => this.emit('log', buffer.toString().trim()))
    child.stderr.on('data', (buffer) => this.emit('log', buffer.toString().trim()))

    child.on('exit', (code, signal) => {
      if (this.stopped) return
      this.ready = false
      this.lastError = `opencode serve exited (code=${code} signal=${signal})`
      this.emit('log', `[runtime] ${this.lastError}; restarting in ${this.restartDelayMs}ms`)
      setTimeout(() => {
        if (!this.stopped) this.restart()
      }, this.restartDelayMs)
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 15_000)
    })

    this.child = child
  }

  async restart() {
    try {
      this.streamAbort?.abort()
      this.child?.removeAllListeners('exit')
      this.child?.kill('SIGTERM')
    } catch { /* already gone */ }
    this.spawnChild()
    try {
      await this.waitForHealth()
      this.restartDelayMs = 1000
      this.attachEventStream()
    } catch (error) {
      this.lastError = String(error?.message || error)
    }
  }

  async waitForHealth(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/global/health`)
        if (response.ok) {
          this.ready = true
          this.lastError = null
          this.emit('ready')
          return true
        }
      } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.lastError = 'opencode serve did not become healthy in time'
    throw new Error(this.lastError)
  }

  /** Authenticated JSON request. Returns parsed body; throws on non-2xx with the server message. */
  async request(method, path, body) {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: this.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })

    const text = await response.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }

    if (!response.ok && response.status !== 204) {
      const message = data?.message || `${method} ${path} failed with ${response.status}`
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return data
  }

  /** Single long-lived SSE subscription to /api/event, reconnected on failure. */
  attachEventStream() {
    if (this.stopped) return
    this.streamAbort?.abort()
    const abort = new AbortController()
    this.streamAbort = abort

    ;(async () => {
      while (!this.stopped && !abort.signal.aborted) {
        try {
          const response = await fetch(`${this.baseUrl}/api/event`, {
            headers: { Authorization: this.authorization },
            signal: abort.signal,
          })
          if (!response.ok || !response.body) throw new Error(`event stream status ${response.status}`)

          this.emit('log', '[runtime] event stream connected')
          await this.readEventStream(response.body, abort.signal)
        } catch (error) {
          if (abort.signal.aborted || this.stopped) return
          this.emit('log', `[runtime] event stream dropped: ${error.message}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()
  }

  async readEventStream(body, signal) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((entry) => entry.startsWith('data: '))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(6))
          this.emit('event', event)
        } catch { /* heartbeat or partial frame */ }
      }
    }
  }

  stop() {
    this.stopped = true
    this.ready = false
    this.streamAbort?.abort()
    try { this.child?.kill('SIGTERM') } catch { /* already gone */ }
  }

  status() {
    return {
      running: Boolean(this.child) && !this.child.killed,
      ready: this.ready,
      port: config.opencodePort,
      model: modelLabel,
      agent: config.agent,
      error: this.lastError,
    }
  }
}
