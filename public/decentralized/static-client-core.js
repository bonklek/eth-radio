import {
  canonicalStreamIdHash as sharedCanonicalStreamIdHash,
  v1SyntheticChannelId,
} from '../../packages/protocol/browser-kernel.js'
import { viewerAbiStringByteLimit } from './static-client-limits.js'

const IO_MAX_ABI_STRING_BYTES = viewerAbiStringByteLimit()

const ZERO_SEGMENT_HASH = `0x${'00'.repeat(32)}`
const MAX_CLIENT_ENDPOINTS = 8
const MAX_CLIENT_ENDPOINT_BYTES = 2048
const MAX_CLIENT_ADDRESS_INPUT = 2048
const MAX_FAVORITES = 256
const MAX_FAVORITE_ADDRESS_INPUT = 2048
const ARCHIVE_TEMPLATE_FIELDS = Object.freeze(['streamId', 'sequence', 'txHash', 'payloadSha256'])

function boundedClientUrl(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${label} must not be empty`)
  if (new TextEncoder().encode(text).byteLength > MAX_CLIENT_ENDPOINT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_CLIENT_ENDPOINT_BYTES} UTF-8 bytes`)
  }
  let url
  try { url = new URL(text) } catch { throw new Error(`${label} is not a valid URL`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  return { text, url }
}

function boundedDistinctUrls(values, label, normalize) {
  if (!Array.isArray(values)) throw new Error(`${label} must be a list`)
  if (values.length === 0) throw new Error(`${label} requires at least one value`)
  if (values.length > MAX_CLIENT_ENDPOINTS) throw new Error(`${label} exceeds ${MAX_CLIENT_ENDPOINTS} values`)
  const normalized = values.map((value, index) => normalize(value, `${label} #${index + 1}`))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicate values`)
  return Object.freeze(normalized)
}

export function normalizeHttpEndpointList(values, label = 'Endpoint') {
  return boundedDistinctUrls(values, label, (value, itemLabel) => boundedClientUrl(value, itemLabel).text)
}

export function normalizeArchiveTemplateList(values, label = 'Archive template') {
  return boundedDistinctUrls(values, label, (value, itemLabel) => {
    const text = String(value || '').trim()
    const fields = [...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])
    if (fields.some((field) => !ARCHIVE_TEMPLATE_FIELDS.includes(field))) {
      throw new Error(`${itemLabel} contains an unsupported placeholder`)
    }
    const withoutFields = ARCHIVE_TEMPLATE_FIELDS.reduce(
      (current, field) => current.replaceAll(`{${field}}`, 'rfe'),
      text,
    )
    if (/[{}]/.test(withoutFields)) throw new Error(`${itemLabel} contains a malformed placeholder`)
    boundedClientUrl(withoutFields, itemLabel)
    return text
  })
}

export function endpointRequiresSessionStorage(value) {
  const { url } = boundedClientUrl(value, 'Endpoint')
  return Boolean(url.username || url.password || url.search)
}

export function normalizeHex(value) {
  return String(value || '').toLowerCase()
}

export function isBytes32Hex(value) {
  return typeof value === 'string' && value.length === 66 && /^0x[0-9a-fA-F]{64}$/.test(value)
}

export function normalizeStationAddressInput(value) {
  const text = String(value || '')
  if (text.length > MAX_CLIENT_ADDRESS_INPUT) return ''
  const address = text.match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || ''
  if (address) return address
  const trimmed = text.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : ''
}

export function canonicalStreamIdHash(streamId) {
  return sharedCanonicalStreamIdHash(streamId)
}

/** @param {Record<string, any>} record */
export function channelIdentity(record, { allowMissingPublisher = false } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Channel identity record is required')
  const streamId = String(record.streamId || '')
  const publisher = normalizeStationAddressInput(record.publisher || '')
  if (!streamId) throw new Error('streamId is required for channel identity')
  if (new TextEncoder().encode(streamId).byteLength > IO_MAX_ABI_STRING_BYTES) throw new Error(`streamId exceeds viewer ABI string limit of ${IO_MAX_ABI_STRING_BYTES} UTF-8 bytes`)
  if (!publisher && !allowMissingPublisher) throw new Error('publisher is required for channel identity')
  const streamIdHash = canonicalStreamIdHash(streamId)
  const claimedHash = record.streamIdHash ? normalizeHex(record.streamIdHash) : streamIdHash
  if (!isBytes32Hex(claimedHash) || claimedHash !== streamIdHash) throw new Error('streamIdHash does not match streamId')
  return { publisher, streamIdHash, streamId, key: JSON.stringify([publisher, streamIdHash, streamId]) }
}

/** @param {Record<string, any>} record */
export function v1ScopedChannelIdentity(record) {
  const identity = channelIdentity(record)
  const chainId = String(record?.chainId || '')
  const stationAddress = normalizeStationAddressInput(record?.stationAddress || '')
  if (!/^(?:0|[1-9][0-9]*)$/.test(chainId)) throw new Error('chainId is required for scoped V1 channel identity')
  if (!stationAddress) throw new Error('stationAddress is required for scoped V1 channel identity')
  const syntheticChannelId = v1SyntheticChannelId(chainId, stationAddress, identity.publisher, identity.streamIdHash)
  return {
    ...identity,
    chainId,
    stationAddress,
    syntheticChannelId,
    key: JSON.stringify(['v1', chainId, stationAddress, syntheticChannelId, identity.streamId]),
  }
}

/** @param {Record<string, any>} record */
export function withChannelIdentity(record, options = {}) {
  const identity = record?.chainId && record?.stationAddress
    ? v1ScopedChannelIdentity(record)
    : channelIdentity(record, options)
  return { ...record, ...identity, channelKey: identity.key }
}

/** @param {Record<string, any>} segment */
export function segmentIdentityKey(segment) {
  const identity = channelIdentity(segment)
  return JSON.stringify([identity.publisher, identity.streamIdHash, identity.streamId, String(segment.sequence), normalizeHex(segment.txHash)])
}

/** @param {Record<string, any>} segment */
export function scopedSegmentIdentityKey(segment) {
  const identity = v1ScopedChannelIdentity(segment)
  return JSON.stringify(['v1-segment', identity.chainId, identity.stationAddress, identity.syntheticChannelId, identity.streamId, String(segment.sequence), normalizeHex(segment.txHash)])
}

/** @param {Record<string, any>[]} segments @param {{streamId?: string, publisher?: string}} [selection] */
export function selectPublisherScopedChannel(segments, { streamId, publisher = '' } = {}) {
  const requestedStreamId = String(streamId || '')
  const requestedPublisher = publisher ? normalizeStationAddressInput(publisher) : ''
  if (!requestedStreamId) throw new Error('streamId is required')
  if (publisher && !requestedPublisher) throw new Error('publisher must be a 20-byte address')
  const matching = segments.filter((segment) => segment?.streamId === requestedStreamId).map((segment) => withChannelIdentity(segment))
  const publishers = [...new Set(matching.map((segment) => segment.publisher).filter(Boolean))].sort()
  if (requestedPublisher) {
    const selected = matching.filter((segment) => segment.publisher === requestedPublisher)
    return { status: selected.length ? 'selected' : 'not-found', publisher: requestedPublisher, publishers, segments: selected }
  }
  if (publishers.length > 1) return { status: 'ambiguous', publisher: '', publishers, segments: [] }
  if (!publishers.length) return { status: 'not-found', publisher: '', publishers, segments: [] }
  return { status: 'selected', publisher: publishers[0], publishers, segments: matching.filter((segment) => segment.publisher === publishers[0]) }
}

export function annotateStreamContinuity(segments) {
  const output = segments.map((segment, index) => ({ ...withChannelIdentity(segment), __index: index }))
  const channels = new Map()
  for (const segment of output) {
    const channel = channels.get(segment.channelKey) || []
    channel.push(segment)
    channels.set(segment.channelKey, channel)
  }
  for (const channel of channels.values()) {
    channel.sort((a, b) => a.sequence - b.sequence || a.__index - b.__index)
    const bySequence = new Map()
    for (const segment of channel) {
      if (bySequence.has(segment.sequence)) throw new Error(`Duplicate segment identity for sequence ${segment.sequence}`)
      const previousHash = segment.previousSegmentHash ? normalizeHex(segment.previousSegmentHash) : ''
      if (previousHash && !isBytes32Hex(previousHash)) throw new Error('previousSegmentHash must be bytes32')
      let continuity
      if (segment.sequence === 0) {
        continuity = !previousHash
          ? { status: 'unknown', reason: 'missing-link-metadata' }
          : previousHash === ZERO_SEGMENT_HASH
            ? { status: 'valid', reason: 'root' }
            : { status: 'invalid', reason: 'root-predecessor-mismatch', expectedHash: ZERO_SEGMENT_HASH, actualHash: previousHash }
      } else {
        const predecessor = bySequence.get(segment.sequence - 1)
        if (!predecessor) continuity = { status: 'unknown', reason: 'missing-predecessor', predecessorSequence: segment.sequence - 1 }
        else if (predecessor.continuity.status === 'invalid') continuity = { status: 'invalid', reason: 'invalid-ancestry', predecessorSequence: segment.sequence - 1 }
        else if (predecessor.continuity.status === 'unknown') continuity = { status: 'unknown', reason: 'unknown-ancestry', predecessorSequence: segment.sequence - 1 }
        else if (!previousHash) continuity = { status: 'unknown', reason: 'missing-link-metadata', predecessorSequence: segment.sequence - 1 }
        else if (previousHash !== predecessor.payloadSha256Hex) continuity = { status: 'invalid', reason: 'predecessor-mismatch', predecessorSequence: segment.sequence - 1, expectedHash: predecessor.payloadSha256Hex, actualHash: previousHash }
        else continuity = { status: 'valid', reason: 'matching-predecessor', predecessorSequence: segment.sequence - 1 }
      }
      segment.previousSegmentHash = previousHash || null
      segment.payloadValidity = segment.payloadValidity || 'unknown'
      segment.continuity = continuity
      segment.quarantined = continuity.status === 'invalid'
      bySequence.set(segment.sequence, segment)
    }
  }
  return output.sort((a, b) => a.__index - b.__index).map((segment) => {
    const result = { ...segment }
    delete result.__index
    return result
  })
}

export function segmentIsQuarantined(segment) {
  return Boolean(segment?.quarantined || segment?.continuity?.status === 'invalid')
}

export function assertPlayableContinuity(segment) {
  if (segmentIsQuarantined(segment)) throw new Error(`Segment #${segment?.sequence ?? '?'} is quarantined because its continuity proof is invalid.`)
  return true
}

export function segmentContinuityPresentation(segment) {
  const quarantined = segmentIsQuarantined(segment)
  if (quarantined) return { quarantined: true, label: `QUARANTINED: ${segment.continuity?.reason || 'invalid continuity'}`, suffix: ' · INVALID', action: 'QUARANTINED' }
  if (segment?.continuity?.status === 'unknown') return { quarantined: false, label: `continuity unknown: ${segment.continuity?.reason || 'partial window'}`, suffix: ' · ?', action: '' }
  return { quarantined: false, label: 'continuity verified', suffix: '', action: '' }
}

/** @param {{viewportHeight?: number, feedPanesHidden?: boolean, segmentMin?: number, paneHeight?: number, rowGap?: number, verticalPadding?: number, blobspaceMin?: number}} [metrics] */
export function calculateSegmentRailBounds({
  viewportHeight,
  feedPanesHidden = false,
  segmentMin = 180,
  paneHeight = 0,
  rowGap = 0,
  verticalPadding = 0,
  blobspaceMin = 112,
} = {}) {
  const min = Number.isFinite(segmentMin) && segmentMin > 0 ? segmentMin : 180
  const fallbackMax = Math.max(560, Math.floor((Number(viewportHeight) || 0) * 0.82))
  if (feedPanesHidden || !Number.isFinite(paneHeight) || paneHeight <= 0) return { min, max: fallbackMax }
  const scannerMin = Number.isFinite(blobspaceMin) && blobspaceMin > 0 ? blobspaceMin : 112
  const gap = Number.isFinite(rowGap) && rowGap >= 0 ? rowGap : 0
  const padding = Number.isFinite(verticalPadding) && verticalPadding >= 0 ? verticalPadding : 0
  const max = Math.max(min, Math.floor(paneHeight - padding - gap - scannerMin))
  return { min, max, scannerMin, paneHeight, gap }
}

export function classifyPlaybackMode({ playbackIntent = 'replay', followIntent = false, liveEdgeKey = '', currentRecordKey = '' } = {}) {
  if (playbackIntent !== 'follow' || !followIntent) return 'replay'
  return liveEdgeKey && currentRecordKey === liveEdgeKey ? 'live' : 'catching-up'
}

export function playbackModeLabel(mode) {
  const labels = {
    idle: 'idle',
    waiting: 'waiting at live edge',
    buffering: 'buffering',
    'replay-buffering': 'buffering replay',
    'catching-up': 'catching up',
    live: 'live',
    replay: 'replay',
    paused: 'paused',
    interrupted: 'interrupted',
    ended: 'replay ended',
  }
  return labels[mode] || 'idle'
}

export function favoriteId(item) {
  return [item.type, String(item.chainId || ''), normalizeHex(item.stationAddress), normalizeHex(item.inboxAddress || ''), normalizeHex(item.publisher || ''), normalizeHex(item.streamIdHash || ''), item.streamId || ''].join(':')
}

export function normalizeFavoriteItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const type = ['station', 'channel', 'stream', 'inbox', 'inbox-channel', 'inbox-stream'].includes(item.type) ? item.type : ''
  const chainId = String(item.chainId || '')
  if (chainId.length > 78 || !/^(?:0|[1-9][0-9]*)$/.test(chainId)) return null
  const stationInput = String(item.stationAddress || '')
  const inboxInput = String(item.inboxAddress || '')
  const publisherInput = String(item.publisher || '')
  if ([stationInput, inboxInput, publisherInput].some((value) => value.length > MAX_FAVORITE_ADDRESS_INPUT)) return null
  const stationAddress = normalizeStationAddressInput(stationInput)
  const inboxAddress = normalizeStationAddressInput(inboxInput)
  const publisher = normalizeStationAddressInput(publisherInput)
  const streamId = String(item.streamId ?? '')
  if (streamId.length > IO_MAX_ABI_STRING_BYTES || new TextEncoder().encode(streamId).byteLength > IO_MAX_ABI_STRING_BYTES) return null
  const canonicalHash = streamId ? canonicalStreamIdHash(streamId) : ''
  const claimedHash = isBytes32Hex(item.streamIdHash) ? normalizeHex(item.streamIdHash) : ''
  if (claimedHash && claimedHash !== canonicalHash) return null
  const firstBlock = typeof item.firstBlock === 'number' ? item.firstBlock : NaN
  const latestBlock = typeof item.latestBlock === 'number' ? item.latestBlock : NaN
  const hasArchiveRange = Number.isSafeInteger(firstBlock) && firstBlock >= 0 && Number.isSafeInteger(latestBlock) && latestBlock >= firstBlock
  if (!type) return null
  if (type.startsWith('inbox')) {
    if (!inboxAddress || (type === 'inbox-channel' && !publisher) || (type === 'inbox-stream' && (!publisher || !streamId))) return null
  } else if (!stationAddress) return null
  if ((type === 'channel' && !publisher) || (type === 'stream' && (!publisher || !streamId))) return null
  const streamIdHash = canonicalHash
  return {
    id: favoriteId({ type, chainId, stationAddress, inboxAddress, publisher, streamId, streamIdHash }),
    type,
    chainId,
    stationAddress,
    inboxAddress,
    publisher,
    streamId,
    streamIdHash,
    firstBlock: hasArchiveRange ? firstBlock : null,
    latestBlock: hasArchiveRange ? latestBlock : null,
    label: String(item.label || '').trim().slice(0, 80),
    createdAt: typeof item.createdAt === 'string' && item.createdAt.length <= 64 && Number.isFinite(Date.parse(item.createdAt))
      ? new Date(item.createdAt).toISOString()
      : new Date().toISOString(),
  }
}

export function normalizeFavorites(value) {
  const byId = new Map()
  for (const item of Array.isArray(value) ? value.slice(0, MAX_FAVORITES) : []) {
    const favorite = normalizeFavoriteItem(item)
    if (favorite) byId.set(favorite.id, favorite)
  }
  return [...byId.values()]
}

function accessibleIdentityParts(item) {
  const parts = []
  if (item?.stationAddress) parts.push(`station ${normalizeHex(item.stationAddress)}`)
  if (item?.inboxAddress) parts.push(`inbox ${normalizeHex(item.inboxAddress)}`)
  if (item?.publisher) parts.push(`publisher ${normalizeHex(item.publisher)}`)
  if (item?.streamIdHash) parts.push(`stream ${normalizeHex(item.streamIdHash)}`)
  if (item?.chainId) parts.push(`chain ${String(item.chainId)}`)
  return parts.length ? parts : [String(item?.type || 'item').replaceAll('-', ' ')]
}

export function favoriteAccessibleName(item, label) {
  return `${String(label || 'Favorite')}; ${accessibleIdentityParts(item).join(', ')}`
}

export function archiveStreamAccessibleName(stream) {
  const title = String(stream?.title || 'Archived stream')
  const parts = []
  if (stream?.publisher) parts.push(`publisher ${normalizeHex(stream.publisher)}`)
  if (stream?.streamIdHash) parts.push(`stream ${normalizeHex(stream.streamIdHash)}`)
  else if (stream?.key) parts.push(`stream ${String(stream.key)}`)
  return `${title}; ${parts.join(', ') || 'unknown stream'}`
}

export function slotJumpAccessibleName(slot, sequence) {
  return `Jump to stream segment #${sequence} from slot ${slot}`
}

export function segmentActionAccessibleName({ sequence, quarantined = false, active = false, cached = false, queued = false }) {
  if (quarantined) return `Segment #${sequence} is quarantined`
  if (active) return `Current segment #${sequence}`
  if (cached) return `Play segment #${sequence}`
  if (queued) return `Fetching segment #${sequence}`
  return `Fetch segment #${sequence}`
}

export function archiveStreamKey(segment) {
  return channelIdentity(segment).key
}

export function clampCacheLimitMb(value, fallback = 512, { min = 16, max = 2048 } = {}) {
  const fallbackNumber = Number(fallback)
  const safeFallback = Number.isFinite(fallbackNumber) ? fallbackNumber : 512
  const number = Number(value)
  const selected = Number.isFinite(number) ? number : safeFallback
  return Math.min(max, Math.max(min, Math.round(selected)))
}

export function selectRecentSegmentsWithinByteBudget(segments, maxBytes) {
  if (!Array.isArray(segments)) throw new Error('Segment hydration window must be an array')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Segment hydration byte budget must be a positive safe integer')
  const ordered = [...segments].sort((left, right) =>
    left.sequence - right.sequence || left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex)
  const selected = []
  let totalBytes = 0
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const segment = ordered[index]
    if (!Number.isSafeInteger(segment?.payloadBytes) || segment.payloadBytes < 0) {
      throw new Error('Segment hydration payloadBytes must be a non-negative safe integer')
    }
    if (totalBytes + segment.payloadBytes > maxBytes) break
    totalBytes += segment.payloadBytes
    selected.push(segment)
  }
  return selected.reverse()
}

export function retainedVerifiedRecordKeys(records, { maxBytes, protectedKeys = [] }) {
  if (!Array.isArray(records)) throw new Error('Verified record window must be an array')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Verified record byte budget must be a positive safe integer')
  const protectedSet = new Set(protectedKeys.filter(Boolean))
  const retained = new Set()
  let totalBytes = 0
  for (const record of records) {
    if (!record?.cacheKey || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new Error('Verified record must have a cache key and non-negative safe byte length')
    }
    retained.add(record.cacheKey)
    totalBytes += record.bytes
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Verified record byte total exceeds JavaScript safe integer range')
  }
  const oldest = [...records].sort((left, right) =>
    String(left.verifiedAt || '').localeCompare(String(right.verifiedAt || '')) || left.sequence - right.sequence)
  for (const record of oldest) {
    if (totalBytes <= maxBytes) break
    if (protectedSet.has(record.cacheKey)) continue
    retained.delete(record.cacheKey)
    totalBytes -= record.bytes
  }
  return retained
}

export function createArchiveAccumulator({ maxSegments, maxStreams }) {
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 1) throw new Error('Archive maxSegments must be a positive safe integer')
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1) throw new Error('Archive maxStreams must be a positive safe integer')
  return { maxSegments, maxStreams, segmentCount: 0, streamKeys: new Set(), segments: [] }
}

export function appendArchiveSegments(accumulator, segments, { narrowingHint = 'Choose a later from-block or add a publisher/stream filter.' } = {}) {
  if (!accumulator || !Array.isArray(accumulator.segments) || !(accumulator.streamKeys instanceof Set)) {
    throw new Error('Archive accumulator is invalid')
  }
  if (!Array.isArray(segments)) throw new Error('Archive segment chunk must be an array')
  if (accumulator.segmentCount + segments.length > accumulator.maxSegments) {
    throw new Error(`Archive discovery exceeds the ${accumulator.maxSegments.toLocaleString()}-segment browser limit. ${narrowingHint}`)
  }
  const nextKeys = new Set(accumulator.streamKeys)
  for (const segment of segments) {
    const key = archiveStreamKey(segment)
    nextKeys.add(key)
    if (nextKeys.size > accumulator.maxStreams) {
      throw new Error(`Archive discovery exceeds the ${accumulator.maxStreams.toLocaleString()}-stream browser limit. ${narrowingHint}`)
    }
  }
  accumulator.streamKeys = nextKeys
  accumulator.segments.push(...segments)
  accumulator.segmentCount += segments.length
  return accumulator
}

export function incrementalStationRange({ anchorBlock, cursorBlock, headBlock, overlapBlocks, maxBlocks }) {
  const anchor = BigInt(anchorBlock)
  const cursor = BigInt(cursorBlock ?? anchorBlock)
  const head = BigInt(headBlock)
  const overlap = BigInt(overlapBlocks)
  const limit = BigInt(maxBlocks)
  if (anchor < 0n || cursor < anchor || head < 0n || overlap < 0n || limit < 1n) throw new Error('Invalid incremental Station range')
  if (anchor > head) return null
  const effectiveCursor = cursor > head + 1n ? head + 1n : cursor
  const fromBlock = effectiveCursor > anchor + overlap ? effectiveCursor - overlap : anchor
  const toBlock = fromBlock + limit - 1n < head ? fromBlock + limit - 1n : head
  return { fromBlock, toBlock, nextCursorBlock: toBlock + 1n, caughtUp: toBlock === head }
}

export function reconcileIncrementalStationSegments(retained, fresh, { replaceFromBlock, anchorOrder = 0n, maxSegments }) {
  if (!Array.isArray(retained) || !Array.isArray(fresh)) throw new Error('Station segment windows must be arrays')
  if (!Number.isSafeInteger(maxSegments) || maxSegments < 2) throw new Error('Station retained segment limit must be at least two')
  const replaceFrom = BigInt(replaceFromBlock)
  const minimumOrder = BigInt(anchorOrder)
  const byKey = new Map()
  for (const segment of retained) {
    if (BigInt(segment.blockNumber) < replaceFrom && segmentOrderForCore(segment) >= minimumOrder) byKey.set(segment.cacheKey, segment)
  }
  for (const segment of fresh) {
    if (segmentOrderForCore(segment) >= minimumOrder) byKey.set(segment.cacheKey, segment)
  }
  const ordered = [...byKey.values()].sort((a, b) =>
    a.sequence - b.sequence || a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex)
  // The first retained item is the continuity anchor for every later item. Once
  // the bounded window rolls, its already-validated status is trusted because
  // it is older than the reorg replacement boundary.
  const window = ordered.slice(-maxSegments)
  const priorBoundary = retained.find((segment) => segment.cacheKey === window[0]?.cacheKey)
  const annotated = annotateStreamContinuity(window)
  if (priorBoundary?.continuity?.status !== 'valid' || !annotated.length) return annotated
  annotated[0].continuity = priorBoundary.continuity
  annotated[0].quarantined = false
  for (let index = 1; index < annotated.length; index += 1) {
    const predecessor = annotated[index - 1]
    const segment = annotated[index]
    if (segment.channelKey !== predecessor.channelKey || segment.sequence !== predecessor.sequence + 1) continue
    if (predecessor.continuity.status === 'invalid') segment.continuity = { status: 'invalid', reason: 'invalid-ancestry', predecessorSequence: predecessor.sequence }
    else if (predecessor.continuity.status === 'unknown') segment.continuity = { status: 'unknown', reason: 'unknown-ancestry', predecessorSequence: predecessor.sequence }
    else if (!segment.previousSegmentHash) segment.continuity = { status: 'unknown', reason: 'missing-link-metadata', predecessorSequence: predecessor.sequence }
    else if (segment.previousSegmentHash !== predecessor.payloadSha256Hex) segment.continuity = { status: 'invalid', reason: 'predecessor-mismatch', predecessorSequence: predecessor.sequence, expectedHash: predecessor.payloadSha256Hex, actualHash: segment.previousSegmentHash }
    else segment.continuity = { status: 'valid', reason: 'matching-predecessor', predecessorSequence: predecessor.sequence }
    segment.quarantined = segment.continuity.status === 'invalid'
  }
  return annotated
}

function segmentOrderForCore(segment) {
  return BigInt(segment.blockNumber) * 1_000_000n + BigInt(segment.transactionIndex) * 1_000n + BigInt(segment.logIndex)
}

export function groupOldStreamsFromSegmentPublishedLogs(segments) {
  const groups = new Map()
  for (const segment of segments) {
    const key = archiveStreamKey(segment)
    const existing = groups.get(key) || {
      key,
      publisher: segment.publisher,
      streamIdHash: normalizeHex(segment.streamIdHash),
      streamId: segment.streamId,
      title: segment.streamId || shortCoreHash(segment.streamIdHash),
      segmentCount: 0,
      firstSequence: segment.sequence,
      latestSequence: segment.sequence,
      firstBlock: segment.blockNumber,
      latestBlock: segment.blockNumber,
    }
    existing.segmentCount += 1
    existing.firstSequence = Math.min(existing.firstSequence, segment.sequence)
    existing.latestSequence = Math.max(existing.latestSequence, segment.sequence)
    existing.firstBlock = Math.min(existing.firstBlock, segment.blockNumber)
    existing.latestBlock = Math.max(existing.latestBlock, segment.blockNumber)
    groups.set(key, existing)
  }
  return [...groups.values()].sort((a, b) => b.latestBlock - a.latestBlock || a.title.localeCompare(b.title))
}

function shortCoreHash(value) {
  const text = String(value || '')
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text
}

export function metadataScopeForConfig(config) {
  const chainPreset = String(config?.chainPreset || '')
  const identity = v1ScopedChannelIdentity(config)
  return {
    cacheKey: JSON.stringify(['segments-v2', identity.chainId, identity.stationAddress, identity.syntheticChannelId, identity.streamId]),
    chainPreset,
    chainId: identity.chainId,
    stationAddress: identity.stationAddress,
    publisher: identity.publisher,
    streamIdHash: identity.streamIdHash,
    streamId: identity.streamId,
    syntheticChannelId: identity.syntheticChannelId,
  }
}

function isCachedMetadataSegment(segment, scope) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
  let identity
  try { identity = channelIdentity(segment) } catch { return false }
  if (identity.streamId !== scope.streamId || identity.streamIdHash !== scope.streamIdHash || identity.publisher !== scope.publisher) return false
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(segment.publisher || '')) || !/^0x[0-9a-fA-F]{64}$/.test(String(segment.txHash || '')) || !/^0x[0-9a-fA-F]{64}$/.test(String(segment.blockHash || ''))) return false
  if (!/^[0-9a-fA-F]{64}$/.test(String(segment.payloadSha256 || '')) || !/^0x[0-9a-fA-F]{64}$/.test(String(segment.payloadSha256Hex || ''))) return false
  if (segment.chainId !== scope.chainId || segment.stationAddress !== scope.stationAddress || segment.syntheticChannelId !== scope.syntheticChannelId) return false
  if (segment.cacheKey !== scopedSegmentIdentityKey(segment)) return false
  for (const value of [segment.sequence, segment.blockNumber, segment.transactionIndex, segment.logIndex, segment.payloadBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) return false
  }
  if (segment.payloadBytes > 6 * 126_976) return false
  if (!Array.isArray(segment.blobVersionedHashes) || segment.blobVersionedHashes.length > 6) return false
  const hashes = segment.blobVersionedHashes.map(normalizeHex)
  return hashes.every(isBytes32Hex) && new Set(hashes).size === hashes.length
}

export function matchingCachedMetadata(record, scope) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  let segments
  try { segments = annotateStreamContinuity(Array.isArray(record.segments) ? record.segments : []) } catch { return null }
  if (record.cacheKey !== scope.cacheKey
    || record.chainPreset !== scope.chainPreset
    || record.chainId !== scope.chainId
    || String(record.stationAddress || '').toLowerCase() !== scope.stationAddress
    || record.publisher !== scope.publisher
    || record.streamIdHash !== scope.streamIdHash
    || record.streamId !== scope.streamId
    || record.syntheticChannelId !== scope.syntheticChannelId
    || !segments.length
    || segments.some((segment) => !isCachedMetadataSegment(segment, scope))) return null
  const updatedAtMs = Date.parse(record.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return null
  return { ...record, segments, updatedAt: new Date(updatedAtMs).toISOString() }
}
