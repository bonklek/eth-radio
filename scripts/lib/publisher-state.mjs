import fs from 'node:fs'
import path from 'node:path'

const bytes32Hex = /^0x[0-9a-fA-F]{64}$/
const txHashHex = /^0x[0-9a-fA-F]{64}$/
const decimalInteger = /^\d+$/

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
  }
}

function validateSubmittedItems(items, statePath) {
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
  ]) {
    assertOptionalDecimalInteger(metrics[name], `metrics.${name}`, statePath)
  }
  for (const name of ['submittedCount', 'confirmedCount', 'pendingCount', 'latestPendingLimit']) {
    if (metrics[name] !== undefined && !isNonNegativeInteger(metrics[name])) {
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
    streamId,
    nextSequence: startSeq,
    previousSegmentHash,
    ...(submitted ? { submitted: [] } : {}),
    published: [],
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
            runtimeBudgetExhausted: false,
          },
        }
      : {}),
  }
}

export function readPublisherState(statePath, defaults, { submitted = false } = {}) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unreadable publisher state ${statePath}: ${error.message}`)
  }

  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`Invalid publisher state ${statePath}: expected an object`)
  }
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
  validatePublishedItems(published, statePath)
  if (submitted) validateSubmittedItems(submittedItems, statePath)
  if (submitted) validateMetrics(state.metrics, statePath)

  return {
    ...defaults,
    ...state,
    nextSequence: Number(state.nextSequence),
    published,
    ...(submitted ? { submitted: submittedItems, metrics: normalizeMetrics(defaults.metrics, state.metrics) } : {}),
  }
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
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`)
    return {
      state: defaults,
      recovered: true,
      quarantinePath,
      statusPath,
      reason: error.message,
    }
  }
}
