import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from '../../../scripts/lib/publisher-safety.mjs'
import { readBoundedJsonFileSync } from '../../../scripts/lib/bounded-files.mjs'

export const MAX_RECOVERY_ARTIFACTS = 16
export const MAX_RECOVERY_ARTIFACT_BYTES = 32 * 1024 * 1024
export const MAX_RECOVERY_TOTAL_BYTES = 64 * 1024 * 1024

export function criticalRecoveryMarkerPath(statePath) {
  return `${statePath}.recovery-required.json`
}

function quarantineDirectory(statePath) {
  return path.join(path.dirname(statePath), '.recovery-quarantine')
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function validateArtifact(file, label) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  if (stat.size > MAX_RECOVERY_ARTIFACT_BYTES) throw new Error(`${label} exceeds recovery artifact byte limit`)
  return stat.size
}

export function readCriticalRecoveryMarker(statePath) {
  const markerPath = criticalRecoveryMarkerPath(statePath)
  if (!fs.existsSync(markerPath)) return null
  const marker = readBoundedJsonFileSync(markerPath, {
    maxBytes: 64 * 1024,
    label: 'publisher recovery-required marker',
  })
  const keys = Object.keys(marker).sort().join(',')
  if (keys !== 'artifacts,detectedAt,reasonCode,schema') throw new Error('publisher recovery marker has unknown or missing fields')
  if (marker.schema !== 'rfe/publisher-recovery-quarantine@1' || marker.reasonCode !== 'CRITICAL_TEMP_ARTIFACT') {
    throw new Error('publisher recovery marker has unsupported identity')
  }
  if (!Number.isFinite(Date.parse(marker.detectedAt))) throw new Error('publisher recovery marker has invalid detectedAt')
  if (!Array.isArray(marker.artifacts) || !marker.artifacts.length || marker.artifacts.length > MAX_RECOVERY_ARTIFACTS) {
    throw new Error('publisher recovery marker has invalid artifact count')
  }
  const names = new Set()
  let totalBytes = 0
  for (const artifact of marker.artifacts) {
    const artifactKeys = Object.keys(artifact).sort().join(',')
    if (artifactKeys !== 'bytes,quarantinedName,sha256') throw new Error('publisher recovery marker artifact has unknown or missing fields')
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_RECOVERY_ARTIFACT_BYTES) {
      throw new Error('publisher recovery marker artifact has invalid byte size')
    }
    if (!/^artifact-[0-9a-f-]{36}\.bin$/.test(artifact.quarantinedName) || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error('publisher recovery marker artifact has invalid identity')
    }
    if (names.has(artifact.quarantinedName)) throw new Error('publisher recovery marker has duplicate artifact identity')
    names.add(artifact.quarantinedName)
    totalBytes += artifact.bytes
    if (totalBytes > MAX_RECOVERY_TOTAL_BYTES) throw new Error('publisher recovery marker exceeds aggregate byte limit')
    const file = path.join(quarantineDirectory(statePath), artifact.quarantinedName)
    if (!fs.existsSync(file)) throw new Error('publisher recovery marker artifact is missing')
    if (validateArtifact(file, 'publisher recovery marker artifact') !== artifact.bytes || sha256(file) !== artifact.sha256) {
      throw new Error('publisher recovery marker artifact integrity mismatch')
    }
  }
  return marker
}

export function quarantineCriticalStateTemps(statePath) {
  const existing = readCriticalRecoveryMarker(statePath)
  if (existing) return existing
  const directory = path.dirname(statePath)
  const base = path.basename(statePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tempPattern = new RegExp(`^${base}(?:\\.previous)?\\.\\d+\\.\\d+\\.tmp$`)
  const discovered = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => tempPattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
  const quarantine = quarantineDirectory(statePath)
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 })
  fs.chmodSync(quarantine, 0o700)
  const orphaned = fs.readdirSync(quarantine, { withFileTypes: true })
    .filter((entry) => /^artifact-[0-9a-f-]{36}\.bin$/.test(entry.name))
    .map((entry) => path.join(quarantine, entry.name))
  if (!discovered.length && !orphaned.length) return null
  if (discovered.length + orphaned.length > MAX_RECOVERY_ARTIFACTS) throw new Error('critical recovery artifact count exceeds limit')

  const artifacts = []
  let totalBytes = 0
  for (const file of orphaned) {
    const bytes = validateArtifact(file, 'orphaned recovery artifact')
    totalBytes += bytes
    artifacts.push({ quarantinedName: path.basename(file), bytes, sha256: sha256(file) })
  }
  for (const file of discovered) {
    const bytes = validateArtifact(file, 'critical temporary state artifact')
    totalBytes += bytes
    if (totalBytes > MAX_RECOVERY_TOTAL_BYTES) throw new Error('critical recovery artifact bytes exceed aggregate limit')
    const quarantinedName = `artifact-${crypto.randomUUID()}.bin`
    const target = path.join(quarantine, quarantinedName)
    fs.renameSync(file, target)
    fs.chmodSync(target, 0o600)
    artifacts.push({ quarantinedName, bytes, sha256: sha256(target) })
  }
  if (totalBytes > MAX_RECOVERY_TOTAL_BYTES) throw new Error('critical recovery artifact bytes exceed aggregate limit')
  artifacts.sort((left, right) => left.quarantinedName.localeCompare(right.quarantinedName))
  const marker = {
    schema: 'rfe/publisher-recovery-quarantine@1',
    reasonCode: 'CRITICAL_TEMP_ARTIFACT',
    detectedAt: new Date().toISOString(),
    artifacts,
  }
  atomicWriteJson(criticalRecoveryMarkerPath(statePath), marker)
  return marker
}
