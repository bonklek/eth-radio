import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from '../../../scripts/lib/publisher-safety.mjs'
import { readBoundedJsonFileSync } from '../../../scripts/lib/bounded-files.mjs'

function leaseKey(chainId, publisher) {
  const identity = `${BigInt(chainId)}:${String(publisher).toLowerCase()}`
  return crypto.createHash('sha256').update(identity).digest('hex')
}

function defaultRegistryRoot() {
  const localData = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME
  return localData
    ? path.join(localData, 'rfe-publisher', 'signer-coordinator')
    : path.join(os.homedir(), '.rfe-publisher', 'signer-coordinator')
}

function registryRecordPath({ chainId, publisher, registryRoot = defaultRegistryRoot() }) {
  return path.join(path.resolve(registryRoot), `${leaseKey(chainId, publisher)}.json`)
}

function readRegistryRecord(file) {
  if (!fs.existsSync(file)) return null
  const record = readBoundedJsonFileSync(file, { maxBytes: 16 * 1024, label: 'signer coordinator registry' })
  if (!record || record.schema !== 'rfe/signer-coordinator-owner@1'
    || !Number.isSafeInteger(record.chainId) || typeof record.publisher !== 'string'
    || typeof record.statePath !== 'string' || !record.statePath) {
    throw new Error('Signer coordinator registry is invalid and requires operator reconciliation')
  }
  return record
}

export function signerCoordinatorEndpoint({ chainId, publisher, platform = process.platform }) {
  const key = leaseKey(chainId, publisher)
  if (platform === 'win32') return `\\\\.\\pipe\\rfe-publisher-${key}`
  if (platform === 'linux') return `\0rfe-publisher-${key}`
  throw new Error(`Signer coordinator requires an OS-owned local endpoint adapter for ${platform}`)
}

export function acquireSignerCoordinatorLease({ chainId, publisher, statePath, registryRoot }) {
  const endpoint = signerCoordinatorEndpoint({ chainId, publisher })
  const ownerStatePath = path.resolve(statePath)
  const recordPath = registryRecordPath({ chainId, publisher, registryRoot })
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy())
    let settled = false
    server.once('error', (error) => {
      if (settled) return
      settled = true
      reject(new Error(`Signer coordinator is already held or unavailable for chain ${chainId} account ${publisher}: ${error.code || error.message}`, { cause: error }))
    })
    server.listen(endpoint, () => {
      if (settled) return
      try {
        const existing = readRegistryRecord(recordPath)
        if (existing && path.resolve(existing.statePath) !== ownerStatePath) {
          throw new Error(`Signer coordinator has unreconciled durable ownership at ${existing.statePath}`)
        }
        fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 })
        atomicWriteJson(recordPath, {
          schema: 'rfe/signer-coordinator-owner@1',
          chainId: Number(chainId),
          publisher: String(publisher).toLowerCase(),
          statePath: ownerStatePath,
          updatedAt: new Date().toISOString(),
        })
        settled = true
        resolve({
          endpoint,
          recordPath,
          async release({ clearOwnership = false } = {}) {
            if (clearOwnership) {
              const current = readRegistryRecord(recordPath)
              if (current && path.resolve(current.statePath) === ownerStatePath) fs.rmSync(recordPath, { force: true })
            }
            if (!server.listening) return
            await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()))
          },
        })
      } catch (error) {
        settled = true
        server.close(() => reject(error))
      }
    })
  })
}

export { registryRecordPath }
