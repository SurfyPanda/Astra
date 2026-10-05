/**
 * ActivityBus fans agent-runtime telemetry out to /activity subscribers and keeps a
 * short ring buffer so the UI can render "what ASTRA is doing right now" even if it
 * connects a moment late.
 */
export class ActivityBus {
  constructor(limit = 60) {
    this.limit = limit
    this.buffer = []
    this.subscribers = new Set()
  }

  publish(entry) {
    const event = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...entry }
    this.buffer.push(event)
    if (this.buffer.length > this.limit) this.buffer.splice(0, this.buffer.length - this.limit)

    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const response of this.subscribers) {
      try {
        response.write(payload)
      } catch {
        this.subscribers.delete(response)
      }
    }
    return event
  }

  subscribe(response) {
    this.subscribers.add(response)
    for (const event of this.buffer.slice(-10)) {
      try { response.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* client left */ }
    }
    return () => {
      this.subscribers.delete(response)
      try { response.end() } catch { /* already closed */ }
    }
  }

  recent() {
    return this.buffer.slice(-20)
  }
}

/** Human-readable one-liners for the agent telemetry the UI shows. */
export function describeTool(name, input = {}) {
  switch (name) {
    case 'bash':
    case 'shell':
      return `shell · ${String(input.command ?? input.cmd ?? '').slice(0, 90)}`
    case 'code':
      return `run code · ${String(input.code ?? '').split('\n')[0].slice(0, 70)}`
    case 'write':
      return `write · ${input.path ?? 'file'}`
    case 'edit':
    case 'patch':
      return `edit · ${input.path ?? 'file'}`
    case 'read':
      return `read · ${input.path ?? 'file'}`
    case 'glob':
    case 'grep':
    case 'list':
      return `${name} · ${input.pattern ?? input.path ?? ''}`.trim()
    case 'webfetch':
      return `fetch · ${String(input.url ?? '').slice(0, 80)}`
    case 'websearch':
      return `search · ${input.query ?? ''}`
    case 'question':
      return 'paused · asking for input'
    default:
      return `${name} · ${JSON.stringify(input).slice(0, 80)}`
  }
}
