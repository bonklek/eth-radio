import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  criticalRecoveryMarkerPath,
  MAX_RECOVERY_ARTIFACT_BYTES,
  MAX_RECOVERY_ARTIFACTS,
  quarantineCriticalStateTemps,
} from '../lib/recovery-artifacts.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-recovery-artifacts-'))
const statePath = path.join(temp, 'publisher-state.json')
assert.equal(quarantineCriticalStateTemps(statePath), null)

const unfinished = `${statePath}.123.456.tmp`
const unfinishedPrior = `${statePath}.previous.124.457.tmp`
fs.writeFileSync(unfinished, '{"reserved":"possible"}', { mode: 0o600 })
fs.writeFileSync(unfinishedPrior, '{"previous":"possible"}', { mode: 0o600 })
const marker = quarantineCriticalStateTemps(statePath)
assert.equal(marker.artifacts.length, 2)
assert.equal(fs.existsSync(unfinished), false)
assert.equal(fs.existsSync(unfinishedPrior), false)
assert.equal(fs.existsSync(criticalRecoveryMarkerPath(statePath)), true)
const quarantined = path.join(temp, '.recovery-quarantine', marker.artifacts[0].quarantinedName)
assert.equal(fs.existsSync(quarantined), true)
assert.deepEqual(quarantineCriticalStateTemps(statePath), marker)

fs.appendFileSync(quarantined, 'tamper')
assert.throws(() => quarantineCriticalStateTemps(statePath), /integrity mismatch/)

const manyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-recovery-many-'))
const manyState = path.join(manyRoot, 'publisher-state.json')
for (let index = 0; index <= MAX_RECOVERY_ARTIFACTS; index += 1) {
  fs.writeFileSync(`${manyState}.${index + 1}.${index + 2}.tmp`, 'x')
}
assert.throws(() => quarantineCriticalStateTemps(manyState), /count exceeds limit/)

const largeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-recovery-large-'))
const largeState = path.join(largeRoot, 'publisher-state.json')
const largeTemp = `${largeState}.1.2.tmp`
fs.writeFileSync(largeTemp, '')
fs.truncateSync(largeTemp, MAX_RECOVERY_ARTIFACT_BYTES + 1)
assert.throws(() => quarantineCriticalStateTemps(largeState), /byte limit/)

for (const directory of [temp, manyRoot, largeRoot]) fs.rmSync(directory, { recursive: true, force: true })
console.log('publisher recovery artifact tests ok')
