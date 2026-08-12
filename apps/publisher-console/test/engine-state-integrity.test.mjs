import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sealPublisherEngineState,
  publisherDurabilityCapability,
  verifyPublisherEngineStateIntegrity,
  verifyPublisherEngineStateLink,
  verifyPublisherEngineStatePair,
  writePublisherEngineStateAtomic,
} from '../lib/engine-state-integrity.mjs'

const first = sealPublisherEngineState({ version: 8, value: 'reserved' })
assert.equal(first.revision, 0)
assert.equal(first.previousStateChecksum, null)
assert.equal(verifyPublisherEngineStateIntegrity(first), first)

const second = sealPublisherEngineState({ ...first, value: 'signed' }, first)
assert.equal(second.revision, 1)
assert.equal(second.previousStateChecksum, first.stateChecksum)
assert.equal(verifyPublisherEngineStateLink(second, first), true)
assert.equal(verifyPublisherEngineStatePair(second, first), 'linked-previous')
assert.equal(verifyPublisherEngineStatePair(second, second), 'duplicate-current')

assert.throws(() => verifyPublisherEngineStateIntegrity({ ...second, value: 'tampered' }), /checksum mismatch/)
assert.throws(() => verifyPublisherEngineStateLink(second, { ...first, stateChecksum: '0'.repeat(64) }), /checksum mismatch/)
assert.throws(() => sealPublisherEngineState(second, { ...first, stateChecksum: 'bad' }), /previous publisher state checksum/)

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-engine-integrity-'))
assert.ok(['file-and-directory-sync', 'file-sync-verified-readback'].includes(publisherDurabilityCapability(temp).mode))
const statePath = path.join(temp, 'publisher-state.json')
const durableFirst = writePublisherEngineStateAtomic(statePath, { version: 8, value: 'reserved' })
const durableSecond = writePublisherEngineStateAtomic(statePath, { ...durableFirst, value: 'signed' }, durableFirst)
const diskCurrent = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const diskPrevious = JSON.parse(fs.readFileSync(`${statePath}.previous`, 'utf8'))
assert.equal(verifyPublisherEngineStateLink(diskCurrent, diskPrevious), true)
assert.equal(durableSecond.stateChecksum, diskCurrent.stateChecksum)

assert.throws(() => writePublisherEngineStateAtomic(statePath, { ...durableSecond, value: 'broadcast' }, durableSecond, {
  writeJson(file, value) {
    if (file === statePath) throw new Error('injected current write failure')
    fs.writeFileSync(file, JSON.stringify(value))
  },
}), /injected current write failure/)
assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).stateChecksum, durableSecond.stateChecksum)
assert.equal(JSON.parse(fs.readFileSync(`${statePath}.previous`, 'utf8')).stateChecksum, durableSecond.stateChecksum)
assert.throws(() => writePublisherEngineStateAtomic(statePath, { ...durableSecond, value: 'corrupt-readback' }, durableSecond, {
  writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(file === statePath ? { ...value, value: 'corrupted' } : value))
    return { fileSynced: true, directorySynced: false, dryRun: false }
  },
}), /checksum mismatch/)
assert.throws(() => writePublisherEngineStateAtomic(statePath, { ...durableSecond, value: 'unflushed' }, durableSecond, {
  writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value))
    return { fileSynced: false, directorySynced: false, dryRun: false }
  },
}), /file was not flushed/)
fs.rmSync(temp, { recursive: true, force: true })

console.log('publisher engine state integrity tests ok')
