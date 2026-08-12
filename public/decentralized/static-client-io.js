const IO_BLOB_BYTES = 131_072
import { viewerAbiStringByteLimit } from './static-client-limits.js'

const IO_MAX_ABI_STRING_BYTES = viewerAbiStringByteLimit()
const IO_MAX_SEGMENT_BLOBS = 6
const IO_MAX_RESPONSE_CHUNKS = 4096
const IO_REQUEST_TIMEOUT_MS = 12_000

export function strip0x(value) {
  return String(value || '').replace(/^0x/i, '')
}

export function isBytes48Hex(value) {
  return typeof value === 'string' && value.length === 98 && /^0x[0-9a-fA-F]{96}$/.test(value)
}

export function isBlobHex(value) {
  const text = String(value || '')
  return text.length === 2 + IO_BLOB_BYTES * 2 && /^0x[0-9a-fA-F]+$/.test(text)
}

export function isByteHex(value) {
  return /^(?:0x)?(?:[0-9a-fA-F]{2})*$/.test(String(value || ''))
}

export function hexToBytes(value) {
  if (!isByteHex(value)) throw new Error('Invalid byte hex')
  const hex = strip0x(value)
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

export function bytesToHex(bytes) {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function concatBytes(chunks, totalLength) {
  if (!Number.isSafeInteger(totalLength) || totalLength < 0) throw new Error('Invalid concatenated byte length')
  const out = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > totalLength) throw new Error('Invalid concatenated byte chunks')
    out.set(chunk, offset)
    offset += chunk.length
  }
  if (offset !== totalLength) throw new Error('Concatenated byte length mismatch')
  return out
}

function abiWord(data, wordIndex, label) {
  if (!Number.isSafeInteger(wordIndex) || wordIndex < 0) throw new Error(`Invalid ${label}: word index must be non-negative`)
  const word = data.slice(wordIndex * 64, wordIndex * 64 + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(word)) throw new Error(`Invalid ${label}: missing ABI word ${wordIndex}`)
  return word
}

export function readWord(data, wordIndex, label = 'ABI data') {
  return BigInt(`0x${abiWord(data, wordIndex, label)}`)
}

export function abiWordNumber(data, wordIndex, label = 'ABI data') {
  const number = Number(readWord(data, wordIndex, label))
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}: value exceeds safe integer range`)
  return number
}

export function readBytes32(data, wordIndex, label = 'ABI data') {
  return `0x${abiWord(data, wordIndex, label)}`
}

function abiOffsetWord(data, wordIndex, label) {
  const offset = abiWordNumber(data, wordIndex, label)
  if (offset < 0 || offset % 32 !== 0) throw new Error(`Invalid ${label}: dynamic offset must be a 32-byte boundary`)
  if (offset > data.length / 2 - 32) throw new Error(`Invalid ${label}: dynamic offset extends past ABI data`)
  return offset
}

export function readString(data, wordIndex, label = 'ABI string') {
  const offset = abiOffsetWord(data, wordIndex, label)
  const length = abiWordNumber(data, offset / 32, label)
  if (length > IO_MAX_ABI_STRING_BYTES) throw new Error(`Invalid ${label}: string exceeds ${IO_MAX_ABI_STRING_BYTES} bytes`)
  const start = offset * 2 + 64
  const paddedEnd = start + Math.ceil(length / 32) * 64
  if (paddedEnd > data.length) throw new Error(`Invalid ${label}: string extends past ABI data`)
  return new TextDecoder().decode(hexToBytes(data.slice(start, start + length * 2)))
}

export function readBytes32Array(data, wordIndex, label = 'ABI bytes32 array') {
  const offset = abiOffsetWord(data, wordIndex, label)
  const length = abiWordNumber(data, offset / 32, label)
  if (length > IO_MAX_SEGMENT_BLOBS) throw new Error(`Invalid ${label}: array exceeds ${IO_MAX_SEGMENT_BLOBS} entries`)
  const startWord = offset / 32 + 1
  if ((startWord + length) * 64 > data.length) throw new Error(`Invalid ${label}: array extends past ABI data`)
  return Array.from({ length }, (_, index) => readBytes32(data, startWord + index, label))
}

export function rpcQuantity(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON-RPC quantity`)
  if (value.length > 66) throw new Error(`${label} exceeds the 256-bit JSON-RPC quantity limit`)
  if (!/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error(`${label} must be a JSON-RPC quantity`)
  return BigInt(value)
}

export function rpcQuantityNumber(value, label) {
  const number = Number(rpcQuantity(value, label))
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

export function requestAbortError(message = 'Request cancelled.') {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError')
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function requestTimeoutError(timeoutMs) {
  const error = new Error(`Request timed out after ${timeoutMs} ms.`)
  error.name = 'TimeoutError'
  return error
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
}

/**
 * @param {RequestInfo | URL} resource
 * @param {RequestInit} [options]
 * @param {{signal?: AbortSignal, timeoutMs?: number, platform?: {fetch?: typeof fetch, AbortController?: typeof AbortController, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}}} [controls]
 */
export async function fetchWithTimeout(resource, options = {}, { signal: parentSignal, timeoutMs = IO_REQUEST_TIMEOUT_MS, platform = {} } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Request timeout must be positive.')
  if (parentSignal?.aborted) throw requestAbortError()
  const fetchImpl = platform.fetch || globalThis.fetch
  const AbortControllerImpl = platform.AbortController || globalThis.AbortController
  const setTimer = platform.setTimeout || globalThis.setTimeout
  const clearTimer = platform.clearTimeout || globalThis.clearTimeout
  if (typeof fetchImpl !== 'function' || typeof AbortControllerImpl !== 'function') throw new Error('Request platform is unavailable.')
  const controller = new AbortControllerImpl()
  let timeoutId = null
  let abortFromParent = null
  const cancellation = new Promise((_, reject) => {
    abortFromParent = () => {
      controller.abort(requestAbortError())
      reject(requestAbortError())
    }
    if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true })
    timeoutId = setTimer(() => {
      const error = requestTimeoutError(timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([fetchImpl(resource, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal }), cancellation])
  } finally {
    if (timeoutId != null) clearTimer(timeoutId)
    if (parentSignal && abortFromParent) parentSignal.removeEventListener('abort', abortFromParent)
  }
}

export function responseContentLength(response, label) {
  const raw = response?.headers?.get?.('content-length')
  if (raw == null || raw === '') return null
  if (raw.length > 78) throw new Error(`${label} Content-Length exceeds the safe integer range`)
  if (!/^\d+$/.test(raw)) throw new Error(`${label} returned an invalid Content-Length`)
  const length = Number(raw)
  if (!Number.isSafeInteger(length)) throw new Error(`${label} Content-Length exceeds the safe integer range`)
  return length
}

/**
 * @param {any} response
 * @param {number} maxBytes
 * @param {string} label
 * @param {{signal?: AbortSignal, timeoutMs?: number, platform?: {setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number}}} [controls]
 */
export async function readBoundedResponseBytes(response, maxBytes, label, { signal, timeoutMs = IO_REQUEST_TIMEOUT_MS, platform = {} } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`Invalid ${label} response limit`)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid ${label} response timeout`)
  const declaredLength = responseContentLength(response, label)
  if (declaredLength != null && declaredLength > maxBytes) throw new Error(`${label} response exceeds ${maxBytes} bytes`)
  const reader = response?.body?.getReader?.()
  if (!reader) throw new Error(`${label} response cannot be read safely without a streaming body`)
  if (signal?.aborted) {
    try { await reader.cancel() } catch { /* Best-effort cleanup after parent cancellation. */ }
    throw requestAbortError()
  }
  const chunks = []
  let total = 0
  const setTimer = platform.setTimeout || globalThis.setTimeout
  const clearTimer = platform.clearTimeout || globalThis.clearTimeout
  const now = platform.now || (() => globalThis.performance?.now?.() ?? Date.now())
  const deadline = now() + timeoutMs
  while (true) {
    const remainingMs = deadline - now()
    if (remainingMs <= 0) {
      try { await reader.cancel() } catch { /* Best-effort cleanup after enforcing the deadline. */ }
      throw requestTimeoutError(timeoutMs)
    }
    let timeoutId = null
    let abortFromParent = null
    let result
    try {
      result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timeoutId = setTimer(() => reject(requestTimeoutError(timeoutMs)), remainingMs) }),
        new Promise((_, reject) => {
          if (!signal) return
          abortFromParent = () => reject(requestAbortError())
          signal.addEventListener('abort', abortFromParent, { once: true })
        }),
      ])
    } catch (error) {
      try { await reader.cancel() } catch { /* Best-effort cleanup after read failure or timeout. */ }
      throw error
    } finally {
      if (timeoutId != null) clearTimer(timeoutId)
      if (signal && abortFromParent) signal.removeEventListener('abort', abortFromParent)
    }
    const { done, value } = result
    if (done) break
    if (!(value instanceof Uint8Array)) {
      try { await reader.cancel() } catch { /* Best-effort cleanup after rejecting malformed data. */ }
      throw new Error(`${label} response returned a non-byte chunk`)
    }
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* Best-effort cleanup after enforcing the byte bound. */ }
      throw new Error(`${label} response exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
    if (chunks.length > IO_MAX_RESPONSE_CHUNKS) {
      try { await reader.cancel() } catch { /* Best-effort cleanup after enforcing the chunk bound. */ }
      throw new Error(`${label} response exceeds ${IO_MAX_RESPONSE_CHUNKS} chunks`)
    }
  }
  return concatBytes(chunks, total)
}

export async function readBoundedJsonResponse(response, maxBytes, label, controls) {
  const bytes = await readBoundedResponseBytes(response, maxBytes, label, controls)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new Error(`${label} response is not valid UTF-8`, { cause: error }) }
  try { return JSON.parse(text) } catch (error) { throw new Error(`${label} response is not valid JSON`, { cause: error }) }
}

/**
 * @param {string} kind
 * @param {string[]} endpoints
 * @param {(endpoint: string) => Promise<any>} request
 * @param {{onActive?: (endpoint: string) => void, onHealth?: (health: {state: string, message: string}) => void, publicEndpointLabel?: (endpoint: string) => string, publicError?: (error: any) => string}} [callbacks]
 */
export async function runEndpointFallback(kind, endpoints, request, { onActive = () => {}, onHealth = () => {}, publicEndpointLabel = String, publicError = String } = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length) {
    onActive('')
    onHealth({ state: 'missing', message: `No ${kind} endpoints configured.` })
    throw new Error(`No ${kind} endpoints configured. Open Connection settings and apply a preset or custom HTTP(S) endpoint.`)
  }
  onHealth({ state: 'checking', message: `Checking ${endpoints.length} ${kind} endpoint${endpoints.length === 1 ? '' : 's'}...` })
  const failures = []
  for (const endpoint of endpoints) {
    try {
      const result = await request(endpoint.replace(/\/$/, ''))
      onActive(endpoint)
      onHealth({ state: 'ok', message: publicEndpointLabel(endpoint) })
      return result
    } catch (error) {
      if (isAbortError(error)) throw error
      failures.push(`${publicEndpointLabel(endpoint)}: ${publicError(error)}`)
    }
  }
  onActive('')
  onHealth({ state: 'failed', message: failures.join(' | ') })
  throw new Error(`${kind} endpoints failed: ${failures.join(' | ')}`)
}

export function singleFlight(holder, key, task) {
  if (holder[key]) return holder[key]
  let tracked = null
  tracked = Promise.resolve().then(task).finally(() => {
    if (holder[key] === tracked) holder[key] = null
  })
  holder[key] = tracked
  return tracked
}
