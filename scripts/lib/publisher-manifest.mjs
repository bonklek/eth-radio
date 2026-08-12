/**
 * Normalize the blob versioned hashes returned by execution RPCs and Station
 * events before they are persisted in publisher manifests.
 *
 * A nullish value is accepted only when the caller explicitly marks the field
 * optional. Empty arrays are valid at this normalization boundary; callers
 * that require a blob-bearing transaction must enforce non-empty output.
 */
export function normalizeBlobVersionedHashes(value, label, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null
    throw new Error(`${label} must be an array`)
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((hash) => {
    const normalized = String(hash || '').toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
      throw new Error(`${label} contains invalid bytes32 hash: ${hash}`)
    }
    return normalized
  })
}

export function stationEventSequenceMatches(eventSequence, expectedSequence) {
  if (typeof eventSequence !== 'bigint') return false
  try {
    return eventSequence === BigInt(expectedSequence)
  } catch {
    return false
  }
}

function normalizedBytes32(value, label) {
  const normalized = `0x${String(value ?? '').replace(/^0x/i, '').toLowerCase()}`
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be bytes32`)
  return normalized
}

function normalizedUnsignedInteger(value, label) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  if (!['bigint', 'number', 'string'].includes(typeof value)) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  try {
    const normalized = BigInt(value)
    if (normalized < 0n) throw new Error()
    return normalized
  } catch {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

export function assertStationEventMetadata(stationEvent, expected) {
  const args = stationEvent?.args
  if (!args || typeof args !== 'object') throw new Error('Station event metadata is missing')

  for (const field of ['streamId', 'codec']) {
    if (typeof args[field] !== 'string' || args[field] !== String(expected[field])) {
      throw new Error(`Station event ${field} does not match the intended segment`)
    }
  }
  for (const field of ['durationMs', 'payloadBytes']) {
    if (normalizedUnsignedInteger(args[field], `Station event ${field}`)
      !== normalizedUnsignedInteger(expected[field], `Expected ${field}`)) {
      throw new Error(`Station event ${field} does not match the intended segment`)
    }
  }
  for (const field of ['payloadSha256', 'previousSegmentHash']) {
    if (normalizedBytes32(args[field], `Station event ${field}`)
      !== normalizedBytes32(expected[field], `Expected ${field}`)) {
      throw new Error(`Station event ${field} does not match the intended segment`)
    }
  }
  return stationEvent
}

/**
 * Select authoritative hashes for a durable publisher manifest.
 *
 * Some execution RPCs omit `blobVersionedHashes`, while others may expose an
 * empty placeholder array. A validated Station event is the safe fallback in
 * either case. Without a Station event, transaction hashes are mandatory.
 */
export function manifestBlobVersionedHashes(transaction, stationEvent = null) {
  const eventHashes = stationEvent
    ? normalizeBlobVersionedHashes(
        stationEvent.args?.blobVersionedHashes,
        'Station event blobVersionedHashes',
      )
    : null
  const transactionHashes = normalizeBlobVersionedHashes(
    transaction?.blobVersionedHashes,
    'transaction blobVersionedHashes',
    { optional: Boolean(stationEvent) },
  )

  if (eventHashes && !eventHashes.length) {
    throw new Error('Station event must contain at least one blob versioned hash')
  }
  if (transactionHashes?.length && eventHashes) {
    const matches = transactionHashes.length === eventHashes.length
      && transactionHashes.every((hash, index) => hash === eventHashes[index])
    if (!matches) {
      throw new Error('Transaction and Station event blob versioned hashes do not match exactly')
    }
  }

  const selected = transactionHashes?.length ? transactionHashes : eventHashes
  if (!selected?.length) throw new Error('Durable publisher manifest requires at least one blob versioned hash')
  return selected
}
