import fs from 'node:fs'
import path from 'node:path'
import { config, modelRef, projectDir } from './config.js'

const STATE_FILE = path.join(projectDir, '.proxy', 'sessions.json')

/**
 * Maps ASTRA chat session IDs to durable OpenCode sessions so conversation memory
 * lives inside the agent runtime (and survives proxy restarts).
 */
export class SessionStore {
  constructor(runtime) {
    this.runtime = runtime
    this.map = new Map()
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      for (const [key, value] of Object.entries(raw)) this.map.set(key, value)
    } catch { /* first run */ }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(this.map), null, 2))
    } catch (error) {
      this.runtime.emit('log', `[sessions] persist failed: ${error.message}`)
    }
  }

  /** Returns (creating if needed) the OpenCode session backing an ASTRA chat session. */
  async ensure(astraSessionId) {
    const known = this.map.get(astraSessionId)
    const knownId = typeof known === 'string' ? known : known?.id

    if (knownId) {
      const alive = await this.sessionExists(knownId)
      if (alive) {
        if (typeof known === 'string' || !known.configured) await this.configure(knownId)
        return knownId
      }
    }

    const created = await this.runtime.request('POST', '/api/session', {
      title: `ASTRA ${astraSessionId.slice(0, 8)}`,
    })
    const openCodeSessionId = created?.data?.id
    if (!openCodeSessionId) throw new Error('opencode did not return a session id')

    // Record before configuring so a failed model switch never leaks an orphan session.
    this.map.set(astraSessionId, { id: openCodeSessionId, configured: false })
    this.persist()
    await this.configure(openCodeSessionId)
    return openCodeSessionId
  }

  async configure(openCodeSessionId) {
    await this.runtime.request('POST', `/api/session/${openCodeSessionId}/model`, { model: modelRef })
    await this.runtime.request('POST', `/api/session/${openCodeSessionId}/agent`, { agent: config.agent })
    for (const [key, value] of this.map) {
      if ((typeof value === 'string' ? value : value?.id) === openCodeSessionId) {
        this.map.set(key, { id: openCodeSessionId, configured: true })
      }
    }
    this.persist()
  }

  async sessionExists(openCodeSessionId) {
    try {
      await this.runtime.request('GET', `/api/session/${openCodeSessionId}`)
      return true
    } catch {
      return false
    }
  }

  /** Drops the conversation memory for one ASTRA chat session (used by /clear). */
  async reset(astraSessionId) {
    const known = this.map.get(astraSessionId)
    const openCodeSessionId = typeof known === 'string' ? known : known?.id
    this.map.delete(astraSessionId)
    this.persist()
    if (!openCodeSessionId) return false
    try {
      await this.runtime.request('DELETE', `/api/session/${openCodeSessionId}`)
      return true
    } catch (error) {
      this.runtime.emit('log', `[sessions] delete failed: ${error.message}`)
      return false
    }
  }

  size() {
    return this.map.size
  }
}
