import fs from 'node:fs'
import path from 'node:path'
import { readBoundedTextFileSync } from './bounded-files.mjs'
import { atomicWriteJson } from './publisher-safety.mjs'

const bytes32Hex = /^0x[0-9a-fA-F]{64}$/
const payloadHashHex = /^(?:0x)?[0-9a-fA-F]{64}$/
const txHashHex = /^0x[0-9a-fA-F]{64}$/
const decimalInteger = /^\d+$/
export const MAX_PUBLISHER_STATE_BYTES = 32 * 1024 * 1024
export const MAX_PUBLISHED_HISTORY = 256
export const MAX_SUBMITTED_HISTORY = 16

function readBoundedStateFile(statePath) {
  return readBoundedTextFileSync(statePath, {
    maxBytes: MAX_PUBLISHER_STATE_BYTES,
    label: 'publisher state',
  })
}

function isNonNegativeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
  if (typeof value === 'string' && decimalInteger.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed)
  }
  return false
}

export function publisherStateInteger(value, label) {
  if (isNonNegativeInteger(value)) return Number(value)
  throw new Error(`${label} must be a non-negative safe integer`)
}

function assertOptionalDecimalInteger(value, label, statePath) {
  if (value === undefined || value === null || value === '') return
  if (!decimalInteger.test(String(value))) {
    throw new Error(`Invalid publisher state ${statePath}: ${label} must be a non-negative integer string`)
  }
}

function validatePublishedItems(items, statePath) {
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid publisher state ${statePath}: published[${index}] must be an object`)
    }
    if (!isNonNegativeInteger(item.sequence)) {
      throw new Error(`Invalid publisher state ${statePath}: published[${index}].sequence must be a non-negative integer`)
    }
    if (item.txHash !== undefined && !txHashHex.test(String(item.txHash))) {
      throw new Error(`Invalid publisher state ${statePath}: published[${index}].txHash must be a transaction hash`)
    }
    if (item.previousSegmentHash !== undefined && !bytes32Hex.test(String(item.previousSegmentHash))) {
      throw new Error(`Invalid publisher state ${statePath}: published[${index}].previousSegmentHash must be 0x-prefixed bytes32`)
    }
    if (item.payloadSha256 !== undefined && !payloadHashHex.test(String(item.payloadSha256))) {
      throw new Error(`Invalid publisher state ${statePath}: published[${index}].payloadSha256 must be a SHA-256 hash`)
    }
    for (const field of ['costWei', 'executionCostWei', 'blobCostWei']) {
      assertOptionalDecimalInteger(item[field], `published[${index}].${field}`, statePath)
    }
  }
}

function validateSubmittedItems(items, statePath) {
  if (items.length > MAX_SUBMITTED_HISTORY) {
    throw new Error(`Invalid publisher state ${statePath}: submitted exceeds ${MAX_SUBMITTED_HISTORY} entries`)
  }
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}] must be an object`)
    }
    if (!isNonNegativeInteger(item.sequence)) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].sequence must be a non-negative integer`)
    }
    if (item.nonce !== undefined && !isNonNegativeInteger(item.nonce)) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].nonce must be a non-negative integer`)
    }
    if (item.txHash !== undefined && !txHashHex.test(String(item.txHash))) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].txHash must be a transaction hash`)
    }
    if (item.previousSegmentHash !== undefined && !bytes32Hex.test(String(item.previousSegmentHash))) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].previousSegmentHash must be 0x-prefixed bytes32`)
    }
    if (item.payloadSha256 !== undefined && !payloadHashHex.test(String(item.payloadSha256))) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].payloadSha256 must be a SHA-256 hash`)
    }
    if (item.reservedCostWei !== undefined) {
      assertOptionalDecimalInteger(item.reservedCostWei, `submitted[${index}].reservedCostWei`, statePath)
      if (BigInt(item.reservedCostWei) <= 0n) {
        throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].reservedCostWei must be greater than zero`)
      }
    }
    if (item.serializedTransaction !== undefined) {
      const serialized = String(item.serializedTransaction)
      if (!/^0x[0-9a-fA-F]+$/.test(serialized) || serialized.length > 32 * 1024 * 1024) {
        throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].serializedTransaction must be bounded hex`)
      }
      const blobCount = publisherStateInteger(item.blobCount, `submitted[${index}].blobCount`)
      if (!Array.isArray(item.blobVersionedHashes) || item.blobVersionedHashes.length !== blobCount
        || item.blobVersionedHashes.some((hash) => !bytes32Hex.test(String(hash)))) {
        throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].blobVersionedHashes must contain exactly blobCount bytes32 values`)
      }
    }
    if (item.submissionStatus !== undefined && !['prepared', 'broadcast'].includes(item.submissionStatus)) {
      throw new Error(`Invalid publisher state ${statePath}: submitted[${index}].submissionStatus is invalid`)
    }
  }
}

function historyAnchorInteger(value, label, statePath) {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`Invalid publisher state ${statePath}: historyAnchor.${label} must be a non-negative integer`)
  }
  return Number(value)
}

function normalizeHistoryAnchor(value, statePath) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid publisher state ${statePath}: historyAnchor must be an object or null`)
  }
  const throughSequence = historyAnchorInteger(value.throughSequence, 'throughSequence', statePath)
  const publishedCount = historyAnchorInteger(value.publishedCount, 'publishedCount', statePath)
  const anchorPayloadHash = payloadHash(value.payloadSha256)
  if (!anchorPayloadHash || !bytes32Hex.test(anchorPayloadHash)) {
    throw new Error(`Invalid publisher state ${statePath}: historyAnchor.payloadSha256 must be a SHA-256 hash`)
  }
  const normalized = { ...value, throughSequence, publishedCount, payloadSha256: anchorPayloadHash }
  for (const field of ['costWei', 'executionCostWei', 'blobCostWei']) {
    assertOptionalDecimalInteger(normalized[field], `historyAnchor.${field}`, statePath)
    normalized[field] = String(normalized[field] || '0')
  }
  return normalized
}

function addDecimal(left, right) {
  return (BigInt(left || '0') + BigInt(right || '0')).toString()
}

export function compactPublisherHistory(state) {
  if (!Array.isArray(state.published)) return state
  state.published.sort((left, right) => Number(left.sequence) - Number(right.sequence))
  while (state.published.length > MAX_PUBLISHED_HISTORY) {
    const removed = state.published.shift()
    const prior = state.historyAnchor
    const removedPayloadHash = payloadHash(removed.payloadSha256)
    if (!removedPayloadHash) {
      throw new Error(`Cannot compact publisher history at sequence ${removed.sequence} without payloadSha256`)
    }
    if (prior && Number(removed.sequence) !== Number(prior.throughSequence) + 1) {
      throw new Error(`Cannot compact non-contiguous publisher history after sequence ${prior.throughSequence}`)
    }
    state.historyAnchor = {
      throughSequence: Number(removed.sequence),
      payloadSha256: removedPayloadHash,
      publishedCount: Number(prior?.publishedCount || 0) + 1,
      costWei: addDecimal(prior?.costWei, removed.costWei),
      executionCostWei: addDecimal(prior?.executionCostWei, removed.executionCostWei),
      blobCostWei: addDecimal(prior?.blobCostWei, removed.blobCostWei),
    }
  }
  return state
}

export function appendPublishedHistory(state, item) {
  if (!Array.isArray(state.published)) throw new Error('Publisher state published history must be an array')
  state.published.push(item)
  return compactPublisherHistory(state)
}

export function savePublisherState(statePath, state, { dryRun = false } = {}) {
  compactPublisherHistory(state)
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_PUBLISHER_STATE_BYTES) {
    throw new Error(`Publisher state exceeds ${MAX_PUBLISHER_STATE_BYTES} bytes`)
  }
  atomicWriteJson(statePath, state, { dryRun })
}

function payloadHash(value) {
  if (value === undefined || value === null || value === '') return null
  return `0x${String(value).replace(/^0x/i, '').toLowerCase()}`
}

function previousHash(value) {
  return value === undefined || value === null || value === '' ? null : String(value).toLowerCase()
}

function assertStrictSequenceOrder(items, label, statePath) {
  let previous = -1
  for (const [index, item] of items.entries()) {
    const sequence = Number(item.sequence)
    if (sequence <= previous) {
      throw new Error(`Invalid publisher state ${statePath}: ${label} sequences must be unique and strictly increasing at index ${index}`)
    }
    previous = sequence
  }
}

function validateHistoryInvariants({ state, defaults, published, submittedItems, submitted, historyAnchor, statePath }) {
  assertStrictSequenceOrder(published, 'published', statePath)
  if (submitted) assertStrictSequenceOrder(submittedItems, 'submitted', statePath)

  let previousNonce = -1
  for (const [index, item] of submittedItems.entries()) {
    if (item.nonce === undefined || item.nonce === null || item.nonce === '') continue
    const nonce = Number(item.nonce)
    if (nonce <= previousNonce) {
      throw new Error(`Invalid publisher state ${statePath}: submitted nonces must be unique and strictly increasing at index ${index}`)
    }
    previousNonce = nonce
  }

  const publishedSequences = new Set(published.map((item) => Number(item.sequence)))
  for (const item of submittedItems) {
    const sequence = Number(item.sequence)
    if (publishedSequences.has(sequence)) {
      throw new Error(`Invalid publisher state ${statePath}: sequence ${sequence} appears in both published and submitted queues`)
    }
  }

  const history = [
    ...published.map((item) => ({ ...item, queue: 'published', sequence: Number(item.sequence) })),
    ...submittedItems.map((item) => ({ ...item, queue: 'submitted', sequence: Number(item.sequence) })),
  ].sort((left, right) => left.sequence - right.sequence)
  const nextSequence = Number(state.nextSequence)
  for (const entry of history) {
    if (entry.sequence >= nextSequence) {
      throw new Error(`Invalid publisher state ${statePath}: ${entry.queue} sequence ${entry.sequence} must be less than nextSequence ${nextSequence}`)
    }
  }
  for (let index = 1; index < history.length; index += 1) {
    if (history[index].sequence !== history[index - 1].sequence + 1) {
      throw new Error(`Invalid publisher state ${statePath}: history sequences must be contiguous between ${history[index - 1].sequence} and ${history[index].sequence}`)
    }
  }
  if (history.length && history.at(-1).sequence + 1 !== nextSequence) {
    throw new Error(`Invalid publisher state ${statePath}: nextSequence ${nextSequence} must follow latest history sequence ${history.at(-1).sequence}`)
  }

  if (historyAnchor) {
    if (!history.length || history[0].sequence !== historyAnchor.throughSequence + 1) {
      throw new Error(`Invalid publisher state ${statePath}: retained history must immediately follow historyAnchor sequence ${historyAnchor.throughSequence}`)
    }
    const firstPreviousHash = previousHash(history[0].previousSegmentHash)
    if (firstPreviousHash && firstPreviousHash !== historyAnchor.payloadSha256) {
      throw new Error(`Invalid publisher state ${statePath}: retained history does not continue from historyAnchor payloadSha256`)
    }
  }

  if (history.length) {
    const first = history[0]
    if (!historyAnchor && first.sequence === Number(defaults.nextSequence)) {
      const initialExpected = previousHash(defaults.previousSegmentHash)
      const initialActual = previousHash(first.previousSegmentHash)
      if (initialExpected && initialActual && initialExpected !== initialActual) {
        throw new Error(`Invalid publisher state ${statePath}: sequence ${first.sequence} previousSegmentHash does not match initial predecessor`)
      }
    }
    for (let index = 1; index < history.length; index += 1) {
      const expected = payloadHash(history[index - 1].payloadSha256)
      const actual = previousHash(history[index].previousSegmentHash)
      if (expected && actual && expected !== actual) {
        throw new Error(`Invalid publisher state ${statePath}: sequence ${history[index].sequence} previousSegmentHash does not match sequence ${history[index - 1].sequence} payloadSha256`)
      }
    }
    const latestPayloadHash = payloadHash(history.at(-1).payloadSha256)
    if (latestPayloadHash && latestPayloadHash !== previousHash(state.previousSegmentHash)) {
      throw new Error(`Invalid publisher state ${statePath}: previousSegmentHash does not match latest history payloadSha256`)
    }
  }
  if (submitted && state.metrics) {
    const recordedSpend = BigInt(state.metrics.actualSpendWei || '0')
    const knownPublishedSpend = BigInt(historyAnchor?.costWei || '0') + published.reduce(
      (total, item) => total + (item.costWei === undefined ? 0n : BigInt(item.costWei)),
      0n,
    )
    if (recordedSpend < knownPublishedSpend) {
      throw new Error(`Invalid publisher state ${statePath}: metrics.actualSpendWei understates published receipt costs`)
    }
    const reservationsKnown = submittedItems.every((item) => item.reservedCostWei !== undefined)
    if (reservationsKnown) {
      const expectedReserved = submittedItems.reduce((total, item) => total + BigInt(item.reservedCostWei), 0n)
      if (BigInt(state.metrics.reservedPendingWei || '0') !== expectedReserved) {
        throw new Error(`Invalid publisher state ${statePath}: metrics.reservedPendingWei does not match pending submissions`)
      }
    }
  }
}

function validateMetrics(metrics, statePath) {
  if (metrics === undefined) return
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error(`Invalid publisher state ${statePath}: metrics must be an object`)
  }
  for (const name of [
    'actualSpendWei',
    'actualExecutionSpendWei',
    'actualBlobSpendWei',
    'runtimeBudgetWei',
    'reservedPendingWei',
    'totalExposureWei',
  ]) {
    assertOptionalDecimalInteger(metrics[name], `metrics.${name}`, statePath)
  }
  for (const name of ['submittedCount', 'confirmedCount', 'pendingCount', 'latestPendingLimit']) {
    if (metrics[name] !== undefined && metrics[name] !== null && metrics[name] !== '' && !isNonNegativeInteger(metrics[name])) {
      throw new Error(`Invalid publisher state ${statePath}: metrics.${name} must be a non-negative integer`)
    }
  }
}

function normalizeMetrics(defaults, metrics = {}) {
  const normalized = { ...defaults, ...metrics }
  for (const name of [
    'actualSpendWei',
    'actualExecutionSpendWei',
    'actualBlobSpendWei',
    'runtimeBudgetWei',
    'reservedPendingWei',
    'totalExposureWei',
  ]) {
    if (normalized[name] === undefined || normalized[name] === null || normalized[name] === '') {
      normalized[name] = defaults[name]
    }
  }
  for (const name of ['submittedCount', 'confirmedCount', 'pendingCount', 'latestPendingLimit']) {
    if (normalized[name] === undefined || normalized[name] === null || normalized[name] === '') {
      normalized[name] = defaults[name]
    }
  }
  return normalized
}

export function makePublisherState({ streamId, startSeq, previousSegmentHash, submitted = false }) {
  return {
    version: 2,
    streamId,
    nextSequence: startSeq,
    previousSegmentHash,
    filesystemIdentity: undefined,
    ...(submitted ? { submitted: [] } : {}),
    published: [],
    historyAnchor: null,
    ...(submitted
      ? {
          metrics: {
            submittedCount: 0,
            confirmedCount: 0,
            latestPendingLimit: null,
            latestTimings: null,
            actualSpendWei: '0',
            actualExecutionSpendWei: '0',
            actualBlobSpendWei: '0',
            runtimeBudgetWei: null,
            reservedPendingWei: '0',
            totalExposureWei: '0',
            runtimeBudgetExhausted: false,
          },
        }
      : {}),
  }
}

export function readPublisherStateSnapshot(statePath, { label = `publisher state ${statePath}` } = {}) {
  let state
  try {
    state = JSON.parse(readBoundedStateFile(statePath))
  } catch (error) {
    throw new Error(`Unreadable ${label}: ${error.message}`, { cause: error })
  }

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`Invalid ${label}: expected an object`)
  }
  if (state.published !== undefined && !Array.isArray(state.published)) {
    throw new Error(`Invalid ${label}: published must be an array`)
  }
  if (state.nextSequence !== undefined && !isNonNegativeInteger(state.nextSequence)) {
    throw new Error(`Invalid ${label}: nextSequence must be a non-negative integer`)
  }
  const published = state.published === undefined ? [] : state.published
  validatePublishedItems(published, statePath)
  return { ...state, published }
}

export function readPublisherState(statePath, defaults, { submitted = false } = {}) {
  const state = readPublisherStateSnapshot(statePath)
  if (state.streamId !== defaults.streamId) {
    throw new Error(`Invalid publisher state ${statePath}: streamId ${state.streamId || '(missing)'} does not match ${defaults.streamId}`)
  }
  if (!isNonNegativeInteger(state.nextSequence)) {
    throw new Error(`Invalid publisher state ${statePath}: nextSequence must be a non-negative integer`)
  }
  if (!bytes32Hex.test(String(state.previousSegmentHash || ''))) {
    throw new Error(`Invalid publisher state ${statePath}: previousSegmentHash must be 0x-prefixed bytes32`)
  }
  if (state.published !== undefined && !Array.isArray(state.published)) {
    throw new Error(`Invalid publisher state ${statePath}: published must be an array`)
  }
  if (submitted && state.submitted !== undefined && !Array.isArray(state.submitted)) {
    throw new Error(`Invalid publisher state ${statePath}: submitted must be an array`)
  }
  const published = state.published === undefined ? [] : state.published
  const submittedItems = state.submitted === undefined ? [] : state.submitted
  const historyAnchor = normalizeHistoryAnchor(state.historyAnchor, statePath)
  validatePublishedItems(published, statePath)
  if (submitted) validateSubmittedItems(submittedItems, statePath)
  if (submitted) validateMetrics(state.metrics, statePath)
  validateHistoryInvariants({ state, defaults, published, submittedItems, submitted, historyAnchor, statePath })

  const normalized = {
    ...defaults,
    ...state,
    version: 2,
    nextSequence: Number(state.nextSequence),
    published,
    historyAnchor,
    ...(submitted ? { submitted: submittedItems, metrics: normalizeMetrics(defaults.metrics, state.metrics) } : {}),
  }
  if (state.version !== undefined && ![1, 2].includes(state.version)) {
    throw new Error(`Invalid publisher state ${statePath}: unsupported version ${state.version}`)
  }
  return compactPublisherHistory(normalized)
}

export function readPublisherStateWithRecovery(statePath, defaults, { submitted = false, recover = false } = {}) {
  try {
    return { state: readPublisherState(statePath, defaults, { submitted }), recovered: false }
  } catch (error) {
    if (!recover) throw error
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantinePath = `${statePath}.invalid-${timestamp}`
    const statusPath = `${statePath}.recovery.json`
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.renameSync(statePath, quarantinePath)
    const status = {
      recoveredAt: new Date().toISOString(),
      statePath,
      quarantinePath,
      reason: error.message,
      nextSequence: defaults.nextSequence,
    }
    atomicWriteJson(statusPath, status)
    return {
      state: defaults,
      recovered: true,
      quarantinePath,
      statusPath,
      reason: error.message,
    }
  }
}
