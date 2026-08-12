import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const consoleDir = path.dirname(fileURLToPath(import.meta.url))
const runtimeDir = path.join(consoleDir, 'runtime')
const logPath = path.join(runtimeDir, 'supervisor.log')
const port = Number(process.env.RFE_CONSOLE_PORT || 8787)
const url = `http://127.0.0.1:${port}`

async function available() {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

if (await available()) {
  console.log(`Publisher console is already running: ${url}`)
  process.exit(0)
}

fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
const descriptor = fs.openSync(logPath, 'a', 0o600)
const child = spawn(process.execPath, [path.join(consoleDir, 'server.mjs')], {
  cwd: path.resolve(consoleDir, '../..'),
  detached: true,
  windowsHide: true,
  stdio: ['ignore', descriptor, descriptor],
})
child.unref()
fs.closeSync(descriptor)

for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  if (await available()) {
    console.log(`Publisher console started in the background: ${url}`)
    console.log(`Supervisor log: ${logPath}`)
    process.exit(0)
  }
}

throw new Error(`Publisher console did not start. Review ${logPath}`)
