import { isBytes32Hex, normalizeHex } from './static-client-core.js'
import { concatBytes, hexToBytes, isBlobHex, isBytes48Hex } from './static-client-io.js'

const MAX_BLOBS_PER_BLOCK = 21
const MAX_SEGMENT_BLOBS = 6
const BLOB_DATA_BYTES = 126_976
const MAX_SEGMENT_PAYLOAD_BYTES = MAX_SEGMENT_BLOBS * BLOB_DATA_BYTES

function nonNegativeSafeInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return number
}

export function sidecarIndex(value, label) {
  const index = nonNegativeSafeInteger(value, label)
  if (index >= MAX_BLOBS_PER_BLOCK) throw new Error(`${label} must be an integer from 0 to ${MAX_BLOBS_PER_BLOCK - 1}`)
  return index
}

export function normalizeSidecarRecord(record, expectedSlot) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  let slot
  try {
    slot = nonNegativeSafeInteger(record.slot, 'cached sidecar slot')
    if (slot !== nonNegativeSafeInteger(expectedSlot, 'expected sidecar slot')) return null
  } catch { return null }
  if (!Array.isArray(record.sidecars) || record.sidecars.length > MAX_BLOBS_PER_BLOCK) return null
  const sidecars = []
  const indices = new Set()
  const hashes = new Set()
  for (const sidecar of record.sidecars) {
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) return null
    let index
    try { index = sidecarIndex(sidecar.index, 'cached sidecar index') } catch { return null }
    if (!isBytes32Hex(sidecar.versionedHash)) return null
    const versionedHash = normalizeHex(sidecar.versionedHash)
    if (indices.has(index) || hashes.has(versionedHash)) return null
    if (!isBytes48Hex(sidecar.commitment) || !isBlobHex(sidecar.blob)) return null
    indices.add(index)
    hashes.add(versionedHash)
    sidecars.push({ index, versionedHash, commitment: sidecar.commitment, blob: sidecar.blob })
  }
  return { ...record, slot, sidecars }
}

export function segmentBlobHashes(segment) {
  if (!Array.isArray(segment?.blobVersionedHashes) || segment.blobVersionedHashes.length > MAX_SEGMENT_BLOBS) {
    throw new Error(`Invalid segment blob hashes: expected at most ${MAX_SEGMENT_BLOBS}`)
  }
  const hashes = segment.blobVersionedHashes.map(normalizeHex)
  if (hashes.some((hash) => !isBytes32Hex(hash)) || new Set(hashes).size !== hashes.length) {
    throw new Error('Invalid segment blob hashes: values must be unique bytes32 hex')
  }
  return hashes
}

export function segmentPayloadLength(segment) {
  const bytes = segment?.payloadBytes
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SEGMENT_PAYLOAD_BYTES) {
    throw new Error(`Invalid segment payloadBytes: expected 0-${MAX_SEGMENT_PAYLOAD_BYTES}`)
  }
  return bytes
}

export async function reconstructPayload(segment, sidecars) {
  if (!Array.isArray(sidecars?.matches)) throw new Error('Invalid sidecar response: matches must be an array')
  if (sidecars.matches.length > MAX_SEGMENT_BLOBS) throw new Error(`Invalid sidecar response: matches exceed ${MAX_SEGMENT_BLOBS}`)
  const payloadBytes = segmentPayloadLength(segment)
  const wantedHashes = segmentBlobHashes(segment)
  const byHash = new Map()
  const indices = new Set()
  for (const [position, match] of sidecars.matches.entries()) {
    const index = Number(match?.index)
    if (!match || typeof match !== 'object' || Array.isArray(match) || !Number.isSafeInteger(index)
      || index < 0 || index >= MAX_BLOBS_PER_BLOCK || !isBytes32Hex(match.versionedHash) || !isBlobHex(match.blob)) {
      throw new Error(`Invalid sidecar match at index ${position}`)
    }
    const hash = normalizeHex(match.versionedHash)
    if (indices.has(index)) throw new Error(`Duplicate sidecar index ${index}`)
    if (byHash.has(hash)) throw new Error(`Duplicate sidecar hash ${hash.slice(0, 10)}...${hash.slice(-6)}`)
    indices.add(index)
    byHash.set(hash, match.blob)
  }
  const chunks = []
  let decodedLength = 0
  for (const hash of wantedHashes) {
    const blob = byHash.get(hash)
    if (!blob) throw new Error(`Missing sidecar ${hash.slice(0, 10)}...${hash.slice(-6)}`)
    const bytes = hexToBytes(blob)
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const field = bytes.subarray(offset, offset + 32)
      if (field[0] !== 0) throw new Error(`Invalid blob field element at ${offset}`)
      chunks.push(field.subarray(1))
      decodedLength += field.length - 1
    }
  }
  if (decodedLength < payloadBytes) throw new Error(`Blob payload is truncated: expected ${payloadBytes} bytes, decoded ${decodedLength}`)
  return concatBytes(chunks, decodedLength).subarray(0, payloadBytes)
}

export function archiveUrl(template, segment) {
  return template
    .replaceAll('{streamId}', encodeURIComponent(segment.streamId))
    .replaceAll('{sequence}', encodeURIComponent(String(segment.sequence)))
    .replaceAll('{txHash}', encodeURIComponent(segment.txHash))
    .replaceAll('{payloadSha256}', encodeURIComponent(segment.payloadSha256))
}
