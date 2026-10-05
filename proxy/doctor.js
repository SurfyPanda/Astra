import { execFileSync } from 'node:child_process'
import { config, modelLabel } from './config.js'

const report = []
const push = (label, ok, detail) => report.push({ label, ok, detail })

push('OpenCode CLI', true, config.cliPath)
try {
  const version = execFileSync(config.cliPath, ['--version'], { encoding: 'utf8' }).trim()
  push('CLI version', /v?\d+\.\d+/.test(version), version)
} catch (error) {
  push('CLI version', false, error.message)
}

push('Project opencode.json', true, `${config.projectDir}/opencode.json`)
push('Project AGENTS.md', true, `${config.projectDir}/AGENTS.md`)
push('Model (free tier)', true, modelLabel)

const res = await fetch(`http://127.0.0.1:${config.port}/health`).catch(() => null)
push('Proxy process', Boolean(res?.ok), res?.ok
  ? `http://127.0.0.1:${config.port}`
  : 'not running — start it with `npm start`')

for (const entry of report) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label.padEnd(18)} ${entry.detail}`)
}
process.exit(report.every((entry) => entry.ok) ? 0 : 1)
