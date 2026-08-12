import fs from 'node:fs'
import { readBoundedJsonFileSync } from './bounded-files.mjs'

export const MAX_SEGMENT_MANIFEST_BYTES = 8 * 1024 * 1024
export const MAX_SEGMENT_MANIFEST_ENTRIES = 10_000

export function readBoundedSegmentManifest(manifestPath) {
  try {
    return readBoundedJsonFileSync(manifestPath, {
      maxBytes: MAX_SEGMENT_MANIFEST_BYTES,
      label: `manifest ${manifestPath}`,
    })
  } catch (error) {
    if (error.cause instanceof SyntaxError) throw error.cause
    throw error
  }
}

export function segmentManifestEntries(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Manifest ${manifestPath} must be a JSON object`)
  }
  if (!Array.isArray(manifest.segments)) {
    throw new Error(`Manifest ${manifestPath} segments must be an array`)
  }
  if (manifest.segments.length > MAX_SEGMENT_MANIFEST_ENTRIES) {
    throw new Error(`Manifest ${manifestPath} exceeds ${MAX_SEGMENT_MANIFEST_ENTRIES} segment entries`)
  }
  assertUniqueSegmentSequences(manifest.segments, `Manifest ${manifestPath}`)
  return manifest.segments
}

export function serializeSegmentManifest(manifest, manifestPath) {
  segmentManifestEntries(manifest, manifestPath)
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_SEGMENT_MANIFEST_BYTES) {
    throw new Error(`Manifest ${manifestPath} exceeds ${MAX_SEGMENT_MANIFEST_BYTES} bytes`)
  }
  return serialized
}

export function segmentSequence(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const sequence = Number(value)
    if (Number.isSafeInteger(sequence)) return sequence
  }
  throw new Error(`${label}.sequence must be a non-negative integer`)
}

function normalizeSegment(segment, index) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    throw new Error(`segments[${index}] must be an object`)
  }
  return {
    ...segment,
    sequence: segmentSequence(segment.sequence, `segments[${index}]`),
  }
}

function assertUniqueSegmentSequences(segments, label) {
  const sequences = new Set()
  for (const [index, segment] of segments.entries()) {
    const normalized = normalizeSegment(segment, index)
    if (sequences.has(normalized.sequence)) {
      throw new Error(`${label} contains duplicate segment sequence ${normalized.sequence}`)
    }
    sequences.add(normalized.sequence)
  }
}

export function upsertSegment(segments, entry) {
  assertUniqueSegmentSequences(segments, 'Segment manifest')
  const normalizedEntry = normalizeSegment(entry, 'new segment')
  let replaced = false
  const next = segments.map((segment, index) => {
    const normalized = normalizeSegment(segment, index)
    if (normalized.sequence !== normalizedEntry.sequence) return normalized
    replaced = true
    return normalizedEntry
  })
  if (!replaced) {
    if (next.length >= MAX_SEGMENT_MANIFEST_ENTRIES) {
      throw new Error(`Segment manifest exceeds ${MAX_SEGMENT_MANIFEST_ENTRIES} segment entries`)
    }
    next.push(normalizedEntry)
  }
  return next.sort((a, b) => a.sequence - b.sequence)
}

function invariantValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return JSON.stringify(value) ?? String(value)
}

export function assertLiveSegmentManifestInvariants(manifest, manifestPath, invariants = {}) {
  for (const [name, expected] of Object.entries(invariants)) {
    if (Object.is(manifest[name], expected)) continue
    throw new Error(
      `Invalid live segment manifest ${manifestPath}: ${name} ${invariantValue(manifest[name])} does not match requested ${invariantValue(expected)}; use --reset or a new stream id`,
    )
  }
}

export function readExistingSegmentManifest(manifestPath, { streamId, filePrefix, invariants = {} }) {
  if (!fs.existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = readBoundedSegmentManifest(manifestPath)
  } catch (error) {
    throw new Error(`Unreadable live segment manifest ${manifestPath}: ${error.message}`, { cause: error })
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid live segment manifest ${manifestPath}: expected an object`)
  }
  if (manifest.streamId !== undefined && manifest.streamId !== streamId) {
    throw new Error(`Invalid live segment manifest ${manifestPath}: streamId ${manifest.streamId} does not match ${streamId}`)
  }
  if (manifest.filePrefix !== undefined && manifest.filePrefix !== filePrefix) {
    throw new Error(`Invalid live segment manifest ${manifestPath}: filePrefix ${manifest.filePrefix} does not match ${filePrefix}`)
  }
  if (manifest.segments !== undefined && !Array.isArray(manifest.segments)) {
    throw new Error(`Invalid live segment manifest ${manifestPath}: segments must be an array`)
  }
  const segments = manifest.segments === undefined
    ? []
    : segmentManifestEntries(manifest, manifestPath)
      .map((segment, index) => normalizeSegment(segment, index))
  if (segments.length > MAX_SEGMENT_MANIFEST_ENTRIES) {
    throw new Error(`Invalid live segment manifest ${manifestPath}: exceeds ${MAX_SEGMENT_MANIFEST_ENTRIES} segment entries`)
  }
  assertLiveSegmentManifestInvariants(manifest, manifestPath, invariants)
  return { ...manifest, segments }
}
