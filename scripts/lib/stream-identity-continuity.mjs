import crypto from 'node:crypto'
import { canonicalStreamIdHash } from '../../packages/protocol/browser-kernel.js'

export { canonicalStreamIdHash }

export const UNATTRIBUTED_PUBLISHER = `0x${'00'.repeat(20)}`
export const ZERO_SEGMENT_HASH = `0x${'00'.repeat(32)}`

const addressPattern = /^0x[0-9a-fA-F]{40}$/
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/

function requiredStreamId(value) {
  if (typeof value !== 'string' || !value) throw new Error('streamId is required')
  return value
}

function nonNegativeSequence(value) {
  const sequence = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === 'string' && /^\d+$/.test(value)
        ? BigInt(value)
        : -1n
  if (sequence < 0n) throw new Error('segment sequence must be a non-negative integer')
  return sequence
}

function bytes32(value, label, { allowUnprefixed = false } = {}) {
  const text = String(value || '')
  const normalized = allowUnprefixed && /^[0-9a-fA-F]{64}$/.test(text) ? `0x${text}` : text
  if (!bytes32Pattern.test(normalized)) throw new Error(`${label} must be 0x-prefixed bytes32`)
  return normalized.toLowerCase()
}

function displayPrefix(value) {
  const prefix = String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48)
  return prefix || 'stream'
}

export function normalizePublisher(value, { allowUnattributed = false } = {}) {
  if ((value === undefined || value === null || value === '') && allowUnattributed) return UNATTRIBUTED_PUBLISHER
  const publisher = String(value || '')
  if (!addressPattern.test(publisher)) throw new Error('publisher must be a 0x-prefixed 20-byte address')
  return publisher.toLowerCase()
}

export function channelIdentity(record, { allowUnattributed = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('channel record is required')
  const streamId = requiredStreamId(record.streamId)
  const publisher = normalizePublisher(record.publisher, { allowUnattributed })
  const calculatedHash = canonicalStreamIdHash(streamId)
  const claimedHash = record.streamIdHash == null || record.streamIdHash === ''
    ? calculatedHash
    : bytes32(record.streamIdHash, 'streamIdHash')
  if (claimedHash !== calculatedHash) throw new Error('streamIdHash does not match streamId')
  return {
    publisher,
    streamId,
    streamIdHash: calculatedHash,
    key: JSON.stringify([publisher, calculatedHash, streamId]),
  }
}

export function withChannelIdentity(record, options = {}) {
  const identity = channelIdentity(record, options)
  return {
    ...record,
    publisher: identity.publisher,
    streamIdHash: identity.streamIdHash,
    channelKey: identity.key,
  }
}

export function segmentIdentityKey(record, options = {}) {
  const identity = channelIdentity(record, options)
  return JSON.stringify([identity.publisher, identity.streamIdHash, identity.streamId, nonNegativeSequence(record.sequence).toString()])
}

/**
 * @param {unknown} manifest
 * @param {{ streamId?: unknown, publisher?: unknown }} [options]
 */
export function proofManifestMatchesChannel(manifest, options = {}) {
  const { streamId, publisher } = options
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const record = /** @type {Record<string, unknown>} */ (manifest)
  try {
    const requestedPublisher = normalizePublisher(publisher, { allowUnattributed: true })
    const manifestIdentity = channelIdentity({
      ...record,
      publisher: record.publisher || requestedPublisher,
    }, { allowUnattributed: true })
    return manifestIdentity.streamId === requiredStreamId(streamId)
      && manifestIdentity.publisher === requestedPublisher
  } catch {
    return false
  }
}

/**
 * @param {unknown[]} records
 * @param {{ streamId?: unknown, publisher?: unknown }} [options]
 */
export function selectPublisherScopedChannel(records, options = {}) {
  const { streamId, publisher } = options
  const requestedStreamId = requiredStreamId(streamId)
  const requestedPublisher = publisher == null || publisher === '' ? null : normalizePublisher(publisher)
  const matching = []
  for (const value of records || []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = /** @type {Record<string, unknown>} */ (value)
    if (record?.streamId !== requestedStreamId) continue
    matching.push(withChannelIdentity(record, { allowUnattributed: true }))
  }
  const attributed = matching.filter((record) => record.publisher !== UNATTRIBUTED_PUBLISHER)
  const reconciled = matching.filter((record) => {
    if (record.publisher !== UNATTRIBUTED_PUBLISHER) return true
    const txHash = String(record.txHash || record.transactionHash || '').toLowerCase()
    const blobHashes = new Set((record.blobVersionedHashes || []).map((hash) => String(hash).toLowerCase()))
    const evidenceMatches = attributed.filter((candidate) => {
      const candidateTxHash = String(candidate.txHash || candidate.transactionHash || '').toLowerCase()
      if (txHash && candidateTxHash && txHash === candidateTxHash) return true
      return (candidate.blobVersionedHashes || []).some((hash) => blobHashes.has(String(hash).toLowerCase()))
    })
    return evidenceMatches.length !== 1
  })
  const byPublisher = new Map()
  for (const record of reconciled) {
    const publisherRecords = byPublisher.get(record.publisher) || []
    publisherRecords.push(record)
    byPublisher.set(record.publisher, publisherRecords)
  }
  const publishers = [...byPublisher.keys()].sort()
  if (requestedPublisher) {
    const segments = byPublisher.get(requestedPublisher) || []
    return {
      status: segments.length ? 'selected' : 'not-found',
      streamId: requestedStreamId,
      publisher: requestedPublisher,
      publishers,
      segments,
    }
  }
  if (publishers.length > 1) {
    return { status: 'ambiguous', streamId: requestedStreamId, publisher: null, publishers, segments: [] }
  }
  if (publishers.length === 0) {
    return { status: 'not-found', streamId: requestedStreamId, publisher: null, publishers, segments: [] }
  }
  const selectedPublisher = publishers[0]
  return {
    status: 'selected',
    streamId: requestedStreamId,
    publisher: selectedPublisher,
    publishers,
    segments: byPublisher.get(selectedPublisher),
  }
}

export function segmentRouteUrls(record) {
  const identity = channelIdentity(record, { allowUnattributed: true })
  const sequence = nonNegativeSequence(record.sequence).toString()
  const suffix = `?publisher=${encodeURIComponent(identity.publisher)}`
  const encodedStreamId = encodeURIComponent(identity.streamId)
  return {
    mediaUrl: `/media/${encodedStreamId}/${sequence}.webm${suffix}`,
    gatewayUrl: `/api/segments/${encodedStreamId}/${sequence}/payload${suffix}`,
  }
}

export function mediaCacheIdentity(record, context = {}) {
  const identity = channelIdentity(record, { allowUnattributed: true })
  const sequence = nonNegativeSequence(record.sequence).toString()
  const payloadSha256 = bytes32(record.payloadSha256Hex || record.payloadSha256, 'segment payload SHA-256', {
    allowUnprefixed: true,
  })
  const txHash = bytes32(record.txHash || record.transactionHash, 'segment transaction hash')
  const blobVersionedHashes = Array.isArray(record.blobVersionedHashes)
    ? record.blobVersionedHashes.map((hash, index) => bytes32(hash, `segment blob hash ${index}`))
    : []
  const cacheIdentity = {
    chain: String(record.chain || context.chain || context.name || '').toLowerCase(),
    station: String(record.station || record.stationAddress || context.stationAddress || '').toLowerCase(),
    channel: identity,
    sequence,
    payloadSha256,
    txHash,
    blobVersionedHashes,
  }
  return crypto.createHash('sha256').update(JSON.stringify(cacheIdentity)).digest('hex')
}

export function mediaCacheFilename(record, context = {}) {
  const sequence = nonNegativeSequence(record?.sequence).toString()
  return `${displayPrefix(record?.streamId)}-${sequence}-${mediaCacheIdentity(record, context)}.webm`
}

function continuityResult(status, reason, details = {}) {
  return { status, reason, ...details }
}

export function annotateStreamContinuity(records) {
  const output = (records || []).map((record, index) => ({
    ...withChannelIdentity(record, { allowUnattributed: true }),
    __continuityIndex: index,
  }))
  const channels = new Map()
  for (const record of output) {
    const channel = channels.get(record.channelKey) || []
    channel.push(record)
    channels.set(record.channelKey, channel)
  }

  for (const channel of channels.values()) {
    channel.sort((left, right) => {
      const a = nonNegativeSequence(left.sequence)
      const b = nonNegativeSequence(right.sequence)
      return a < b ? -1 : a > b ? 1 : left.__continuityIndex - right.__continuityIndex
    })
    const bySequence = new Map()
    for (const record of channel) {
      const sequence = nonNegativeSequence(record.sequence)
      const sequenceKey = sequence.toString()
      if (bySequence.has(sequenceKey)) throw new Error(`duplicate segment identity for sequence ${sequenceKey}`)
      const previousHash = record.previousSegmentHash == null || record.previousSegmentHash === ''
        ? null
        : bytes32(record.previousSegmentHash, 'previousSegmentHash')
      const payloadHash = bytes32(record.payloadSha256Hex || record.payloadSha256, 'segment payload SHA-256', {
        allowUnprefixed: true,
      })
      let continuity
      if (sequence === 0n) {
        continuity = previousHash == null
          ? continuityResult('unknown', 'missing-link-metadata')
          : previousHash === ZERO_SEGMENT_HASH
            ? continuityResult('valid', 'root')
            : continuityResult('invalid', 'root-predecessor-mismatch', { actualHash: previousHash, expectedHash: ZERO_SEGMENT_HASH })
      } else {
        const predecessorSequence = sequence - 1n
        const predecessor = bySequence.get(predecessorSequence.toString())
        if (!predecessor) {
          continuity = continuityResult('unknown', 'missing-predecessor', {
            predecessorSequence: predecessorSequence.toString(),
            actualHash: previousHash,
          })
        } else if (predecessor.continuity.status === 'invalid') {
          continuity = continuityResult('invalid', 'invalid-ancestry', {
            predecessorSequence: predecessorSequence.toString(),
          })
        } else if (predecessor.continuity.status === 'unknown') {
          continuity = continuityResult('unknown', 'unknown-ancestry', {
            predecessorSequence: predecessorSequence.toString(),
          })
        } else if (previousHash == null) {
          continuity = continuityResult('unknown', 'missing-link-metadata', {
            predecessorSequence: predecessorSequence.toString(),
          })
        } else if (previousHash !== predecessor.payloadHash) {
          continuity = continuityResult('invalid', 'predecessor-mismatch', {
            predecessorSequence: predecessorSequence.toString(),
            actualHash: previousHash,
            expectedHash: predecessor.payloadHash,
          })
        } else {
          continuity = continuityResult('valid', 'matching-predecessor', {
            predecessorSequence: predecessorSequence.toString(),
          })
        }
      }
      record.previousSegmentHash = previousHash
      record.payloadHash = payloadHash
      record.continuity = continuity
      record.quarantined = continuity.status === 'invalid'
      bySequence.set(sequenceKey, record)
    }
  }
  return output
    .sort((left, right) => left.__continuityIndex - right.__continuityIndex)
    .map((record) => {
      const result = { ...record }
      delete result.__continuityIndex
      delete result.payloadHash
      return result
    })
}
