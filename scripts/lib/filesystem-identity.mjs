import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { forEachBoundedLineSync, readBoundedJsonFileSync, sha256FileSync } from './bounded-files.mjs'
import { readDirectoryBoundedSync } from './bounded-directory.mjs'

const HASH_BYTES = 32
const IDENTITY_VERSION = 1
export const MAX_IDENTITY_JSON_BYTES = 16 * 1024 * 1024
export const MAX_LATENCY_LOG_BYTES = 8 * 1024 * 1024
const MAX_IDENTITY_DIRECTORY_ENTRIES = 50_000

function requiredText(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`)
  return value
}

function readablePrefix(value) {
  const prefix = String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48)
  return prefix || 'stream'
}

function stableHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, HASH_BYTES * 2)
}

function normalizedScope({ chain = '', station = '', publisher = '', streamId }) {
  return {
    chain: String(chain || 'unspecified-chain').toLowerCase(),
    station: String(station || 'unspecified-station').toLowerCase(),
    publisher: String(publisher || 'all-publishers').toLowerCase(),
    streamId: requiredText(streamId, 'streamId'),
  }
}

export function legacyFilesystemKey(streamId) {
  let key = String(streamId || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
  if (!key || key === '.' || key === '..') key = 'stream'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key)) key = `_${key}`
  return key
}

export function streamFilesystemIdentity(streamId) {
  const rawStreamId = requiredText(streamId, 'streamId')
  const scope = { streamId: rawStreamId }
  return {
    version: IDENTITY_VERSION,
    kind: 'stream',
    key: `${readablePrefix(rawStreamId)}--${stableHash(JSON.stringify(scope))}`,
    scope,
  }
}

export function scopedStreamFilesystemIdentity(scopeInput) {
  const scope = normalizedScope(scopeInput)
  return {
    version: IDENTITY_VERSION,
    kind: 'scoped-stream',
    key: `${readablePrefix(scope.streamId)}--${stableHash(JSON.stringify(scope))}`,
    scope,
  }
}

export function withFilesystemIdentity(record, identity) {
  return { ...record, filesystemIdentity: identity }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(tempPath, filePath)
    let directoryDescriptor
    try {
      directoryDescriptor = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(directoryDescriptor)
    } catch {
      // Some platforms do not permit directory descriptors.
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.rmSync(tempPath, { force: true })
    } catch (error) {
      void error
    }
  }
}

function containedChild(root, basename, description) {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, basename)
  if (path.dirname(candidate) !== resolvedRoot || path.basename(candidate) !== basename) {
    throw new Error(`${description} escapes its filesystem root`)
  }
  return candidate
}

function requirePlainDirectory(directory, description) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a plain directory`)
  }
}

function requirePlainFile(filePath, description) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a plain file`)
  }
}

function readJson(filePath, description) {
  return readBoundedJsonFileSync(filePath, {
    maxBytes: MAX_IDENTITY_JSON_BYTES,
    label: `${description} ${filePath}`,
  })
}

function assertRecordIdentity(record, { streamId, identity, description, allowLegacy = false }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`Invalid ${description}: expected an object`)
  if (record.streamId !== streamId) {
    throw new Error(`Invalid ${description}: streamId ${record.streamId || '(missing)'} does not match ${streamId}`)
  }
  if (!record.filesystemIdentity) {
    if (allowLegacy) return
    throw new Error(`Invalid ${description}: filesystemIdentity is missing`)
  }
  if (record.filesystemIdentity.key !== identity.key
    || JSON.stringify(record.filesystemIdentity.scope) !== JSON.stringify(identity.scope)) {
    throw new Error(`Invalid ${description}: filesystem identity does not match the requested stream scope`)
  }
}

export function resolveScopedJsonPath({
  explicitPath,
  targetPath,
  legacyPath,
  streamId,
  identity,
  description,
  companionSuffixes = [],
}) {
  if (explicitPath) return path.resolve(explicitPath)
  const targetExists = fs.existsSync(targetPath)
  const legacyExists = legacyPath !== targetPath && fs.existsSync(legacyPath)
  if (targetExists) {
    const target = readJson(targetPath, description)
    assertRecordIdentity(target, { streamId, identity, description })
    if (legacyExists) {
      const legacy = readJson(legacyPath, `legacy ${description}`)
      assertRecordIdentity(legacy, { streamId, identity, description: `legacy ${description}`, allowLegacy: true })
      throw new Error(`Both scoped and legacy ${description} exist; refusing to mix or discard either file`)
    }
    return targetPath
  }
  if (!legacyExists) return targetPath

  const legacy = readJson(legacyPath, `legacy ${description}`)
  assertRecordIdentity(legacy, { streamId, identity, description: `legacy ${description}`, allowLegacy: true })
  for (const suffix of companionSuffixes) {
    if (fs.existsSync(`${targetPath}${suffix}`)) throw new Error(`Scoped ${description} companion already exists: ${targetPath}${suffix}`)
  }
  atomicWriteJson(targetPath, withFilesystemIdentity(legacy, identity))
  for (const suffix of companionSuffixes) {
    const legacyCompanion = `${legacyPath}${suffix}`
    if (fs.existsSync(legacyCompanion)) fs.renameSync(legacyCompanion, `${targetPath}${suffix}`)
  }
  fs.rmSync(legacyPath)
  return targetPath
}

function segmentSequence(value, description) {
  const sequence = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`${description} sequence must be a non-negative integer`)
  return sequence
}

function verifySegmentManifest(manifestPath, manifest, { streamId, filePrefix, identity, allowLegacy }) {
  assertRecordIdentity(manifest, {
    streamId,
    identity,
    description: `segment manifest ${manifestPath}`,
    allowLegacy,
  })
  if (manifest.filePrefix !== filePrefix) throw new Error(`Invalid segment manifest ${manifestPath}: filePrefix does not match ${filePrefix}`)
  if (!Array.isArray(manifest.segments)) throw new Error(`Invalid segment manifest ${manifestPath}: segments must be an array`)
  const directory = path.dirname(manifestPath)
  return manifest.segments.map((segment, index) => {
    const sequence = segmentSequence(segment?.sequence, `segment manifest ${manifestPath} segment ${index}`)
    const expectedName = `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`
    const fileValue = String(segment.file || '')
    const filePath = path.isAbsolute(fileValue) ? path.resolve(fileValue) : path.resolve(directory, fileValue)
    if (path.dirname(filePath) !== path.resolve(directory) || path.basename(filePath) !== expectedName) {
      throw new Error(`Invalid segment manifest ${manifestPath}: entry ${index} points outside the watched segment file; expected ${expectedName}`)
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Missing segment output ${filePath}`)
    const actualBytes = fs.statSync(filePath).size
    if (segment.bytes !== undefined) {
      const declaredBytes = typeof segment.bytes === 'number'
        ? segment.bytes
        : typeof segment.bytes === 'string' && /^\d+$/.test(segment.bytes)
          ? Number(segment.bytes)
          : Number.NaN
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error(`Manifest segment ${sequence} bytes must be a non-negative integer`)
      }
      if (declaredBytes !== actualBytes) throw new Error(`Segment output size mismatch: ${filePath}`)
    }
    const payloadSha256 = sha256FileSync(filePath, { label: `segment output ${filePath}` })
    const expectedHash = String(segment.payloadSha256 || '').replace(/^0x/, '').toLowerCase()
    if (expectedHash && expectedHash !== payloadSha256) throw new Error(`Segment output SHA-256 mismatch: ${filePath}`)
    return { ...segment, sequence, file: filePath, bytes: actualBytes, payloadSha256 }
  })
}

function legacySegmentFiles(directory, legacyPrefix) {
  if (!fs.existsSync(directory)) return []
  const escaped = legacyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}-\\d+\\.webm$`)
  return readDirectoryBoundedSync(directory, {
    maxEntries: MAX_IDENTITY_DIRECTORY_ENTRIES,
    label: `legacy segment directory ${directory}`,
  }).entries.filter((name) => pattern.test(name))
}

export function resolveSegmentSet({
  directory,
  streamId,
  migrate = true,
  allowUnmanifestedSafeLegacy = false,
  allowInvalidSafeLegacyManifest = false,
}) {
  const identity = streamFilesystemIdentity(streamId)
  const filePrefix = identity.key
  const legacyPrefix = legacyFilesystemKey(streamId)
  const manifestPath = path.join(directory, `${filePrefix}.segments.json`)
  const legacyManifestPath = path.join(directory, `${legacyPrefix}.segments.json`)
  const targetExists = fs.existsSync(manifestPath)
  const legacyExists = legacyManifestPath !== manifestPath && fs.existsSync(legacyManifestPath)

  if (targetExists) {
    const manifest = readJson(manifestPath, 'segment manifest')
    const segments = verifySegmentManifest(manifestPath, manifest, { streamId, filePrefix, identity, allowLegacy: false })
    if (legacyExists) throw new Error('Both scoped and legacy segment manifests exist; refusing to mix segment sets')
    return { identity, filePrefix, manifestPath, manifest: { ...manifest, segments }, migrated: false }
  }

  if (!legacyExists) {
    const looseLegacy = legacySegmentFiles(directory, legacyPrefix)
    if (looseLegacy.length) {
      if (allowUnmanifestedSafeLegacy && streamId === legacyPrefix) {
        return { identity, filePrefix: legacyPrefix, manifestPath: legacyManifestPath, manifest: null, migrated: false, legacy: true }
      }
      throw new Error('Legacy segment files exist without an identity-bearing manifest; refusing ambiguous reuse')
    }
    return { identity, filePrefix, manifestPath, manifest: null, migrated: false }
  }

  let legacyManifest
  let segments
  try {
    legacyManifest = readJson(legacyManifestPath, 'legacy segment manifest')
    segments = verifySegmentManifest(legacyManifestPath, legacyManifest, {
      streamId,
      filePrefix: legacyPrefix,
      identity,
      allowLegacy: true,
    })
  } catch (error) {
    if (allowInvalidSafeLegacyManifest && streamId === legacyPrefix) {
      return { identity, filePrefix: legacyPrefix, manifestPath: legacyManifestPath, manifest: null, migrated: false, legacy: true }
    }
    throw error
  }
  if (!migrate) {
    return { identity, filePrefix: legacyPrefix, manifestPath: legacyManifestPath, manifest: { ...legacyManifest, segments }, migrated: false, legacy: true }
  }

  const migratedSegments = segments.map((segment) => {
    const targetFile = path.join(directory, `${filePrefix}-${String(segment.sequence).padStart(6, '0')}.webm`)
    if (fs.existsSync(targetFile)) {
      if (sha256FileSync(targetFile, { label: `scoped segment output ${targetFile}` }) !== segment.payloadSha256) {
        throw new Error(`Scoped segment output conflicts with legacy output: ${targetFile}`)
      }
      fs.rmSync(segment.file)
    } else {
      fs.renameSync(segment.file, targetFile)
    }
    return { ...segment, file: targetFile }
  })
  const manifest = withFilesystemIdentity({
    ...legacyManifest,
    filePrefix,
    segments: migratedSegments,
    migratedFromFilePrefix: legacyPrefix,
  }, identity)
  atomicWriteJson(manifestPath, manifest)
  fs.rmSync(legacyManifestPath)
  return { identity, filePrefix, manifestPath, manifest, migrated: true }
}

function identityEvidence(runDir, streamId) {
  const candidates = [
    path.join(runDir, 'status.json'),
    path.join(runDir, 'publish-state.json'),
  ]
  const segmentDir = path.join(runDir, 'segments')
  if (fs.existsSync(segmentDir)) {
    candidates.push(...readDirectoryBoundedSync(segmentDir, {
      maxEntries: MAX_IDENTITY_DIRECTORY_ENTRIES,
      label: `run segment directory ${segmentDir}`,
    }).entries
      .filter((name) => name.endsWith('.segments.json'))
      .map((name) => path.join(segmentDir, name)))
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const record = readJson(candidate, 'run identity evidence')
    if (record.streamId !== streamId) throw new Error(`Legacy run directory belongs to stream ${record.streamId || '(missing)'}, not ${streamId}`)
    return true
  }
  const latencyPaths = [
    path.join(runDir, 'logs', 'latency-monitor.jsonl.1'),
    path.join(runDir, 'logs', 'latency-monitor.jsonl'),
  ].filter((candidate) => fs.existsSync(candidate))
  if (latencyPaths.length) {
    let records = 0
    for (const latencyPath of latencyPaths) {
      forEachBoundedLineSync(latencyPath, (line, lineNumber) => {
        if (!line) return
        let record
        try {
          record = JSON.parse(line)
        } catch (error) {
          throw new Error(`Invalid monitor log ${latencyPath} line ${lineNumber}: ${error.message}`, { cause: error })
        }
        records += 1
        if (record.streamId !== streamId) throw new Error(`Legacy monitor log belongs to stream ${record.streamId || '(missing)'}, not ${streamId}`)
      }, {
        maxBytes: MAX_LATENCY_LOG_BYTES,
        label: `legacy monitor log ${latencyPath}`,
      })
    }
    return records > 0
  }
  return false
}

export function resolveRunDirectory({ baseDir, streamId, identity, migrate = true }) {
  const resolvedBaseDir = path.resolve(baseDir)
  const targetDir = containedChild(resolvedBaseDir, identity.key, 'Scoped run directory')
  const legacyDir = containedChild(resolvedBaseDir, legacyFilesystemKey(streamId), 'Legacy run directory')
  const markerName = '.stream-identity.json'
  const targetExists = fs.existsSync(targetDir)
  const legacyExists = legacyDir !== targetDir && fs.existsSync(legacyDir)
  if (targetExists) {
    requirePlainDirectory(targetDir, 'Existing scoped run directory')
    const markerPath = path.join(targetDir, markerName)
    if (fs.existsSync(markerPath)) {
      requirePlainFile(markerPath, 'Run identity marker')
      const marker = readJson(markerPath, 'run identity marker')
      if (marker.key !== identity.key || JSON.stringify(marker.scope) !== JSON.stringify(identity.scope)) {
        throw new Error('Run directory identity marker does not match the requested stream scope')
      }
    } else {
      const entries = readDirectoryBoundedSync(targetDir, {
        maxEntries: MAX_IDENTITY_DIRECTORY_ENTRIES,
        label: `scoped run directory ${targetDir}`,
      }).entries
      if (entries.length) throw new Error('Existing scoped run directory has no identity marker and is not empty')
      atomicWriteJson(markerPath, identity)
    }
    if (legacyExists) throw new Error('Both scoped and legacy run directories exist; refusing to mix run state')
    return targetDir
  }
  if (legacyExists) {
    requirePlainDirectory(legacyDir, 'Legacy run directory')
    if (!identityEvidence(legacyDir, streamId)) throw new Error('Legacy run directory has no verifiable stream identity')
    if (!migrate) return legacyDir
    const legacyMarkerPath = path.join(legacyDir, markerName)
    if (fs.existsSync(legacyMarkerPath)) {
      requirePlainFile(legacyMarkerPath, 'Legacy run identity marker')
      const marker = readJson(legacyMarkerPath, 'legacy run identity marker')
      if (marker.key !== identity.key || JSON.stringify(marker.scope) !== JSON.stringify(identity.scope)) {
        throw new Error('Legacy run identity marker does not match the requested stream scope')
      }
    } else {
      atomicWriteJson(legacyMarkerPath, identity)
    }
    fs.mkdirSync(resolvedBaseDir, { recursive: true })
    fs.renameSync(legacyDir, targetDir)
  } else {
    fs.mkdirSync(resolvedBaseDir, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    atomicWriteJson(path.join(targetDir, markerName), identity)
  }
  return targetDir
}
