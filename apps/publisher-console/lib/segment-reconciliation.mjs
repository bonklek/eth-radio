import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const hash64 = /^[0-9a-f]{64}$/i

export function sourceIdentity(filePath) {
  const resolved = path.resolve(filePath)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('media source must be a regular non-symlink file')
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(resolved, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!read) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const after = fs.lstatSync(resolved)
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || Math.trunc(after.mtimeMs) !== Math.trunc(stat.mtimeMs)) {
    throw new Error('media source changed while its identity was being measured')
  }
  return {
    path: resolved,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
    sha256: hash.digest('hex'),
  }
}

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function reconcileSegmentResume({
  manifest,
  segmentDir,
  startSequence,
  mode,
  confirmedCount = 0,
  expectedSourceIdentity = null,
}) {
  if (!['finite', 'live'].includes(mode)) throw new Error('segment reconciliation mode is invalid')
  if (!Number.isSafeInteger(startSequence) || startSequence < 0) throw new Error('segment reconciliation startSequence is invalid')
  if (!Number.isSafeInteger(confirmedCount) || confirmedCount < 0 || confirmedCount > manifest.segments.length) {
    throw new Error('publisher confirmed count is inconsistent with the segment manifest')
  }
  if (expectedSourceIdentity && JSON.stringify(manifest.sourceIdentity) !== JSON.stringify(expectedSourceIdentity)) {
    throw new Error('media source identity changed since segment production began')
  }

  const directory = path.resolve(segmentDir)
  const expectedFiles = new Set()
  let priorCaptureIndex = -1
  for (const [index, segment] of manifest.segments.entries()) {
    const expectedSequence = startSequence + index
    if (segment.sequence !== expectedSequence) throw new Error(`segment resume sequence gap or reorder at index ${index}`)
    if (mode === 'finite' && segment.mediaIndex !== index) throw new Error(`segment resume media index gap or reorder at index ${index}`)
    if (mode === 'live') {
      if (!Number.isSafeInteger(segment.captureIndex) || segment.captureIndex <= priorCaptureIndex) {
        throw new Error(`live capture index duplicate or reorder at index ${index}`)
      }
      priorCaptureIndex = segment.captureIndex
    }
    const file = path.resolve(segment.file)
    expectedFiles.add(file.toLowerCase())
    if (!fs.existsSync(file)) {
      if (index < confirmedCount) continue
      throw new Error(`unconfirmed segment file is missing at index ${index}`)
    }
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`segment file is not a regular non-symlink file at index ${index}`)
    if (stat.size !== segment.bytes) throw new Error(`segment byte length changed at index ${index}`)
    if (!hash64.test(segment.payloadSha256) || digest(file) !== segment.payloadSha256.toLowerCase()) {
      throw new Error(`segment payload digest changed at index ${index}`)
    }
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (/\.tmp(?:$|\.)|\.part\.webm$/i.test(entry.name)) throw new Error(`partial segment artifact requires operator recovery: ${entry.name}`)
    if (/\.webm$/i.test(entry.name) && !expectedFiles.has(file.toLowerCase())) {
      throw new Error(`untracked segment file requires operator recovery: ${entry.name}`)
    }
  }
  if (mode === 'live' && manifest.nextCaptureIndex <= priorCaptureIndex) {
    throw new Error('live nextCaptureIndex does not advance beyond retained capture indices')
  }
  return { nextSequence: startSequence + manifest.segments.length, retainedCount: manifest.segments.length }
}
