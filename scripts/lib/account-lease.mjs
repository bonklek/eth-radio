import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readBoundedJsonFileSync } from './bounded-files.mjs'

const OWNER_FILE = 'owner.json'
const OWNER_MAX_BYTES = 16 * 1024
const DEFAULT_STALE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 5_000

function requiredScope(chainId, account) {
  const parsedChainId = typeof chainId === 'bigint' ? chainId : BigInt(chainId)
  if (parsedChainId <= 0n) throw new Error('Account lease chainId must be positive')
  const normalizedAccount = String(account || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(normalizedAccount)) throw new Error('Account lease requires a valid account address')
  return { chainId: parsedChainId.toString(), account: normalizedAccount }
}

function leaseKey(scope) {
  return crypto.createHash('sha256').update(`${scope.chainId}:${scope.account}`).digest('hex')
}

function ownerPath(lockPath) {
  return path.join(lockPath, OWNER_FILE)
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some platforms do not permit directory descriptors; atomic names remain authoritative.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function writeOwner(lockPath, owner) {
  const target = ownerPath(lockPath)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    fsyncDirectory(lockPath)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

function readOwner(lockPath) {
  try {
    return readBoundedJsonFileSync(ownerPath(lockPath), {
      maxBytes: OWNER_MAX_BYTES,
      label: `account lease owner ${ownerPath(lockPath)}`,
    })
  } catch {
    return null
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function contentionError(scope, owner) {
  const detail = owner && Number.isSafeInteger(owner.pid) ? ` by pid ${owner.pid}` : ''
  return Object.assign(
    new Error(`Transaction sender lease is already held for chain ${scope.chainId} account ${scope.account}${detail}`),
    { code: 'ACCOUNT_LEASE_CONTENDED' },
  )
}

function recoverStaleLock({ lockPath, scope, staleMs, now }) {
  const owner = readOwner(lockPath)
  const sameHost = owner?.hostname === os.hostname()
  if (sameHost && processIsAlive(owner.pid)) throw contentionError(scope, owner)
  if (owner && !sameHost) throw contentionError(scope, owner)

  let lastActivity = owner ? timestampMs(owner.heartbeatAt || owner.createdAt) : 0
  if (!lastActivity) {
    try {
      lastActivity = fs.statSync(lockPath).mtimeMs
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }
  if (now() - lastActivity < staleMs) throw contentionError(scope, owner)

  const quarantinePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`
  try {
    fs.renameSync(lockPath, quarantinePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST' || error?.code === 'EPERM') return false
    throw error
  }
  fs.rmSync(quarantinePath, { recursive: true, force: true })
  fsyncDirectory(path.dirname(lockPath))
  return true
}

/**
 * Acquires an exclusive local sender lease for one chain/account pair.
 * A live local PID is never evicted, even when its heartbeat appears old.
 * @param {{chainId: string | number | bigint, account: string, root?: string, staleMs?: number, heartbeatMs?: number, now?: () => number}} options
 */
export function acquireAccountLease({
  chainId,
  account,
  root = path.join(os.homedir(), '.eth-radio', 'account-leases'),
  staleMs = DEFAULT_STALE_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  now = Date.now,
}) {
  if (!Number.isSafeInteger(staleMs) || staleMs < 1) throw new Error('Account lease staleMs must be a positive safe integer')
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('Account lease heartbeatMs must be a positive safe integer')
  const scope = requiredScope(chainId, account)
  const lockPath = path.join(path.resolve(root), `${leaseKey(scope)}.lock`)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      fsyncDirectory(path.dirname(lockPath))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (recoverStaleLock({ lockPath, scope, staleMs, now })) continue
      continue
    }

    const token = crypto.randomUUID()
    const owner = {
      version: 1,
      token,
      chainId: scope.chainId,
      account: scope.account,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date(now()).toISOString(),
      heartbeatAt: new Date(now()).toISOString(),
    }
    try {
      writeOwner(lockPath, owner)
    } catch (error) {
      fs.rmSync(lockPath, { recursive: true, force: true })
      throw error
    }

    let released = false
    const heartbeat = setInterval(() => {
      if (released) return
      const current = readOwner(lockPath)
      if (!current || current.token !== token) return
      owner.heartbeatAt = new Date(now()).toISOString()
      try {
        writeOwner(lockPath, owner)
      } catch {
        // A failed heartbeat does not justify deleting or replacing an uncertain owner.
      }
    }, heartbeatMs)
    heartbeat.unref()

    const release = () => {
      if (released) return false
      released = true
      clearInterval(heartbeat)
      process.removeListener('exit', release)
      const current = readOwner(lockPath)
      if (!current || current.token !== token) return false
      fs.rmSync(lockPath, { recursive: true, force: true })
      fsyncDirectory(path.dirname(lockPath))
      return true
    }
    process.once('exit', release)
    return { ...scope, lockPath, token, release }
  }
  throw contentionError(scope, readOwner(lockPath))
}
