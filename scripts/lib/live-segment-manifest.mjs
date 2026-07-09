import fs from 'node:fs'

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

export function upsertSegment(segments, entry) {
  const normalizedEntry = normalizeSegment(entry, 'new segment')
  return [
    ...segments.filter((segment, index) => normalizeSegment(segment, index).sequence !== normalizedEntry.sequence),
    normalizedEntry,
  ].sort((a, b) => a.sequence - b.sequence)
}

export function readExistingSegmentManifest(manifestPath, { streamId, filePrefix }) {
  if (!fs.existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Unreadable live segment manifest ${manifestPath}: ${error.message}`)
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
    : manifest.segments.map((segment, index) => normalizeSegment(segment, index))
  return { ...manifest, segments }
}
