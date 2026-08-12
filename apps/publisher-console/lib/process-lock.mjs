import fs from 'node:fs'
import path from 'node:path'

export class ProcessLock {
  constructor(filePath, { conflictMessage = (pid) => `Process ${pid} already owns ${filePath}`, beforeAcquire } = {}) {
    this.filePath = filePath
    this.conflictMessage = conflictMessage
    this.beforeAcquire = beforeAcquire
  }

  acquire() {
    this.beforeAcquire?.()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      this.#create()
    } catch (cause) {
      const pid = this.owner()
      if (pid && ProcessLock.isAlive(pid)) throw new Error(this.conflictMessage(pid), { cause })
      fs.rmSync(this.filePath, { force: true })
      this.#create()
    }
  }

  release() {
    try {
      if (this.owner() === process.pid) fs.rmSync(this.filePath, { force: true })
    } catch {
      // Best effort during shutdown.
    }
  }

  owner() {
    return Number(fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf8') : 0)
  }

  #create() {
    const descriptor = fs.openSync(this.filePath, 'wx', 0o600)
    try { fs.writeFileSync(descriptor, String(process.pid)) } finally { fs.closeSync(descriptor) }
  }

  static isAlive(pid) {
    try { process.kill(pid, 0); return true } catch { return false }
  }
}
