import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const consoleDir = path.dirname(fileURLToPath(import.meta.url))
const lockPath = path.join(consoleDir, 'runtime', 'supervisor.lock')
if (!fs.existsSync(lockPath)) {
  console.log('Publisher console is not running.')
  process.exit(0)
}
const pid = Number(fs.readFileSync(lockPath, 'utf8'))
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Supervisor lock contains an invalid process ID')
try {
  process.kill(pid, 'SIGTERM')
  console.log(`Stopping publisher console process ${pid}.`)
} catch (error) {
  if (error.code !== 'ESRCH') throw error
  fs.rmSync(lockPath, { force: true })
  console.log('Removed a stale publisher console lock.')
}
