import crypto from 'node:crypto'
import fs from 'node:fs'
import { atomicWriteJson } from '../../../scripts/lib/publisher-safety.mjs'
import { readBoundedJsonFileSync } from '../../../scripts/lib/bounded-files.mjs'
import { canonicalJson } from './arm-consent.mjs'

const checksum = /^[0-9a-f]{64}$/

export function publisherDurabilityCapability(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
    return { mode: 'file-and-directory-sync', directorySyncSupported: true }
  } catch (error) {
    return {
      mode: 'file-sync-verified-readback',
      directorySyncSupported: false,
      reasonCode: String(error?.code || 'DIRECTORY_SYNC_UNAVAILABLE').slice(0, 64),
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function publisherEngineStateChecksum(value) {
  const document = { ...value }
  delete document.stateChecksum
  return crypto.createHash('sha256').update(canonicalJson(document)).digest('hex')
}

export function sealPublisherEngineState(value, previous = null) {
  if (previous !== null && !checksum.test(String(previous.stateChecksum || ''))) {
    throw new Error('previous publisher state checksum is invalid')
  }
  const sealed = {
    ...value,
    revision: previous === null ? 0 : Number(previous.revision) + 1,
    previousStateChecksum: previous?.stateChecksum ?? null,
  }
  sealed.stateChecksum = publisherEngineStateChecksum(sealed)
  return sealed
}

export function verifyPublisherEngineStateIntegrity(value) {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('publisher engine state revision is invalid')
  if (value.revision === 0 && value.previousStateChecksum !== null) throw new Error('initial publisher state must not link a previous checksum')
  if (value.revision > 0 && !checksum.test(String(value.previousStateChecksum || ''))) {
    throw new Error('publisher engine state previous checksum is invalid')
  }
  if (!checksum.test(String(value.stateChecksum || ''))) throw new Error('publisher engine state checksum is invalid')
  if (publisherEngineStateChecksum(value) !== value.stateChecksum) throw new Error('publisher engine state checksum mismatch')
  return value
}

export function verifyPublisherEngineStateLink(current, previous) {
  verifyPublisherEngineStateIntegrity(current)
  verifyPublisherEngineStateIntegrity(previous)
  if (current.revision !== previous.revision + 1 || current.previousStateChecksum !== previous.stateChecksum) {
    throw new Error('publisher engine state previous revision link is invalid')
  }
  return true
}

export function verifyPublisherEngineStatePair(current, previous) {
  verifyPublisherEngineStateIntegrity(current)
  verifyPublisherEngineStateIntegrity(previous)
  if (current.revision === previous.revision && current.stateChecksum === previous.stateChecksum) return 'duplicate-current'
  verifyPublisherEngineStateLink(current, previous)
  return 'linked-previous'
}

export function writePublisherEngineStateAtomic(statePath, value, previous = null, {
  writeJson = atomicWriteJson,
} = {}) {
  const sealed = sealPublisherEngineState(value, previous)
  if (previous) writeJson(`${statePath}.previous`, previous)
  const writeEvidence = writeJson(statePath, sealed)
  const committed = readBoundedJsonFileSync(statePath, {
    maxBytes: 32 * 1024 * 1024,
    label: 'committed publisher engine state',
  })
  verifyPublisherEngineStateIntegrity(committed)
  if (committed.stateChecksum !== sealed.stateChecksum) throw new Error('publisher engine state readback does not match committed revision')
  if (writeEvidence?.fileSynced === false && !writeEvidence?.dryRun) throw new Error('publisher engine state file was not flushed')
  return sealed
}
