import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Project root = the directory that owns opencode.json + AGENTS.md (one level up from /proxy). */
export const projectDir = path.resolve(here, '..')

const bundledCli = path.join(
  os.homedir(),
  'Library/Application Support/ai.opencode.desktop/cli',
)

/**
 * Resolve the OpenCode CLI binary. Order: explicit env -> newest desktop bundle -> PATH.
 * The desktop bundle is preferred because it matches the schema of the shared local database.
 */
function resolveCli() {
  const fromEnv = process.env.OPENCODE_CLI
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  if (fs.existsSync(bundledCli)) {
    const versions = fs.readdirSync(bundledCli)
      .filter((entry) => fs.statSync(path.join(bundledCli, entry)).isDirectory())
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const candidate = path.join(bundledCli, version, 'opencode-cli')
      if (fs.existsSync(candidate)) return candidate
    }
  }

  return 'opencode'
}

export const config = {
  port: Number(process.env.ASTRA_PROXY_PORT || 4321),
  host: process.env.ASTRA_PROXY_HOST || '127.0.0.1',
  cliPath: resolveCli(),
  projectDir,
  password: process.env.ASTRA_PROXY_PASSWORD || crypto.randomBytes(24).toString('base64url'),
  model: {
    providerID: process.env.ASTRA_MODEL_PROVIDER || 'opencode',
    modelID: process.env.ASTRA_MODEL || 'mimo-v2.6-flash-free',
  },
  agent: process.env.ASTRA_AGENT || 'build',
  turnTimeoutMs: Number(process.env.ASTRA_TURN_TIMEOUT_MS || 300_000),
  opencodePort: Number(process.env.ASTRA_OPENCODE_PORT || 4399),
}

export const modelLabel = `${config.model.providerID}/${config.model.modelID}`

/** Shape expected by `POST /api/session/{id}/model` (opencode Model.Ref). */
export const modelRef = { providerID: config.model.providerID, id: config.model.modelID }
