import {
  ASSET_ROLES,
  MAX_ASSET_ROLES,
  MAX_BLOBS_PER_SEGMENT,
  MAX_MANIFEST_SEGMENTS,
  MAX_TEXT_BYTES,
  OVERLAY_STATUSES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  UINT32_MAX,
  UINT64_MAX,
} from './constants.mjs'
import {
  boundedList,
  boundedText,
  bytes32,
  decimalString,
  optionalBytes32,
  optionalDecimalString,
  record,
} from './scalars.mjs'

function overlay(input, label) {
  const hasBoolean = Object.hasOwn(input, 'overlayBurnedIn')
  const burned = hasBoolean ? input.overlayBurnedIn : undefined
  if (hasBoolean && typeof burned !== 'boolean') {
    throw new TypeError(`${label}.overlayBurnedIn must be a boolean when present`)
  }
  let status = input.overlayStatus
  if (status === undefined) status = hasBoolean ? (burned ? 'known-present' : 'known-absent') : 'unknown'
  if (!OVERLAY_STATUSES.includes(status)) {
    throw new TypeError(`${label}.overlayStatus is not supported`)
  }
  if (status === 'unknown' && hasBoolean) {
    throw new TypeError(`${label} cannot combine unknown overlay status with a boolean attestation`)
  }
  if (status === 'known-present' && burned !== true) {
    throw new TypeError(`${label}.overlayBurnedIn must be true for known-present status`)
  }
  if (status === 'known-absent' && burned !== false) {
    throw new TypeError(`${label}.overlayBurnedIn must be false for known-absent status`)
  }
  return status === 'unknown'
    ? { overlayStatus: status }
    : { overlayBurnedIn: burned, overlayStatus: status }
}

function protocolHeader(input, schema) {
  if (input.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (input.schema !== schema) throw new TypeError(`schema must be ${schema}`)
  if (input.version !== PROTOCOL_VERSION) throw new TypeError(`version must be ${PROTOCOL_VERSION}`)
}

function inclusion(input, label) {
  const value = record(input, label)
  return {
    txHash: bytes32(value.txHash, `${label}.txHash`),
    blockNumber: decimalString(value.blockNumber, `${label}.blockNumber`, { maximum: UINT64_MAX }),
    blockHash: bytes32(value.blockHash, `${label}.blockHash`),
    transactionIndex: decimalString(value.transactionIndex, `${label}.transactionIndex`, { maximum: UINT32_MAX }),
  }
}

export function normalizeSegmentRecordV2(input, label = 'segment') {
  const value = record(input, label)
  const hashes = boundedList(value.blobVersionedHashes, `${label}.blobVersionedHashes`, {
    minimum: 1,
    maximum: MAX_BLOBS_PER_SEGMENT,
  }).map((hash, index) => bytes32(hash, `${label}.blobVersionedHashes[${index}]`))
  /** @type {Record<string, any>} */
  const normalized = {
    sequence: decimalString(value.sequence, `${label}.sequence`, { maximum: UINT32_MAX }),
    durationMs: decimalString(value.durationMs, `${label}.durationMs`, { maximum: UINT64_MAX }),
    payloadBytes: decimalString(value.payloadBytes, `${label}.payloadBytes`, { maximum: UINT32_MAX }),
    payloadSha256: bytes32(value.payloadSha256, `${label}.payloadSha256`),
    previousSegmentHash: bytes32(value.previousSegmentHash, `${label}.previousSegmentHash`),
    blobVersionedHashes: hashes,
    ...overlay(value, label),
  }
  if (value.inclusion !== undefined) normalized.inclusion = inclusion(value.inclusion, `${label}.inclusion`)
  if (value.witness !== undefined) {
    const witness = record(value.witness, `${label}.witness`)
    if (!['fresh', 'delayed', 'stale', 'unavailable'].includes(witness.quality)) {
      throw new TypeError(`${label}.witness.quality is not supported`)
    }
    normalized.witness = {
      quality: witness.quality,
      blockNumber: optionalDecimalString(witness.blockNumber, `${label}.witness.blockNumber`, { maximum: UINT64_MAX }),
      blockHash: optionalBytes32(witness.blockHash, `${label}.witness.blockHash`),
      sampledAt: witness.sampledAt === undefined
        ? undefined
        : boundedText(witness.sampledAt, `${label}.witness.sampledAt`, { maxBytes: 64 }),
    }
  }
  return normalized
}

export function normalizeAssetManifestV2(input) {
  const value = record(input, 'asset manifest')
  protocolHeader(value, 'asset-manifest')
  const availability = record(value.availability, 'asset manifest.availability')
  const roles = boundedList(value.roles, 'asset manifest.roles', { maximum: MAX_ASSET_ROLES })
    .map((role, index) => boundedText(role, `asset manifest.roles[${index}]`, { maxBytes: 64 }))
  if (new Set(roles).size !== roles.length) throw new TypeError('asset manifest.roles must not contain duplicates')
  /** @type {Record<string, any>} */
  const normalized = {
    protocol: PROTOCOL_NAME,
    schema: 'asset-manifest',
    version: PROTOCOL_VERSION,
    assetId: bytes32(value.assetId, 'asset manifest.assetId'),
    manifestRoot: bytes32(value.manifestRoot, 'asset manifest.manifestRoot'),
    codec: boundedText(value.codec, 'asset manifest.codec', { maxBytes: 64 }),
    profile: boundedText(value.profile, 'asset manifest.profile', { maxBytes: 64 }),
    totalDurationMs: decimalString(value.totalDurationMs, 'asset manifest.totalDurationMs', { maximum: UINT64_MAX }),
    ...overlay(value, 'asset manifest'),
    availability: {
      network: boundedText(availability.network, 'asset manifest.availability.network', { maxBytes: 64 }),
      publishedAtBlock: decimalString(availability.publishedAtBlock, 'asset manifest.availability.publishedAtBlock', { maximum: UINT64_MAX }),
      publishedAtSlot: decimalString(availability.publishedAtSlot, 'asset manifest.availability.publishedAtSlot', { maximum: UINT64_MAX }),
      minimumAvailableUntilSlot: decimalString(availability.minimumAvailableUntilSlot, 'asset manifest.availability.minimumAvailableUntilSlot', { maximum: UINT64_MAX }),
      lastRefreshedAtBlock: optionalDecimalString(availability.lastRefreshedAtBlock, 'asset manifest.availability.lastRefreshedAtBlock', { maximum: UINT64_MAX }),
    },
    roles,
    segments: boundedList(value.segments, 'asset manifest.segments', { maximum: MAX_MANIFEST_SEGMENTS })
      .map((segment, index) => normalizeSegmentRecordV2(segment, `asset manifest.segments[${index}]`)),
  }
  for (const role of roles) {
    if (!ASSET_ROLES.includes(role)) normalized.hasUnknownRoles = true
  }
  const metadata = value.metadata
  if (metadata !== undefined) {
    let serialized
    try {
      serialized = JSON.stringify(metadata)
    } catch {
      throw new TypeError('asset manifest.metadata must be JSON-serializable')
    }
    if (serialized === undefined || new TextEncoder().encode(serialized).length > MAX_TEXT_BYTES) {
      throw new TypeError(`asset manifest.metadata must serialize within ${MAX_TEXT_BYTES} UTF-8 bytes`)
    }
    normalized.metadata = metadata
  }
  return normalized
}
