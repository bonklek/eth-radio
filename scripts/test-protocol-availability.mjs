import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assessAssetAvailability,
  ethereumAvailabilityProfile,
  executionTimestampSlot,
  executionTimestampSlotForProfile,
  minimumAvailableUntilSlot,
  normalizeAvailabilityProfileV1,
  requiredUntilSlot,
  slotStartTimestamp,
  slotStartTimestampForProfile,
  UINT64_MAX,
} from '../packages/protocol/index.mjs'
import { executionTimestampSlot as compatibilityTimestampSlot } from './lib/beacon-head.mjs'
import {
  executionTimestampSlot as browserExecutionTimestampSlot,
  slotStartTimestamp as browserSlotStartTimestamp,
} from '../packages/protocol/browser-kernel.js'

const fixture = JSON.parse(fs.readFileSync(
  new URL('../test/fixtures/protocol/availability-v1.json', import.meta.url),
  'utf8',
))
const profile = normalizeAvailabilityProfileV1(fixture.profile)
assert.deepEqual(profile, fixture.profile)

const reference = ethereumAvailabilityProfile({
  network: 'sepolia',
  chainId: '11155111',
  safetyMarginSlots: '1024',
  observedAt: '2026-07-10',
})
assert.deepEqual(reference, fixture.profile)

for (const testCase of fixture.cases) {
  const actual = assessAssetAvailability({
    inclusionSlot: testCase.inclusionSlot,
    estimatedSeasonEndSlot: testCase.estimatedSeasonEndSlot,
    observationSlot: testCase.observationSlot,
    profile,
  })
  assert.deepEqual(actual, {
    ...testCase.expected,
    inclusionSlot: testCase.inclusionSlot,
    observationSlot: testCase.observationSlot,
  }, testCase.name)
}

const genesisTime = 1_606_824_023n
assert.equal(executionTimestampSlot(genesisTime, genesisTime), 0n)
assert.equal(executionTimestampSlot(genesisTime + 11n, genesisTime), 0n)
assert.equal(executionTimestampSlot(genesisTime + 12n, genesisTime), 1n)
assert.equal(executionTimestampSlotForProfile(genesisTime + 25n, genesisTime, profile), 2n)
assert.equal(compatibilityTimestampSlot(genesisTime + 25n, genesisTime), 2n)
assert.equal(browserExecutionTimestampSlot, executionTimestampSlot)
assert.equal(browserSlotStartTimestamp, slotStartTimestamp)
assert.equal(slotStartTimestamp('2', genesisTime), genesisTime + 24n)
assert.equal(slotStartTimestampForProfile('2', genesisTime, profile), genesisTime + 24n)
assert.throws(() => executionTimestampSlot(genesisTime - 1n, genesisTime), /before beacon genesis/)
assert.throws(() => executionTimestampSlot(-1n, -1n), /fit uint64/)
assert.throws(() => executionTimestampSlot(genesisTime, genesisTime, 0n), /greater than zero/)
assert.throws(() => slotStartTimestamp('01', genesisTime), /canonical non-negative decimal/)
assert.throws(() => slotStartTimestamp('0', -1n), /fit uint64/)

assert.equal(minimumAvailableUntilSlot('1000000', profile), 1_131_072n)
assert.equal(requiredUntilSlot('1130048', profile), 1_131_072n)
assert.throws(() => minimumAvailableUntilSlot(UINT64_MAX.toString(), profile), /exceeds uint64/)
assert.throws(() => requiredUntilSlot(UINT64_MAX.toString(), profile), /exceeds uint64/)
assert.throws(() => normalizeAvailabilityProfileV1({ ...fixture.profile, version: 2 }), /version must be 1/)
assert.throws(() => normalizeAvailabilityProfileV1({ ...fixture.profile, chainId: '01' }), /canonical/)
assert.throws(() => normalizeAvailabilityProfileV1({ ...fixture.profile, secondsPerSlot: '0' }), /greater than zero/)
assert.throws(() => normalizeAvailabilityProfileV1({ ...fixture.profile, slotsPerEpoch: '0' }), /greater than zero/)
assert.throws(() => normalizeAvailabilityProfileV1({ ...fixture.profile, minimumBlobServeEpochs: '0' }), /greater than zero/)
assert.throws(
  () => assessAssetAvailability({ inclusionSlot: '10', estimatedSeasonEndSlot: '9', observationSlot: '10', profile }),
  /season end slot must not precede inclusion/,
)
assert.throws(
  () => assessAssetAvailability({ inclusionSlot: '10', estimatedSeasonEndSlot: '11', observationSlot: '9', profile }),
  /Observation slot must not precede inclusion/,
)
assert.throws(
  () => normalizeAvailabilityProfileV1({
    ...fixture.profile,
    slotsPerEpoch: UINT64_MAX.toString(),
    minimumBlobServeEpochs: '2',
  }),
  /multiplication exceeds uint64/,
)

let randomState = 0xa341316c
function random(maximum) {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return (randomState >>> 0) % maximum
}

for (let index = 0; index < 10_000; index += 1) {
  const slot = BigInt(random(10_000_000))
  const offset = BigInt(random(12))
  const timestamp = genesisTime + slot * 12n + offset
  assert.equal(executionTimestampSlot(timestamp, genesisTime), slot)
  assert.equal(slotStartTimestamp(slot, genesisTime), genesisTime + slot * 12n)

  const inclusion = BigInt(random(10_000_000))
  const minimumUntil = inclusion + 4096n * 32n
  const requestedEnd = minimumUntil - 1024n + BigInt(random(2049) - 1024)
  const observation = minimumUntil - 1n + BigInt(random(2))
  const assessment = assessAssetAvailability({
    inclusionSlot: inclusion,
    estimatedSeasonEndSlot: requestedEnd,
    observationSlot: observation,
    profile,
  })
  const expectedRequired = requestedEnd + 1024n
  assert.equal(assessment.eligible, minimumUntil >= expectedRequired)
  assert.equal(assessment.theoreticalStatus, observation < minimumUntil
    ? 'inside-minimum-serving-window'
    : 'outside-minimum-serving-window')
  assert.equal(BigInt(assessment.marginSlots) * BigInt(assessment.shortfallSlots), 0n)
}

console.log('availability profile, boundary, compatibility, and property tests ok')
