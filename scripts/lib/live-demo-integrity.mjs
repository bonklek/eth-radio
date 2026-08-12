import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readBoundedJsonFileSync } from './bounded-files.mjs'
export { mediaCacheFilename, mediaCacheIdentity } from './stream-identity-continuity.mjs'

export const BLOB_BYTES = 131_072
export const FIELD_ELEMENT_BYTES = 32
export const BLOB_DATA_BYTES = (BLOB_BYTES / FIELD_ELEMENT_BYTES) * (FIELD_ELEMENT_BYTES - 1)

const bytes32Hex = /^0x[0-9a-fA-F]{64}$/

function safeNonNegativeInteger(value, label) {
  let number
  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    number = Number(value)
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    number = Number(value)
  } else {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return number
}

function positiveInteger(value, label) {
  const number = safeNonNegativeInteger(value, label)
  if (number === 0) throw new Error(`${label} must be greater than zero`)
  return number
}

function normalizeBytes32(value, label) {
  const text = String(value || '')
  if (!bytes32Hex.test(text)) throw new Error(`${label} must be 0x-prefixed bytes32`)
  return text.toLowerCase()
}

export function isExactBlobHex(value) {
  return typeof value === 'string'
    && value.length === 2 + BLOB_BYTES * 2
    && value.startsWith('0x')
    && /^[0-9a-fA-F]+$/.test(value.slice(2))
}

export function normalizeRequestedBlobHashes(hashes, maxSidecars) {
  const maximum = positiveInteger(maxSidecars, 'maximum sidecar count')
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new Error('Expected at least one requested blob versioned hash')
  }
  if (hashes.length > maximum) {
    throw new Error(`Requested blob count ${hashes.length} exceeds protocol maximum ${maximum}`)
  }
  const normalized = hashes.map((hash, index) => normalizeBytes32(hash, `requested blob hash ${index}`))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Requested blob versioned hashes must be unique')
  }
  return normalized
}

export function validateBeaconSidecars(sidecars, maxSidecars) {
  const maximum = positiveInteger(maxSidecars, 'maximum sidecar count')
  if (!Array.isArray(sidecars)) throw new Error('Blob sidecars must be an array')
  if (sidecars.length > maximum) {
    throw new Error(`Beacon sidecar count ${sidecars.length} exceeds protocol maximum ${maximum}`)
  }

  const indexes = new Set()
  return sidecars.map((sidecar, position) => {
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
      throw new Error(`Beacon sidecar ${position} must be an object`)
    }
    const index = safeNonNegativeInteger(sidecar.index, `Beacon sidecar ${position} index`)
    if (index >= maximum) {
      throw new Error(`Beacon sidecar ${position} index ${index} exceeds protocol maximum index ${maximum - 1}`)
    }
    if (indexes.has(index)) throw new Error(`Beacon sidecar index ${index} is duplicated`)
    indexes.add(index)
    if (!isExactBlobHex(sidecar.blob)) {
      throw new Error(`Beacon sidecar ${position} blob must be exactly ${BLOB_BYTES} bytes`)
    }
    return { ...sidecar, index }
  })
}

/**
 * @param {unknown} payload
 * @param {{ txHash?: unknown, wantedHashes?: unknown, maxSidecars?: unknown }} [options]
 */
export function validateSidecarCachePayload(payload, {
  txHash,
  wantedHashes,
  maxSidecars,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Sidecar cache payload must be an object')
  }
  const record = /** @type {Record<string, unknown>} */ (payload)
  const expectedTxHash = normalizeBytes32(txHash, 'expected transaction hash')
  const cachedTxHash = normalizeBytes32(record.txHash, 'cached transaction hash')
  if (cachedTxHash !== expectedTxHash) throw new Error('Cached transaction hash does not match the requested transaction')

  const slot = safeNonNegativeInteger(record.slot, 'cached beacon slot')
  const wanted = normalizeRequestedBlobHashes(wantedHashes, maxSidecars)
  const wantedSet = new Set(wanted)
  const matches = validateBeaconSidecars(record.matches, maxSidecars).map((match, index) => {
    const versionedHash = normalizeBytes32(match.versionedHash, `cached sidecar ${index} versioned hash`)
    if (!wantedSet.has(versionedHash)) throw new Error(`Cached sidecar ${index} was not requested`)
    return { ...match, versionedHash }
  })
  const matchedHashes = new Set(matches.map((match) => match.versionedHash))
  if (matchedHashes.size !== matches.length) throw new Error('Cached sidecar versioned hashes must be unique')
  const missing = wanted.filter((hash) => !matchedHashes.has(hash))
  if (missing.length || matches.length !== wanted.length) {
    throw new Error(`Sidecar cache is incomplete: missing ${missing.length} of ${wanted.length} requested blob(s)`)
  }
  return { ...record, txHash: cachedTxHash, slot: String(slot), matches }
}

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // Best-effort cleanup must not replace the validation error.
  }
}

export function readValidatedSidecarCache(cachePath, options = {}) {
  if (!fs.existsSync(cachePath)) return null
  try {
    const maximumBytes = positiveInteger(options.maxCacheBytes, 'maximum sidecar cache bytes')
    return validateSidecarCachePayload(readBoundedJsonFileSync(cachePath, {
      maxBytes: maximumBytes,
      label: `sidecar cache ${cachePath}`,
    }), options)
  } catch (error) {
    removeFile(cachePath)
    options.onInvalid?.(error)
    return null
  }
}

export function writeValidatedSidecarCache(cachePath, payload, options = {}) {
  const validated = validateSidecarCachePayload(payload, options)
  const maximumBytes = positiveInteger(options.maxCacheBytes, 'maximum sidecar cache bytes')
  const serialized = `${JSON.stringify(validated, null, 2)}\n`
  const bytes = Buffer.byteLength(serialized)
  if (bytes > maximumBytes) throw new Error(`Validated sidecar cache exceeds ${maximumBytes} bytes`)

  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const tempPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, serialized, { flag: 'wx' })
    fs.renameSync(tempPath, cachePath)
  } finally {
    removeFile(tempPath)
  }
  return validated
}

export async function loadOrFetchValidatedSidecarCache({
  cachePath,
  fetchPayload,
  ...options
}) {
  const cached = readValidatedSidecarCache(cachePath, options)
  if (cached) return cached
  const payload = await fetchPayload()
  return writeValidatedSidecarCache(cachePath, payload, options)
}

/**
 * @param {Response} response
 * @param {{ maxBytes?: unknown, label?: string }} [options]
 */
export async function readBoundedJsonResponse(response, { maxBytes, label = 'response' } = {}) {
  const maximumBytes = positiveInteger(maxBytes, `${label} maximum bytes`)
  if (!response?.ok) {
    try {
      await response?.body?.cancel()
    } catch {
      // Preserve the HTTP error if response cancellation itself fails.
    }
    throw new Error(`${label} returned HTTP ${response?.status || 'error'} ${response?.statusText || ''}`.trim())
  }
  const declaredLength = response.headers?.get?.('content-length')
  if (/^\d+$/.test(String(declaredLength || '')) && Number(declaredLength) > maximumBytes) {
    try {
      await response.body?.cancel()
    } catch {
      // Preserve the size-limit error if response cancellation itself fails.
    }
    throw new Error(`${label} exceeds ${maximumBytes} bytes`)
  }
  if (!response.body?.getReader) throw new Error(`${label} has no readable body`)

  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new Error(`${label} exceeds ${maximumBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function insideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function rejectReparsePath(rootPath, filePath) {
  const resolvedRoot = path.resolve(rootPath)
  const resolvedFile = path.resolve(filePath)
  if (!insideRoot(resolvedRoot, resolvedFile)) throw new Error('Cached media path escapes its expected root')
  if ((await fs.promises.lstat(resolvedRoot)).isSymbolicLink()) {
    throw new Error('Cached media root must not be a symbolic link or reparse point')
  }
  const relative = path.relative(resolvedRoot, resolvedFile)
  let current = resolvedRoot
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if ((await fs.promises.lstat(current)).isSymbolicLink()) {
      throw new Error('Cached media path must not traverse a symbolic link or reparse point')
    }
  }
}

async function sha256FileHandle(handle, size) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)))
  let position = 0
  while (position < size) {
    const length = Math.min(buffer.length, size - position)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    if (bytesRead <= 0) throw new Error('Cached media changed while being verified')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

/**
 * Opens, bounds, and verifies media through one pinned descriptor. The returned
 * shape is directly compatible with serveOpenedFile, preventing pathname
 * replacement between verification and streaming.
 * @param {string} filePath
 * @param {{payloadBytes?: unknown, payloadSha256?: unknown}} expected
 * @param {{beforeOpen?: () => void | Promise<void>, root?: string}} options
 */
export async function openVerifiedMediaFile(filePath, {
  payloadBytes,
  payloadSha256,
} = {}, { beforeOpen, root } = {}) {
  const expectedBytes = safeNonNegativeInteger(payloadBytes, 'cached media payload bytes')
  const expectedHash = normalizeBytes32(payloadSha256, 'cached media payload SHA-256').slice(2)
  let handle
  try {
    if (root) await rejectReparsePath(root, filePath)
    const pathStatBefore = await fs.promises.lstat(filePath)
    if (pathStatBefore.isSymbolicLink() || !pathStatBefore.isFile()) throw new Error('Cached media path must be a regular non-symlink file')
    await beforeOpen?.()
    handle = await fs.promises.open(filePath, 'r')
    const descriptorStat = await handle.stat()
    const pathStatAfter = await fs.promises.lstat(filePath)
    if (!descriptorStat.isFile() || pathStatAfter.isSymbolicLink()
      || !sameFile(pathStatBefore, descriptorStat) || !sameFile(descriptorStat, pathStatAfter)) {
      throw new Error('Cached media path changed while being opened')
    }
    if (descriptorStat.size !== expectedBytes) throw new Error('Cached media size mismatch')
    if (await sha256FileHandle(handle, expectedBytes) !== expectedHash) throw new Error('Cached media SHA-256 mismatch')
    const descriptorAfterHash = await handle.stat()
    if (!sameFile(descriptorStat, descriptorAfterHash) || descriptorAfterHash.size !== expectedBytes
      || descriptorAfterHash.mtimeMs !== descriptorStat.mtimeMs) {
      throw new Error('Cached media changed while being verified')
    }
    return { handle, stat: descriptorAfterHash, canonicalPath: filePath }
  } catch (error) {
    await handle?.close().catch(() => {})
    throw error
  }
}

/**
 * @param {string} filePath
 * @param {{ payloadBytes?: unknown, payloadSha256?: unknown }} [expected]
 */
export async function verifyOrDeleteCachedMedia(filePath, {
  payloadBytes,
  payloadSha256,
} = {}) {
  if (!fs.existsSync(filePath)) return false
  let opened
  try {
    opened = await openVerifiedMediaFile(filePath, { payloadBytes, payloadSha256 })
    return true
  } catch {
    removeFile(filePath)
    return false
  } finally {
    await opened?.handle.close().catch(() => {})
  }
}

export async function ensureVerifiedMediaCache(filePath, expected, createPayload) {
  if (await verifyOrDeleteCachedMedia(filePath, expected)) return filePath
  if (typeof createPayload !== 'function') throw new Error('Media cache payload builder is required')

  const payload = Buffer.from(await createPayload())
  const expectedBytes = safeNonNegativeInteger(expected?.payloadBytes, 'media payload bytes')
  const expectedHash = normalizeBytes32(expected?.payloadSha256, 'media payload SHA-256').slice(2)
  if (payload.length !== expectedBytes) {
    throw new Error(`Media payload size mismatch: expected ${expectedBytes}, got ${payload.length}`)
  }
  const actualHash = crypto.createHash('sha256').update(payload).digest('hex')
  if (actualHash !== expectedHash) throw new Error('Media payload SHA-256 mismatch')

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, payload, { flag: 'wx' })
    fs.renameSync(tempPath, filePath)
  } finally {
    removeFile(tempPath)
  }
  return filePath
}
